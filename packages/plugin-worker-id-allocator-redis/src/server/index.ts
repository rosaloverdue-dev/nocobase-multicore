import { randomUUID } from 'node:crypto';
import { Plugin } from '@nocobase/server';
import { keyPrefix, skipReason, sleep } from '../../../shared/src/env';

const SLOTS = 32; // NocoBase falls back to Math.random()*32, so ids live in [0, 32)
const LEASE_MS = 30_000;
const RENEW_MS = 10_000;
const EXTEND_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/**
 * WorkerIdAllocatorAdapter: gives every process a unique snowflake worker id in [0, 32).
 * Without it each process picks a random id and two processes can collide, producing duplicate primary keys.
 * The id is a Redis lease renewed every 10s; a crashed process frees its id after 30s.
 */
export class RedisWorkerIdAllocator {
  readonly kind = 'redis';
  private client: any;
  private token = randomUUID();
  private id: number | null = null;
  private timer?: NodeJS.Timeout;

  constructor(private app: any) {}

  /** The Application object is re-initialised on every reload(); the lease (and its id) must survive that. */
  rebind(app: any) {
    this.app = app;
    this.client = undefined;
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

  async getWorkerId(): Promise<number> {
    if (this.id !== null) return this.id;
    const client = await this.getClient();
    const start = Math.floor(Math.random() * SLOTS);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      for (let i = 0; i < SLOTS; i += 1) {
        const id = (start + i) % SLOTS;
        const ok = await client.set(this.key(id), this.token, { NX: true, PX: LEASE_MS });
        if (ok === 'OK') {
          this.id = id;
          this.timer = setInterval(() => this.renew().catch(() => undefined), RENEW_MS);
          this.timer.unref?.();
          this.app.logger.info(`[multicore] worker id ${id} leased`);
          return id;
        }
      }
      await sleep(1500); // all 32 ids are taken (stale leases expire after 30s) - wait and retry
    }
    throw new Error(`[multicore] no free worker id in Redis (${SLOTS} processes are already running?)`);
  }

  private async renew() {
    if (this.id === null) return;
    const client = await this.getClient();
    const ok = await client.eval(EXTEND_SCRIPT, { keys: [this.key(this.id)], arguments: [this.token, String(LEASE_MS)] });
    if (Number(ok) !== 1) {
      this.app.logger.error(`[multicore] worker id ${this.id} lease was lost: restart this process to obtain a new id`);
    }
  }

  async release(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.id === null || !this.client?.isOpen) return;
    const id = this.id;
    this.id = null;
    try {
      await this.client.eval(RELEASE_SCRIPT, { keys: [this.key(id)], arguments: [this.token] });
    } catch (e) {
      // the lease expires on its own
    }
  }
}

export class PluginWorkerIdAllocatorRedis extends Plugin {
  async beforeLoad() {
    const reason = skipReason();
    if (reason) {
      this.app.logger.info(`[multicore] worker-id allocator not activated: ${reason}`);
      return;
    }
    // Application.load() asks for the id right after the "beforeLoad" event, i.e. after this hook.
    const holder = globalThis as any;
    if (!holder.__mcoreWorkerId) holder.__mcoreWorkerId = new RedisWorkerIdAllocator(this.app);
    else holder.__mcoreWorkerId.rebind(this.app);
    this.app.workerIdAllocator.setAdapter(holder.__mcoreWorkerId);
  }
}

export default PluginWorkerIdAllocatorRedis;
