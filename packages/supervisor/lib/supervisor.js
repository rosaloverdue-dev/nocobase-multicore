'use strict';
/**
 * nocobase-multicore supervisor.
 *
 * Runs as the container's main process. It never loads NocoBase itself: it forks N workers with node:cluster
 * (every worker executes `@nocobase/app/lib/index.js start`). With the built-in balancer (default) every worker
 * listens on a private loopback port and the supervisor routes each request to the least busy one; with
 * MULTICORE_BALANCER=off the workers share one port and the kernel/primary round-robins connections.
 *
 * The number of workers and the mode (single | cluster) are read from storage/multicore/config.json, which the
 * NocoBase plugin `@nb-multicore/plugin-multicore` writes when an administrator flips the switch in the UI. The plugin then
 * sends `{cmd:'multicore', type:'apply'}` over the cluster IPC channel; SIGHUP and a slow poll are fallbacks.
 *
 * Everything notable (worker exits with their reason, restarts, long event-loop stalls, Bad-gateway answers) is
 * written to a journal: kept in memory for the status page and appended to storage/multicore/events.log.
 */
const cluster = require('node:cluster');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { readConfig, configPath, statusPath, eventsPath, maxWorkers } = require('./config');
const { Balancer } = require('./balancer');

const CMD = 'multicore';
const DRAIN_GRACE_MS = 30_000;
const ROUTING_DELAY_MS = 1_500;
const LISTEN_TIMEOUT_MS = 240_000;
/** A worker that sent no heartbeat for this long gets a "stall" line in the journal once it answers again. */
const STALL_EVENT_MS = 5_000;
const MAX_EVENTS = 200;
const EVENTS_FILE_MAX_BYTES = 512 * 1024;

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

/** Why a worker process ended, as a short code the status page can translate. */
function exitReason(code, signal) {
  if (signal === 'SIGABRT' || code === 134) return 'oom'; // V8 aborts when the heap limit is reached
  if (signal === 'SIGKILL' || code === 137) return 'killed'; // kernel OOM killer, or our own drain timeout
  if (signal === 'SIGSEGV' || code === 139) return 'crash';
  if (signal) return 'signal';
  if (code === 0) return 'exit';
  return 'error';
}

/** Slot id as shown to people: a replacement worker runs under a temporary id (1000 + n) until it takes over slot n. */
function shownId(slot) {
  return slot.id >= 1000 ? slot.id - 1000 : slot.id;
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
    this.events = [];
    this.badGateway = null; // aggregated "Bad gateway" answers, flushed to the journal every few seconds
    // MULTICORE_BALANCER=off keeps the plain node:cluster round-robin on one shared port.
    this.balancerOn = this.env.MULTICORE_BALANCER !== 'off';
    this.balancer = this.balancerOn ? new Balancer({ log: this.log, onEvent: (e) => this.onBalancerEvent(e) }) : null;
    // flags of the supervisor process itself are inherited by the workers, except the heap limit (set per config)
    this.baseExecArgv = process.execArgv.filter((arg) => !/^--max[-_]old[-_]space[-_]size/.test(arg));
  }

  // ---------- public API ----------
  async start() {
    if (this.balancerOn) {
      // every worker listens on its own private port, so the kernel/primary must not share handles between them
      cluster.schedulingPolicy = cluster.SCHED_NONE;
    }
    this.loadJournal();
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
    this.event('boot', { pid: process.pid, cpus: os.cpus().length });
    if (this.balancerOn) {
      const { port, host } = publicAddress(this.env);
      this.publicPort = port;
      const addr = await this.balancer.listen(port, host);
      this.log(`balancer: least-busy routing on ${addr.address}:${addr.port} -> private worker ports`);
    }
    await this.reconcile('boot');
  }

  /** Serialize: only one topology change at a time, later calls queue behind the running one. */
  enqueue(label, fn) {
    this.chain = this.chain
      .then(fn)
      .catch((error) => {
        this.lastReconcile = { at: new Date().toISOString(), reason: label, ok: false, error: String(error && error.message) };
        this.event('failed', { what: label, error: String(error && error.message) });
        this.log(`${label} failed:`, error && error.stack ? error.stack : error);
      })
      .then(() => this.writeStatus());
    return this.chain;
  }

  reconcile(reason) {
    return this.enqueue(`reconcile (${reason})`, () => this.doReconcile(reason));
  }

  // ---------- journal ----------
  event(type, data = {}) {
    const entry = { at: new Date().toISOString(), type, ...data };
    this.events.push(entry);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    try {
      fs.appendFile(eventsPath(this.env), `${JSON.stringify(entry)}\n`, () => undefined);
    } catch (e) {
      // the journal is best-effort
    }
    return entry;
  }

  /** Show the tail of the previous run's journal too, and keep the file small. */
  loadJournal() {
    try {
      const file = eventsPath(this.env);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (!fs.existsSync(file)) return;
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      const tail = lines.slice(-MAX_EVENTS);
      for (const line of tail) {
        try {
          this.events.push(JSON.parse(line));
        } catch (e) {
          // skip a damaged line
        }
      }
      if (fs.statSync(file).size > EVENTS_FILE_MAX_BYTES) fs.writeFileSync(file, `${tail.join('\n')}\n`);
    } catch (e) {
      // best-effort
    }
  }

  onBalancerEvent(e) {
    if (e.type !== 'bad-gateway') return;
    if (!this.badGateway) {
      this.badGateway = { count: 0, codes: {}, slots: {} };
      setTimeout(() => {
        const agg = this.badGateway;
        this.badGateway = null;
        this.event('bad-gateway', agg);
      }, 5_000).unref();
    }
    this.badGateway.count += 1;
    this.badGateway.codes[e.code] = (this.badGateway.codes[e.code] || 0) + 1;
    this.badGateway.slots[e.slot] = (this.badGateway.slots[e.slot] || 0) + 1;
  }

  // ---------- reconcile ----------
  desired() {
    const cfg = readConfig(this.env);
    try {
      this.configMtime = fs.statSync(configPath(this.env)).mtimeMs;
    } catch (e) {
      this.configMtime = 0;
    }
    return { mode: cfg.enabled ? 'cluster' : 'single', count: cfg.enabled ? cfg.workers : 1, cfg };
  }

  liveSlots() {
    return [...this.slots.values()].filter((s) => !s.draining && s.id < 1000).sort((a, b) => a.id - b.id);
  }

  async doReconcile(reason) {
    if (this.stopping) return;
    const { mode, count, cfg } = this.desired();
    this.heapMb = cfg.heapMb;
    if (this.balancerOn) this.balancer.setAffinity(cfg.affinity); // hot: no worker restart
    this.log(`reconcile (${reason}): desired mode=${mode} workers=${count}${cfg.heapMb ? ` heap=${cfg.heapMb}MB` : ''}`);

    // 1) scale down first: drain the highest slots (never start a worker only to drain it right after a mode change).
    while (this.liveSlots().length > count) {
      const victim = this.liveSlots().pop();
      this.log(`scale down: draining slot ${victim.id}`);
      await this.drain(victim);
    }

    // 2) mode or heap-limit change => rolling replacement of every live slot (their environment/flags differ).
    const stale = this.liveSlots().filter((s) => s.mode !== mode || s.heapMb !== cfg.heapMb);
    for (const slot of stale) {
      await this.replaceSlot(slot, mode);
    }

    // 3) scale up: sequential starts (NocoBase boot is heavy; avoids a thundering herd on the database).
    while (this.liveSlots().length < count) {
      const used = new Set(this.liveSlots().map((s) => s.id));
      let id = 0;
      while (used.has(id)) id += 1;
      await this.spawn(id, mode, { quickstart: this.firstBootPending && id === 0 });
      this.firstBootPending = false;
    }

    this.lastReconcile = { at: new Date().toISOString(), reason, ok: true, mode, workers: count };
    this.event('reconcile', { reason, mode, workers: this.liveSlots().length });
    this.log(`reconcile done: mode=${mode} workers=${this.liveSlots().length}`);
  }

  workerEnv(slot, replacing) {
    const env = {
      MULTICORE_SUPERVISED: '1',
      MULTICORE_MODE: slot.mode,
      MULTICORE_SLOT: String(slot.id),
      MULTICORE_WORKERS: String(this.slots.size),
    };
    if (slot.mode === 'cluster') {
      const url = this.env.REDIS_URL || this.env.MULTICORE_REDIS_URL;
      if (url) {
        env.REDIS_URL = url;
        if (!this.env.CACHE_DEFAULT_STORE) env.CACHE_DEFAULT_STORE = 'redis';
        if (!this.env.CACHE_REDIS_URL) env.CACHE_REDIS_URL = url;
      }
      // Snowflake worker ids of the other live workers. Their Redis lease can expire while such a worker is stuck in
      // a long event-loop stall; a new worker must not grab that id, or the stalled one has to exit when it wakes up.
      const taken = [...this.slots.values()].filter((s) => s !== slot && s.wid != null).map((s) => s.wid);
      if (taken.length) env.MULTICORE_WID_AVOID = taken.join(',');
    }
    if (slot.port) {
      env.APP_PORT = String(slot.port);
      env.APP_HOST = '127.0.0.1';
    }
    // Only one live process can own the default IPC socket of the NocoBase CLI (storage/gateway.sock).
    if (slot.id !== 0 || replacing) {
      const dir = path.join(path.dirname(configPath(this.env)), 'sockets');
      fs.mkdirSync(dir, { recursive: true });
      env.SOCKET_PATH = path.join(dir, `w${process.pid}-${slot.id}-${Date.now() % 100000}.sock`);
    }
    return env;
  }

  async spawn(id, mode, { quickstart = false, replacing = false } = {}) {
    const slot = {
      id,
      mode,
      heapMb: this.heapMb || 0,
      state: 'starting',
      restarts: 0,
      stalls: 0,
      startedAt: Date.now(),
      lastBeat: Date.now(),
      draining: false,
      worker: null,
      backoff: 1000,
    };
    this.slots.set(id, slot);
    await this.fork(slot, { replacing, quickstart });
    await this.waitListening(slot);
    return slot;
  }

  async fork(slot, { replacing = false, quickstart = false } = {}) {
    slot.port = this.balancerOn ? await freePort() : null;
    slot.wid = null;
    cluster.setupPrimary({
      exec: WORKER_ENTRY,
      args: quickstart ? ['start', '--quickstart'] : ['start'],
      // a command-line flag wins over NODE_OPTIONS, so the limit from the settings page is the one in effect
      execArgv: slot.heapMb ? [...this.baseExecArgv, `--max-old-space-size=${slot.heapMb}`] : this.baseExecArgv,
      silent: false,
    });
    const worker = cluster.fork(this.workerEnv(slot, replacing));
    slot.worker = worker;
    slot.state = 'starting';
    slot.startedAt = Date.now();
    slot.lastBeat = Date.now();
    slot.listeningAt = null;
    worker.__slotId = slot.id;
    this.log(`slot ${slot.id}: forked worker pid=${worker.process.pid} mode=${slot.mode}${slot.heapMb ? ` heap=${slot.heapMb}MB` : ''}`);
    return worker;
  }

  waitListening(slot) {
    return new Promise((resolve) => {
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

  /**
   * Zero-downtime replacement of one worker: start the replacement under a temporary slot id, wait until it serves,
   * then drain the old worker; finally the replacement takes the id. If the replacement does not come up, the old
   * worker simply keeps running.
   */
  async replaceSlot(oldSlot, mode = oldSlot.mode) {
    this.log(`slot ${oldSlot.id}: rolling replace ${oldSlot.mode} -> ${mode}`);
    const tmpId = 1000 + oldSlot.id;
    const fresh = await this.spawn(tmpId, mode, { replacing: true });
    if (this.stopping) return;
    if (fresh.state !== 'listening') {
      this.log(`slot ${oldSlot.id}: the replacement did not start, keeping the old worker`);
      await this.drain(fresh);
      this.slots.delete(tmpId);
      throw new Error(`slot ${oldSlot.id}: the replacement worker did not start, the old worker keeps running`);
    }
    await this.drain(oldSlot);
    this.slots.delete(tmpId);
    fresh.id = oldSlot.id;
    fresh.worker.__slotId = oldSlot.id;
    fresh.restarts = oldSlot.restarts;
    fresh.stalls = oldSlot.stalls;
    this.slots.set(fresh.id, fresh);
  }

  /** Manual restart from the settings page: one slot, or all of them one after another. */
  restart(target, by) {
    const ids = target === 'all' ? this.liveSlots().map((s) => s.id) : [Number(target)];
    if (!ids.length || ids.some((id) => !Number.isInteger(id) || !this.slots.has(id) || id >= 1000)) return false;
    this.event('restart-requested', { slot: target === 'all' ? 'all' : ids[0], by: by || null });
    this.enqueue(`restart (${target})`, async () => {
      for (const id of ids) {
        const slot = this.slots.get(id);
        if (this.stopping || !slot || slot.draining) continue;
        const startedAt = Date.now();
        await this.replaceSlot(slot);
        this.event('restarted', { slot: id, ms: Date.now() - startedAt });
      }
    });
    return true;
  }

  async drain(slot) {
    slot.draining = true;
    slot.state = 'draining';
    // 1) stop sending NEW requests to it and let the ones in flight finish
    if (this.balancerOn) await this.balancer.remove(slot, DRAIN_GRACE_MS);
    const worker = slot.worker;
    if (!worker || worker.isDead()) {
      if (this.slots.get(slot.id) === slot) this.slots.delete(slot.id);
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
    const slot = this.slotOf(worker);
    if (message.type === 'hb') {
      if (!slot) return;
      const now = Date.now();
      const silent = now - slot.lastBeat;
      if (slot.state === 'listening' && silent >= STALL_EVENT_MS) {
        slot.stalls += 1;
        slot.lastStall = { at: new Date(now).toISOString(), ms: silent };
        this.event('stall', { slot: shownId(slot), pid: worker.process.pid, ms: silent });
        this.log(`slot ${slot.id}: event loop was blocked for ${(silent / 1000).toFixed(1)}s`);
      }
      slot.lastBeat = now;
      if (this.balancerOn) this.balancer.beat(slot, Number(message.lag) || 0);
      return;
    }
    const reply = (type, extra = {}) => {
      if (!message.reqId) return;
      try {
        worker.send({ cmd: CMD, type, reqId: message.reqId, ...extra });
      } catch (e) {
        // the worker is gone
      }
    };
    if (message.type === 'wid') {
      // the snowflake worker id this process leased in Redis
      if (slot) slot.wid = Number.isInteger(message.id) ? message.id : null;
    } else if (message.type === 'apply') {
      this.log(`apply requested by worker pid=${worker.process.pid}`);
      this.event('apply', { by: message.by || null });
      this.reconcile('ipc-apply');
      reply('apply:ack');
    } else if (message.type === 'restart') {
      const accepted = this.restart(message.slot, message.by);
      this.log(`restart of slot ${message.slot} requested by worker pid=${worker.process.pid}: ${accepted ? 'accepted' : 'rejected'}`);
      reply('restart:ack', { accepted });
    } else if (message.type === 'status') {
      reply('status:res', { data: this.snapshot() });
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
      slot.lastBeat = Date.now();
      if (this.balancerOn && address && address.port === slot.port) {
        this.balancer.add(slot, slot.port);
        this.log(`slot ${slot.id}: ready, routing to 127.0.0.1:${slot.port}`);
      }
      this.event('worker-ready', { slot: shownId(slot), pid: worker.process.pid, bootMs: Date.now() - slot.startedAt });
    }
  }

  onExit(worker, code, signal) {
    const slot = [...this.slots.values()].find((s) => s.worker === worker);
    if (!slot) return;
    this.log(`slot ${slot.id}: worker pid=${worker.process.pid} exited code=${code} signal=${signal}`);
    if (this.balancerOn) this.balancer.remove(slot, 0);
    slot.wid = null;
    if (this.stopping || slot.draining) return;
    // Unexpected exit (crash, out of memory, process.exit from NocoBase restart flows): respawn with exponential backoff.
    const reason = exitReason(code, signal);
    slot.lastExit = { at: new Date().toISOString(), code, signal, reason };
    const healthy = slot.listeningAt && Date.now() - slot.listeningAt > 60_000;
    if (healthy) slot.backoff = 1000;
    slot.restarts += 1;
    slot.state = 'restarting';
    const delay = slot.backoff;
    slot.backoff = Math.min(slot.backoff * 2, 30_000);
    this.event('worker-exit', { slot: shownId(slot), pid: worker.process.pid, code, signal, reason, respawnInMs: delay });
    setTimeout(() => {
      if (this.stopping || slot.draining || this.slots.get(slot.id) !== slot) return;
      this.fork(slot, { replacing: slot.id >= 1000 }).catch((error) => this.log('respawn failed:', error && error.message));
    }, delay).unref();
  }

  pollConfig() {
    try {
      const mtime = fs.statSync(configPath(this.env)).mtimeMs;
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
  snapshot({ events = 60 } = {}) {
    const { mode, count, cfg } = this.desired();
    const now = Date.now();
    return {
      supervisorPid: process.pid,
      startedAt: new Date(this.startedAt).toISOString(),
      cpus: os.cpus().length,
      maxWorkers: maxWorkers(this.env),
      host: {
        totalMemMb: Math.round(os.totalmem() / 1048576),
        freeMemMb: Math.round(os.freemem() / 1048576),
        load: os.loadavg().map((v) => Math.round(v * 100) / 100),
      },
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
          stalls: s.stalls,
          lastStall: s.lastStall || null,
          lastExit: s.lastExit || null,
          silentMs: s.state === 'listening' ? now - s.lastBeat : 0,
          wid: s.wid == null ? null : s.wid,
          heapMb: s.heapMb || 0,
          port: s.port || undefined,
          startedAt: new Date(s.startedAt).toISOString(),
        })),
      events: events > 0 ? this.events.slice(-events) : [],
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
    try {
      fs.appendFileSync(eventsPath(this.env), `${JSON.stringify({ at: new Date().toISOString(), type: 'shutdown', signal })}\n`);
    } catch (e) {
      // best-effort
    }
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

module.exports = { Supervisor, run, exitReason };
