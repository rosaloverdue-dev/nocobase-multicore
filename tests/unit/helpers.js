'use strict';
/**
 * Helpers shared by the unit tests.
 *
 *  bundle(entry)  compiles a TypeScript source of this repo with esbuild, stubbing the NocoBase host packages
 *                 (null when esbuild is not installed -> the test skips itself).
 *  redis()        a connected node-redis client for tests that need a REAL Redis (null -> the test skips itself).
 *                 Needs a Redis server (TEST_REDIS_URL, default redis://127.0.0.1:6399/0) and the `redis` package
 *                 (or REDIS_CLIENT_MODULE=/path/to/a/module exporting createClient).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function findEsbuild() {
  for (const c of [process.env.ESBUILD_MODULE, 'esbuild', '/opt/npm-tools/node_modules/esbuild/lib/main.js'].filter(Boolean)) {
    try {
      return require(c);
    } catch (e) {
      // try next
    }
  }
  return null;
}

const STUBS = {
  // `Gateway.getInstance()` returns whatever the test put into globalThis.__fakeGateway
  '@nocobase/server':
    'export class Plugin { constructor(app){ this.app = app; } get db(){ return this.app.db; } }\n' +
    'export const Gateway = { getInstance: () => globalThis.__fakeGateway };',
  '@nocobase/lock-manager': 'export class LockAcquireError extends Error {}',
};

async function bundle(entry) {
  const esbuild = findEsbuild();
  if (!esbuild) return null;
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcore-')), 'bundle.cjs');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '../..', entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: out,
    logLevel: 'silent',
    plugins: [
      {
        name: 'stub-host',
        setup(b) {
          b.onResolve({ filter: /^@nocobase\// }, (args) => ({ path: args.path, namespace: 'stub' }));
          b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: STUBS[args.path] || 'module.exports = {};', loader: 'js' }));
        },
      },
    ],
  });
  return require(out);
}

function redisModule() {
  for (const c of [process.env.REDIS_CLIENT_MODULE, 'redis'].filter(Boolean)) {
    try {
      const mod = require(c);
      if (typeof mod.createClient === 'function') return mod;
    } catch (e) {
      // try next
    }
  }
  return null;
}

const TEST_REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6399/0';
const opened = [];

/** A new connected client, or null when no client library / no server is available. */
async function redis() {
  const mod = redisModule();
  if (!mod) return null;
  const client = mod.createClient({ url: TEST_REDIS_URL, socket: { reconnectStrategy: false, connectTimeout: 1500 } });
  client.on('error', () => undefined);
  try {
    await client.connect();
  } catch (e) {
    return null;
  }
  opened.push(client);
  return client;
}

/** What plugins get from the host: `app.redisConnectionManager.getConnectionSync(name)` -> one client per name. */
function connectionManager() {
  const byName = new Map();
  return {
    async getConnectionSync(name) {
      if (!byName.has(name) || !byName.get(name).isOpen) byName.set(name, await redis());
      return byName.get(name);
    },
  };
}

function closeAll() {
  for (const c of opened.splice(0)) {
    try {
      c.destroy();
    } catch (e) {
      // already closed
    }
  }
}

const logger = () => {
  const lines = [];
  const push = (level) => (message) => lines.push([level, String(message)]);
  return { lines, info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug'), trace: push('trace') };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { bundle, redis, connectionManager, closeAll, logger, sleep, TEST_REDIS_URL };
