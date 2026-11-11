'use strict';
/** Queue adapter against a REAL Redis (skipped when none is available, see tests/unit/helpers.js). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { bundle, redis, connectionManager, closeAll, logger, sleep } = require('./helpers');

let n = 0;
async function make(tuning) {
  const mod = await bundle('packages/plugin-queue-adapter-redis/src/server/adapter.ts');
  const probe = await redis();
  if (!mod || !probe) return null;
  const prefix = `mcoretest:${process.pid}:${Date.now()}:${(n += 1)}`;
  const consumer = async () => {
    const app = { logger: logger(), redisConnectionManager: connectionManager() };
    const adapter = new mod.RedisQueueAdapter(app, prefix, tuning);
    await adapter.connect();
    return { adapter, app };
  };
  const cleanup = async () => {
    for await (const keys of probe.scanIterator({ MATCH: `${prefix}:*`, COUNT: 200 })) {
      const list = Array.isArray(keys) ? keys : [keys];
      if (list.length) await probe.del(list);
    }
  };
  return { consumer, cleanup, probe, prefix };
}

test.after(() => closeAll());

test('each message is processed exactly once across two workers', async (t) => {
  const env = await make();
  if (!env) return t.skip('no Redis / esbuild available');
  const a = await env.consumer();
  const b = await env.consumer();
  const seen = [];
  const sub = (who) => ({ concurrency: 4, idle: () => true, process: async (m) => { await sleep(5); seen.push(`${who}:${m.n}`); } });
  a.adapter.subscribe('jobs', sub('A'));
  b.adapter.subscribe('jobs', sub('B'));
  await sleep(100);
  for (let i = 0; i < 60; i += 1) await a.adapter.publish('jobs', { n: i });
  const deadline = Date.now() + 8000;
  while (seen.length < 60 && Date.now() < deadline) await sleep(50);
  await sleep(300);
  assert.equal(seen.length, 60);
  assert.equal(new Set(seen.map((s) => s.split(':')[1])).size, 60, 'no duplicates');
  assert.ok(seen.some((s) => s.startsWith('A:')) && seen.some((s) => s.startsWith('B:')), 'both workers took part');
  assert.equal(await env.probe.xLen(`${env.prefix}:q:jobs`), 0, 'processed messages are removed from the stream');
  await a.adapter.close();
  await b.adapter.close();
  await env.cleanup();
});

test('a job that runs longer than the takeover threshold is NOT run a second time by another worker', async (t) => {
  const env = await make({ claimEveryMs: 100, stalledAfterMs: 400 });
  if (!env) return t.skip('no Redis / esbuild available');
  const a = await env.consumer();
  const b = await env.consumer();
  const runs = [];
  // A is busy with the job (like the workflow dispatcher: not idle while it executes); B is an idle worker whose
  // takeover scan runs every 100 ms
  let busy = false;
  if (process.env.MCORE_TEST_NO_REFRESH) a.adapter.touchRunning = async () => undefined; // 0.1.x behaviour, see below
  a.adapter.subscribe('long', {
    idle: () => !busy,
    process: async (m) => { busy = true; runs.push(`A:start:${m.id}`); await sleep(1600); runs.push(`A:end:${m.id}`); busy = false; },
  });
  await sleep(100);
  await a.adapter.publish('long', { id: 1 });
  await sleep(250);
  b.adapter.subscribe('long', { idle: () => true, process: async (m) => { runs.push(`B:start:${m.id}`); } });
  await sleep(2200);
  assert.deepEqual(runs, ['A:start:1', 'A:end:1'], 'four takeover thresholds passed, the job still ran once');
  assert.ok(!b.app.logger.lines.some(([, m]) => /took over/.test(m)));
  await a.adapter.close();
  await b.adapter.close();
  await env.cleanup();
});

test('a job left behind by a dead worker is taken over and run by another one', async (t) => {
  const env = await make({ claimEveryMs: 100, stalledAfterMs: 400 });
  if (!env) return t.skip('no Redis / esbuild available');
  const a = await env.consumer();
  const runs = [];
  a.adapter.subscribe('crash', { idle: () => true, process: () => new Promise(() => { runs.push('A'); }) }); // never finishes
  await sleep(100);
  await a.adapter.publish('crash', { id: 7 });
  await sleep(200);
  assert.deepEqual(runs, ['A']);
  // the worker dies: no more refreshes, connections gone
  clearInterval(a.adapter.claimTimer);
  a.adapter.connected = false;
  const b = await env.consumer();
  b.adapter.subscribe('crash', { idle: () => true, process: async (m) => { runs.push(`B:${m.id}`); } });
  const deadline = Date.now() + 5000;
  while (runs.length < 2 && Date.now() < deadline) await sleep(50);
  assert.deepEqual(runs, ['A', 'B:7']);
  assert.ok(b.app.logger.lines.some(([, m]) => /took over stalled message/.test(m)));
  await b.adapter.close();
  await env.cleanup();
});

test('a failing message is retried maxRetries times, then dropped', async (t) => {
  const env = await make();
  if (!env) return t.skip('no Redis / esbuild available');
  const a = await env.consumer();
  const attempts = [];
  a.adapter.subscribe('flaky', { idle: () => true, process: async (m, o) => { attempts.push(o.retried); throw new Error('boom'); } });
  await sleep(100);
  await a.adapter.publish('flaky', { x: 1 }, { maxRetries: 2 });
  const deadline = Date.now() + 6000;
  while (attempts.length < 3 && Date.now() < deadline) await sleep(50);
  await sleep(700);
  assert.deepEqual(attempts, [0, 1, 2]);
  assert.equal(await env.probe.xLen(`${env.prefix}:q:flaky`), 0);
  await a.adapter.close();
  await env.cleanup();
});
