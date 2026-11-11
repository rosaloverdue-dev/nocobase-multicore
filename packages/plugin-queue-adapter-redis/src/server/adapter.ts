import { randomUUID } from 'node:crypto';
import { keyPrefix, sleep } from '../../../shared/src/env';

type QueueEvent = {
  interval?: number;
  concurrency?: number;
  idle(): boolean;
  process(message: any, options: { id?: string; retried?: number; signal?: AbortSignal; queueOptions?: any }): Promise<void>;
};
type MessageOptions = { timeout?: number; maxRetries?: number; retried?: number; timestamp?: number };

const GROUP = 'nb';
const DEFAULT_INTERVAL = 250;
const DEFAULT_TIMEOUT = 15_000;
const MAX_STREAM_LEN = 100_000;
const RETRY_DELAY = 500;
/** How often a worker looks for messages abandoned by a dead worker, and how often it marks its own running jobs as alive. */
const CLAIM_EVERY = 10_000;
/**
 * A pending message is "abandoned" when nobody touched it for this long. A job that is still running is touched every
 * CLAIM_EVERY ms by its worker, so only messages of a dead (or completely frozen) worker ever get this old.
 */
const STALLED_AFTER = 90_000;

type Tuning = { claimEveryMs?: number; stalledAfterMs?: number };

/**
 * IEventQueueAdapter backed by Redis Streams + a consumer group.
 *
 *  publish   XADD <stream> {content, options}
 *  consume   XREADGROUP (each message goes to exactly one worker in the whole cluster)
 *  success   XACK + XDEL
 *  failure   re-published with retried+1 (maxRetries), otherwise logged and dropped (same as the memory adapter)
 *  running   while the handler runs, its worker refreshes the message every 10 s (XCLAIM ... JUSTID), so a job that
 *            takes minutes (an import, a long workflow) is never mistaken for an abandoned one and run twice
 *  crash     messages left pending by a dead worker are taken over by XAUTOCLAIM after 90 s without a refresh
 *
 * Delivery is at-least-once: a worker that dies mid-job leaves it pending and another worker re-runs it.
 */
export class RedisQueueAdapter {
  /** Marker read by the multicore manager plugin to report which adapter is active. */
  readonly kind = 'redis';

  private client: any;
  private connected = false;
  private consumerId = `${process.pid}-${randomUUID().slice(0, 8)}`;
  private subs = new Map<string, { event: QueueEvent; stop: boolean; inflight: number; reader?: any }>();
  private claimTimer?: NodeJS.Timeout;
  private prefix: string;
  private claimEveryMs: number;
  private stalledAfterMs: number;
  /** stream -> ids of the messages whose handler is running in this process right now */
  private running = new Map<string, Set<string>>();

  constructor(
    private app: any,
    prefix?: string,
    tuning: Tuning = {},
  ) {
    this.prefix = prefix || keyPrefix();
    this.claimEveryMs = tuning.claimEveryMs || CLAIM_EVERY;
    this.stalledAfterMs = tuning.stalledAfterMs || STALLED_AFTER;
  }

  private stream(channel: string) {
    return `${this.prefix}:q:${channel}`;
  }

  private get logger() {
    return this.app.logger;
  }

  isConnected() {
    return this.connected;
  }

  async connect() {
    if (this.connected) return;
    this.client = await this.app.redisConnectionManager.getConnectionSync('mcore:queue');
    this.connected = true;
    this.claimTimer = setInterval(() => {
      this.touchRunning().catch(() => undefined);
      this.claimStalled().catch(() => undefined);
    }, this.claimEveryMs);
    this.claimTimer.unref?.();
    this.logger.info(`[multicore] queue adapter connected (consumer ${this.consumerId})`);
    // channels subscribed before connect()
    for (const channel of this.subs.keys()) this.startLoop(channel);
  }

  async close() {
    this.connected = false;
    if (this.claimTimer) clearInterval(this.claimTimer);
    const loops = [];
    for (const sub of this.subs.values()) {
      sub.stop = true;
      loops.push(this.waitIdle(sub));
      try {
        if (sub.reader?.isOpen) sub.reader.destroy?.();
      } catch (e) {
        // ignore
      }
      sub.reader = undefined;
    }
    await Promise.race([Promise.all(loops), sleep(10_000)]);
  }

  private async waitIdle(sub: { inflight: number }) {
    while (sub.inflight > 0) await sleep(50);
  }

  subscribe(channel: string, event: QueueEvent) {
    if (this.subs.has(channel)) return;
    this.subs.set(channel, { event, stop: false, inflight: 0 });
    if (this.connected) this.startLoop(channel);
  }

  unsubscribe(channel: string) {
    const sub = this.subs.get(channel);
    if (!sub) return;
    sub.stop = true;
    this.subs.delete(channel);
  }

  async publish(channel: string, content: any, options: MessageOptions = {}) {
    await this.client.xAdd(
      this.stream(channel),
      '*',
      { content: JSON.stringify(content ?? null), options: JSON.stringify({ ...options, timestamp: options.timestamp ?? Date.now() }) },
      { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: MAX_STREAM_LEN } },
    );
  }

  // ---------------------------------------------------------------- consuming

  private async ensureGroup(stream: string) {
    try {
      await this.client.xGroupCreate(stream, GROUP, '0', { MKSTREAM: true });
    } catch (error: any) {
      if (!String(error?.message).includes('BUSYGROUP')) throw error;
    }
  }

  private startLoop(channel: string) {
    const sub = this.subs.get(channel);
    if (!sub) return;
    this.loop(channel, sub).catch((error) => {
      this.logger.error(`[multicore] queue loop for "${channel}" crashed: ${error?.message}`, { error });
    });
  }

  private async loop(channel: string, sub: { event: QueueEvent; stop: boolean; inflight: number; reader?: any }) {
    const stream = this.stream(channel);
    // A dedicated connection: XREADGROUP ... BLOCK would otherwise stall every other command on the shared client.
    const reader = this.client.duplicate();
    reader.on('error', (error: any) => this.logger.warn(`[multicore] queue reader error: ${error?.message}`));
    await reader.connect();
    sub.reader = reader;
    await this.ensureGroup(stream);
    while (!sub.stop && this.connected) {
      const { event } = sub;
      const interval = event.interval || DEFAULT_INTERVAL;
      const concurrency = event.concurrency ?? 1;
      const room = concurrency <= 0 ? 10 : concurrency - sub.inflight;
      if (room <= 0 || !event.idle()) {
        await sleep(interval);
        continue;
      }
      let response: any;
      try {
        response = await reader.xReadGroup(GROUP, this.consumerId, { key: stream, id: '>' }, { COUNT: room, BLOCK: interval });
      } catch (error: any) {
        if (sub.stop || !this.connected) break;
        if (String(error?.message).includes('NOGROUP')) {
          await this.ensureGroup(stream);
        } else {
          this.logger.warn(`[multicore] queue read failed on "${channel}": ${error?.message}`);
          await sleep(1000);
        }
        continue;
      }
      for (const entry of response || []) {
        for (const message of entry.messages || []) {
          this.dispatch(channel, stream, sub, message);
        }
      }
    }
    try {
      reader.destroy?.();
    } catch (e) {
      // ignore
    }
  }

  private dispatch(channel: string, stream: string, sub: { event: QueueEvent; inflight: number }, message: { id: string; message: any }) {
    sub.inflight += 1;
    this.handle(channel, stream, sub.event, message)
      .catch((error) => this.logger.error(`[multicore] queue handler failed on "${channel}": ${error?.message}`, { error }))
      .finally(() => {
        sub.inflight -= 1;
      });
  }

  private async handle(channel: string, stream: string, event: QueueEvent, entry: { id: string; message: any }) {
    let content: any;
    let options: MessageOptions = {};
    try {
      content = JSON.parse(entry.message.content);
      options = JSON.parse(entry.message.options || '{}');
    } catch (error) {
      this.logger.error(`[multicore] queue "${channel}": dropping malformed message ${entry.id}`);
      await this.ack(stream, entry.id);
      return;
    }
    const { timeout = DEFAULT_TIMEOUT, maxRetries = 0, retried = 0 } = options;
    let ids = this.running.get(stream);
    if (!ids) this.running.set(stream, (ids = new Set()));
    ids.add(entry.id);
    try {
      await event.process(content, { id: entry.id, retried, signal: AbortSignal.timeout(timeout), queueOptions: options });
    } catch (error: any) {
      if (maxRetries > 0 && retried < maxRetries) {
        this.logger.warn(`[multicore] queue "${channel}" message ${entry.id} failed, retry ${retried + 1}/${maxRetries}: ${error?.message}`);
        await sleep(RETRY_DELAY);
        await this.publish(channel, content, { ...options, retried: retried + 1, timestamp: Date.now() });
      } else {
        this.logger.error(`[multicore] queue "${channel}" message ${entry.id} failed: ${error?.message}`, { error });
      }
    } finally {
      ids.delete(entry.id);
    }
    await this.ack(stream, entry.id);
  }

  private async ack(stream: string, id: string) {
    try {
      // both commands leave in the same tick, i.e. in one network round trip
      await Promise.all([this.client.xAck(stream, GROUP, id), this.client.xDel(stream, id)]);
    } catch (error: any) {
      this.logger.warn(`[multicore] queue ack failed for ${id}: ${error?.message}`);
    }
  }

  /**
   * Jobs that are still running here: claim them for ourselves again, which resets their idle time in Redis without
   * counting as a new delivery (JUSTID). Without this, any job longer than the takeover threshold would be picked up
   * by another worker and run a second time while the first run is still in progress.
   */
  private async touchRunning() {
    if (!this.connected) return;
    for (const [stream, ids] of this.running.entries()) {
      if (!ids.size) continue;
      try {
        await this.client.sendCommand(['XCLAIM', stream, GROUP, this.consumerId, '0', ...ids, 'JUSTID']);
      } catch (error: any) {
        this.logger.warn(`[multicore] queue: could not refresh running messages on ${stream}: ${error?.message}`);
      }
    }
  }

  /** Take over messages that a crashed worker left pending, and run them here. */
  private async claimStalled() {
    if (!this.connected) return;
    for (const [channel, sub] of this.subs.entries()) {
      if (sub.stop || !sub.event.idle()) continue;
      const stream = this.stream(channel);
      let result: any;
      try {
        result = await this.client.xAutoClaim(stream, GROUP, this.consumerId, this.stalledAfterMs, '0-0', { COUNT: 5 });
      } catch (error: any) {
        if (String(error?.message).includes('NOGROUP')) continue;
        throw error;
      }
      for (const message of result?.messages || []) {
        if (!message) continue;
        if (this.running.get(stream)?.has(message.id)) continue; // our own job, simply slow
        this.logger.warn(`[multicore] queue "${channel}": took over stalled message ${message.id}`);
        this.dispatch(channel, stream, sub, message);
      }
    }
  }
}
