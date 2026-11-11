'use strict';
/**
 * Shared config helpers for the supervisor AND the manager plugin (the plugin build bundles this very file,
 * so the config file format has exactly one implementation; see docs/ARCHITECTURE.md "Config file").
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const AFFINITY_MODES = Object.freeze(['off', 'token', 'ip']);
const DEFAULT_CONFIG = Object.freeze({ enabled: false, workers: 1, affinity: 'off', heapMb: 0 });
const HEAP_MIN_MB = 256;

/** Worker affinity ("sticky" routing): anything unknown means 'off', which is the default. */
function normalizeAffinity(value) {
  return AFFINITY_MODES.includes(value) ? value : 'off';
}

/**
 * Heap limit of every worker in MB (`node --max-old-space-size`). 0 = do not pass the flag: the limit then comes from
 * NODE_OPTIONS or from Node's own default. Anything below 256 MB would not even boot NocoBase.
 */
function normalizeHeapMb(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  const hostMb = Math.floor(os.totalmem() / 1048576);
  return Math.max(HEAP_MIN_MB, Math.min(n, Math.max(HEAP_MIN_MB, hostMb)));
}

function storageDir(env = process.env) {
  if (env.MULTICORE_STORAGE) return path.resolve(env.MULTICORE_STORAGE);
  if (env.STORAGE_PATH) return path.resolve(process.cwd(), env.STORAGE_PATH);
  return path.resolve(process.cwd(), 'storage');
}

function configPath(env = process.env) {
  return env.MULTICORE_CONFIG ? path.resolve(env.MULTICORE_CONFIG) : path.join(storageDir(env), 'multicore', 'config.json');
}

function statusPath(env = process.env) {
  return path.join(path.dirname(configPath(env)), 'status.json');
}

/** Journal of the supervisor (worker exits, restarts, stalls, ...): JSON lines, trimmed by the supervisor. */
function eventsPath(env = process.env) {
  return path.join(path.dirname(configPath(env)), 'events.log');
}

function maxWorkers(env = process.env) {
  const fromEnv = Number(env.MULTICORE_MAX_WORKERS);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return Math.min(fromEnv, 64);
  const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(2, Math.min(cpus * 2, 32));
}

function clampWorkers(value, env = process.env) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, maxWorkers(env));
}

function readConfig(env = process.env) {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(env), 'utf8'));
    return {
      enabled: Boolean(raw.enabled),
      workers: clampWorkers(raw.workers, env),
      affinity: normalizeAffinity(raw.affinity),
      heapMb: normalizeHeapMb(raw.heapMb),
      updatedAt: raw.updatedAt || null,
      updatedBy: raw.updatedBy || null,
    };
  } catch (error) {
    return { ...DEFAULT_CONFIG, updatedAt: null, updatedBy: null };
  }
}

/** Atomic write: tmp file + rename, so the supervisor never reads a half-written file. */
function writeConfig(config, env = process.env) {
  const file = configPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = {
    enabled: Boolean(config.enabled),
    workers: clampWorkers(config.workers, env),
    affinity: normalizeAffinity(config.affinity),
    heapMb: normalizeHeapMb(config.heapMb),
    updatedAt: new Date().toISOString(),
    updatedBy: config.updatedBy || null,
  };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
  fs.renameSync(tmp, file);
  return body;
}

module.exports = {
  AFFINITY_MODES,
  normalizeAffinity,
  normalizeHeapMb,
  DEFAULT_CONFIG,
  storageDir,
  configPath,
  statusPath,
  eventsPath,
  maxWorkers,
  clampWorkers,
  readConfig,
  writeConfig,
};
