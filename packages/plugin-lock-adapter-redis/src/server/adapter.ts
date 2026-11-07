import { randomUUID } from 'node:crypto';
import { LockAcquireError } from '@nocobase/lock-manager';
import { keyPrefix, sleep } from '../../../shared/src/env';

const RELEASE_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
const EXTEND_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;

/** TTL of a "reservation" created by tryAcquire() before the caller converts it with acquire()/runExclusive(). */
const RESERVATION_TTL = 60_000;

type Releaser = () => void | Promise<void>;

class RedisLease {
  private timer?: NodeJS.Timeout;
  private released = false;
  lost = false;

  constructor(
    private adapter: RedisLockAdapter,
    readonly key: string,
    readonly token: string,
  ) {}

  /** Keep the lock alive every ttl/3 until release(). Used while a critical section is running. */
  startHeartbeat(ttl: number) {
    this.stopHeartbeat();
    const every = Math.max(250, Math.floor(ttl / 3));
    this.timer = setInterval(() => {
      this.adapter
        .extend(this.key, this.token, ttl)
        .then((ok) => {
          if (!ok && !this.released) {
            this.lost = true;
            this.stopHeartbeat();
            this.adapter.warn(`lock "${this.key}" was lost (expired or taken over) while still in use`);
          }
        })
        .catch(() => undefined);
    }, every);
    this.timer.unref?.();
  }

  stopHeartbeat() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async release() {
    if (this.released) return;
    this.released = true;
    this.stopHeartbeat();
    await this.adapter.unlock(this.key, this.token);
  }
}

/**
 * ILockAdapter backed by Redis (SET NX PX + Lua compare-and-delete). Safe across processes and across hosts.
 * Semantics follow the stock LocalLockAdapter of @nocobase/lock-manager:
 *  - acquire(key, ttl)       waits for the lock; the lease lasts at most `ttl` ms unless released earlier
 *  - runExclusive(key,fn,ttl) waits, runs fn while renewing the lease, always releases
 *  - tryAcquire(key, timeout) returns an ILock "reservation" or throws LockAcquireError
 */
export class RedisLockAdapter {
  /** Marker read by the multicore manager plugin to report which adapter is active. */
  readonly kind = 'redis';

  private client: any;
  private app: any;
  private prefix: string;

  constructor(options: { app: any; prefix?: string }) {
    this.app = options.app;
    this.prefix = options.prefix || keyPrefix();
  }

  warn(message: string) {
    this.app.logger.warn(`[multicore] ${message}`);
  }

  private k(key: string) {
    return `${this.prefix}:lock:${key}`;
  }

  async connect() {
    this.client = await this.app.redisConnectionManager.getConnectionSync('mcore:lock');
  }

  async close() {
    // the shared connection is closed by app.redisConnectionManager
  }

  async extend(key: string, token: string, ttl: number): Promise<boolean> {
    const result = await this.client.eval(EXTEND_SCRIPT, { keys: [this.k(key)], arguments: [token, String(ttl)] });
    return Number(result) === 1;
  }

  async unlock(key: string, token: string) {
    try {
      await this.client.eval(RELEASE_SCRIPT, { keys: [this.k(key)], arguments: [token] });
    } catch (error: any) {
      this.warn(`failed to release lock "${key}": ${error?.message}`);
    }
  }

  /** Try to take the lock until `timeout` ms elapsed (timeout < 0 => wait forever, 0 => single attempt). */
  private async take(key: string, ttl: number, timeout: number): Promise<string | null> {
    const token = randomUUID();
    const deadline = timeout < 0 ? Infinity : Date.now() + timeout;
    let wait = 15;
    for (;;) {
      const ok = await this.client.set(this.k(key), token, { NX: true, PX: ttl });
      if (ok === 'OK') return token;
      if (Date.now() >= deadline) return null;
      await sleep(wait + Math.floor(Math.random() * wait));
      wait = Math.min(wait * 2, 120);
    }
  }

  async acquire(key: string, ttl: number): Promise<Releaser> {
    const token = await this.take(key, ttl, -1);
    return () => this.unlock(key, token as string);
  }

  async runExclusive<T>(key: string, fn: () => Promise<T>, ttl: number): Promise<T> {
    const token = (await this.take(key, ttl, -1)) as string;
    const lease = new RedisLease(this, key, token);
    lease.startHeartbeat(ttl);
    try {
      return await fn();
    } finally {
      await lease.release();
    }
  }

  async tryAcquire(key: string, timeout = 0) {
    const token = await this.take(key, RESERVATION_TTL, timeout);
    if (!token) {
      throw new LockAcquireError(timeout === 0 ? 'lock is locked' : 'lock acquire timed out');
    }
    let lease = new RedisLease(this, key, token);
    lease.startHeartbeat(RESERVATION_TTL); // a reservation must survive until the caller converts it
    let active = true;
    const adapter = this;
    return {
      async release() {
        await lease.release();
      },
      async acquire(ttl: number): Promise<Releaser> {
        lease.stopHeartbeat();
        await adapter.extend(key, token, ttl);
        return () => lease.release();
      },
      async extend(ttl: number) {
        if (!(await adapter.extend(key, token, ttl))) {
          throw new LockAcquireError('lock is not active');
        }
      },
      async runExclusive<T>(fn: () => Promise<T>, ttl: number): Promise<T> {
        if (!active) throw new LockAcquireError('lock is not active');
        lease.startHeartbeat(ttl);
        await adapter.extend(key, token, ttl);
        try {
          return await fn();
        } finally {
          active = false;
          await lease.release();
        }
      },
    };
  }
}
