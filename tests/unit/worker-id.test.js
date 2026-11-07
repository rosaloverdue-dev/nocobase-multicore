'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The allocator is TypeScript and imports @nocobase/server: bundle it with esbuild, stubbing the host package.
async function load() {
  let esbuild;
  for (const c of [process.env.ESBUILD_MODULE, 'esbuild', '/opt/npm-tools/node_modules/esbuild/lib/main.js'].filter(Boolean)) {
    try {
      esbuild = require(c);
      break;
    } catch (e) {
      // try next
    }
  }
  if (!esbuild) return null;
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wid-')), 'wid.cjs');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '../../packages/plugin-worker-id-allocator-redis/src/server/index.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: out,
    logLevel: 'silent',
    plugins: [
      {
        name: 'stub-host',
        setup(b) {
          b.onResolve({ filter: /^@nocobase\/server$/ }, () => ({ path: 'stub', namespace: 'stub' }));
          b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export class Plugin {}', loader: 'js' }));
        },
      },
    ],
  });
  return require(out);
}

/** Minimal Redis stand-in: SET NX PX, EVAL(extend) with the real semantics of the Lua script. */
function fakeRedis() {
  const data = new Map();
  return {
    data,
    isOpen: true,
    async set(key, value, opts = {}) {
      if (opts.NX && data.has(key)) return null;
      data.set(key, value);
      return 'OK';
    },
    async get(key) {
      return data.has(key) ? data.get(key) : null;
    },
    async eval(script, { keys, arguments: args }) {
      return data.get(keys[0]) === args[0] ? 1 : 0;
    },
  };
}

const logger = () => {
  const lines = [];
  return { lines, info: (m) => lines.push(['info', m]), warn: (m) => lines.push(['warn', m]), error: (m) => lines.push(['error', m]) };
};

async function make(client) {
  const mod = await load();
  if (!mod) return null;
  process.env.MULTICORE_MODE = 'cluster';
  const log = logger();
  const app = { logger: log, redisConnectionManager: { getConnectionSync: async () => client } };
  const alloc = new mod.RedisWorkerIdAllocator(app);
  let exited = null;
  alloc.terminate = (code) => {
    exited = code;
  };
  return { alloc, log, exited: () => exited };
}

test('two allocators never get the same id', async (t) => {
  const redis = fakeRedis();
  const a = await make(redis);
  if (!a) return t.skip('esbuild is not available');
  const b = await make(redis);
  const ia = await a.alloc.getWorkerId();
  const ib = await b.alloc.getWorkerId();
  assert.notEqual(ia, ib);
  clearInterval(a.alloc.timer);
  clearInterval(b.alloc.timer);
});

test('a lease that expired is reclaimed (same id), process keeps running', async (t) => {
  const redis = fakeRedis();
  const a = await make(redis);
  if (!a) return t.skip('esbuild is not available');
  process.env.MULTICORE_SUPERVISED = '1';
  const id = await a.alloc.getWorkerId();
  clearInterval(a.alloc.timer);
  redis.data.clear(); // lease expired / Redis flushed
  await a.alloc.renew();
  assert.equal(a.exited(), null);
  assert.equal(a.alloc.currentId, id);
  assert.equal(redis.data.get(`mcore:${process.env.DB_DATABASE || 'nocobase'}:wid:${id}`), a.alloc.token);
});

test('id stolen by another process: supervised worker exits, unsupervised only logs', async (t) => {
  const redis = fakeRedis();
  const a = await make(redis);
  if (!a) return t.skip('esbuild is not available');
  const id = await a.alloc.getWorkerId();
  clearInterval(a.alloc.timer);
  const key = [...redis.data.keys()][0];
  redis.data.set(key, 'someone-else');
  process.env.MULTICORE_SUPERVISED = '1';
  await a.alloc.renew();
  assert.equal(a.exited(), 1);
  assert.ok(a.log.lines.some(([l, m]) => l === 'error' && /exiting/.test(m)));

  const c = await make(redis);
  c.alloc.id = id;
  c.alloc.token = a.alloc.token;
  process.env.MULTICORE_SUPERVISED = '0';
  await c.alloc.renew();
  assert.equal(c.exited(), null);
  assert.ok(c.log.lines.some(([l, m]) => l === 'error' && /restart this process/.test(m)));
});

test('queued renew ticks after a stall do not mistake our own reclaimed lease for a conflict', async (t) => {
  const redis = fakeRedis();
  const a = await make(redis);
  if (!a) return t.skip('esbuild is not available');
  process.env.MULTICORE_SUPERVISED = '1';
  await a.alloc.getWorkerId();
  clearInterval(a.alloc.timer);
  redis.data.clear(); // lease expired during a long stall
  await Promise.all([a.alloc.renew(), a.alloc.renew(), a.alloc.renew()]);
  assert.equal(a.exited(), null);
  // even a racing renew that lost the NX race to our own earlier SET is not a conflict
  const key = [...redis.data.keys()][0];
  redis.data.set(key, a.alloc.token);
  const realEval = redis.eval;
  let first = true;
  redis.eval = async (...x) => { if (first) { first = false; return 0; } return realEval(...x); };
  await a.alloc.renew();
  assert.equal(a.exited(), null);
});
