import { randomUUID } from 'node:crypto';
import { Plugin } from '@nocobase/server';
import { keyPrefix, skipReason, sleep } from '../../../shared/src/env';
import { turnOffClusterMode } from '../../../shared/src/safeguard';

const SLOTS = 32; // NocoBase falls back to Math.random()*32, so ids live in [0, 32)
// Long enough to survive a few seconds of event-loop stall or a short Redis hiccup; a crashed process frees its id after this time.
const LEASE_MS = 60_000;
const RENEW_MS = 10_000;
const EXTEND_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/**
 * WorkerIdAllocatorAdapter: gives every process a unique snowflake worker id in [0, 32).
 * Without it each process picks a random id and two processes can collide, producing duplicate primary keys.
 * The id is a Redis lease renewed every 10s; a crashed process frees its id after 60s.
 * If the lease is lost (expired during a long stall, Redis restart/flush) the allocator first tries to take the SAME id back;
 * if another process already owns it, a supervised worker exits so the supervisor respawns it with a fresh id.
 *
 * Two things keep that last case from happening inside one supervisor: every worker tells the supervisor which id it
 * holds, and the supervisor passes the ids of the live workers to each new worker (MULTICORE_WID_AVOID), which then
 * leaves them alone even when their lease has run out in Redis (the owner is stuck in a long event-loop stall and
 * will renew as soon as it wakes up).
 */
export class RedisWorkerIdAllocator {
  readonly kind = 'redis';
  private client: any;
  private token = randomUUID();
  private id: number | null = null;
  private timer?: NodeJS.Timeout;

  constructor(private app: any) {}

  /** The id currently leased by this process (null until the core asked for it). */
  get currentId(): number | null {
    return this.id;
  }

  /** The Application object is re-initialised on every reload(); the lease (and its id) must survive that. */
  rebind(app: any) {
    this.app = app;
    this.client = undefined;
    if (this.id !== null) this.report();
  }

  private async getClient() {
    if (!this.client?.isOpen) {
      this.client = await this.app.redisConnectionManager.getConnectionSync('mcore:wid');
    }
    return this.client;
  }

  private key(id: number) {
    return `${keyPrefix()}:wid:${id}`;
  }

  /** Ids held by the other live workers of this supervisor (see the class comment). */
  private avoided(): Set<number> {
    const out = new Set<number>();
    for (const part of String(process.env.MULTICORE_WID_AVOID || '').split(',')) {
      const n = Number(part);
      if (part.trim() !== '' && Number.isInteger(n) && n >= 0 && n < SLOTS) out.add(n);
    }
    return out;
  }

  /** Tell the supervisor which id this process holds, so that workers started later keep away from it. */
  private report() {
    if (process.env.MULTICORE_SUPERVISED !== '1' || typeof process.send !== 'function') return;
    try {
      process.send({ cmd: 'multicore', type: 'wid', id: this.id });
    } catch (e) {
      // supervisor gone
    }
  }

  async getWorkerId(): Promise<number> {
    if (this.id !== null) return this.id;
    const client = await this.getClient();
    const avoid = this.avoided();
    const start = Math.floor(Math.random() * SLOTS);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      for (let i = 0; i < SLOTS; i += 1) {
        const id = (start + i) % SLOTS;
        // an id of a live sibling is only considered when nothing else has been free for a while
        if (avoid.has(id) && attempt < 10) continue;
        const ok = await client.set(this.key(id), this.token, { NX: true, PX: LEASE_MS });
        if (ok === 'OK') {
          this.id = id;
          this.timer = setInterval(() => this.renew().catch(() => undefined), RENEW_MS);
          this.timer.unref?.();
          this.app.logger.info(`[multicore] worker id ${id} leased`);
          this.report();
          return id;
        }
      }
      await sleep(this.retryDelayMs); // every id is taken (stale leases expire after 60 s) - wait and retry
    }
    throw new Error(`[multicore] no free worker id in Redis (${SLOTS} processes are already running?)`);
  }

  /** Overridable for tests. */
  protected retryDelayMs = 1500;

  /** Overridable for tests. */
  protected terminate(code = 1) {
    process.exit(code);
  }

  private renewing?: Promise<void>;

  /**
   * After a long event-loop stall several interval ticks can be queued; they must not run concurrently
   * (one would reclaim the id, the next would then see "someone owns it" - and that someone is ourselves).
   */
  renew(): Promise<void> {
    if (!this.renewing) {
      this.renewing = this.doRenew().finally(() => {
        this.renewing = undefined;
      });
    }
    return this.renewing;
  }

  private async doRenew() {
    if (this.id === null) return;
    const client = await this.getClient();
    const key = this.key(this.id);
    const ok = await client.eval(EXTEND_SCRIPT, { keys: [key], arguments: [this.token, String(LEASE_MS)] });
    if (Number(ok) === 1) return;
    // Lease lost. Nobody else may be using the id: try to take it back (NX = only if still free).
    const reclaimed = await client.set(key, this.token, { NX: true, PX: LEASE_MS });
    if (reclaimed === 'OK') {
      this.app.logger.warn(`[multicore] worker id ${this.id} lease had expired; reclaimed the same id`);
      return;
    }
    // The key may already hold OUR token (set by an earlier renew/reclaim): that is not a conflict.
    if ((await client.get(key)) === this.token) {
      await client.eval(EXTEND_SCRIPT, { keys: [key], arguments: [this.token, String(LEASE_MS)] });
      return;
    }
    // Another process owns our id now: two processes would generate colliding primary keys. Stop being a worker.
    if (process.env.MULTICORE_SUPERVISED === '1') {
      this.app.logger.error(`[multicore] worker id ${this.id} is now owned by another process: exiting so the supervisor starts a fresh worker`);
      this.terminate(1);
    } else {
      this.app.logger.error(`[multicore] worker id ${this.id} is now owned by another process: restart this process to obtain a new id`);
    }
  }

  /**
   * Called by the core on every Application.stop(), which also happens on a plain app reload (e.g. after enabling
   * a plugin) while the process - and the snowflake generator that already uses this id - keeps running.
   * Dropping the lease here would let another worker take the same id. So the lease is kept and renewed for as long
   * as the process lives; when the process exits the lease simply expires (60 s).
   */
  async release(): Promise<void> {
    return;
  }
}

export class PluginWorkerIdAllocatorRedis extends Plugin {
  async beforeDisable() {
    turnOffClusterMode(this.app, 'plugin plugin-worker-id-allocator-redis is being disabled');
  }

  async beforeRemove() {
    turnOffClusterMode(this.app, 'plugin plugin-worker-id-allocator-redis is being removed');
  }

  /**
   * Must be done in afterAdd(): Application.load() initialises the plugins (afterAdd) and then immediately asks
   * workerIdAllocator for the id. Plugin.beforeLoad() runs later (inside pm.load()), i.e. too late - the core would
   * already have picked a random id and two workers could collide ("id must be unique" on insert).
   */
  async afterAdd() {
    const reason = skipReason();
    if (reason) {
      this.app.logger.info(`[multicore] worker-id allocator not activated: ${reason}`);
      return;
    }
    const holder = globalThis as any;
    if (!holder.__mcoreWorkerId) holder.__mcoreWorkerId = new RedisWorkerIdAllocator(this.app);
    else holder.__mcoreWorkerId.rebind(this.app);
    this.app.workerIdAllocator.setAdapter(holder.__mcoreWorkerId);
  }
}

export default PluginWorkerIdAllocatorRedis;
