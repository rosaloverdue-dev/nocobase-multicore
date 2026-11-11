'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { Balancer } = require('../../packages/supervisor/lib/balancer');

function upstream(name, handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => handler(req, res, name));
    server.on('upgrade', (req, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      socket.on('data', (d) => socket.write(`${name}:${d}`));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, name }));
  });
}
const get = (port, path = '/', headers = {}) =>
  new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers, agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });

async function setup(handlerA, handlerB) {
  const a = await upstream('A', handlerA);
  const b = await upstream('B', handlerB);
  const bal = new Balancer({ stallMs: 500 });
  const addr = await bal.listen(0, '127.0.0.1');
  const sa = { id: 0 };
  const sb = { id: 1 };
  bal.add(sa, a.port);
  bal.add(sb, b.port);
  const stop = () => {
    bal.close();
    a.server.close();
    b.server.close();
    a.server.closeAllConnections?.();
    b.server.closeAllConnections?.();
  };
  return { bal, port: addr.port, sa, sb, stop };
}
const echo = (req, res, name) => {
  res.setHeader('set-cookie', ['a=1', 'b=2']);
  res.end(JSON.stringify({ name, xff: req.headers['x-forwarded-for'], host: req.headers.host, url: req.url }));
};

test('equal load is shared evenly, headers and cookies survive', async () => {
  const t = await setup(echo, echo);
  const seen = { A: 0, B: 0 };
  for (let i = 0; i < 20; i += 1) {
    const r = await get(t.port, `/x?i=${i}`, { 'X-Forwarded-For': '1.2.3.4' });
    const j = JSON.parse(r.body);
    seen[j.name] += 1;
    assert.equal(j.url, `/x?i=${i}`);
    assert.match(j.xff, /^1\.2\.3\.4, /);
    assert.deepEqual(r.headers['set-cookie'], ['a=1', 'b=2']);
  }
  assert.equal(seen.A, 10);
  assert.equal(seen.B, 10);
  t.stop();
});

test('a busy worker does not get new requests while another is free', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const slow = (req, res, name) => (req.url === '/heavy' ? gate.then(() => echo(req, res, name)) : echo(req, res, name));
  const t = await setup(slow, slow);
  const heavy = get(t.port, '/heavy');
  await new Promise((r) => setTimeout(r, 100));
  const names = [];
  for (let i = 0; i < 10; i += 1) names.push(JSON.parse((await get(t.port, '/fast')).body).name);
  assert.equal(new Set(names).size, 1, 'all quick requests must go to the idle worker');
  release();
  await heavy;
  t.stop();
});

test('a stalled worker (no heartbeat) is avoided', async () => {
  const t = await setup(echo, echo);
  const stalledName = 'A';
  const keepAlive = setInterval(() => t.bal.beat(t.sb), 100);
  await new Promise((r) => setTimeout(r, 700)); // A has not beaten for > stallMs
  const names = [];
  for (let i = 0; i < 6; i += 1) names.push(JSON.parse((await get(t.port)).body).name);
  clearInterval(keepAlive);
  assert.ok(names.every((n) => n === 'B'), `expected only B, got ${names} (A=${stalledName} stalled)`);
  t.stop();
});

test('POST body is forwarded intact', async () => {
  const sink = (req, res, name) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => res.end(`${name}:${Buffer.concat(chunks).length}`));
  };
  const t = await setup(sink, sink);
  const payload = Buffer.alloc(3 * 1024 * 1024, 7);
  const out = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: t.port, method: 'POST', path: '/u', agent: false }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve(b));
    });
    req.on('error', reject);
    req.end(payload);
  });
  assert.match(out, /^[AB]:3145728$/);
  t.stop();
});

test('no upstream -> 503 JSON; dead upstream -> request retried on the other one', async () => {
  const bal = new Balancer();
  const addr = await bal.listen(0, '127.0.0.1');
  const r = await get(addr.port);
  assert.equal(r.status, 503);
  bal.close();

  const t = await setup(echo, echo);
  t.stop(); // closes both servers, balancer too; rebuild with one dead port
  const alive = await upstream('B', echo);
  const bal2 = new Balancer();
  const a2 = await bal2.listen(0, '127.0.0.1');
  bal2.add({ id: 0 }, 1); // nothing listens on port 1
  bal2.add({ id: 1 }, alive.port);
  for (let i = 0; i < 4; i += 1) {
    const res = await get(a2.port);
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).name, 'B');
  }
  assert.ok(bal2.stats.retries >= 1);
  bal2.close();
  alive.server.close();
});

test('websocket upgrade is tunnelled', async () => {
  const t = await setup(echo, echo);
  const reply = await new Promise((resolve, reject) => {
    const s = net.connect(t.port, '127.0.0.1', () => {
      s.write('GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    });
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      if (buf.includes('101') && !buf.includes('hello')) s.write('hello');
      if (buf.includes('hello')) resolve(buf);
    });
    s.on('error', reject);
  });
  assert.match(reply, /101 Switching Protocols/);
  assert.match(reply, /[AB]:hello/);
  t.stop();
});

test('remove() waits for in-flight requests', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const slow = (req, res, name) => gate.then(() => echo(req, res, name));
  const t = await setup(slow, slow);
  const pending = get(t.port);
  await new Promise((r) => setTimeout(r, 100));
  const busy = t.bal.ups.find((u) => u.inflight > 0);
  let done = false;
  const removal = t.bal.remove(busy.slot, 5000).then(() => (done = true));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(done, false);
  release();
  await pending;
  await removal;
  assert.equal(done, true);
  t.stop();
});

// ---------- worker affinity ----------
const bearer = (n) => ({ Authorization: `Bearer user-token-${n}` });
const who = async (port, headers) => JSON.parse((await get(port, '/', headers)).body).name;

test('affinity is OFF by default: tokens do not stick', async () => {
  const t = await setup(echo, echo);
  assert.equal(t.bal.affinity, 'off');
  assert.equal(t.bal.snapshot().mode, 'least-busy');
  const seen = new Set();
  for (let i = 0; i < 10; i += 1) seen.add(await who(t.port, bearer(1)));
  assert.equal(seen.size, 2);
  t.stop();
});

test('token affinity: same token -> same worker, different tokens spread, anonymous requests balance', async () => {
  const t = await setup(echo, echo);
  t.bal.setAffinity('token');
  assert.equal(t.bal.snapshot().mode, 'sticky-token');
  const byUser = {};
  for (let n = 0; n < 12; n += 1) {
    const names = new Set();
    for (let i = 0; i < 5; i += 1) names.add(await who(t.port, bearer(n)));
    assert.equal(names.size, 1, `user ${n} must stay on one worker`);
    byUser[n] = [...names][0];
  }
  assert.equal(new Set(Object.values(byUser)).size, 2, 'users are spread over both workers');
  const anon = new Set();
  for (let i = 0; i < 10; i += 1) anon.add(await who(t.port));
  assert.equal(anon.size, 2);
  t.stop();
});

test('ip affinity uses X-Forwarded-For', async () => {
  const t = await setup(echo, echo);
  t.bal.setAffinity('ip');
  for (const ip of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) {
    const names = new Set();
    for (let i = 0; i < 5; i += 1) names.add(await who(t.port, { 'X-Forwarded-For': ip }));
    assert.equal(names.size, 1);
  }
  t.stop();
});

test('affinity falls back to the other worker when the preferred one is stalled, draining or overloaded', async () => {
  const t = await setup(echo, echo);
  t.bal.setAffinity('token');
  const headers = bearer(7);
  const home = await who(t.port, headers);
  const homeUp = t.bal.ups.find((u) => (u.slot.id === 0 ? 'A' : 'B') === home);
  const other = home === 'A' ? 'B' : 'A';
  // overloaded
  homeUp.inflight = 10;
  assert.equal(await who(t.port, headers), other);
  homeUp.inflight = 0;
  assert.equal(await who(t.port, headers), home);
  // stalled (no heartbeat)
  homeUp.lastBeat = Date.now() - 5000;
  assert.equal(await who(t.port, headers), other);
  homeUp.lastBeat = Date.now();
  // draining
  homeUp.draining = true;
  assert.equal(await who(t.port, headers), other);
  assert.ok(t.bal.snapshot().overflowed >= 2);
  t.stop();
});

test('switching affinity off again restores least-busy balancing', async () => {
  const t = await setup(echo, echo);
  t.bal.setAffinity('token');
  t.bal.setAffinity('off');
  const seen = new Set();
  for (let i = 0; i < 10; i += 1) seen.add(await who(t.port, bearer(1)));
  assert.equal(seen.size, 2);
  t.stop();
});

// ---------------------------------------------------------------- 0.2.0 regressions

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const send = (port, method, path, body, headers = {}) =>
  new Promise((resolve) => {
    const h = { ...headers };
    if (body != null && !h['transfer-encoding']) h['content-length'] = Buffer.byteLength(body);
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    r.on('error', (e) => resolve({ status: 0, body: e.code }));
    r.end(body == null ? undefined : body);
  });

test('a client that aborts a request does not leak "in flight" and the request is NOT run again elsewhere', async () => {
  const hits = { A: 0, B: 0 };
  const slow = (req, res, name) => {
    hits[name] += 1;
    setTimeout(() => res.end(name), req.url.includes('slow') ? 250 : 0);
  };
  const t = await setup(slow, slow);
  const beat = setInterval(() => { t.bal.beat(t.sa, 0); t.bal.beat(t.sb, 0); }, 100);
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => {
      const r = http.get({ host: '127.0.0.1', port: t.port, path: '/slow', agent: false }, () => {});
      r.on('error', () => {});
      setTimeout(() => { r.destroy(); resolve(); }, 30);
    });
  }
  await sleep(500);
  const snap = t.bal.snapshot();
  assert.deepEqual(snap.upstreams.map((u) => u.inflight), [0, 0], 'no leaked in-flight counters');
  assert.equal(hits.A + hits.B, 20, 'every aborted request reached a worker exactly once');
  assert.equal(snap.retries, 0);
  assert.equal(snap.aborted, 20);
  assert.equal(snap.errors, 0, 'a client abort is not a worker failure');
  // and the balancing is still even afterwards
  const before = { ...hits };
  for (let i = 0; i < 40; i += 1) await get(t.port, '/fast');
  assert.equal(hits.A - before.A, 20);
  assert.equal(hits.B - before.B, 20);
  clearInterval(beat);
  t.stop();
});

test('a write (POST) is replayed when the first worker cannot be reached at all', async () => {
  const seen = [];
  const collect = (req, res, name) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { seen.push(`${name}:${body}`); res.end(`${name}:${body}`); });
  };
  const live = await upstream('LIVE', collect);
  const bal = new Balancer({});
  const addr = await bal.listen(0, '127.0.0.1');
  const dead = { id: 0 };
  const ok = { id: 1 };
  // a port nobody listens on: connect is refused
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const deadPort = probe.address().port;
  await new Promise((r) => probe.close(r));
  bal.add(dead, deadPort);
  bal.add(ok, live.port);
  for (let i = 0; i < 6; i += 1) {
    const r = await send(addr.port, 'POST', '/api/x:create', JSON.stringify({ i }), { 'content-type': 'application/json' });
    assert.equal(r.status, 200);
    assert.equal(r.body, `LIVE:{"i":${i}}`);
  }
  assert.equal(seen.length, 6, 'each write was executed exactly once');
  assert.ok(bal.snapshot().retries >= 1);
  assert.equal(bal.snapshot().errors, 0);
  bal.close();
  live.server.close();
  live.server.closeAllConnections?.();
});

test('POST on a reused keep-alive socket that the worker closed: replayed while the worker lives, 502 once it is gone', async () => {
  // an upstream that answers the first request and then destroys the idle keep-alive socket when the next request arrives
  let mode = 'normal';
  const executed = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (mode === 'reset' && req.socket.__used) {
        req.socket.destroy(); // nothing processed, connection reset (what an overdue keep-alive timer does)
        return;
      }
      req.socket.__used = true;
      executed.push(body);
      res.end(`done:${body}`);
    });
  });
  server.keepAliveTimeout = 60_000;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const bal = new Balancer({});
  const addr = await bal.listen(0, '127.0.0.1');
  const slot = { id: 0 };
  bal.add(slot, server.address().port);
  assert.equal((await send(addr.port, 'POST', '/a', 'one')).body, 'done:one'); // leaves one idle keep-alive socket behind
  mode = 'reset';
  const r = await send(addr.port, 'POST', '/a', 'two');
  assert.equal(r.status, 200, 'replayed on a fresh connection to the same (only) worker');
  assert.equal(r.body, 'done:two');
  assert.deepEqual(executed, ['one', 'two'], 'executed exactly once');
  assert.equal(bal.snapshot().retries, 1);

  // same situation, but the worker dies: it may have processed the write, so it must not be replayed
  const events = [];
  bal.onEvent = (e) => events.push(e);
  const pending = send(addr.port, 'POST', '/a', 'three');
  await sleep(20);
  bal.remove(slot, 0); // what the supervisor does when the worker process exits
  const failed = await pending;
  assert.equal(failed.status, 502);
  assert.match(failed.body, /BAD_GATEWAY/);
  assert.deepEqual(executed, ['one', 'two']);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'bad-gateway');
  bal.close();
  server.close();
  server.closeAllConnections?.();
});

test('large and chunked uploads are streamed through untouched', async () => {
  const sizes = (req, res, name) => {
    let n = 0;
    req.on('data', (c) => (n += c.length));
    req.on('end', () => res.end(`${name}:${n}:${req.headers['transfer-encoding'] || 'len'}`));
  };
  const t = await setup(sizes, sizes);
  const big = Buffer.alloc(3 * 1024 * 1024, 7); // above the 1 MiB replay limit
  const a = await send(t.port, 'POST', '/upload', big);
  assert.match(a.body, /^[AB]:3145728:len$/);
  const b = await send(t.port, 'POST', '/upload', Buffer.alloc(70_000, 1), { 'transfer-encoding': 'chunked' });
  assert.match(b.body, /^[AB]:70000:chunked$/);
  const c = await send(t.port, 'PUT', '/small', 'x'.repeat(5000));
  assert.match(c.body, /^[AB]:5000:len$/);
  assert.deepEqual(t.bal.snapshot().upstreams.map((u) => u.inflight), [0, 0]);
  t.stop();
});

test('event-loop lag reported by a worker shifts new requests to the others', async () => {
  const t = await setup(echo, echo);
  t.bal.beat(t.sa, 600); // worker A answers its timers 600 ms late
  t.bal.beat(t.sb, 0);
  const seen = { A: 0, B: 0 };
  for (let i = 0; i < 10; i += 1) seen[JSON.parse((await get(t.port, '/')).body).name] += 1;
  assert.deepEqual(seen, { A: 0, B: 10 });
  t.bal.beat(t.sa, 0); // recovered
  for (let i = 0; i < 10; i += 1) seen[JSON.parse((await get(t.port, '/')).body).name] += 1;
  assert.equal(seen.A, 5);
  // a few milliseconds of timer jitter are not "lag": an idle cluster is still shared evenly
  t.bal.beat(t.sa, 7);
  t.bal.beat(t.sb, 1);
  const jitter = { A: 0, B: 0 };
  for (let i = 0; i < 20; i += 1) jitter[JSON.parse((await get(t.port, '/')).body).name] += 1;
  assert.deepEqual(jitter, { A: 10, B: 10 });
  const snap = t.bal.snapshot();
  assert.equal(snap.upstreams[0].served + snap.upstreams[1].served, 40);
  assert.ok(snap.upstreams.every((u) => u.avgMs >= 0 && u.failed === 0));
  t.stop();
});

test('a websocket is connected to another worker when the first one refuses', async () => {
  const live = await upstream('LIVE', echo);
  const bal = new Balancer({ halfCloseMs: 20 });
  const addr = await bal.listen(0, '127.0.0.1');
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const deadPort = probe.address().port;
  await new Promise((r) => probe.close(r));
  bal.add({ id: 0 }, deadPort);
  bal.add({ id: 1 }, live.port);
  for (let i = 0; i < 4; i += 1) {
    const answer = await new Promise((resolve, reject) => {
      const s = net.connect(addr.port, '127.0.0.1', () => {
        s.write('GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
      });
      let buf = '';
      s.on('data', (d) => {
        buf += d;
        if (buf.includes('\r\n\r\n') && !buf.includes('LIVE:')) s.write('hi');
        if (buf.includes('LIVE:hi')) { s.destroy(); resolve(buf); }
      });
      s.on('error', reject);
      s.on('close', () => resolve(buf));
    });
    assert.match(answer, /101 Switching Protocols/);
    assert.match(answer, /LIVE:hi/);
  }
  await sleep(150);
  assert.deepEqual(bal.snapshot().upstreams.map((u) => u.websockets), [0, 0], 'tunnels are not left half-open');
  bal.close();
  live.server.close();
  live.server.closeAllConnections?.();
});

test('requests longer than the idle-socket timeout are not cut; idle sockets to the workers are closed', async () => {
  const slowly = (req, res) => {
    if (req.url === '/slow') return setTimeout(() => res.end('slow-ok'), 900);
    if (req.url === '/stream') {
      res.write('a');
      setTimeout(() => res.write('b'), 700);
      return setTimeout(() => res.end('c'), 1400);
    }
    return res.end('warm');
  };
  const a = await upstream('A', slowly);
  a.server.keepAliveTimeout = 600_000;
  const bal = new Balancer({ freeSocketMs: 300 });
  const addr = await bal.listen(0, '127.0.0.1');
  const slot = { id: 0 };
  bal.add(slot, a.port);
  const beat = setInterval(() => bal.beat(slot, 0), 100);
  await get(addr.port, '/warm');
  await get(addr.port, '/warm'); // the long ones below run on reused keep-alive sockets
  const [slow, stream] = await Promise.all([get(addr.port, '/slow'), get(addr.port, '/stream')]);
  assert.equal(slow.body, 'slow-ok');
  assert.equal(stream.body, 'abc');
  const snap = bal.snapshot();
  assert.deepEqual([snap.errors, snap.retries, snap.aborted, snap.upstreams[0].inflight], [0, 0, 0, 0]);
  const free = () => Object.values(bal.ups[0].agent.freeSockets).reduce((n, list) => n + list.length, 0);
  await get(addr.port, '/warm');
  assert.ok(free() >= 1, 'the connection is kept for reuse');
  await sleep(600);
  assert.equal(free(), 0, 'and closed by the balancer once it has been idle for freeSocketMs');
  clearInterval(beat);
  bal.close();
  a.server.close();
  a.server.closeAllConnections?.();
});
