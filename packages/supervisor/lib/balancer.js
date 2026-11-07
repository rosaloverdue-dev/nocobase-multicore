'use strict';
/**
 * Least-busy HTTP / WebSocket balancer that runs inside the supervisor (primary) process.
 *
 * Why it exists: `node:cluster` hands every NEW TCP connection to the next worker in turn ("round-robin"). It knows
 * nothing about load, so a user whose connection lands on a worker that is busy for 20 s with a heavy request waits
 * for it, while the other worker sits idle. Here every worker listens on its own private loopback port and the
 * supervisor owns the public port: each HTTP *request* (not connection) goes to the worker with the fewest requests
 * in flight, and a worker whose event loop has stopped answering (no heartbeat for `stallMs`) is avoided as long as
 * any other worker is available. WebSocket connections are tunnelled byte-for-byte to the worker with the fewest sockets.
 *
 * Bonus: because the supervisor knows when a worker has no request in flight, a rolling replace waits for exactly that
 * instead of cutting requests off.
 */
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade']);

class Balancer {
  constructor({ log = () => {}, stallMs = 2500, overflow = 4 } = {}) {
    this.log = log;
    this.stallMs = stallMs;
    // Worker affinity: 'off' (default, pure least-busy) | 'token' (same login token -> same worker) | 'ip' (same client address).
    // The preferred worker is only used while it is healthy and not much busier than the least-busy one.
    this.affinity = 'off';
    this.overflow = overflow;
    this.ups = [];
    this.rr = 0;
    this.server = null;
    this.stats = { requests: 0, errors: 0, noUpstream: 0, retries: 0, sticky: 0, overflowed: 0 };
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
      inflight: 0,
      sockets: 0,
      served: 0,
      draining: false,
      lastBeat: Date.now(),
      agent: new http.Agent({ keepAlive: true, maxSockets: Infinity, keepAliveMsecs: 10_000 }),
    };
    this.ups.push(up);
    return up;
  }

  find(slot) {
    return this.ups.find((u) => u.slot === slot);
  }

  beat(slot) {
    const up = this.find(slot);
    if (up) up.lastBeat = Date.now();
  }

  /** Stop routing to the slot; resolves when its in-flight requests are done (or after graceMs). */
  remove(slot, graceMs = 30_000) {
    const up = this.find(slot);
    if (!up) return Promise.resolve();
    up.draining = true;
    return new Promise((resolve) => {
      const started = Date.now();
      const finish = () => {
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
    const stalled = now - preferred.lastBeat > this.stallMs;
    if (stalled || preferred.inflight > best.inflight + this.overflow) {
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
      const stalled = now - u.lastBeat > this.stallMs;
      const score = u.inflight + (isWs ? u.sockets : u.sockets * 0.001) + (stalled ? 1000 : 0);
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
      upstreams: this.ups.map((u) => ({
        slot: u.slot.id,
        port: u.port,
        inflight: u.inflight,
        websockets: u.sockets,
        served: u.served,
        stalled: now - u.lastBeat > this.stallMs,
        draining: u.draining,
      })),
    };
  }

  // ---------- plain HTTP ----------
  onRequest(req, res) {
    this.stats.requests += 1;
    this.forward(req, res, this.pick(false, undefined, this.affinityKey(req)), 0, null);
  }

  forward(req, res, up, attempt, failed) {
    if (!up) {
      this.stats.noUpstream += 1;
      if (res.headersSent) return res.destroy();
      res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '2', connection: 'close' });
      res.end('{"errors":[{"message":"The application is starting or restarting, please retry in a moment.","code":"APP_NOT_READY"}]}');
      return undefined;
    }
    const headers = {};
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const key = req.rawHeaders[i];
      if (HOP_BY_HOP.has(key.toLowerCase())) continue;
      headers[key] = headers[key] === undefined ? req.rawHeaders[i + 1] : [].concat(headers[key], req.rawHeaders[i + 1]);
    }
    // keep the original transfer framing for request bodies
    if (req.headers['transfer-encoding']) headers['Transfer-Encoding'] = req.headers['transfer-encoding'];
    const remote = req.socket.remoteAddress;
    const xff = req.headers['x-forwarded-for'];
    headers['X-Forwarded-For'] = xff ? `${xff}, ${remote}` : remote;
    if (!req.headers['x-forwarded-proto']) headers['X-Forwarded-Proto'] = req.socket.encrypted ? 'https' : 'http';

    up.inflight += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      up.inflight -= 1;
      up.served += 1;
    };
    const preq = http.request(
      { host: up.host, port: up.port, method: req.method, path: req.url, headers, agent: up.agent },
      (pres) => {
        res.statusCode = pres.statusCode;
        res.statusMessage = pres.statusMessage;
        for (let i = 0; i < pres.rawHeaders.length; i += 2) {
          const key = pres.rawHeaders[i];
          if (HOP_BY_HOP.has(key.toLowerCase())) continue;
          res.appendHeader(key, pres.rawHeaders[i + 1]);
        }
        pres.pipe(res);
        pres.on('error', () => res.destroy());
        res.on('close', () => {
          release();
          if (!pres.complete) pres.destroy();
        });
      },
    );
    preq.on('error', (err) => {
      release();
      const bodyless = !(Number(req.headers['content-length']) > 0) && !req.headers['transfer-encoding'];
      const retryable =
        attempt === 0 &&
        bodyless &&
        !res.headersSent &&
        (err.syscall === 'connect' || (['GET', 'HEAD', 'OPTIONS'].includes(req.method) && ['ECONNRESET', 'EPIPE'].includes(err.code)));
      if (retryable) {
        this.stats.retries += 1;
        return this.forward(req, res, this.pick(false, up, this.affinityKey(req)), 1, up);
      }
      this.stats.errors += 1;
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json', connection: 'close' });
        res.end('{"errors":[{"message":"Bad gateway: the application worker did not answer.","code":"BAD_GATEWAY"}]}');
      } else {
        res.destroy();
      }
      return undefined;
    });
    // client went away before the answer: stop the work on our side of the wire
    res.on('close', () => {
      if (!res.writableEnded) preq.destroy();
      release();
    });
    if (attempt > 0 || req.readableEnded) preq.end();
    else req.pipe(preq);
    return undefined;
  }

  // ---------- WebSocket / Upgrade ----------
  onUpgrade(req, socket, head) {
    const up = this.pick(true, undefined, this.affinityKey(req));
    if (!up) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    const remote = req.socket.remoteAddress;
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    let hasXff = false;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const key = req.rawHeaders[i];
      let value = req.rawHeaders[i + 1];
      if (key.toLowerCase() === 'x-forwarded-for') {
        hasXff = true;
        value = `${value}, ${remote}`;
      }
      lines.push(`${key}: ${value}`);
    }
    if (!hasXff) lines.push(`X-Forwarded-For: ${remote}`);
    up.sockets += 1;
    const upstream = net.connect(up.port, up.host, () => {
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      up.sockets -= 1;
      socket.destroy();
      upstream.destroy();
    };
    socket.setNoDelay(true);
    upstream.setNoDelay(true);
    socket.on('error', end);
    upstream.on('error', end);
    socket.on('close', end);
    upstream.on('close', end);
  }
}

module.exports = { Balancer };
