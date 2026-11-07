import { keyPrefix } from '../../../shared/src/env';

type Callback = (message: string) => Promise<void> | void;

/**
 * IPubSubAdapter backed by Redis Pub/Sub.
 *
 * Two dedicated connections are used (a connection in subscriber mode cannot publish). Connections are owned by
 * `app.redisConnectionManager`, which closes them when the application is destroyed, so `close()` here only detaches
 * the listeners it registered.
 */
export class RedisPubSubAdapter {
  /** Marker read by the multicore manager plugin to report which adapter is active. */
  readonly kind = 'redis';

  private pub: any;
  private sub: any;
  private connected = false;
  // channel -> (user callback -> redis listener)
  private listeners = new Map<string, Map<Callback, (message: string) => void>>();

  constructor(
    private app: any,
    private prefix: string = keyPrefix(),
  ) {}

  private ch(channel: string) {
    return `${this.prefix}:ps:${channel}`;
  }

  isConnected() {
    return this.connected && Boolean(this.pub?.isReady) && Boolean(this.sub?.isReady);
  }

  async connect() {
    if (this.connected) return;
    const manager = this.app.redisConnectionManager;
    this.pub = await manager.getConnectionSync('mcore:pubsub:pub');
    this.sub = await manager.getConnectionSync('mcore:pubsub:sub');
    this.connected = true;
    this.app.logger.info(`[multicore] pub/sub adapter connected (prefix ${this.prefix})`);
  }

  async close() {
    if (!this.connected) return;
    this.connected = false;
    for (const [channel, map] of this.listeners.entries()) {
      for (const listener of map.values()) {
        try {
          if (this.sub?.isOpen) await this.sub.unsubscribe(this.ch(channel), listener);
        } catch (error) {
          // the connection may already be closing
        }
      }
    }
    this.listeners.clear();
  }

  async subscribe(channel: string, callback: Callback) {
    let map = this.listeners.get(channel);
    if (!map) {
      map = new Map();
      this.listeners.set(channel, map);
    }
    if (map.has(callback)) return;
    const listener = (message: string) => {
      Promise.resolve()
        .then(() => callback(message))
        .catch((error) => {
          this.app.logger.error(`[multicore] pub/sub handler failed on ${channel}: ${error?.message}`, { error });
        });
    };
    map.set(callback, listener);
    await this.sub.subscribe(this.ch(channel), listener);
  }

  async unsubscribe(channel: string, callback: Callback) {
    const map = this.listeners.get(channel);
    const listener = map?.get(callback);
    if (!map || !listener) return;
    map.delete(callback);
    if (!map.size) this.listeners.delete(channel);
    if (this.sub?.isOpen) await this.sub.unsubscribe(this.ch(channel), listener);
  }

  async publish(channel: string, message: string) {
    await this.pub.publish(this.ch(channel), message);
  }
}
