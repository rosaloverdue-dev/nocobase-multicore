# AGENTS.md — manifest for AI agents working on this repository

Read this file first. It tells you what the project is, how it is built, how to test it, what is verified and what is not, and what to do next. Humans: see `README.md` and `docs/`.

## 1. What this repository is

`nocobase-multicore` makes **NocoBase 2.x run on several CPU cores** and adds an **admin page with a switch** ("Settings → Multi-core mode") that turns multi-core mode on/off and sets the number of workers.

NocoBase (community edition) is a single Node.js process. Its open core already contains pluggable adapters for everything that must be shared between processes, but the default adapters are in-memory. This repo supplies **Redis-backed adapters as NocoBase plugins**, a **supervisor** that runs N worker processes sharing one port (`node:cluster`), and a **manager plugin** with the UI and API. No NocoBase core code is patched.

Licence: AGPL-3.0-only (this project; NocoBase itself is under its own NocoBase License Agreement, see `NOTICE`). Package scope: `@nb-multicore/*`. Target: NocoBase `2.x` (developed and tested on `2.2.33`, Docker image `nocobase/nocobase`).

## 2. Components

| Path | Package | Role |
|---|---|---|
| `packages/supervisor` | `nocobase-multicore-supervisor` (plain Node, no NocoBase imports) | `bin/nocobase-multicore.js` launcher = cluster **primary**. Forks workers, rolling replace on mode change, scale up/down, respawn with backoff, writes `storage/multicore/status.json`. `lib/worker-entry.js` is what each worker runs: it executes the NocoBase CLI `initEnv()` and loads the app entry. `lib/config.js` is the config-file format, shared with the manager plugin. |
| `packages/plugin-pubsub-adapter-redis` | `@nb-multicore/plugin-pubsub-adapter-redis` | `app.pubSubManager.setAdapter(...)`. Cross-process events (cache invalidation, metadata sync messages, ...). |
| `packages/plugin-lock-adapter-redis` | `@nb-multicore/plugin-lock-adapter-redis` | `app.lockManager.registerAdapter('redis', ...)` and makes it the default. `SET NX PX` + Lua release/extend, heartbeat renewal. |
| `packages/plugin-queue-adapter-redis` | `@nb-multicore/plugin-queue-adapter-redis` | `app.eventQueue.setAdapter(...)`. Redis Streams + consumer group; each message goes to exactly one worker; stalled messages are reclaimed (`XAUTOCLAIM`). At-least-once. |
| `packages/plugin-worker-id-allocator-redis` | `@nb-multicore/plugin-worker-id-allocator-redis` | `app.workerIdAllocator.setAdapter(...)`. 32 leased snowflake worker ids so two workers never generate the same id. |
| `packages/plugin-multicore` | `@nb-multicore/plugin-multicore` | The manager: ACL snippet `pm.multicore`, resource `multicore` (`status`, `apply`, `selftest`, `whoami`), per-worker heartbeat to Redis, and the client settings page (en/ru/zh). |
| `packages/shared` | (bundled into each plugin) | env helpers, `skipReason()`. |
| `scripts/build.mjs` | | esbuild-based builder. Produces `build/<plugin>/` (ready plugin dir) and `build/*.tgz`. |
| `tests/` | | Black-box probes run against a live stand: `consistency.js`, `bench.js`. |
| `docker/` | | Entrypoint + compose override used to run the stock `nocobase/nocobase` image under the supervisor. |
| `docs/` | | `ARCHITECTURE.md`, `OPERATIONS.md`, `TEST-REPORT.md`, `KNOWN-ISSUES.md`. |

## 3. Runtime model (the one thing to understand)

```
nocobase-multicore (supervisor, node:cluster primary, no NocoBase code)
  ├─ balancer (lib/balancer.js): owns the public port, routes each request / WebSocket to the least busy worker
  ├─ worker slot 0  ── NocoBase app (private 127.0.0.1 port) ─┐
  ├─ worker slot 1  ── NocoBase app (private 127.0.0.1 port) ─┼─ SCHED_NONE, no shared port
  └─ worker slot N  ── NocoBase app (private 127.0.0.1 port) ─┘
          │ all of them talk through Redis: pub/sub, locks, queue, worker ids, cache
```

* Config: `storage/multicore/config.json` → `{ "enabled": bool, "workers": n, "updatedAt", "updatedBy" }`. Written atomically by the manager plugin; re-read by the supervisor on IPC message, on `SIGHUP`, and by a 10 s poll.
* Worker env set by the supervisor: `MULTICORE_SUPERVISED=1`, `MULTICORE_MODE=cluster|single`, `MULTICORE_SLOT=<n>`, and in cluster mode `REDIS_URL`, `CACHE_DEFAULT_STORE=redis`, `CACHE_REDIS_URL` (unless already set).
* **The adapter plugins activate only when `MULTICORE_MODE === 'cluster'` and `REDIS_URL` is set** (`skipReason()` in `packages/shared/src/env.ts`). Otherwise NocoBase behaves exactly as stock. This is what makes the switch safe: turning the mode off falls back to a single process with stock in-memory adapters.
* Mode change = **rolling replace**: start a new worker (temporary slot id 1000+n), wait for `listening`, drain the old one (SIGTERM, 30 s grace then SIGKILL), repeat. Scale-down drains the highest slots first. A crashed worker is respawned with exponential backoff (1 s → 30 s).
* Worker → supervisor IPC: `{cmd:'multicore', type:'apply'|'status', reqId}`; replies `apply:ack` / `status:res`.
* Redis key prefix: `${MULTICORE_REDIS_PREFIX||'mcore'}:${MULTICORE_NAMESPACE||DB_DATABASE||'nocobase'}`.
* First boot of slot 0 uses `start --quickstart` (install/upgrade). `MULTICORE_QUICKSTART=0` disables.

NocoBase extension points used (all in the open core, check them when upgrading NocoBase): `pubSubManager.setAdapter`, `lockManager.registerAdapter` + `lockManager.options.defaultAdapter`, `eventQueue.setAdapter`, `workerIdAllocator.setAdapter`, `redisConnectionManager.getConnectionSync`, `app.on('afterStart'|'beforeStop')`.

## 4. Build

```bash
# needs only esbuild (npm i -D esbuild, or ESBUILD_MODULE=/path/to/esbuild/lib/main.js)
node scripts/build.mjs            # readable bundles
MINIFY=1 node scripts/build.mjs   # small server bundles (used when the only transfer channel is text)
```

Output: `build/plugin-*/` (drop into `storage/plugins/@nb-multicore/<name>/`), `build/nb-multicore-plugin-*-<version>.tgz`, `build/nocobase-multicore-supervisor-<version>.tgz`. The client bundle is wrapped in a UMD/AMD shim with externals `react`, `antd`, `@nocobase/client`, `@ant-design/icons`. `dist/externalVersion.js` reads versions from the host install, so the plugin-manager compatibility check passes for any 2.x host.

There is no unit-test runner wired up and **CI is not available** (no CI runners are configured). Unit tests: `npm run test:unit` (balancer). Everything else is verified on a live stand (below). Do not add a workflow that cannot run.

## 5. How to test (the stand)

A throw-away stack: Postgres 16 + Redis 7 + `nocobase/nocobase:2.2.33`, with the plugin dirs mounted/copied into `storage/plugins/@nb-multicore/`. See `docker/` and `docs/OPERATIONS.md` for the exact compose files.

1. Start stock (single process), `pm add` + `pm enable` the five plugins:
   `yarn nocobase pm add @nb-multicore/<name>` then `yarn nocobase pm enable @nb-multicore/<name> ...`.
2. Restart with `docker-compose.multicore.yml` (entrypoint replaced; supervisor runs).
3. Sign in (`POST /api/auth:signIn`) and call `POST /api/multicore:apply {"enabled":true,"workers":2}`.
4. `POST /api/multicore:selftest` must return `ok:true` (pub/sub reaches every worker, lock excludes, 20 queue jobs processed once each).
5. `node tests/consistency.js` (cross-worker metadata/write consistency), `node tests/bench.js` (throughput), `node tests/workflow.js` (workflow triggers; env `BASE_URL NB_USER NB_PASSWORD`).

Results of the runs done so far are in `docs/TEST-REPORT.md`. Re-run them after any change to adapters or the supervisor.

### Hard safety rules for the lab
* Only ever use a dedicated development/test server. **Never touch any production server or its containers.** Use a separate docker network, loopback-only ports and memory limits.
* Verify file transfers with `sha256sum`.

## 6. Verified vs. not verified

Verified on NocoBase 2.2.33 (see `docs/TEST-REPORT.md`):
* Supervisor runs the stock image; workers share the port; mode switch single⇄cluster and 1⇄2⇄3 workers are rolling and clean.
* All four adapters become active in cluster mode; self-test passes repeatedly.
* Collection/field create propagates to every worker in ≈0.6–1.1 s; row writes/reads across workers are consistent.

Known upstream behaviour (not caused by this repo, reproducible in single-process mode too): see `docs/KNOWN-ISSUES.md`.

Also verified: workflow collection + schedule triggers and create-record node (`tests/workflow.js`), safeguard auto-off, uninstall while cluster is on, `install.sh`/`uninstall.sh` in Docker.

Also verified: `install.sh --docker` (Compose, Redis auto) and `--local`, the settings page in en/ru/zh in a headless browser, the least-busy balancer.

Not verified / open: file uploads with local storage across workers (needs shared volume), WebSocket/SSE sticky behaviour, Redis outage behaviour, long-running soak, NocoBase versions other than 2.2.33.

## 7. Conventions and gotchas for editing

* The supervisor and `shared/` must stay free of NocoBase imports. Plugins must **not** import `redis`; use `app.redisConnectionManager` (the host provides node-redis v5).
* **Lifecycle gotcha:** the worker-id adapter MUST be set in `afterAdd()` (core asks `workerIdAllocator` before plugins' `beforeLoad`). Pub/sub, lock and queue adapters are fine in `beforeLoad`.
* Layout: installers `scripts/install.sh`, `scripts/uninstall.sh`; supervisor entrypoint `packages/supervisor/docker/entrypoint.sh`; shared safeguard `packages/shared/src/safeguard.ts`; docs are trilingual (`README.md`, `README.ru.md`, `README.zh-CN.md`, per-package READMEs) generated by hand-maintained data — update all three languages together.
* Plugin `load()` can run again on app reload: adapters that own timers/clients are kept as singletons with `rebind(app)` (see worker-id allocator).
* Anything that changes the worker env must be reflected in `Supervisor.workerEnv()` and documented in `docs/OPERATIONS.md`.
* A worker must exit on SIGTERM: NocoBase stops the app but leaves handles open, so `worker-entry.js` installs a timer that calls `process.exit(0)` after `MULTICORE_EXIT_GRACE_MS` (default 10 s). Do not remove it, or every rolling replace waits for the SIGKILL.
* Non-zero worker slots (and replacement workers) get a unique `SOCKET_PATH` because the NocoBase gateway IPC socket is owned by one process.
* NocoBase 2.2.33: `pm add <name>` does nothing for plugins already in `storage/plugins`; the installer runs `yarn nocobase postinstall` (symlinks into node_modules) and then `pm enable` (creates the DB rows).
* **Every plugin needs `dist/client/index.js`**, even server-only ones: the NocoBase web app loads the client bundle of every enabled plugin through requirejs, and a 404 stops the whole UI with `Script error for "@nb-multicore/..."`. `scripts/build.mjs` generates a minimal stub for the plugins without `src/client`.
* Keep user-facing text bilingual (en/ru/zh) in the client bundle; user docs are in English with Russian and Chinese translations; this file and code comments are in English.

## 8. What to do next (backlog, most valuable first)

1. ~~Schedule triggers~~ verified (fire once per tick). Remaining: soak test with workflows, sync workflows under extreme concurrency (stock limit).
2. Local-storage file uploads: document/verify a shared volume, or add a storage check to the self-test.
3. Redis outage handling (reconnect, degrade, health banner) and `maxmemory` guidance.
4. Sticky routing for WebSocket / SSE if the stock gateway needs it.
5. Real unit tests for adapters against a Redis container; a script that automates the whole stand (`tests/run-stand.sh`).
6. Support other NocoBase minor versions: CI matrix when CI becomes available.
7. Publish the plugins to an npm registry (currently distributed as `.tgz` GitHub release assets).

## 9. Delivery workflow

* Work on a branch, open a **pull request yourself** (use `gh api repos/<owner>/<repo>/pulls` if `gh pr create` is blocked) and share the link; a maintainer merges.
* Releases are created by the agent with the built `.tgz` files attached.
