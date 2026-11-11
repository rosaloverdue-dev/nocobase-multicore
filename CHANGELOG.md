# Changelog

## 0.2.0 — 2026-11-11
**Fixes (all present since 0.1.0)**
* **Balancer sent almost all traffic to one worker.** A request cancelled by the browser was retried on another worker, and that second attempt was never released from the "requests in flight" counter. The leaked counts piled up on every worker except one, so the least-busy rule kept choosing that one; cancelled heavy requests were also executed twice. Now a request whose client is gone is cancelled and never retried, and every attempt is released exactly once. (Reproduction: 40 aborted `GET`s → 80 upstream hits and the next 200 requests split 0/200/0/0; now 40 hits and 50/50/50/50.)
* **`Bad gateway: the application worker did not answer` without any worker dying.** Node closes idle keep-alive connections after 5 s; a worker whose event loop was blocked longer ran those overdue timers first when it woke up and destroyed connections that already carried requests. Reads were retried, writes failed with 502. Workers now keep idle connections for 10 min (`MULTICORE_KEEPALIVE_MS`) and the balancer closes them after 8 s; in addition bodies up to 1 MiB are buffered so a write can be replayed when the worker certainly did not process it (connection refused, or a reused socket reset before the first response byte while the worker is alive).
* **Queue: a long job could be started twice.** A message whose handler ran for more than 35 s was taken over by another worker. A running job is now refreshed by its worker every 10 s (`XCLAIM … JUSTID`); only messages nobody refreshed for 90 s are taken over.
* A worker with a blocked event loop no longer disappears from the worker table: the table is built from the supervisor's slot list, Redis heartbeats only add details.
* A replacement worker that fails to start no longer causes the old worker to be drained; the old one keeps serving.
* New workers do not take the snowflake id of a live sibling whose Redis lease expired during a long stall (`MULTICORE_WID_AVOID`).
* Removing/disabling a plugin (safeguard) keeps the other settings of `config.json` instead of dropping them.

**New**
* **Lag-aware balancing**: workers report their event-loop lag with every heartbeat (twice a second); the load score is requests in flight + lag/100 ms (lag under 50 ms is ignored as timer jitter). Stall threshold 1.5 s (was 2.5 s).
* **Settings page**: overview tiles (workers, users online, open tabs, requests per second, balancer errors, server memory); worker table with state (running / not responding for N s / starting / being replaced), memory and heap limit, requests per second, average response time, open tabs, users, crashes and stalls with the last reason.
* **Restart a worker** / **Restart all, one by one** — zero-downtime, also as `POST /api/multicore:restart`.
* **Who is connected**: per worker or for the whole cluster — user, login, open tabs, connected since, IP, workers (`GET /api/multicore:connections`). Uses the WebSocket connections NocoBase already tracks.
* **Event journal** on the page and in `storage/multicore/events.log`: worker exits with the reason (out of memory, killed, exit code), stalls of 5 s and more with their duration, restarts and who asked, Bad-gateway answers.
* **Worker memory limit** (`heapMb` → `--max-old-space-size`) from the settings page, applied by a rolling replace.
* **Database connection budget warning** when `(workers + 1) × DB_POOL_MAX` exceeds `max_connections`.
* WebSocket: a refused upstream connection is retried on another worker; half-closed tunnels are torn down.

**Performance**
* The status page no longer scans the Redis keyspace (`SCAN`) on every refresh: workers register in a sorted set; heartbeat is one pipeline; the page stops polling in a background browser tab.
* Queue acknowledgement is one round trip instead of two.
* Proxy overhead unchanged (≈8–9k req/s through the balancer on 2 cores, same as 0.1.2, with or without bodies).

**Tests** — `npm run test:unit` (47 tests): balancer regressions, supervisor end-to-end with fake workers (boot, even split, zero-downtime restart, crash + respawn, stall without Bad gateway, heap limit, scale down), queue adapter / worker-id / manager plugin against a real Redis. `npm run test:ui`: the settings page in headless Chromium with a mock API. **Not yet re-run on a NocoBase stand** — see `docs/TEST-REPORT.md`.

**Upgrade** — replace the plugin folders and `storage/multicore/supervisor`, then restart the app (the supervisor itself must restart to load the new balancer). `config.json` is compatible.

## 0.1.2 — 2026-11-07
* **Worker-id lease: no more false "id owned by another process" exits.** After a long event-loop stall (a heavy request blocking a worker for a minute) several queued renew ticks ran concurrently: one reclaimed the id, the next saw the key holding the worker's *own* token and exited the worker, so in-flight requests got `Bad gateway: the application worker did not answer`. Renewals are now serialized and a key that holds our own token is never a conflict. Unit test added (16 tests).
* Known limit (unchanged): a request that blocks one worker's event loop for a long time still stalls that worker; the balancer routes new requests to the other workers.

## 0.1.1 — 2026-11-07
* **Worker affinity (sticky routing), optional and OFF by default.** *Settings → Multi-core mode → Worker affinity*: off / by login token / by client IP. Applied instantly without restarting workers. The preferred worker is skipped when it is stalled, draining or clearly busier than the least busy one. For plugins that keep state in process memory (for example an "online users" counter that kicked users out with 401 in cluster mode). See `docs/KNOWN-ISSUES.md`.
* **Worker-id lease loss fixed.** The lease is now 60 s (was 30 s); if it expires the allocator takes the *same* id back; if another process already owns it, a supervised worker exits and the supervisor respawns it with a fresh id (no more two workers on one id). Unit tests with a fake Redis.
* **`install.sh` upgrade path fixed:** re-running the installer no longer drops Redis from the compose override (workers started without `REDIS_URL` and silently ran with in-memory adapters).
* `install.sh` writes `COMPOSE_FILE` into the project's `.env` (and `uninstall.sh` removes it), so a plain `docker compose up -d` keeps the supervisor.
* Docs: how to restart the app and how to update NocoBase itself (verified 2.2.33 → 2.2.34), known issue about plugins with in-process state; trilingual.
* Tests: 15 unit tests (`npm run test:unit`).

## 0.1.0 — 2026-11-07
Highlights of the release:

* **Least-busy load balancer** inside the supervisor: workers listen on private loopback ports, each HTTP request / WebSocket goes to the least busy worker, stalled workers are avoided, rolling replace drains in-flight requests. `MULTICORE_BALANCER=off` restores the shared-port mode. Live counters in the admin page and `status.json`.
* **One-command install**: `install.sh --docker <container> [--workers N]` adds Redis to the Docker Compose project, switches the entrypoint and recreates the app; `--local <dir> --redis-url URL` for project folders; `uninstall.sh` reverts everything (`--purge` also removes the Redis volume).
* Installer uses `postinstall` + `pm enable` (`pm add` does nothing for local plugins on NocoBase 2.2.33).
* Worker entry works with a bare `.env` (no `APP_PACKAGE_ROOT`), as in local installs.
* Admin page in English, Russian and Simplified Chinese; menu title is localised; per-worker requests in flight / served.
* English documentation and README with language switcher (EN / RU / 中文); Russian originals of the long docs in `docs/ru/`.
* Unit tests for the balancer (`npm run test:unit`).
* Optional donations: Boosty button in the three READMEs and `.github/FUNDING.yml`.
* Legal: `LICENSE` now holds the full AGPL-3.0 text; new `NOTICE` (independent project, NocoBase trademark, NocoBase's own license terms); both ship inside every archive.

Details:

First release. Verified on NocoBase 2.2.33 (see `docs/TEST-REPORT.md`).

* Supervisor (`node:cluster`) with rolling mode switch, scale up/down, crash respawn with backoff.
* Redis adapters as plugins: pub/sub, lock, event queue (Streams), worker-id allocator.
* Manager plugin: settings page with a multi-core switch and worker counter, live worker table, cluster self-test (ru/en).
* Fixes found while testing on the stand: worker bootstrap (`initEnv`), workers now exit on SIGTERM, scale-down before replace, worker leaves the round-robin before SIGTERM, worker accepts connections only when the app is `running`, `listening` of the IPC socket no longer counts as ready, real slot ids in the worker table, client stub for server-only plugins (the UI failed with a requirejs `Script error` without it).
* **Fix:** worker-id allocator is installed in `afterAdd` (the core asks for the id before `beforeLoad`); previously ~27 % of workflow executions were lost with `id must be unique`. `release()` is a no-op (the lease lives as long as the process).
* Self-test checks that every worker has a distinct worker id; the worker table marks the adapter as active only if its id is really in use.
* Safeguard: disabling/removing any of the five plugins switches cluster mode off first (`packages/shared/src/safeguard.ts`).
* `scripts/install.sh` / `scripts/uninstall.sh`, bundle `nocobase-multicore-bundle-<ver>.tgz` (5 plugin tgz + supervisor + scripts), entrypoint moved to `packages/supervisor/docker/entrypoint.sh`.
* `tests/workflow.js`; trilingual (EN/RU/ZH) README and per-package READMEs; plugin descriptions/homepage links (en/ru/zh) for the plugin manager.
