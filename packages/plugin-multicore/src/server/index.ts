import { randomUUID } from 'node:crypto';
import os from 'node:os';
import v8 from 'node:v8';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Gateway, Plugin } from '@nocobase/server';
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
/** At most this many signed-in users of one worker are published for the "who is connected" window. */
const MAX_LISTED_USERS = 3000;
const PROFILE_TTL = 60_000;

type Pending = { resolve: (value: any) => void; timer: NodeJS.Timeout };
/** One signed-in user on one worker: [userId, open tabs (WebSocket connections), connected since (ms), client IP]. */
type UserRow = [number | string, number, number, string];
type Connections = { pid: number; slot: string | null; at: number; clients: number; anonymous: number; users: UserRow[]; truncated?: boolean };

export class PluginMulticore extends Plugin {
  async beforeDisable() {
    turnOffClusterMode(this.app, 'plugin plugin-multicore is being disabled');
  }

  async beforeRemove() {
    turnOffClusterMode(this.app, 'plugin plugin-multicore is being removed');
  }

  private redis: any;
  private redisVersion?: string;
  private heartbeatTimer?: NodeJS.Timeout;
  private loopDelay = monitorEventLoopDelay({ resolution: 20 });
  private lastCpu = process.cpuUsage();
  private lastCpuAt = Date.now();
  private startedAt = new Date().toISOString();
  private pending = new Map<string, Pending>();
  private ipcBound = false;
  /** WebSocket client id -> when this process first saw it (the gateway does not keep a connect time). */
  private firstSeen = new Map<string, number>();
  private profiles = new Map<string, { nickname?: string; username?: string; at: number }>();

  // ------------------------------------------------------------------ lifecycle

  async afterAdd() {}

  async beforeLoad() {}

  async load() {
    this.app.acl.registerSnippet({ name: 'pm.multicore', actions: ['multicore:*'] });
    const guarded = (fn: (ctx: any) => Promise<any>) => async (ctx: any, next: any) => {
      try {
        ctx.body = await fn(ctx);
      } catch (error: any) {
        ctx.throw(error.status || 500, error.message);
      }
      await next();
    };
    this.app.resourceManager.define({
      name: 'multicore',
      actions: {
        status: guarded(() => this.buildStatus()),
        apply: guarded((ctx) => this.apply(ctx.action.params.values || {}, ctx.state?.currentUser)),
        selftest: guarded(() => this.selfTest()),
        whoami: guarded(async () => this.identity()),
        // who is connected (WebSocket = an open browser tab) to one worker (?slot=N) or to all of them
        // (&summary=1: only the totals, no user names - cheap enough to poll)
        connections: guarded((ctx) =>
          this.connections(ctx.action.params.slot ?? ctx.action.params.values?.slot, Boolean(ctx.action.params.summary ?? ctx.action.params.values?.summary)),
        ),
        // zero-downtime restart of one worker ({slot: N}) or of all workers one after another ({slot: 'all'})
        restart: guarded((ctx) => this.restart(ctx.action.params.values?.slot ?? ctx.action.params.slot, ctx.state?.currentUser)),
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

  /**
   * Browser tabs connected to THIS process. NocoBase keeps every WebSocket client of the gateway in a map and the
   * auth plugin tags a signed-in one with `userId#<id>`; nothing is added to the connections themselves.
   */
  private collectConnections(): Connections {
    const now = Date.now();
    const out: Connections = { pid: process.pid, slot: process.env.MULTICORE_SLOT ?? null, at: now, clients: 0, anonymous: 0, users: [] };
    let clients: Map<string, any> | undefined;
    try {
      clients = (Gateway as any).getInstance()?.wsServer?.webSocketClients;
    } catch (e) {
      clients = undefined;
    }
    if (!clients || typeof clients.values !== 'function') return out;
    const byUser = new Map<string, UserRow>();
    const alive = new Set<string>();
    for (const client of clients.values()) {
      if (!client) continue;
      if (client.app && client.app !== this.app.name) continue; // a sub-application's client
      out.clients += 1;
      const id = String(client.id);
      alive.add(id);
      let since = this.firstSeen.get(id);
      if (!since) {
        since = now;
        this.firstSeen.set(id, since);
      }
      let userId: string | null = null;
      for (const tag of client.tags || []) {
        if (typeof tag === 'string' && tag.startsWith('userId#')) userId = tag.slice(7);
      }
      if (userId === null) {
        out.anonymous += 1;
        continue;
      }
      const forwarded = client.headers?.['x-forwarded-for'];
      const ip = forwarded ? String(forwarded).split(',')[0].trim() : '';
      const row = byUser.get(userId);
      if (row) {
        row[1] += 1;
        if (since < row[2]) row[2] = since;
      } else {
        byUser.set(userId, [/^\d+$/.test(userId) ? Number(userId) : userId, 1, since, ip]);
      }
    }
    for (const id of this.firstSeen.keys()) if (!alive.has(id)) this.firstSeen.delete(id);
    out.users = [...byUser.values()];
    if (out.users.length > MAX_LISTED_USERS) {
      out.users.length = MAX_LISTED_USERS;
      out.truncated = true;
    }
    return out;
  }

  private sample(connections: Connections = this.collectConnections()) {
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
      heapLimitMb: Math.round(v8.getHeapStatistics().heap_size_limit / 1048576),
      loopLagMs: Math.round(lag * 10) / 10,
      wsClients: connections.clients,
      wsUsers: connections.users.length,
      wsAnonymous: connections.anonymous,
      beatAt: now,
    };
  }

  private async getRedis() {
    if (!this.redis?.isOpen) {
      this.redis = await (this.app as any).redisConnectionManager.getConnectionSync('mcore:manager');
    }
    return this.redis;
  }

  private workerKey(pid: number | string = process.pid) {
    return `${keyPrefix()}:workers:${pid}`;
  }

  /** Sorted set "pid -> time of its last heartbeat": the list of workers without scanning the whole keyspace. */
  private indexKey() {
    return `${keyPrefix()}:workers:index`;
  }

  private connKey(pid: number | string = process.pid) {
    return `${keyPrefix()}:conn:${pid}`;
  }

  private async beat() {
    try {
      const redis = await this.getRedis();
      const connections = this.collectConnections();
      const sample = this.sample(connections);
      const now = sample.beatAt;
      // issued in the same tick: node-redis sends them as one pipeline
      await Promise.all([
        redis.set(this.workerKey(), JSON.stringify(sample), { PX: HEARTBEAT_TTL }),
        redis.set(this.connKey(), JSON.stringify(connections), { PX: HEARTBEAT_TTL }),
        redis.zAdd(this.indexKey(), { score: now, value: String(process.pid) }),
        redis.zRemRangeByScore(this.indexKey(), 0, now - HEARTBEAT_TTL * 3),
        redis.pExpire(this.indexKey(), HEARTBEAT_TTL * 6),
      ]);
    } catch (error: any) {
      this.app.logger.warn(`[multicore] heartbeat failed: ${error?.message}`);
    }
  }

  private async startHeartbeat() {
    await this.beat();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => this.beat(), HEARTBEAT_EVERY);
    this.heartbeatTimer.unref?.();
  }

  private async stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    try {
      if (this.redis?.isOpen) {
        await Promise.all([
          this.redis.del([this.workerKey(), this.connKey()]),
          this.redis.zRem(this.indexKey(), String(process.pid)),
        ]);
      }
    } catch (e) {
      // expires on its own
    }
  }

  private parse(values: (string | null)[]): any[] {
    const out: any[] = [];
    for (const value of values) {
      if (!value) continue;
      try {
        out.push(JSON.parse(value));
      } catch (e) {
        // skip a damaged entry
      }
    }
    return out;
  }

  /** Pids of the workers that sent a heartbeat recently. */
  private async livePids(redis: any): Promise<string[]> {
    return redis.zRangeByScore(this.indexKey(), Date.now() - HEARTBEAT_TTL, '+inf');
  }

  private async listWorkers(): Promise<any[]> {
    if (!isClusterMode() || !redisUrl()) return [this.sample()];
    const redis = await this.getRedis();
    const pids = await this.livePids(redis);
    if (!pids.length) return [this.sample()];
    const workers = this.parse(await redis.mGet(pids.map((pid) => this.workerKey(pid))));
    if (!workers.length) return [this.sample()];
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

  private supervised() {
    return typeof process.send === 'function' && process.env.MULTICORE_SUPERVISED === '1';
  }

  private askSupervisor(type: 'status' | 'apply' | 'restart', payload: Record<string, any> = {}, timeoutMs = 2500): Promise<any | null> {
    if (!this.supervised()) return Promise.resolve(null);
    const reqId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        resolve(null);
      }, timeoutMs);
      this.pending.set(reqId, { resolve, timer });
      try {
        process.send!({ ...payload, cmd: 'multicore', type, reqId });
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
      if (!this.redisVersion) {
        const info: string = await redis.info('server');
        this.redisVersion = /redis_version:(\S+)/.exec(info)?.[1];
      }
      return { configured: true, ok: true, latencyMs: Math.round(latencyMs * 100) / 100, version: this.redisVersion };
    } catch (error: any) {
      return { configured: true, ok: false, error: error?.message };
    }
  }

  /**
   * Database connection budget. Every worker has its own pool (DB_POOL_MAX), and during a rolling restart one extra
   * worker runs next to the old ones; if that adds up to more than the database accepts, requests start failing with
   * "too many clients" exactly when the load is high. Read once in a while, never on the hot path.
   */
  private dbBudget: { at: number; value: any } | null = null;

  private async databaseBudget() {
    const now = Date.now();
    if (this.dbBudget && now - this.dbBudget.at < 300_000) return this.dbBudget.value;
    const value: any = { dialect: null, poolMax: null, maxConnections: null };
    try {
      const sequelize: any = (this.db as any)?.sequelize;
      value.dialect = sequelize?.getDialect?.() || process.env.DB_DIALECT || null;
      const poolMax = Number(sequelize?.options?.pool?.max ?? process.env.DB_POOL_MAX);
      value.poolMax = Number.isFinite(poolMax) && poolMax > 0 ? poolMax : null;
      if (value.dialect === 'postgres') {
        const [rows] = await sequelize.query('SHOW max_connections');
        value.maxConnections = Number(rows?.[0]?.max_connections) || null;
      } else if (value.dialect === 'mysql' || value.dialect === 'mariadb') {
        const [rows] = await sequelize.query("SHOW VARIABLES LIKE 'max_connections'");
        value.maxConnections = Number(rows?.[0]?.Value) || null;
      }
    } catch (error: any) {
      this.app.logger.debug?.(`[multicore] cannot read the database connection limit: ${error?.message}`);
    }
    this.dbBudget = { at: now, value };
    return value;
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

  /**
   * One row per worker. The supervisor is the authority on which workers exist (a worker whose event loop is blocked
   * for a long time stops sending heartbeats to Redis, but it is still there and must stay in the table); Redis
   * heartbeats add what only the worker itself knows (CPU, memory, connections).
   */
  private mergeWorkers(beats: any[], supervisor: any) {
    const now = Date.now();
    const beatByPid = new Map<number, any>(beats.map((b) => [b.pid, b]));
    const loadBySlot = new Map<number, any>((supervisor?.balancer?.upstreams || []).map((u: any) => [u.slot, u]));
    const rows: any[] = [];
    if (supervisor?.workers?.length) {
      for (const w of supervisor.workers) {
        const beat = beatByPid.get(w.pid);
        beatByPid.delete(w.pid);
        const replacement = w.slot >= 1000;
        const load = loadBySlot.get(w.slot) || {};
        rows.push({
          ...(beat || {}),
          pid: w.pid,
          slot: String(replacement ? w.slot - 1000 : w.slot),
          replacement,
          state: w.state,
          mode: w.mode,
          uptimeSec: beat?.uptimeSec ?? Math.max(0, Math.round((now - Date.parse(w.startedAt)) / 1000)),
          restarts: w.restarts || 0,
          stalls: w.stalls || 0,
          lastStall: w.lastStall || null,
          lastExit: w.lastExit || null,
          silentMs: w.silentMs || 0,
          stalled: Boolean(load.stalled) || (w.state === 'listening' && w.silentMs > 5000),
          heapLimitCfgMb: w.heapMb || 0,
          inflight: load.inflight ?? null,
          served: load.served ?? null,
          failed: load.failed ?? null,
          avgMs: load.avgMs ?? null,
          websockets: load.websockets ?? null,
          noHeartbeat: !beat,
        });
      }
    }
    // not supervised (or the supervisor did not answer and there is no status file): whatever Redis knows
    for (const beat of beatByPid.values()) {
      if (supervisor?.workers?.length) continue; // a leftover heartbeat of a worker the supervisor no longer has
      rows.push({ ...beat, slot: String(beat.slot ?? 0), state: 'listening', restarts: 0, stalls: 0 });
    }
    rows.sort((a, b) => Number(a.slot) - Number(b.slot) || Number(a.replacement || 0) - Number(b.replacement || 0) || a.pid - b.pid);
    return rows;
  }

  private async buildStatus() {
    const [redis, database, beats, supervisorReply] = await Promise.all([
      this.redisHealth(),
      this.databaseBudget(),
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
    const workers = this.mergeWorkers(beats, supervisor);
    const config = cfg.readConfig();
    return {
      self: this.identity(),
      cpus: os.cpus().length,
      maxWorkers: cfg.maxWorkers(),
      supervised: process.env.MULTICORE_SUPERVISED === '1',
      clusterModeActive: isClusterMode(),
      config,
      redis,
      database,
      adapters: this.adapters(),
      supervisor,
      workers,
      online: {
        connections: workers.reduce((sum, w) => sum + (w.wsClients || 0), 0),
      },
      serverTime: new Date().toISOString(),
    };
  }

  // ------------------------------------------------------------------ who is connected

  private async userProfiles(ids: (number | string)[]) {
    const now = Date.now();
    const missing = ids.filter((id) => {
      const hit = this.profiles.get(String(id));
      return !hit || now - hit.at > PROFILE_TTL;
    });
    if (missing.length) {
      try {
        const records = await this.db.getRepository('users').find({ filter: { id: { $in: missing } }, fields: ['id', 'nickname', 'username'] });
        for (const record of records) {
          this.profiles.set(String(record.get('id')), { nickname: record.get('nickname'), username: record.get('username'), at: now });
        }
      } catch (error: any) {
        this.app.logger.warn(`[multicore] cannot load user names: ${error?.message}`);
      }
      for (const id of missing) if (!this.profiles.has(String(id))) this.profiles.set(String(id), { at: now });
      if (this.profiles.size > 20_000) this.profiles.clear();
    }
    return this.profiles;
  }

  /** Users connected to one worker (slot given) or to the whole cluster: every worker publishes its own list. */
  private async connections(slotParam: any, summaryOnly = false) {
    let lists: Connections[];
    if (isClusterMode() && redisUrl()) {
      const redis = await this.getRedis();
      const pids = await this.livePids(redis);
      lists = pids.length ? this.parse(await redis.mGet(pids.map((pid) => this.connKey(pid)))) : [];
    } else {
      lists = [this.collectConnections()];
    }
    // the supervisor knows the real slot of a worker that was started as a replacement (temporary id 1000+n)
    const supervisor = (await this.askSupervisor('status'))?.data;
    const slotByPid = new Map<number, number>((supervisor?.workers || []).map((w: any) => [w.pid, w.slot >= 1000 ? w.slot - 1000 : w.slot]));
    for (const list of lists) {
      const raw = slotByPid.has(list.pid) ? slotByPid.get(list.pid) : Number(list.slot ?? 0);
      list.slot = String(Number(raw) >= 1000 ? Number(raw) - 1000 : raw);
    }
    const wanted = slotParam === undefined || slotParam === null || slotParam === '' || slotParam === 'all' ? null : String(slotParam);
    const selected = wanted === null ? lists : lists.filter((l) => l.slot === wanted);

    const byUser = new Map<string, any>();
    for (const list of selected) {
      for (const [id, tabs, since, ip] of list.users) {
        const key = String(id);
        let user = byUser.get(key);
        if (!user) byUser.set(key, (user = { id, tabs: 0, since, ip, workers: [] }));
        user.tabs += tabs;
        if (since < user.since) user.since = since;
        if (!user.ip && ip) user.ip = ip;
        user.workers.push({ slot: list.slot, tabs });
      }
    }
    const totals = {
      users: byUser.size,
      connections: selected.reduce((sum, l) => sum + l.clients, 0),
      anonymous: selected.reduce((sum, l) => sum + l.anonymous, 0),
    };
    if (summaryOnly) return { slot: wanted, updatedAt: new Date().toISOString(), totals };
    const profiles = await this.userProfiles([...byUser.values()].map((u) => u.id));
    const users = [...byUser.values()].map((u) => {
      const profile = profiles.get(String(u.id));
      return { ...u, nickname: profile?.nickname || null, username: profile?.username || null, since: new Date(u.since).toISOString() };
    });
    users.sort((a, b) => String(a.nickname || a.username || a.id).localeCompare(String(b.nickname || b.username || b.id)));
    return {
      slot: wanted,
      updatedAt: new Date().toISOString(),
      totals,
      workers: selected
        .map((l) => ({ slot: l.slot, pid: l.pid, connections: l.clients, users: l.users.length, anonymous: l.anonymous, truncated: Boolean(l.truncated) }))
        .sort((a, b) => Number(a.slot) - Number(b.slot)),
      users,
    };
  }

  // ------------------------------------------------------------------ apply / restart

  private who(user: any) {
    return user?.username || user?.nickname || user?.id || null;
  }

  private fail(status: number, message: string): never {
    const error: any = new Error(message);
    error.status = status;
    throw error;
  }

  private async apply(values: { enabled?: boolean; workers?: number; affinity?: string; heapMb?: number }, user: any) {
    const enabled = Boolean(values.enabled);
    const workers = cfg.clampWorkers(values.workers ?? 1);
    const affinity = cfg.normalizeAffinity(values.affinity);
    const current = cfg.readConfig();
    const heapMb = values.heapMb === undefined ? current.heapMb : cfg.normalizeHeapMb(values.heapMb);
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
    if (problems.length) this.fail(400, problems.join('; '));
    const saved = cfg.writeConfig({ enabled, workers, affinity, heapMb, updatedBy: this.who(user) });
    this.app.logger.info(`[multicore] config saved: ${JSON.stringify(saved)}`);
    const ack = await this.askSupervisor('apply', { by: this.who(user) });
    return {
      config: saved,
      applied: Boolean(ack),
      message: ack
        ? 'Supervisor notified: workers are being started/stopped (rolling, a few seconds to a minute).'
        : 'Config saved, but the supervisor did not answer. It re-reads the config within ~10 seconds (or on SIGHUP).',
    };
  }

  /** Rolling (zero-downtime) restart: the supervisor starts a replacement first and only then drains the old worker. */
  private async restart(slotParam: any, user: any) {
    if (!this.supervised()) this.fail(400, 'The application is not running under nocobase-multicore, there is no supervisor to restart workers');
    const slot = slotParam === 'all' ? 'all' : Number(slotParam);
    if (slot !== 'all' && (!Number.isInteger(slot) || slot < 0)) this.fail(400, 'Pass {"slot": <number>} or {"slot": "all"}');
    const ack = await this.askSupervisor('restart', { slot, by: this.who(user) });
    if (!ack) this.fail(504, 'The supervisor did not answer');
    if (!ack.accepted) this.fail(404, `There is no worker in slot ${slot}`);
    this.app.logger.info(`[multicore] restart of ${slot === 'all' ? 'all workers' : `slot ${slot}`} requested by ${this.who(user)}`);
    return { accepted: true, slot };
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
