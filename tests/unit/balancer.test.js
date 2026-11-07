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
