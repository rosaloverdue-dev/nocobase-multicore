# Operations

## Requirements
* NocoBase 2.x (tested 2.2.33), Node.js 20+ in the image.
* Redis 6+ (tested 7.4), `maxmemory-policy noeviction` (or at least no eviction of `mcore:*` keys).
* PostgreSQL/MySQL as for plain NocoBase. Every worker has its own connection pool and a rolling restart runs one extra worker for a while: keep `(workers + 1) × DB_POOL_MAX` below the database's `max_connections` (the settings page warns when it is not).

## Install and uninstall (one command)
From the unpacked bundle `nocobase-multicore-bundle-<version>.tgz`:
```bash
./install.sh --docker <container>          # Docker Compose: Redis + entrypoint are configured for you
./install.sh --local /path/to/nocobase     # bare-metal / VM; give your Redis: --redis-url redis://host:6379/0
./uninstall.sh --docker <container>        # --purge also removes the supervisor files and the Redis volume
```
`install.sh` options: `--workers N` (switch cluster mode on right away), `--redis-url URL`, `--no-switch`, `--no-enable`, `--from <dir with tgz>`, `--restart`.

For a Docker Compose container it reads the compose labels, writes `docker-compose.multicore.yml` next to your compose file (supervisor entrypoint, `REDIS_URL`, a `multicore-redis` service attached to the app's network) and recreates the app with `docker compose up -d`. If the app already has `REDIS_URL`, no Redis service is added. `uninstall.sh` removes the override again and recreates the app with its original entrypoint.

Manual Redis is only needed for: containers not started by Docker Compose, `--local` installs, and plugins uploaded through *Plugin manager → Add* (pass `--redis-url`, or set `REDIS_URL` yourself).

## Launcher files
`storage/multicore/supervisor/` (put there by `install.sh`; source in `packages/supervisor`). Entry point: `node storage/multicore/supervisor/bin/nocobase-multicore.js`, run from the NocoBase project root (`/app/nocobase` in the image).

## Docker (official `nocobase/nocobase` image)
The image starts the app with the last line of `/app/docker-entrypoint.sh` (`yarn start --quickstart`). `packages/supervisor/docker/entrypoint.sh` takes the stock entrypoint, replaces only that line with the launcher and runs it — the rest of the image preparation (nginx, client files) is kept. If a new image changes the line, the script stops with a clear error.

Add to the `app` service (this is what `install.sh` does for you):
```yaml
entrypoint: ["/bin/sh", "/app/nocobase/storage/multicore/supervisor/docker/entrypoint.sh"]
environment:
  REDIS_URL: redis://redis:6379/0
  # CORS_ORIGIN_WHITELIST: "https://your-address"   # if "Invalid sign-in origin" behind a proxy
```
A ready example: `docker/docker-compose.example.yml`.

## Not Docker
From the project root run `node storage/multicore/supervisor/bin/nocobase-multicore.js` instead of `yarn start`. Environment variables are the same as for a normal start (`.env` is read like `nocobase start` does). The supervisor owns `APP_PORT` (default 13000); workers listen on private loopback ports.

## Enabling plugins manually
```bash
cd /app/nocobase
# 1. unpack each nb-multicore-plugin-<name>-<version>.tgz into storage/plugins/@nb-multicore/plugin-<name>/
# 2. link the plugins into node_modules (NocoBase 2.x: `pm add` does nothing for plugins that are already in storage/plugins)
yarn nocobase postinstall
yarn nocobase pm enable @nb-multicore/plugin-pubsub-adapter-redis @nb-multicore/plugin-lock-adapter-redis \
  @nb-multicore/plugin-queue-adapter-redis @nb-multicore/plugin-worker-id-allocator-redis @nb-multicore/plugin-multicore
```
Plugin folders live in `storage/plugins/@nb-multicore/<name>/`. Or upload the `.tgz` files from the release via *Plugin manager → Add → Upload*. **Enabling/uploading from the UI while the cluster runs reaches only the worker that served the request — restart the app afterwards.**

## Workflows and removing plugins
* Triggers and workflows behave as in a single process (`tests/workflow.js`: no duplicates, no losses). The plugins create no tables and change no data.
* Disabling/removing any plugin first switches the cluster off (`turnOffClusterMode` writes `enabled:false`); the supervisor returns to one process. No manual recovery is needed.
* The queue is *at-least-once*: workflow actions should be idempotent.

## Production checklist
1. Back up the database and `storage/`.
2. Try on a copy / test server first (`tests/workflow.js`, self-test).
3. Redis: `maxmemory-policy noeviction`, monitoring; database `max_connections` ≥ workers × pool size.
4. Switch on in a quiet hour, start with 2–3 workers.
5. Roll back: turn the switch off in the UI (or `{"enabled": false}` in `config.json`), or run `uninstall.sh`.

## Control
* UI: Settings → Multi-core mode.
* API (role with `pm.multicore`; root has it):
  * `POST /api/multicore:apply {"enabled":true,"workers":2,"affinity":"off","heapMb":0}` (`affinity`: `off` (default) | `token` | `ip`; `heapMb`: worker heap limit, `0` = not set);
  * `GET /api/multicore:status`, `POST /api/multicore:selftest`, `GET /api/multicore:whoami`;
  * `POST /api/multicore:restart {"slot": 1}` or `{"slot": "all"}` — zero-downtime restart of one worker / of all workers one after another;
  * `GET /api/multicore:connections?slot=1` — who is connected to that worker (omit `slot` for the whole cluster, `&summary=1` for the totals only).
* Files: `storage/multicore/config.json` (settings), `storage/multicore/status.json` (supervisor state incl. balancer stats and the last journal entries), `storage/multicore/events.log` (the journal, JSON lines, trimmed to the last 200 entries when it grows over 512 KB). The supervisor re-reads the config on a worker message, on `SIGHUP`, and every 10 s.

## Restarting a worker by hand
*Settings → Multi-core mode → Workers → Restart* (or *Restart all, one by one*). The supervisor starts a replacement, waits until it serves requests, then removes the old worker from the balancer, lets its requests finish (up to 30 s) and stops it — users notice nothing except that open tabs reconnect their WebSocket. If the replacement does not start, the old worker keeps running and the journal says so. Use it after enabling a plugin from the UI (only one worker saw the change), or to free the memory of a worker that has grown.

## Worker memory limit
Every worker is a separate Node.js process with its own JavaScript heap limit. *Worker memory limit* (`heapMb` in `config.json`) passes `--max-old-space-size=<MB>` to the workers; it wins over a value in `NODE_OPTIONS`. Empty / `0` leaves Node's default (or `NODE_OPTIONS`). A change is applied by a rolling replace. A worker that reaches its limit is killed by Node ("out of memory" in the journal) and respawned, and the requests it was serving fail — so do not set it lower than a single-process NocoBase needed on the same data (the table shows "heap used (limit)" per worker). The limits are ceilings, not reservations: their sum may exceed the RAM as long as the workers do not all fill up at once.

## The event journal
*Settings → Multi-core mode → Event journal*, and `storage/multicore/events.log`. One line per event: `boot`, `reconcile` (config applied), `worker-ready`, `worker-exit` (with `reason`: `oom` — heap limit reached; `killed` — SIGKILL, typically the kernel's out-of-memory killer; `error` + exit code; `crash`; `signal`), `stall` (a worker did not answer heartbeats for ≥ 5 s, with the duration), `restart-requested` / `restarted`, `bad-gateway` (502 answers of the balancer, grouped per 5 s with error codes), `failed`, `shutdown`.

## Worker affinity (sticky routing)
Off by default. *Settings → Multi-core mode → Worker affinity* (or `"affinity"` in `config.json` / `multicore:apply`) makes the balancer send the same user to the same worker: `token` = by the `Authorization: Bearer` token (or `?token=` of a WebSocket URL; requests without a token are balanced normally), `ip` = by `X-Forwarded-For` / the client address. Applied instantly, no worker restart. The preferred worker is skipped when it has no heartbeat (stalled), is draining, or has more than 4 requests in flight more than the least busy worker. Counters `sticky` / `overflowed` are in `status.json`. Why you may need it: [KNOWN-ISSUES](KNOWN-ISSUES.md#plugins-that-keep-state-in-process-memory-users-kicked-out-401-reload-loop).

## Restart and update NocoBase
* Restart: `docker compose restart app` from the project folder. `install.sh` puts `COMPOSE_FILE=<compose file>:<docker-compose.multicore.yml>` into the project's `.env` so plain `docker compose` commands keep using the override; without it use `docker compose -f docker-compose.yml -f docker-compose.multicore.yml up -d` (otherwise NocoBase silently starts as one process, without Redis).
* Update NocoBase (verified 2.2.33 → 2.2.34 on Docker Compose): back up DB and `storage/`; change the image tag in `docker-compose.yml`; `docker compose pull && docker compose up -d`; wait 1–3 minutes (the entrypoint runs the NocoBase upgrade, then the supervisor starts the workers). No need to re-run `install.sh`. Roll back with the previous tag and the backup.

## Environment variables
| Variable | Default | Meaning |
|---|---|---|
| `REDIS_URL` | — | Redis for the cluster (required to switch on). |
| `MULTICORE_BALANCER` | on | `off` — plain shared-port round-robin instead of the least-busy balancer. |
| `MULTICORE_APP_ENTRY` | auto-detected `@nocobase/app` | Path to `@nocobase/app/lib/index.js`. |
| `MULTICORE_MAX_WORKERS` | `min(cores×2, 32)`, at least 2 | Upper bound for the worker count. |
| `MULTICORE_QUICKSTART` | on | `0` — skip `start --quickstart` on first start. |
| `MULTICORE_EXIT_GRACE_MS` | `10000` | How long a worker may take to exit before `process.exit`. |
| `MULTICORE_KEEPALIVE_MS` | `600000` | How long a worker keeps an idle connection from the balancer open. The balancer closes idle connections itself after 8 s; the worker must never be the first to do it. |
| `MULTICORE_REDIS_PREFIX` / `MULTICORE_NAMESPACE` | `mcore` / DB name | Redis key prefix; several clusters on one Redis. |
| `MULTICORE_STORAGE` / `MULTICORE_CONFIG` | `storage` | Where `config.json`, `status.json` and `events.log` live. |

## How many workers
No more than the number of physical cores (minus cores used by the database and Redis if they share the host). Each worker is a full NocoBase process: ≈350–400 MB RAM when idle (more under load, see the worker table) and its own DB connections.

## The proxy chain in the official image
`reverse proxy (Caddy, …) → nginx inside the NocoBase image (port 80) → balancer (APP_PORT, 13000) → worker`. Things worth checking when the site "sometimes opens slowly":
* nginx in the image runs with its package defaults (`worker_processes auto`, `worker_connections 1024`). Every open browser tab holds a WebSocket, i.e. two nginx connections; a few thousand open tabs need a higher `worker_connections`.
* nginx only gzips answers of requests that did not come through another proxy (`gzip_proxied` is off by default). Behind Caddy, switch compression on there (`encode zstd gzip`), otherwise large JSON lists travel uncompressed.
* The nginx access log `/var/log/nginx/nocobase.log` inside the container is not rotated; it grows until the container is recreated.
* One huge synchronous request still occupies one worker completely (JavaScript is single-threaded). The journal shows such moments as `stall` with the duration; the cure is smaller pages / fewer appended relations in the heavy block.

## Diagnostics
* The **event journal** (settings page, `storage/multicore/events.log`) — the first place to look: worker exits with the reason, stalls, restarts, Bad-gateway answers.
* `docker logs <container> | grep '\[multicore\]'` — the same supervisor events as plain log lines.
* The settings page shows per worker: state, CPU, memory and heap limit, event-loop lag, requests in flight / served / per second, average response time, open tabs and users, crashes and stalls.
* Self-test: pub/sub reaches everyone, locks exclude other processes, 20 queue jobs run exactly once, worker ids are distinct.
