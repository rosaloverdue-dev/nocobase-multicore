'use strict';
/**
 * Least-busy HTTP / WebSocket balancer that runs inside the supervisor (primary) process.
 *
 * Why it exists: `node:cluster` hands every NEW TCP connection to the next worker in turn ("round-robin"). It knows
 * nothing about load, so a user whose connection lands on a worker that is busy for 20 s with a heavy request waits
 * for it, while the other worker sits idle. Here every worker listens on its own private loopback port and the
 * supervisor owns the public port: each HTTP *request* (not connection) goes to the worker with the lowest load score
 * (requests in flight + event-loop lag), and a worker whose event loop has stopped answering (no heartbeat for
 * `stallMs`) is avoided as long as any other worker is available. WebSocket connections are tunnelled byte-for-byte
 * to the worker with the fewest sockets.
 *
 * Rules that keep the accounting honest (each of them was a real bug once, see CHANGELOG 0.2.0):
 *  - a request is "in flight" on exactly one worker, and is released exactly once per attempt;
 *  - a request whose client has gone away is never retried on another worker;
 *  - a request is only ever retried when its body can be replayed (no body, or a small body buffered here) and it is
 *    certain enough that the first worker never processed it.
 *
 * Bonus: because the supervisor knows when a worker has no request in flight, a rolling replace waits for exactly that
 * instead of cutting requests off.
 */
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'expect']);
const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS']);
const EMPTY = Buffer.alloc(0);
const NOT_READY = '{"errors":[{"message":"The application is starting or restarting, please retry in a moment.","code":"APP_NOT_READY"}]}';
const BAD_GATEWAY = '{"errors":[{"message":"Bad gateway: the application worker did not answer.","code":"BAD_GATEWAY"}]}';

class Balancer {
  /**
   * @param {object} [options]
   * @param {Function} [options.log]
   * @param {Function} [options.onEvent]   called with ({type, ...}) for things worth a line in the supervisor journal
   * @param {number} [options.stallMs]     no heartbeat for this long => the worker is "stalled" and avoided
   * @param {number} [options.overflow]    affinity: how much busier the preferred worker may be before we give up on it
   * @param {number} [options.replayLimit] request bodies up to this size are buffered so the request can be retried
   * @param {number} [options.freeSocketMs] idle keep-alive sockets to the workers are closed after this long
   * @param {number} [options.halfCloseMs]  a WebSocket tunnel is torn down this long after one side said goodbye
   */
  constructor({ log = () => {}, onEvent = () => {}, stallMs = 1500, overflow = 4, replayLimit = 1024 * 1024, freeSocketMs = 8000, halfCloseMs = 3000 } = {}) {
    this.log = log;
    this.onEvent = onEvent;
    this.stallMs = stallMs;
    // Worker affinity: 'off' (default, pure least-busy) | 'token' (same login token -> same worker) | 'ip' (same client address).
    // The preferred worker is only used while it is healthy and not much busier than the least-busy one.
    this.affinity = 'off';
    this.overflow = overflow;
    this.replayLimit = replayLimit;
    this.freeSocketMs = freeSocketMs;
    this.halfCloseMs = halfCloseMs;
    this.ups = [];
    this.rr = 0;
    this.server = null;
    this.stats = { requests: 0, errors: 0, noUpstream: 0, retries: 0, aborted: 0, upgrades: 0, sticky: 0, overflowed: 0 };
    this.lastError = null;
  }

  listen(port, host) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.onRequest(req, res));
      server.keepAliveTimeout = 65_000;
      server.requestTimeout = 0; // uploads and long exports are not ours to cut
      server.headersTimeout = 70_000;
      server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
      server.on('clientError', (err, socket) => {
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      });
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        server.on('error', (err) => this.log('balancer server error:', err && err.message));
        this.server = server;
        resolve(server.address());
      });
    });
  }

  close() {
    if (this.server) this.server.close();
    for (const u of this.ups) u.agent.destroy();
  }

  // ---------- upstream registry ----------
  add(slot, port, host = '127.0.0.1') {
    this.remove(slot, 0);
    const up = {
      slot,
      port,
      host,
      inflight: 0, // HTTP requests being processed by this worker right now
      sockets: 0, // open WebSocket tunnels
      served: 0, // responses received from this worker
      failed: 0, // attempts that ended with a transport error
      avgMs: 0, // moving average of the time to the first response byte
      lag: 0, // event-loop lag the worker reported with its last heartbeat, ms
      draining: false,
      gone: false,
      lastBeat: Date.now(),
      // `timeout` here is the idle time after which a FREE keep-alive socket is closed (an active request is not cut:
      // nothing listens for the request's 'timeout' event). It must stay well below the worker's keep-alive timeout,
      // otherwise the worker may close a socket at the very moment a request is written to it.
      agent: new http.Agent({ keepAlive: true, maxSockets: Infinity, maxFreeSockets: 128, scheduling: 'lifo', timeout: this.freeSocketMs }),
    };
    this.ups.push(up);
    return up;
  }

  find(slot) {
    return this.ups.find((u) => u.slot === slot);
  }

  /** Heartbeat of a worker; `lag` is its event-loop delay in ms (how late its timer fired). */
  beat(slot, lag) {
    const up = this.find(slot);
    if (!up) return;
    up.lastBeat = Date.now();
    up.lag = Number.isFinite(lag) && lag > 0 ? Math.min(lag, 60_000) : 0;
  }

  /** Stop routing to the slot; resolves when its in-flight requests are done (or after graceMs). */
  remove(slot, graceMs = 30_000) {
    const up = this.find(slot);
    if (!up) return Promise.resolve();
    up.draining = true;
    return new Promise((resolve) => {
      const started = Date.now();
      const finish = () => {
        up.gone = true;
        this.ups = this.ups.filter((u) => u !== up);
        up.agent.destroy();
        resolve();
      };
      const check = () => {
        if (up.inflight <= 0 || Date.now() - started >= graceMs) return finish();
        setTimeout(check, 100);
      };
      check();
    });
  }

  setAffinity(mode) {
    const next = mode === 'token' || mode === 'ip' ? mode : 'off';
    if (next !== this.affinity) this.log(`affinity: ${this.affinity} -> ${next}`);
    this.affinity = next;
  }

  /** Stable per-user key of a request, or null when there is nothing to stick to (anonymous request in token mode). */
  affinityKey(req) {
    if (this.affinity === 'ip') {
      const xff = req.headers['x-forwarded-for'];
      const first = xff ? String(xff).split(',')[0].trim() : '';
      return first || (req.socket && req.socket.remoteAddress) || null;
    }
    if (this.affinity === 'token') {
      const auth = req.headers.authorization;
      if (auth && /^Bearer\s+\S+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '');
      const url = req.url || '';
      const q = url.indexOf('?');
      if (q >= 0) {
        const t = new URLSearchParams(url.slice(q + 1)).get('token');
        if (t) return t;
      }
      return null;
    }
    return null;
  }

  isStalled(up, now = Date.now()) {
    return now - up.lastBeat > this.stallMs;
  }

  /**
   * Load score of a worker, lower is better: requests in flight, plus its event-loop lag (100 ms of lag weighs like
   * one extra request, capped), plus a huge penalty while it does not answer heartbeats at all.
   */
  score(up, isWs, now) {
    return up.inflight + (isWs ? up.sockets : up.sockets * 0.001) + Math.min(up.lag / 100, 10) + (this.isStalled(up, now) ? 1000 : 0);
  }

  pick(isWs, exclude, key) {
    const best = this.leastBusy(isWs, exclude);
    if (!key || this.affinity === 'off' || !best) return best;
    // rendezvous hashing: the preferred worker of a key stays the same when other workers come and go
    const now = Date.now();
    let preferred = null;
    let top = null;
    for (const u of this.ups) {
      if (u.draining || u === exclude) continue;
      const h = crypto.createHash('sha1').update(`${key}|${u.slot.id}`).digest().readUInt32BE(0);
      if (top === null || h > top) {
        top = h;
        preferred = u;
      }
    }
    if (!preferred || preferred === best) return best;
    if (this.isStalled(preferred, now) || this.score(preferred, isWs, now) > this.score(best, isWs, now) + this.overflow) {
      this.stats.overflowed += 1;
      return best;
    }
    this.stats.sticky += 1;
    return preferred;
  }

  leastBusy(isWs, exclude) {
    const now = Date.now();
    const n = this.ups.length;
    let best = null;
    let bestScore = Infinity;
    for (let i = 0; i < n; i += 1) {
      const u = this.ups[(this.rr + i) % n];
      if (u.draining || u === exclude) continue;
      const score = this.score(u, isWs, now);
      if (score < bestScore) {
        best = u;
        bestScore = score;
      }
    }
    this.rr = n ? (this.rr + 1) % n : 0;
    return best;
  }

  snapshot() {
    const now = Date.now();
    return {
      mode: this.affinity === 'off' ? 'least-busy' : `sticky-${this.affinity}`,
      affinity: this.affinity,
      ...this.stats,
      lastError: this.lastError,
      upstreams: this.ups.map((u) => ({
        slot: u.slot.id,
        port: u.port,
        inflight: u.inflight,
        websockets: u.sockets,
        served: u.served,
        failed: u.failed,
        avgMs: Math.round(u.avgMs * 10) / 10,
        lagMs: Math.round(u.lag),
        stalled: this.isStalled(u, now),
        silentMs: now - u.lastBeat,
        draining: u.draining,
      })),
    };
  }

  // ---------- plain HTTP ----------
  onRequest(req, res) {
    this.stats.requests += 1;
    /**
     * One client request. `body` is null while the request body is streamed (cannot be replayed => never retried),
     * otherwise a Buffer (possibly empty). `release` belongs to the current attempt.
     */
    const ctx = { req, res, key: this.affinityKey(req), headers: null, body: null, attempt: 0, up: null, preq: null, release: null, responded: false, done: false, clientGone: false };
    res.on('close', () => this.onClientClose(ctx));

    const chunked = Boolean(req.headers['transfer-encoding']);
    const length = Number(req.headers['content-length']) || 0;
    if (!chunked && length === 0) {
      ctx.body = EMPTY;
      req.resume();
      this.dispatch(ctx);
    } else if (!chunked && length <= this.replayLimit) {
      // small body: read it first, then the request can safely be sent again to another worker if the first one is gone
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('error', () => undefined); // the 'close' of the response does the cleanup
      req.on('end', () => {
        ctx.body = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
        this.dispatch(ctx);
      });
    } else {
      this.dispatch(ctx); // large upload / chunked: streamed straight through
    }
  }

  /** The client's side is finished: either the answer was delivered, or the client went away before/while it arrived. */
  onClientClose(ctx) {
    if (ctx.done) return;
    ctx.done = true;
    if (!ctx.res.writableFinished) {
      ctx.clientGone = true;
      this.stats.aborted += 1;
      // stop the work on our side of the wire; the resulting upstream error must NOT be treated as a worker failure
      if (ctx.preq) ctx.preq.destroy();
    }
    if (ctx.release) ctx.release();
  }

  requestHeaders(ctx) {
    if (ctx.headers) return ctx.headers;
    const { req } = ctx;
    const headers = {};
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const key = req.rawHeaders[i];
      if (HOP_BY_HOP.has(key.toLowerCase())) continue;
      headers[key] = headers[key] === undefined ? req.rawHeaders[i + 1] : [].concat(headers[key], req.rawHeaders[i + 1]);
    }
    // keep the original transfer framing for streamed request bodies
    if (ctx.body === null && req.headers['transfer-encoding']) headers['Transfer-Encoding'] = req.headers['transfer-encoding'];
    const remote = req.socket.remoteAddress;
    const xff = req.headers['x-forwarded-for'];
    headers['X-Forwarded-For'] = xff ? `${xff}, ${remote}` : remote;
    if (!req.headers['x-forwarded-proto']) headers['X-Forwarded-Proto'] = req.socket.encrypted ? 'https' : 'http';
    ctx.headers = headers;
    return headers;
  }

  answer(ctx, status, body, extra = {}) {
    const { res } = ctx;
    if (res.headersSent || res.destroyed) {
      res.destroy();
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json', connection: 'close', ...extra });
    res.end(body);
  }

  dispatch(ctx, exclude) {
    if (ctx.done) return;
    // after a failure prefer another worker, but a single worker may get its own request again on a fresh connection
    const up = this.pick(false, exclude, ctx.key) || (exclude ? this.pick(false, undefined, ctx.key) : null);
    if (!up) {
      this.stats.noUpstream += 1;
      this.answer(ctx, 503, NOT_READY, { 'retry-after': '2' });
      return;
    }
    const { req, res } = ctx;
    up.inflight += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      up.inflight -= 1;
    };
    ctx.up = up;
    ctx.release = release;
    const startedAt = process.hrtime.bigint();

    const preq = http.request(
      { host: up.host, port: up.port, method: req.method, path: req.url, headers: this.requestHeaders(ctx), agent: up.agent },
      (pres) => {
        ctx.responded = true;
        up.served += 1;
        const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
        up.avgMs = up.avgMs ? up.avgMs * 0.9 + ms * 0.1 : ms;
        res.statusCode = pres.statusCode;
        res.statusMessage = pres.statusMessage;
        for (let i = 0; i < pres.rawHeaders.length; i += 2) {
          const key = pres.rawHeaders[i];
          if (HOP_BY_HOP.has(key.toLowerCase())) continue;
          res.appendHeader(key, pres.rawHeaders[i + 1]);
        }
        pres.on('error', () => res.destroy());
        pres.once('close', release); // emitted after 'end' as well: the worker is done with this request
        pres.pipe(res);
      },
    );
    ctx.preq = preq;
    preq.on('error', (err) => {
      release();
      // We destroyed the upstream request ourselves because the client left: not a failure, and never a reason to
      // run the same request again on another worker.
      if (ctx.clientGone || ctx.done) return;
      up.failed += 1;
      if (ctx.responded) {
        res.destroy(); // the worker died in the middle of the answer
        return;
      }
      this.onUpstreamFailure(ctx, up, preq, err);
    });

    if (ctx.body !== null) preq.end(ctx.body.length ? ctx.body : undefined);
    else req.pipe(preq);
  }

  onUpstreamFailure(ctx, up, preq, err) {
    const retry = () => {
      if (ctx.done) return;
      this.stats.retries += 1;
      ctx.attempt += 1;
      this.dispatch(ctx, up);
    };
    const fail = () => {
      if (ctx.done) return;
      this.stats.errors += 1;
      this.lastError = { at: new Date().toISOString(), slot: up.slot.id, code: err.code || err.message, method: ctx.req.method };
      this.onEvent({ type: 'bad-gateway', slot: up.slot.id, code: err.code || String(err.message), method: ctx.req.method });
      this.answer(ctx, 502, BAD_GATEWAY);
    };
    const replayable = ctx.body !== null && ctx.attempt === 0 && !ctx.res.headersSent;
    if (!replayable) return fail();
    // 1) the connection was never established: the worker has certainly not seen the request
    if (err.syscall === 'connect' || err.code === 'ECONNREFUSED') return retry();
    const reset = err.code === 'ECONNRESET' || err.code === 'EPIPE';
    if (!reset) return fail();
    // 2) reads are safe to repeat
    if (IDEMPOTENT.has(ctx.req.method)) return retry();
    // 3) a write (POST...) on a REUSED keep-alive socket that was reset before a single response byte: the worker closed
    //    the idle connection while the request was on its way (classic keep-alive race, typical right after a long
    //    event-loop stall). That is only true if the worker is still alive: a crashed worker may have processed it.
    if (preq.reusedSocket) {
      setTimeout(() => (up.gone || up.draining ? fail() : retry()), 100);
      return undefined;
    }
    return fail();
  }

  // ---------- WebSocket / Upgrade ----------
  onUpgrade(req, socket, head) {
    this.stats.upgrades += 1;
    const key = this.affinityKey(req);
    const remote = req.socket.remoteAddress;
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    let hasXff = false;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      let value = req.rawHeaders[i + 1];
      if (name.toLowerCase() === 'x-forwarded-for') {
        hasXff = true;
        value = `${value}, ${remote}`;
      }
      lines.push(`${name}: ${value}`);
    }
    if (!hasXff) lines.push(`X-Forwarded-For: ${remote}`);
    const handshake = `${lines.join('\r\n')}\r\n\r\n`;
    let clientClosed = false;
    socket.setNoDelay(true);
    socket.on('error', () => undefined);
    socket.once('close', () => {
      clientClosed = true;
    });

    const connect = (exclude, attempt) => {
      const up = this.pick(true, exclude, key) || (exclude ? this.pick(true, undefined, key) : null);
      if (!up || clientClosed) {
        if (!clientClosed) socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
        return;
      }
      up.sockets += 1;
      let connected = false;
      let done = false;
      const upstream = net.connect(up.port, up.host);
      const end = () => {
        if (done) return;
        done = true;
        up.sockets -= 1;
        upstream.destroy();
        if (!connected && !clientClosed && attempt === 0) {
          connect(up, 1); // the worker refused the connection: try another one once
          return;
        }
        socket.destroy();
      };
      upstream.setNoDelay(true);
      upstream.once('connect', () => {
        connected = true;
        upstream.write(handshake);
        if (head && head.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      // One side sent FIN: the pipe passes it on; if the other side never answers with its own FIN the tunnel would
      // stay half-open (and counted) forever, so it is closed for good after a short linger.
      const halfClosed = () => {
        if (!done) setTimeout(end, this.halfCloseMs).unref();
      };
      upstream.on('error', end);
      upstream.on('close', end);
      upstream.once('end', halfClosed);
      socket.once('close', end);
      socket.once('end', halfClosed);
    };
    connect(undefined, 0);
  }
}

module.exports = { Balancer };
