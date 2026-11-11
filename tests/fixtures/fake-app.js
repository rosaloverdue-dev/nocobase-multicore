'use strict';
/**
 * A stand-in for the NocoBase app entry, used by tests/unit/supervisor.test.js: a tiny HTTP server that behaves like
 * a worker as far as the supervisor can tell (listens on APP_PORT, talks over the cluster IPC channel, can be told
 * to block its event loop or to die). Run through the real lib/worker-entry.js.
 */
const http = require('node:http');
const v8 = require('node:v8');

const pending = new Map();
process.on('message', (m) => {
  if (!m || m.cmd !== 'multicore' || !m.reqId || !pending.has(m.reqId)) return;
  pending.get(m.reqId)(m);
  pending.delete(m.reqId);
});
const ask = (type, extra = {}) =>
  new Promise((resolve) => {
    const reqId = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    pending.set(reqId, resolve);
    process.send({ cmd: 'multicore', type, reqId, ...extra });
    setTimeout(() => resolve(null), 3000);
  });

const wid = process.pid % 1000;
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (o) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(o));
  };
  const me = () => ({
    pid: process.pid,
    slot: process.env.MULTICORE_SLOT,
    mode: process.env.MULTICORE_MODE,
    wid,
    widAvoid: process.env.MULTICORE_WID_AVOID || '',
    heapLimitMb: Math.round(v8.getHeapStatistics().heap_size_limit / 1048576),
    keepAliveTimeout: server.keepAliveTimeout,
  });
  if (u.pathname === '/whoami') return json(me());
  if (u.pathname === '/slow') return setTimeout(() => json(me()), Number(u.searchParams.get('ms')) || 50);
  if (u.pathname === '/block') {
    const end = Date.now() + Number(u.searchParams.get('ms'));
    while (Date.now() < end); // eslint-disable-line no-empty
    return json(me());
  }
  if (u.pathname === '/exit') {
    json({ bye: process.pid });
    return setTimeout(() => process.exit(Number(u.searchParams.get('code')) || 0), 20);
  }
  if (u.pathname === '/ipc') {
    const slot = u.searchParams.get('slot');
    return json(await ask(u.searchParams.get('type'), { slot: slot === 'all' ? 'all' : slot == null ? undefined : Number(slot), by: 'tester' }));
  }
  let n = 0;
  req.on('data', (c) => (n += c.length));
  req.on('end', () => json({ ...me(), method: req.method, bytes: n }));
  return undefined;
});
process.on('SIGTERM', () => server.close());
server.listen(Number(process.env.APP_PORT), process.env.APP_HOST || '127.0.0.1', () => {
  // the worker-id allocator plugin reports the leased snowflake id like this
  process.send({ cmd: 'multicore', type: 'wid', id: wid });
});
