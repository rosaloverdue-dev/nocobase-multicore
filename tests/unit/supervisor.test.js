'use strict';
/**
 * End-to-end test of the supervisor + balancer with fake workers (tests/fixtures/fake-app.js instead of NocoBase):
 * boot, even balancing, zero-downtime manual restart, crash + respawn, event-loop stall, heap limit, scale down.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { exitReason } = require('../../packages/supervisor/lib/supervisor');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

test('exit codes are classified for the journal', () => {
  assert.equal(exitReason(null, 'SIGABRT'), 'oom');
  assert.equal(exitReason(134, null), 'oom');
  assert.equal(exitReason(null, 'SIGKILL'), 'killed');
  assert.equal(exitReason(1, null), 'error');
  assert.equal(exitReason(0, null), 'exit');
  assert.equal(exitReason(null, 'SIGTERM'), 'signal');
});

test('supervisor end-to-end with fake workers', { timeout: 180_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcore-sup-'));
  const config = path.join(dir, 'multicore', 'config.json');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const writeConfig = (c) => fs.writeFileSync(config, JSON.stringify(c));
  writeConfig({ enabled: true, workers: 3, affinity: 'off' });
  const port = await freePort();
  const out = [];
  const sup = spawn(process.execPath, [path.join(__dirname, '../../packages/supervisor/bin/nocobase-multicore.js')], {
    cwd: dir,
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      MULTICORE_APP_ENTRY: path.join(__dirname, '../fixtures/fake-app.js'),
      MULTICORE_SKIP_INITENV: '1',
      MULTICORE_DEFER_LISTEN: '0',
      MULTICORE_QUICKSTART: '0',
      MULTICORE_EXIT_GRACE_MS: '200',
      MULTICORE_CONFIG: config,
      REDIS_URL: 'redis://127.0.0.1:1/0',
      APP_PORT: String(port),
      APP_HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  sup.stdout.on('data', (d) => out.push(String(d)));
  sup.stderr.on('data', (d) => out.push(String(d)));
  let exited = null;
  sup.on('exit', (code) => {
    exited = code;
  });
  t.after(() => {
    if (exited === null) sup.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const call = (p, { method = 'GET', body } = {}) =>
    new Promise((resolve) => {
      const started = Date.now();
      const r = http.request({ host: '127.0.0.1', port, path: p, method, agent: false, headers: body ? { 'content-length': Buffer.byteLength(body) } : {} }, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (e) {
            // not json
          }
          resolve({ status: res.statusCode, json, ms: Date.now() - started });
        });
      });
      r.on('error', (e) => resolve({ status: 0, json: null, error: e.code, ms: Date.now() - started }));
      r.end(body);
    });
  const status = async () => (await call('/ipc?type=status')).json?.data;
  const until = async (what, fn, timeoutMs = 40_000) => {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await fn().catch(() => null);
      if (last) return last;
      await sleep(200);
    }
    throw new Error(`timeout waiting for: ${what}\n${out.join('').split('\n').slice(-25).join('\n')}`);
  };
  /** pid by slot, taken from the supervisor (only workers that are serving). */
  const pids = async () => {
    const s = await status();
    if (!s) return null;
    const map = {};
    for (const w of s.workers) if (w.state === 'listening' && w.slot < 1000) map[w.slot] = w.pid;
    return map;
  };

  await t.test('boots 3 workers and spreads requests evenly', async () => {
    await until('3 workers listening', async () => Object.keys((await pids()) || {}).length === 3);
    const seen = {};
    for (let i = 0; i < 90; i += 1) {
      const r = await call('/whoami');
      assert.equal(r.status, 200);
      seen[r.json.slot] = (seen[r.json.slot] || 0) + 1;
      assert.ok(r.json.keepAliveTimeout >= 600_000, 'the worker keeps idle connections much longer than the balancer');
      assert.equal(r.json.mode, 'cluster');
    }
    assert.deepEqual(seen, { 0: 30, 1: 30, 2: 30 });
    const s = await status();
    assert.equal(s.balancer.upstreams.length, 3);
    assert.ok(s.balancer.upstreams.every((u) => u.inflight <= 1 && !u.stalled));
    assert.ok(s.host.totalMemMb > 0);
    assert.ok(s.events.some((e) => e.type === 'boot') && s.events.filter((e) => e.type === 'worker-ready').length >= 3);
  });

  await t.test('a worker reports its snowflake id; later workers are told to avoid the ids of live ones', async () => {
    const s = await status();
    const wids = s.workers.map((w) => w.wid);
    assert.ok(wids.every((w) => Number.isInteger(w)), `every worker reported its id: ${wids}`);
    // slot 2 started last: it must have been told about slots 0 and 1
    let last;
    for (let i = 0; i < 12 && !last; i += 1) {
      const r = await call('/whoami');
      if (r.json.slot === '2') last = r.json;
    }
    const avoid = last.widAvoid.split(',').map(Number);
    assert.ok(avoid.includes(s.workers.find((w) => w.slot === 0).wid));
    assert.ok(avoid.includes(s.workers.find((w) => w.slot === 1).wid));
  });

  await t.test('manual restart of one worker is zero-downtime', async () => {
    const before = await pids();
    let running = true;
    const results = [];
    const load = Promise.all(
      [0, 1, 2, 3].map(async () => {
        while (running) results.push(await call('/slow?ms=20'));
      }),
    );
    const rejected = await call('/ipc?type=restart&slot=7');
    assert.equal(rejected.json.accepted, false, 'unknown slot is refused');
    const ack = await call('/ipc?type=restart&slot=1');
    assert.equal(ack.json.accepted, true);
    const after = await until('slot 1 replaced', async () => {
      const p = await pids();
      return p && p[1] && p[1] !== before[1] && Object.keys(p).length === 3 ? p : null;
    });
    await sleep(300);
    running = false;
    await load;
    assert.equal(after[0], before[0], 'the other workers were not touched');
    assert.equal(after[2], before[2]);
    const bad = results.filter((r) => r.status !== 200);
    assert.equal(bad.length, 0, `no request failed during the restart (${results.length} requests): ${JSON.stringify(bad.slice(0, 3))}`);
    assert.ok(results.length > 50);
    const s = await status();
    assert.ok(s.events.some((e) => e.type === 'restart-requested' && e.slot === 1 && e.by === 'tester'));
    assert.ok(s.events.some((e) => e.type === 'restarted' && e.slot === 1));
    assert.equal(s.balancer.errors, 0);
  });

  await t.test('a crashed worker is respawned and the reason is in the journal', async () => {
    const victim = (await call('/exit?code=3')).json.bye;
    const s = await until('respawn', async () => {
      const st = await status();
      const w = st && st.workers.find((x) => x.restarts === 1);
      return w && w.state === 'listening' && w.pid !== victim ? st : null;
    });
    const w = s.workers.find((x) => x.restarts === 1);
    assert.equal(w.lastExit.code, 3);
    assert.equal(w.lastExit.reason, 'error');
    const e = s.events.find((x) => x.type === 'worker-exit');
    assert.equal(e.pid, victim);
    assert.equal(e.slot, w.slot);
    assert.equal(Object.keys(await pids()).length, 3);
  });

  await t.test('a worker with a blocked event loop is avoided, writes survive, the stall is journaled', async () => {
    for (let i = 0; i < 9; i += 1) await call('/whoami'); // warm keep-alive sockets to every worker
    const blocked = call('/block?ms=5600');
    await sleep(150);
    const answers = [];
    for (let i = 0; i < 30; i += 1) {
      answers.push(await call('/api', { method: 'POST', body: JSON.stringify({ i }) }));
      await sleep(100);
    }
    const b = await blocked;
    assert.equal(b.status, 200);
    assert.ok(answers.every((a) => a.status === 200), 'no Bad gateway while one worker is busy');
    assert.ok(answers.every((a) => a.json.pid !== b.json.pid), 'new requests went to the other workers');
    assert.ok(Math.max(...answers.map((a) => a.ms)) < 1000, 'and they were not held up');
    const s = await until('stall event', async () => {
      const st = await status();
      return st && st.events.some((e) => e.type === 'stall') ? st : null;
    });
    const e = s.events.find((x) => x.type === 'stall');
    assert.ok(e.ms >= 5000 && e.pid === b.json.pid, JSON.stringify(e));
    assert.equal(s.workers.find((w) => w.pid === b.json.pid).stalls, 1);
    assert.equal(s.balancer.errors, 0);
  });

  await t.test('heap limit from the config is applied by a rolling replace', async () => {
    const before = (await call('/whoami')).json.heapLimitMb;
    writeConfig({ enabled: true, workers: 3, affinity: 'off', heapMb: 300 });
    sup.kill('SIGHUP');
    await until(
      'all workers on the new heap limit',
      async () => {
        const s = await status();
        if (!s || s.workers.length !== 3 || !s.workers.every((w) => w.state === 'listening' && w.heapMb === 300)) return null;
        const limits = new Set();
        for (let i = 0; i < 9; i += 1) limits.add((await call('/whoami')).json.heapLimitMb);
        return limits.size === 1 && [...limits][0] !== before ? [...limits][0] : null;
      },
      60_000,
    ).then((limit) => {
      assert.ok(limit >= 300 && limit < 460, `heap limit ${limit} MB (was ${before})`);
    });
  });

  await t.test('switching the mode off returns to one single-mode worker', async () => {
    writeConfig({ enabled: false, workers: 1 });
    sup.kill('SIGHUP');
    await until('single worker', async () => {
      const s = await status();
      return s && s.workers.length === 1 && s.workers[0].mode === 'single' && s.workers[0].state === 'listening';
    }, 60_000);
    const r = await call('/whoami');
    assert.equal(r.json.mode, 'single');
  });

  await t.test('SIGTERM stops everything and the journal is on disk', async () => {
    sup.kill('SIGTERM');
    await until('supervisor exit', async () => exited !== null, 20_000);
    assert.equal(exited, 0);
    const lines = fs.readFileSync(path.join(dir, 'multicore', 'events.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    for (const type of ['boot', 'worker-ready', 'restart-requested', 'restarted', 'worker-exit', 'stall', 'reconcile', 'shutdown']) {
      assert.ok(lines.some((e) => e.type === type), `journal has "${type}"`);
    }
  });
});
