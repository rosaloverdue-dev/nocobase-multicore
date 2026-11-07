'use strict';
/**
 * nocobase-multicore supervisor.
 *
 * Runs as the container's main process. It never loads NocoBase itself: it forks N workers with node:cluster
 * (every worker executes `@nocobase/app/lib/index.js start`) and the kernel/primary round-robins HTTP connections
 * between them, so a single port is served by several CPU cores without any load balancer.
 *
 * The number of workers and the mode (single | cluster) are read from storage/multicore/config.json, which the
 * NocoBase plugin `@nb-multicore/plugin-multicore` writes when an administrator flips the switch in the UI. The plugin then
 * sends `{cmd:'multicore', type:'apply'}` over the cluster IPC channel; SIGHUP and a slow poll are fallbacks.
 */
const cluster = require('node:cluster');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { readConfig, statusPath, maxWorkers } = require('./config');
const { Balancer } = require('./balancer');

const CMD = 'multicore';
const DRAIN_GRACE_MS = 30_000;
const ROUTING_DELAY_MS = 1_500;
const LISTEN_TIMEOUT_MS = 240_000;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Public address of the site: APP_PORT / APP_HOST from the environment or from .env (NocoBase reads them the same way). */
function publicAddress(env) {
  const out = { port: Number(env.APP_PORT) || 0, host: env.APP_HOST || '' };
  if (!out.port || !out.host) {
    try {
      const text = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*(APP_PORT|APP_HOST)\s*=\s*["']?([^"'#\s]*)/);
        if (!m) continue;
        if (m[1] === 'APP_PORT' && !out.port) out.port = Number(m[2]) || 0;
        if (m[1] === 'APP_HOST' && !out.host) out.host = m[2];
      }
    } catch (e) {
      // no .env
    }
  }
  return { port: out.port || 13000, host: out.host || '0.0.0.0' };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const WORKER_ENTRY = path.join(__dirname, 'worker-entry.js');

function resolveEntry(env) {
  if (env.MULTICORE_APP_ENTRY) return env.MULTICORE_APP_ENTRY;
  try {
    return require.resolve('@nocobase/app/lib/index.js', { paths: [process.cwd()] });
  } catch (error) {
    throw new Error(
      'Cannot find @nocobase/app. Set MULTICORE_APP_ENTRY to the NocoBase entry file ' +
        '(e.g. /app/nocobase/node_modules/@nocobase/app/lib/index.js) or run the supervisor from the project root.',
    );
  }
}

class Supervisor {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.log = options.log || ((...args) => console.log('[multicore]', ...args));
    this.entry = resolveEntry(this.env);
    this.slots = new Map(); // slotId -> slot
    this.stopping = false;
    this.startedAt = Date.now();
    this.firstBootPending = this.env.MULTICORE_QUICKSTART !== '0';
    this.chain = Promise.resolve();
    this.lastReconcile = null;
    this.configMtime = 0;
    // MULTICORE_BALANCER=off keeps the plain node:cluster round-robin on one shared port.
    this.balancerOn = this.env.MULTICORE_BALANCER !== 'off';
    this.balancer = this.balancerOn ? new Balancer({ log: this.log }) : null;
  }

  // ---------- public API ----------
  async start() {
    if (this.balancerOn) {
      // every worker listens on its own private port, so the kernel/primary must not share handles between them
      cluster.schedulingPolicy = cluster.SCHED_NONE;
    }
    cluster.setupPrimary({ exec: WORKER_ENTRY, args: ['start'], silent: false });
    cluster.on('message', (worker, message) => this.onMessage(worker, message));
    cluster.on('exit', (worker, code, signal) => this.onExit(worker, code, signal));
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
    process.on('SIGINT', () => this.shutdown('SIGINT'));
    process.on('SIGHUP', () => {
      this.log('SIGHUP: reloading config');
      this.reconcile('sighup');
    });
    this.poller = setInterval(() => this.pollConfig(), 10_000);
    this.poller.unref();
    this.log(
      `supervisor pid=${process.pid} entry=${this.entry} cpus=${os.cpus().length} maxWorkers=${maxWorkers(this.env)}`,
    );
    if (this.balancerOn) {
      const { port, host } = publicAddress(this.env);
      this.publicPort = port;
      const addr = await this.balancer.listen(port, host);
      this.log(`balancer: least-busy routing on ${addr.address}:${addr.port} -> private worker ports`);
    }
    await this.reconcile('boot');
  }

  reconcile(reason) {
    // Serialize: only one reconcile at a time, later calls queue behind the running one.
    this.chain = this.chain
      .then(() => this.doReconcile(reason))
      .catch((error) => {
        this.lastReconcile = { at: new Date().toISOString(), reason, ok: false, error: String(error && error.message) };
        this.log('reconcile failed:', error && error.stack ? error.stack : error);
      })
      .then(() => this.writeStatus());
    return this.chain;
  }

  // ---------- reconcile ----------
  desired() {
    const cfg = readConfig(this.env);
    try {
      this.configMtime = fs.statSync(require('./config').configPath(this.env)).mtimeMs;
    } catch (e) {
      this.configMtime = 0;
    }
    return { mode: cfg.enabled ? 'cluster' : 'single', count: cfg.enabled ? cfg.workers : 1, cfg };
  }

  async doReconcile(reason) {
    if (this.stopping) return;
    const { mode, count, cfg } = this.desired();
    if (this.balancerOn) this.balancer.setAffinity(cfg.affinity); // hot: no worker restart
    this.log(`reconcile (${reason}): desired mode=${mode} workers=${count}`);

    const live = () => [...this.slots.values()].filter((s) => !s.draining).sort((a, b) => a.id - b.id);
    // 1) scale down first: drain the highest slots (never start a worker only to drain it right after a mode change).
    while (live().length > count) {
      const victim = live().pop();
      this.log(`scale down: draining slot ${victim.id}`);
      await this.drain(victim);
    }

    // 2) mode change => rolling replacement of every live slot (env differs, e.g. cache store).
    const stale = [...this.slots.values()].filter((s) => !s.draining && s.mode !== mode).sort((a, b) => a.id - b.id);
    for (const slot of stale) {
      await this.replaceSlot(slot, mode);
    }

    // 3) scale up: sequential starts (NocoBase boot is heavy; avoids a thundering herd on the database).
    while (live().length < count) {
      const used = new Set(live().map((s) => s.id));
      let id = 0;
      while (used.has(id)) id += 1;
      await this.spawn(id, mode, { quickstart: this.firstBootPending && id === 0 });
      this.firstBootPending = false;
    }

    this.lastReconcile = { at: new Date().toISOString(), reason, ok: true, mode, workers: count };
    this.log(`reconcile done: mode=${mode} workers=${live().length}`);
  }

  workerEnv(id, mode, replacing, port) {
    const env = {
      MULTICORE_SUPERVISED: '1',
      MULTICORE_MODE: mode,
      MULTICORE_SLOT: String(id),
      MULTICORE_WORKERS: String(this.slots.size),
    };
    if (mode === 'cluster') {
      const url = this.env.REDIS_URL || this.env.MULTICORE_REDIS_URL;
      if (url) {
        env.REDIS_URL = url;
        if (!this.env.CACHE_DEFAULT_STORE) env.CACHE_DEFAULT_STORE = 'redis';
        if (!this.env.CACHE_REDIS_URL) env.CACHE_REDIS_URL = url;
      }
    }
    if (port) {
      env.APP_PORT = String(port);
      env.APP_HOST = '127.0.0.1';
    }
    // Only one live process can own the default IPC socket of the NocoBase CLI (storage/gateway.sock).
    if (id !== 0 || replacing) {
      const dir = path.join(path.dirname(require('./config').configPath(this.env)), 'sockets');
      fs.mkdirSync(dir, { recursive: true });
      env.SOCKET_PATH = path.join(dir, `w${process.pid}-${id}-${Date.now() % 100000}.sock`);
    }
    return env;
  }

  async spawn(id, mode, { quickstart = false, replacing = false } = {}) {
    cluster.setupPrimary({ exec: WORKER_ENTRY, args: quickstart ? ['start', '--quickstart'] : ['start'], silent: false });
    const slot = { id, mode, state: 'starting', restarts: 0, startedAt: Date.now(), draining: false, worker: null, backoff: 1000 };
    this.slots.set(id, slot);
    await this.fork(slot, { replacing });
    await this.waitListening(slot);
    return slot;
  }

  async fork(slot, { replacing = false } = {}) {
    slot.port = this.balancerOn ? await freePort() : null;
    const worker = cluster.fork(this.workerEnv(slot.id, slot.mode, replacing, slot.port));
    slot.worker = worker;
    slot.state = 'starting';
    slot.startedAt = Date.now();
    worker.__slotId = slot.id;
    this.log(`slot ${slot.id}: forked worker pid=${worker.process.pid} mode=${slot.mode}`);
    return worker;
  }

  waitListening(slot) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = setInterval(() => {
        if (slot.state === 'listening') {
          clearInterval(tick);
          resolve();
        } else if (this.stopping || slot.draining) {
          clearInterval(tick);
          resolve();
        } else if (Date.now() - started > LISTEN_TIMEOUT_MS) {
          clearInterval(tick);
          // Not fatal: keep the worker, let the next reconcile/poll deal with it.
          this.log(`slot ${slot.id}: no 'listening' after ${LISTEN_TIMEOUT_MS / 1000}s, continuing`);
          resolve();
        }
      }, 250);
    });
  }

  async replaceSlot(oldSlot, mode) {
    this.log(`slot ${oldSlot.id}: rolling replace ${oldSlot.mode} -> ${mode}`);
    // Start the replacement under a temporary slot id, then drain the old worker; finally the replacement takes the id.
    const tmpId = 1000 + oldSlot.id;
    const fresh = await this.spawn(tmpId, mode, { replacing: true });
    await this.drain(oldSlot);
    this.slots.delete(tmpId);
    fresh.id = oldSlot.id;
    fresh.worker.__slotId = oldSlot.id;
    this.slots.set(fresh.id, fresh);
  }

  async drain(slot) {
    slot.draining = true;
    slot.state = 'draining';
    // 1) stop sending NEW requests to it and let the ones in flight finish
    if (this.balancerOn) await this.balancer.remove(slot, DRAIN_GRACE_MS);
    const worker = slot.worker;
    if (!worker || worker.isDead()) {
      this.slots.delete(slot.id);
      return;
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.log(`slot ${slot.id}: drain timeout, SIGKILL`);
        try {
          worker.process.kill('SIGKILL');
        } catch (e) {
          // already gone
        }
      }, DRAIN_GRACE_MS);
      worker.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      // Without the balancer: stop the primary from routing NEW connections to this worker first (while NocoBase is
      // shutting down it answers in-flight-at-the-wrong-moment requests with 500 "connection manager was closed").
      try {
        worker.disconnect();
      } catch (e) {
        // already disconnected
      }
      setTimeout(() => {
        try {
          worker.process.kill('SIGTERM');
        } catch (e) {
          resolve();
        }
      }, ROUTING_DELAY_MS);
    });
    if (this.slots.get(slot.id) === slot) this.slots.delete(slot.id);
  }

  // ---------- events ----------
  onMessage(worker, message) {
    if (message && message.cmd === '__listening') return;
    if (!message || message.cmd !== CMD) return;
    if (message.type === 'hb') {
      if (this.balancerOn) {
        const s = this.slotOf(worker);
        if (s) this.balancer.beat(s);
      }
      return;
    }
    if (message.type === 'apply') {
      this.log(`apply requested by worker pid=${worker.process.pid}`);
      this.reconcile('ipc-apply');
      if (message.reqId) worker.send({ cmd: CMD, type: 'apply:ack', reqId: message.reqId });
    } else if (message.type === 'status') {
      worker.send({ cmd: CMD, type: 'status:res', reqId: message.reqId, data: this.snapshot() });
    }
  }

  slotOf(worker) {
    return [...this.slots.values()].find((s) => s.worker === worker) || this.slots.get(worker.__slotId);
  }

  onListening(worker, address) {
    const slot = this.slotOf(worker);
    if (slot && slot.state !== 'draining') {
      slot.state = 'listening';
      slot.listeningAt = Date.now();
      if (this.balancerOn && address && address.port === slot.port) {
        this.balancer.add(slot, slot.port);
        this.log(`slot ${slot.id}: ready, routing to 127.0.0.1:${slot.port}`);
      }
    }
  }

  onExit(worker, code, signal) {
    const slot = [...this.slots.values()].find((s) => s.worker === worker);
    if (!slot) return;
    this.log(`slot ${slot.id}: worker pid=${worker.process.pid} exited code=${code} signal=${signal}`);
    if (this.balancerOn) this.balancer.remove(slot, 0);
    if (this.stopping || slot.draining) return;
    // Unexpected exit (crash, process.exit from NocoBase restart flows): respawn with exponential backoff.
    const healthy = slot.listeningAt && Date.now() - slot.listeningAt > 60_000;
    if (healthy) slot.backoff = 1000;
    slot.restarts += 1;
    slot.state = 'restarting';
    const delay = slot.backoff;
    slot.backoff = Math.min(slot.backoff * 2, 30_000);
    setTimeout(() => {
      if (this.stopping || slot.draining || this.slots.get(slot.id) !== slot) return;
      cluster.setupPrimary({ exec: WORKER_ENTRY, args: ['start'], silent: false });
      this.fork(slot, { replacing: false }).catch((error) => this.log('respawn failed:', error && error.message));
    }, delay).unref();
  }

  pollConfig() {
    try {
      const mtime = fs.statSync(require('./config').configPath(this.env)).mtimeMs;
      if (mtime !== this.configMtime) {
        this.log('config file changed on disk');
        this.reconcile('poll');
      }
    } catch (e) {
      // no config file yet
    }
    this.writeStatus();
  }

  // ---------- status ----------
  snapshot() {
    const { mode, count, cfg } = this.desired();
    return {
      supervisorPid: process.pid,
      startedAt: new Date(this.startedAt).toISOString(),
      cpus: os.cpus().length,
      maxWorkers: maxWorkers(this.env),
      desired: { mode, workers: count },
      config: cfg,
      lastReconcile: this.lastReconcile,
      balancer: this.balancerOn ? { publicPort: this.publicPort, ...this.balancer.snapshot() } : { mode: 'round-robin' },
      workers: [...this.slots.values()]
        .sort((a, b) => a.id - b.id)
        .map((s) => ({
          slot: s.id,
          pid: s.worker && s.worker.process.pid,
          state: s.state,
          mode: s.mode,
          restarts: s.restarts,
          port: s.port || undefined,
          startedAt: new Date(s.startedAt).toISOString(),
        })),
    };
  }

  writeStatus() {
    try {
      const file = statusPath(this.env);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ...this.snapshot(), writtenAt: new Date().toISOString() }, null, 2));
      fs.renameSync(tmp, file);
    } catch (e) {
      // status is best-effort
    }
  }

  async shutdown(signal) {
    if (this.stopping) return;
    this.stopping = true;
    this.log(`${signal}: shutting down workers`);
    const slots = [...this.slots.values()];
    await Promise.all(slots.map((s) => this.drain(s)));
    if (this.balancerOn) this.balancer.close();
    this.writeStatus();
    process.exit(0);
  }
}

function run(options) {
  if (!cluster.isPrimary) {
    throw new Error('nocobase-multicore must run as the cluster primary');
  }
  const supervisor = new Supervisor(options);
  // The IPC socket of the NocoBase gateway also emits 'listening' (unix socket: port -1); only the HTTP port counts.
  cluster.on('listening', (worker, address) => {
    if (address && address.port > 0) supervisor.onListening(worker, address);
  });
  supervisor.start().catch((error) => {
    console.error('[multicore] fatal:', error);
    process.exit(1);
  });
  return supervisor;
}

module.exports = { Supervisor, run };
