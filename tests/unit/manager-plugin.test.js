'use strict';
/** Server side of the manager plugin against a REAL Redis, with a stub NocoBase app (skipped without Redis/esbuild). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { bundle, redis, connectionManager, closeAll, logger, TEST_REDIS_URL } = require('./helpers');

const USERS = [
  { id: 1, nickname: 'Super Admin', username: 'admin' },
  { id: 7, nickname: 'Анна', username: 'anna' },
  { id: 9, nickname: null, username: 'bob' },
];

function wsClient(id, userId, ip) {
  const tags = new Set(['app#main']);
  if (userId != null) tags.add(`userId#${userId}`);
  return [id, { id, app: 'main', tags, headers: ip ? { 'x-forwarded-for': `${ip}, 10.0.0.1` } : {} }];
}

async function boot() {
  const mod = await bundle('packages/plugin-multicore/src/server/index.ts');
  const probe = await redis();
  if (!mod || !probe) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcore-plugin-'));
  process.env.MULTICORE_MODE = 'cluster';
  process.env.REDIS_URL = TEST_REDIS_URL;
  process.env.MULTICORE_REDIS_PREFIX = `mcoretest${process.pid}${Date.now()}`;
  process.env.MULTICORE_NAMESPACE = 'unit';
  process.env.MULTICORE_SLOT = '0';
  process.env.MULTICORE_CONFIG = path.join(dir, 'config.json');
  delete process.env.MULTICORE_SUPERVISED;
  const prefix = `${process.env.MULTICORE_REDIS_PREFIX}:unit`;
  const clients = new Map([wsClient('c1', 1, '203.0.113.5'), wsClient('c2', 1, '203.0.113.5'), wsClient('c3', 7, '198.51.100.9'), wsClient('c4', null)]);
  globalThis.__fakeGateway = { wsServer: { webSocketClients: clients } };
  const handlers = {};
  let resource;
  const app = {
    name: 'main',
    instanceId: 5,
    logger: logger(),
    acl: { registerSnippet: () => undefined },
    resourceManager: { define: (def) => { resource = def; } },
    pubSubManager: { subscribe: async () => undefined, publish: async () => undefined },
    eventQueue: { subscribe: () => undefined },
    lockManager: {},
    pm: { getPlugins: () => new Map() },
    on: (name, fn) => { handlers[name] = fn; },
    redisConnectionManager: connectionManager(),
    db: {
      sequelize: {
        getDialect: () => 'postgres',
        options: { pool: { max: 20 } },
        query: async (sql) => (/max_connections/.test(sql) ? [[{ max_connections: '100' }]] : [[]]),
      },
      getRepository: () => ({
        find: async ({ filter }) => USERS.filter((u) => filter.id.$in.map(String).includes(String(u.id))).map((u) => ({ get: (k) => u[k] })),
      }),
    },
  };
  const plugin = new mod.PluginMulticore(app);
  await plugin.load();
  await handlers.afterStart();
  const call = async (action, params = {}, user = { username: 'admin' }) => {
    const ctx = { action: { params }, state: { currentUser: user }, throw: (status, message) => { const e = new Error(message); e.status = status; throw e; } };
    await resource.actions[action](ctx, async () => undefined);
    return ctx.body;
  };
  const stop = async () => {
    await handlers.beforeStop();
    for await (const keys of probe.scanIterator({ MATCH: `${prefix}:*`, COUNT: 200 })) {
      const list = Array.isArray(keys) ? keys : [keys];
      if (list.length) await probe.del(list);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { plugin, call, probe, prefix, clients, stop, app };
}

test.after(() => closeAll());

test('manager plugin: heartbeat, worker list, who is connected, restart, apply', async (t) => {
  const env = await boot();
  if (!env) return t.skip('no Redis / esbuild available');
  const { call, probe, prefix } = env;

  await t.test('the heartbeat publishes the worker, its connections and the index', async () => {
    const beat = JSON.parse(await probe.get(`${prefix}:workers:${process.pid}`));
    assert.equal(beat.pid, process.pid);
    assert.equal(beat.wsClients, 4);
    assert.equal(beat.wsUsers, 2);
    assert.equal(beat.wsAnonymous, 1);
    assert.ok(beat.heapLimitMb > 100 && beat.rssMb > 10);
    assert.deepEqual(await probe.zRange(`${prefix}:workers:index`, 0, -1), [String(process.pid)]);
    const conn = JSON.parse(await probe.get(`${prefix}:conn:${process.pid}`));
    assert.equal(conn.clients, 4);
    assert.deepEqual(conn.users.map((u) => [u[0], u[1], u[3]]).sort(), [[1, 2, '203.0.113.5'], [7, 1, '198.51.100.9']]);
  });

  // a second worker of the same cluster (another process): its heartbeat and connection list are in Redis
  const other = 424242;
  await Promise.all([
    probe.set(`${prefix}:workers:${other}`, JSON.stringify({ pid: other, slot: '1', mode: 'cluster', instanceId: 6, uptimeSec: 10, wsClients: 3, wsUsers: 2, cpuPercent: 1, rssMb: 300 }), { PX: 20000 }),
    probe.set(`${prefix}:conn:${other}`, JSON.stringify({ pid: other, slot: '1', at: Date.now(), clients: 3, anonymous: 0, users: [[7, 2, Date.now() - 60000, '198.51.100.9'], [9, 1, Date.now() - 5000, '192.0.2.44']] }), { PX: 20000 }),
    probe.zAdd(`${prefix}:workers:index`, { score: Date.now(), value: String(other) }),
    // a dead worker: stale index entry, no keys
    probe.zAdd(`${prefix}:workers:index`, { score: Date.now() - 3600_000, value: '999' }),
  ]);

  await t.test('status lists the workers known to Redis (no supervisor in this test)', async () => {
    const status = await call('status');
    assert.deepEqual(status.workers.map((w) => [w.slot, w.pid]), [['0', process.pid], ['1', other]]);
    assert.equal(status.online.connections, 7);
    assert.equal(status.redis.ok, true);
    assert.equal(status.config.heapMb, 0);
    assert.deepEqual(status.database, { dialect: 'postgres', poolMax: 20, maxConnections: 100 });
  });

  await t.test('who is connected: whole cluster, one worker, names resolved', async () => {
    const all = await call('connections');
    assert.deepEqual(all.totals, { users: 3, connections: 7, anonymous: 1 });
    const anna = all.users.find((u) => u.id === 7);
    assert.equal(anna.nickname, 'Анна');
    assert.equal(anna.tabs, 3, 'tabs on both workers are added up');
    assert.deepEqual(anna.workers.sort((a, b) => a.slot - b.slot), [{ slot: '0', tabs: 1 }, { slot: '1', tabs: 2 }]);
    assert.ok(Date.now() - Date.parse(anna.since) >= 59000, 'earliest connection wins');
    assert.equal(all.users.find((u) => u.id === 9).username, 'bob');
    assert.deepEqual(all.workers.map((w) => [w.slot, w.connections, w.users]), [['0', 4, 2], ['1', 3, 2]]);

    const summary = await call('connections', { summary: '1' });
    assert.deepEqual(summary.totals, all.totals);
    assert.equal(summary.users, undefined, 'the summary carries no user list');

    const one = await call('connections', { slot: '1' });
    assert.equal(one.slot, '1');
    assert.deepEqual(one.users.map((u) => u.id).sort(), [7, 9]);
    assert.deepEqual(one.totals, { users: 2, connections: 3, anonymous: 0 });
    assert.equal(one.users.find((u) => u.id === 9).ip, '192.0.2.44');
  });

  await t.test('a worker that stopped sending heartbeats stays in the table (supervisor is the authority)', () => {
    const supervisor = {
      workers: [
        { slot: 0, pid: process.pid, state: 'listening', mode: 'cluster', restarts: 2, stalls: 1, silentMs: 300, startedAt: new Date(Date.now() - 50_000).toISOString(), heapMb: 2048 },
        { slot: 1, pid: 777, state: 'listening', mode: 'cluster', restarts: 0, stalls: 0, silentMs: 42_000, startedAt: new Date(Date.now() - 90_000).toISOString() },
        { slot: 1001, pid: 778, state: 'starting', mode: 'cluster', restarts: 0, stalls: 0, silentMs: 0, startedAt: new Date().toISOString() },
      ],
      balancer: { upstreams: [{ slot: 0, inflight: 2, served: 100, avgMs: 12.5, websockets: 4, stalled: false, failed: 0 }, { slot: 1, inflight: 9, served: 50, avgMs: 900, websockets: 1, stalled: true, failed: 3 }] },
    };
    const rows = env.plugin.mergeWorkers([{ pid: process.pid, slot: '0', cpuPercent: 3, rssMb: 500, uptimeSec: 49, wsClients: 4 }, { pid: 31337, slot: '5' }], supervisor);
    assert.deepEqual(rows.map((r) => [r.slot, r.pid, r.state, r.replacement]), [['0', process.pid, 'listening', false], ['1', 777, 'listening', false], ['1', 778, 'starting', true]]);
    assert.equal(rows[0].restarts, 2);
    assert.equal(rows[0].inflight, 2);
    assert.equal(rows[0].heapLimitCfgMb, 2048);
    assert.equal(rows[0].noHeartbeat, false);
    assert.equal(rows[1].noHeartbeat, true);
    assert.equal(rows[1].stalled, true);
    assert.ok(rows[1].uptimeSec >= 89);
    assert.equal(rows[1].served, 50);
  });

  await t.test('restart: refused without a supervisor, forwarded with one', async () => {
    await assert.rejects(call('restart', { values: { slot: 1 } }), (e) => e.status === 400 && /not running under nocobase-multicore/.test(e.message));
    // pretend to be a supervised worker: the supervisor answers over IPC
    const sent = [];
    const realSend = process.send;
    process.env.MULTICORE_SUPERVISED = '1';
    process.send = (m) => {
      sent.push(m);
      setImmediate(() => process.emit('message', { cmd: 'multicore', type: `${m.type}:ack`, reqId: m.reqId, accepted: m.slot === 1 || m.slot === 'all' }));
      return true;
    };
    env.plugin.ipcBound = false;
    env.plugin.bindIpc();
    try {
      assert.deepEqual(await call('restart', { values: { slot: 1 } }), { accepted: true, slot: 1 });
      assert.deepEqual(await call('restart', { values: { slot: 'all' } }), { accepted: true, slot: 'all' });
      await assert.rejects(call('restart', { values: { slot: 5 } }), (e) => e.status === 404);
      await assert.rejects(call('restart', { values: { slot: 'x' } }), (e) => e.status === 400);
      assert.deepEqual(sent.map((m) => [m.type, m.slot, m.by]), [['restart', 1, 'admin'], ['restart', 'all', 'admin'], ['restart', 5, 'admin']]);
    } finally {
      process.send = realSend;
      delete process.env.MULTICORE_SUPERVISED;
    }
  });

  await t.test('apply stores the heap limit and keeps it when the field is not sent', async () => {
    const a = await call('apply', { values: { enabled: false, workers: 3, affinity: 'token', heapMb: 2048 } });
    assert.equal(a.config.heapMb, 2048);
    assert.equal(a.config.affinity, 'token');
    assert.equal(a.config.updatedBy, 'admin');
    const b = await call('apply', { values: { enabled: false, workers: 2 } });
    assert.equal(b.config.heapMb, 2048, 'an older client that does not know the field does not reset it');
    const c = await call('apply', { values: { enabled: false, workers: 2, heapMb: 0 } });
    assert.equal(c.config.heapMb, 0);
    await assert.rejects(call('apply', { values: { enabled: true, workers: 2 } }), (e) => e.status === 400);
  });

  await t.test('stopping removes the worker from Redis', async () => {
    await env.stop();
    assert.equal(await probe.get(`${prefix}:workers:${process.pid}`), null);
  });
});
