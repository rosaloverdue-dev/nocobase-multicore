import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Plugin } from '@nocobase/server';
// The supervisor's config helpers are bundled into this plugin by scripts/build.mjs (single implementation).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cfg = require('../../../supervisor/lib/config.js');
import { isClusterMode, keyPrefix, redisUrl, sleep } from '../../../shared/src/env';
import { turnOffClusterMode } from '../../../shared/src/safeguard';

const ADAPTER_PLUGINS = {
  pubsub: '@nb-multicore/plugin-pubsub-adapter-redis',
  lock: '@nb-multicore/plugin-lock-adapter-redis',
  queue: '@nb-multicore/plugin-queue-adapter-redis',
  workerId: '@nb-multicore/plugin-worker-id-allocator-redis',
} as const;

const HEARTBEAT_EVERY = 5_000;
const HEARTBEAT_TTL = 20_000;
const SELFTEST_CHANNEL = 'multicore.selftest';
const SELFTEST_QUEUE = 'multicore.selftest';

type Pending = { resolve: (value: any) => void; timer: NodeJS.Timeout };

export class PluginMulticore extends Plugin {
  async beforeDisable() {
    turnOffClusterMode(this.app, 'plugin plugin-multicore is being disabled');
  }

  async beforeRemove() {
    turnOffClusterMode(this.app, 'plugin plugin-multicore is being removed');
  }

  private redis: any;
  private heartbeatTimer?: NodeJS.Timeout;
  private loopDelay = monitorEventLoopDelay({ resolution: 20 });
  private lastCpu = process.cpuUsage();
  private lastCpuAt = Date.now();
  private startedAt = new Date().toISOString();
  private pending = new Map<string, Pending>();
  private ipcBound = false;

  // ------------------------------------------------------------------ lifecycle

  async afterAdd() {}

  async beforeLoad() {}

  async load() {
    this.app.acl.registerSnippet({ name: 'pm.multicore', actions: ['multicore:*'] });
    this.app.resourceManager.define({
      name: 'multicore',
      actions: {
        status: async (ctx: any, next: any) => {
          ctx.body = await this.buildStatus();
          await next();
        },
        apply: async (ctx: any, next: any) => {
          const values = ctx.action.params.values || {};
          try {
            ctx.body = await this.apply(values, ctx.state?.currentUser);
          } catch (error: any) {
            ctx.throw(error.status || 500, error.message);
          }
          await next();
        },
        selftest: async (ctx: any, next: any) => {
          ctx.body = await this.selfTest();
          await next();
        },
        whoami: async (ctx: any, next: any) => {
          ctx.body = this.identity();
          await next();
        },
      },
    });

    this.bindIpc();

    if (isClusterMode()) {
      // Cross-worker self-test endpoints: every worker listens, the initiator checks who answered.
      await this.app.pubSubManager.subscribe(SELFTEST_CHANNEL, (message: any) => this.onSelfTestMessage(message));
      this.app.eventQueue.subscribe(SELFTEST_QUEUE, {
        concurrency: 4,
        idle: () => true,
        process: async (message: any) => this.onSelfTestQueue(message),
      });
    }

    this.app.on('afterStart', async () => {
      this.loopDelay.enable();
      if (isClusterMode() && redisUrl()) {
        await this.startHeartbeat();
      }
    });
    this.app.on('beforeStop', async () => {
      await this.stopHeartbeat();
      this.loopDelay.disable();
    });
  }

  // ------------------------------------------------------------------ identity / heartbeat

  private identity() {
    return {
      pid: process.pid,
      ppid: process.ppid,
      slot: process.env.MULTICORE_SLOT ?? null,
      instanceId: (this.app as any).instanceId ?? null,
      hostname: os.hostname(),
      mode: process.env.MULTICORE_MODE || 'single',
      supervised: process.env.MULTICORE_SUPERVISED === '1',
      startedAt: this.startedAt,
      uptimeSec: Math.round(process.uptime()),
      time: new Date().toISOString(),
    };
  }

  private sample() {
    const now = Date.now();
    const cpu = process.cpuUsage(this.lastCpu);
    const elapsedMs = Math.max(1, now - this.lastCpuAt);
    this.lastCpu = process.cpuUsage();
    this.lastCpuAt = now;
    const mem = process.memoryUsage();
    const lag = this.loopDelay.count ? this.loopDelay.percentile(99) / 1e6 : 0;
    this.loopDelay.reset();
    return {
      ...this.identity(),
      cpuPercent: Math.round(((cpu.user + cpu.system) / 1000 / elapsedMs) * 1000) / 10,
      rssMb: Math.round(mem.rss / 1048576),
      heapMb: Math.round(mem.heapUsed / 1048576),
      loopLagMs: Math.round(lag * 10) / 10,
      beatAt: now,
    };
  }

  private async getRedis() {
    if (!this.redis?.isOpen) {
      this.redis = await (this.app as any).redisConnectionManager.getConnectionSync('mcore:manager');
    }
    return this.redis;
  }

  private workerKey() {
    return `${keyPrefix()}:workers:${process.pid}`;
  }

  private async beat() {
    try {
      const redis = await this.getRedis();
      await redis.set(this.workerKey(), JSON.stringify(this.sample()), { PX: HEARTBEAT_TTL });
    } catch (error: any) {
      this.app.logger.warn(`[multicore] heartbeat failed: ${error?.message}`);
    }
  }

  private async startHeartbeat() {
    await this.beat();
    this.heartbeatTimer = setInterval(() => this.beat(), HEARTBEAT_EVERY);
    this.heartbeatTimer.unref?.();
  }

  private async stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    try {
      if (this.redis?.isOpen) await this.redis.del(this.workerKey());
    } catch (e) {
      // expires on its own
    }
  }

  private async listWorkers(): Promise<any[]> {
    if (!isClusterMode() || !redisUrl()) return [this.sample()];
    const redis = await this.getRedis();
    const keys: string[] = [];
    for await (const batch of redis.scanIterator({ MATCH: `${keyPrefix()}:workers:*`, COUNT: 100 })) {
      keys.push(...(Array.isArray(batch) ? batch : [batch]));
    }
    if (!keys.length) return [this.sample()];
    const values = await redis.mGet(keys);
    const workers = values
      .filter(Boolean)
      .map((v: string) => {
        try {
          return JSON.parse(v);
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);
    workers.sort((a: any, b: any) => Number(a.slot ?? 0) - Number(b.slot ?? 0) || a.pid - b.pid);
    return workers;
  }

  // ------------------------------------------------------------------ supervisor IPC

  private bindIpc() {
    if (this.ipcBound || typeof process.send !== 'function') return;
    this.ipcBound = true;
    process.on('message', (message: any) => {
      if (!message || message.cmd !== 'multicore' || !message.reqId) return;
      const pending = this.pending.get(message.reqId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.reqId);
      pending.resolve(message);
    });
  }

  private askSupervisor(type: 'status' | 'apply', timeoutMs = 2500): Promise<any | null> {
    if (typeof process.send !== 'function' || process.env.MULTICORE_SUPERVISED !== '1') return Promise.resolve(null);
    const reqId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        resolve(null);
      }, timeoutMs);
      this.pending.set(reqId, { resolve, timer });
      try {
        process.send!({ cmd: 'multicore', type, reqId });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(reqId);
        resolve(null);
      }
    });
  }

  // ------------------------------------------------------------------ status

  private pluginState(packageName: string): 'enabled' | 'disabled' | 'missing' {
    const plugins: Map<string, any> = (this.app.pm as any).getPlugins?.() || new Map();
    for (const plugin of plugins.values()) {
      const name = plugin?.options?.packageName || plugin?.name;
      if (name === packageName || plugin?.name === packageName) return plugin.enabled ? 'enabled' : 'disabled';
    }
    return 'missing';
  }

  private async redisHealth() {
    if (!redisUrl()) return { configured: false, ok: false, error: 'REDIS_URL is not set' };
    try {
      const redis = await this.getRedis();
      const started = process.hrtime.bigint();
      await redis.ping();
      const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;
      const info: string = await redis.info('server');
      const version = /redis_version:(\S+)/.exec(info)?.[1];
      return { configured: true, ok: true, latencyMs: Math.round(latencyMs * 100) / 100, version };
    } catch (error: any) {
      return { configured: true, ok: false, error: error?.message };
    }
  }

  private adapters() {
    const app: any = this.app;
    return {
      pubsub: { plugin: this.pluginState(ADAPTER_PLUGINS.pubsub), active: app.pubSubManager?.adapter?.kind === 'redis' },
      lock: {
        plugin: this.pluginState(ADAPTER_PLUGINS.lock),
        active: app.lockManager?.options?.defaultAdapter === 'redis',
      },
      queue: { plugin: this.pluginState(ADAPTER_PLUGINS.queue), active: app.eventQueue?.adapter?.kind === 'redis' },
      workerId: {
        plugin: this.pluginState(ADAPTER_PLUGINS.workerId),
        // really in effect: the redis adapter holds a lease AND the core uses exactly that id for snowflake ids
        active:
          app.workerIdAllocator?.adapter?.kind === 'redis' &&
          app.workerIdAllocator.adapter.currentId != null &&
          app.workerIdAllocator.adapter.currentId === app.instanceId,
      },
      cache: { active: (app.cacheManager?.defaultStore || process.env.CACHE_DEFAULT_STORE) === 'redis' },
    };
  }

  private async buildStatus() {
    const [redis, workers, supervisorReply] = await Promise.all([
      this.redisHealth(),
      this.listWorkers().catch((error) => {
        this.app.logger.warn(`[multicore] cannot list workers: ${error?.message}`);
        return [this.sample()];
      }),
      this.askSupervisor('status'),
    ]);
    let supervisor = supervisorReply?.data || null;
    if (!supervisor) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        supervisor = { ...JSON.parse(require('node:fs').readFileSync(cfg.statusPath(), 'utf8')), stale: true };
      } catch (e) {
        supervisor = null;
      }
    }
    // A worker replaced during a mode switch keeps its temporary slot id (1000+n) in its env; the supervisor knows the real one.
    const slotByPid = new Map<number, number>((supervisor?.workers || []).map((w: any) => [w.pid, w.slot]));
    const loadBySlot = new Map<number, any>(((supervisor as any)?.balancer?.upstreams || []).map((u: any) => [u.slot, u]));
    for (const worker of workers as any[]) {
      if (slotByPid.has(worker.pid)) worker.slot = String(slotByPid.get(worker.pid));
      const load = loadBySlot.get(Number(worker.slot));
      if (load) {
        worker.inflight = load.inflight;
        worker.served = load.served;
        worker.stalled = load.stalled;
      }
    }
    workers.sort((a: any, b: any) => Number(a.slot ?? 0) - Number(b.slot ?? 0) || a.pid - b.pid);
    const config = cfg.readConfig();
    return {
      self: this.identity(),
      cpus: os.cpus().length,
      maxWorkers: cfg.maxWorkers(),
      supervised: process.env.MULTICORE_SUPERVISED === '1',
      clusterModeActive: isClusterMode(),
      config,
      redis,
      adapters: this.adapters(),
      supervisor,
      workers,
      serverTime: new Date().toISOString(),
    };
  }

  // ------------------------------------------------------------------ apply

  private async apply(values: { enabled?: boolean; workers?: number }, user: any) {
    const enabled = Boolean(values.enabled);
    const workers = cfg.clampWorkers(values.workers ?? 1);
    const problems: string[] = [];
    if (enabled) {
      const health = await this.redisHealth();
      if (!health.ok) problems.push(`Redis is not available: ${health.error}`);
      for (const [key, packageName] of Object.entries(ADAPTER_PLUGINS)) {
        const state = this.pluginState(packageName);
        if (state !== 'enabled') problems.push(`Plugin ${packageName} (${key}) is ${state}`);
      }
      if (process.env.MULTICORE_SUPERVISED !== '1') {
        problems.push('The application is not running under nocobase-multicore (see docs/OPERATIONS.md)');
      }
    }
    if (problems.length) {
      const error: any = new Error(problems.join('; '));
      error.status = 400;
      throw error;
    }
    const saved = cfg.writeConfig({ enabled, workers, updatedBy: user?.username || user?.nickname || user?.id || null });
    this.app.logger.info(`[multicore] config saved: ${JSON.stringify(saved)}`);
    const ack = await this.askSupervisor('apply');
    return {
      config: saved,
      applied: Boolean(ack),
      message: ack
        ? 'Supervisor notified: workers are being started/stopped (rolling, a few seconds to a minute).'
        : 'Config saved, but the supervisor did not answer. It re-reads the config within ~10 seconds (or on SIGHUP).',
    };
  }

  // ------------------------------------------------------------------ distributed self test

  private async onSelfTestMessage(message: any) {
    if (!message?.testId) return;
    const redis = await this.getRedis();
    const hash = `${keyPrefix()}:st:${message.testId}`;
    const me = String(process.pid);
    if (message.kind === 'ping') {
      await redis.hSet(hash, `ping:${me}`, '1');
    } else if (message.kind === 'lock') {
      try {
        const lock = await (this.app as any).lockManager.tryAcquire(`multicore:selftest:${message.testId}`, 0);
        await redis.hSet(hash, `lockleak:${me}`, '1'); // acquired although the initiator still holds it: BAD
        await lock.release();
      } catch (error) {
        await redis.hSet(hash, `lockblocked:${me}`, '1'); // expected
      }
    }
    await redis.pExpire(hash, 120_000);
  }

  private async onSelfTestQueue(message: any) {
    const redis = await this.getRedis();
    const hash = `${keyPrefix()}:st:${message.testId}`;
    await redis.hIncrBy(hash, `q:${message.n}`, 1);
    await redis.hSet(hash, `qw:${message.n}`, String(process.pid));
    await redis.pExpire(hash, 120_000);
  }

  private async selfTest() {
    if (!isClusterMode()) {
      return { ok: false, reason: 'Cluster mode is not active in this process (MULTICORE_MODE != cluster)' };
    }
    const redis = await this.getRedis();
    const app: any = this.app;
    const testId = randomUUID().slice(0, 8);
    const hash = `${keyPrefix()}:st:${testId}`;
    const workers = await this.listWorkers();
    const expected = workers.length;
    const result: any = { testId, workers: expected, checks: {} };

    // 1) pub/sub reaches every worker
    await app.pubSubManager.publish(SELFTEST_CHANNEL, { testId, kind: 'ping' });
    // 2) a lock held here is invisible-proof: nobody else may take it
    const lock = await app.lockManager.tryAcquire(`multicore:selftest:${testId}`, 0);
    await app.pubSubManager.publish(SELFTEST_CHANNEL, { testId, kind: 'lock' });
    await sleep(1500);
    await lock.release();
    // 3) a queue message is processed exactly once cluster-wide
    const total = 20;
    for (let n = 0; n < total; n += 1) {
      await app.eventQueue.publish(SELFTEST_QUEUE, { testId, n });
    }
    const deadline = Date.now() + 8000;
    let all: Record<string, string> = {};
    do {
      await sleep(250);
      all = await redis.hGetAll(hash);
    } while (Date.now() < deadline && Object.keys(all).filter((k) => k.startsWith('q:')).length < total);

    const count = (prefix: string) => Object.keys(all).filter((k) => k.startsWith(prefix)).length;
    const processed = Object.keys(all).filter((k) => k.startsWith('q:'));
    const duplicates = processed.filter((k) => Number(all[k]) > 1).length;
    const byWorker: Record<string, number> = {};
    for (let n = 0; n < total; n += 1) {
      const w = all[`qw:${n}`];
      if (w) byWorker[w] = (byWorker[w] || 0) + 1;
    }
    result.checks.pubsub = { expected, received: count('ping:'), ok: count('ping:') === expected };
    result.checks.lock = {
      expectedBlocked: Math.max(0, expected - 1),
      blocked: count('lockblocked:') - (all[`lockblocked:${process.pid}`] ? 1 : 0),
      leaked: count('lockleak:'),
      ok: count('lockleak:') === 0 && count('lockblocked:') - (all[`lockblocked:${process.pid}`] ? 1 : 0) === Math.max(0, expected - 1),
    };
    result.checks.queue = {
      published: total,
      processed: processed.length,
      duplicates,
      byWorker,
      ok: processed.length === total && duplicates === 0,
    };
    // 4) every worker has its own snowflake worker id (otherwise two workers can create the same primary key)
    const ids = workers.map((w: any) => w?.instanceId ?? w?.identity?.instanceId ?? null);
    result.checks.workerIds = {
      ids,
      distinct: new Set(ids.filter((v: any) => v !== null)).size,
      ok: ids.every((v: any) => v !== null) && new Set(ids).size === ids.length,
    };
    result.ok = Object.values(result.checks).every((c: any) => c.ok);
    await redis.del(hash);
    return result;
  }
}

export default PluginMulticore;
