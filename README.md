**English** · [Русский](README.ru.md) · [简体中文](README.zh-CN.md)

<h1 align="center">nocobase-multicore</h1>
<p align="center"><b>Run NocoBase 2.x on all CPU cores — switch it on with one click, install it with one command.</b></p>
<p align="center">
  <a href="https://github.com/rosaloverdue-dev/nocobase-multicore"><img alt="Views" src="https://komarev.com/ghpvc/?username=nocobase-multicore&color=007ec6&style=flat-square&label=Views"></a>
  <img alt="license" src="https://img.shields.io/badge/license-AGPL--3.0-blue">
  <img alt="NocoBase" src="https://img.shields.io/badge/NocoBase-2.x-2f54eb">
  <img alt="tested" src="https://img.shields.io/badge/tested-2.2.33-brightgreen">
  <img alt="Redis" src="https://img.shields.io/badge/Redis-6%2B-dc382d">
  <img alt="languages" src="https://img.shields.io/badge/UI-en%20%C2%B7%20ru%20%C2%B7%20zh--CN-lightgrey">
</p>
<p align="center"><sub>Independent community project, not affiliated with or endorsed by NocoBase.</sub></p>
<p align="center"><a href="https://boosty.to/lipsept/donate"><img alt="Support the project on Boosty" src="https://img.shields.io/badge/Support%20the%20project-Boosty-F15F2C?style=flat"></a></p>

NocoBase (community edition) is a single Node.js process — **one CPU core**, however big your server is. `nocobase-multicore` starts it as **several worker processes behind one port**, balances requests between them by load, and moves everything that must be shared (events, locks, job queue, record ids, cache) to Redis. The NocoBase core is **not patched**: it is five ordinary plugins plus a small launcher, with an admin page under *Settings → Multi-core mode*.

| | Stock NocoBase | With nocobase-multicore |
|---|---|---|
| CPU cores used | 1 | up to all (you choose the number of workers) |
| One heavy request | freezes the whole site | only one worker is busy, the balancer sends everybody else to the free ones |
| Restart / mode change | site is down | rolling replace, no errors for users |
| Install | — | one command (Docker Compose: Redis included) |
| Remove | — | one command, back to stock NocoBase; removing a plugin switches the cluster off by itself |

> Status `0.1.2` — tested on NocoBase **2.2.33** (see [docs/TEST-REPORT.md](docs/TEST-REPORT.md)). AI agents continuing the work: start with [AGENTS.md](AGENTS.md).

## Contents
[Quick start](#quick-start) · [How it works](#how-it-works) · [Load balancing](#load-balancing) · [Requirements](#requirements) · [Installation methods](#installation-methods) · [Launch methods](#launch-methods) · [Admin page](#admin-page) · [Configuration](#configuration-reference) · [Tests](#test-commands) · [FAQ](#workflows-safety-and-removal-faq) · [Troubleshooting](#troubleshooting) · [The parts in detail](#the-parts-in-detail)

## Quick start

NocoBase runs in **Docker Compose**? One command (run it on the Docker host; `<container>` is the NocoBase app container name from `docker ps`):

```bash
tar xzf nocobase-multicore-bundle-0.1.2.tgz && cd nocobase-multicore-bundle-0.1.2
./install.sh --docker <container> --workers 2
```

It installs and enables the five plugins, **adds a Redis container to your compose project**, switches the app to the supervisor entrypoint and recreates the app container. Then open *Settings → Multi-core mode* and press *Run check*. To go back: `./uninstall.sh --docker <container>`.

NocoBase runs from a project folder (no Docker)?
```bash
./install.sh --local /path/to/nocobase --redis-url redis://127.0.0.1:6379/0
cd /path/to/nocobase && node storage/multicore/supervisor/bin/nocobase-multicore.js   # instead of `yarn start`
```
Download `nocobase-multicore-bundle-<version>.tgz` from the [latest release](https://github.com/rosaloverdue-dev/nocobase-multicore/releases/latest) (the same files are in [`releases/v0.1.2`](releases/v0.1.2), or build them: `node scripts/build.mjs`).

## What is inside

| Part | Purpose |
|---|---|
| `supervisor` — launcher | Starts N workers (`node:cluster`), balances requests, changes the number of workers smoothly, restarts crashed ones. |
| `plugin-multicore` | The admin page: switch, worker count, live process table, cluster self-test, safeguard. |
| `plugin-pubsub-adapter-redis` | Shared event bus between workers. |
| `plugin-lock-adapter-redis` | Locks between processes. |
| `plugin-queue-adapter-redis` | Shared job queue (each job goes to exactly one worker). |
| `plugin-worker-id-allocator-redis` | Unique worker ids so two processes never create the same record id. |

Each part is described below (and in `packages/<name>/README.md`). When the mode is off — or Redis is not configured — the adapters change nothing and NocoBase runs as usual in one process.

## How it works

```
 browser ─► nginx ─► :13000 supervisor (node:cluster primary + least-busy balancer)
                        ├─► worker 1  (full NocoBase app, private port) ┐
                        ├─► worker 2  (full NocoBase app, private port) ├─► PostgreSQL / MySQL (shared database)
                        └─► worker N  (full NocoBase app, private port) ┘
                                  │ pub/sub · locks · job queue · worker ids · cache
                                  ▼
                                Redis
```
1. The supervisor owns the public port. Every HTTP **request** and WebSocket goes to the worker that is least busy right now.
2. Everything that used to live in the memory of the single process is in Redis, through the extension points NocoBase itself provides (`pubSubManager`, `lockManager`, `eventQueue`, `workerIdAllocator`, cache store).
3. The admin page writes `storage/multicore/config.json`; the supervisor reads it and does a **rolling replace** (a new worker must accept requests before the old one is stopped), so users see no downtime.

## Load balancing

Plain `node:cluster` hands every new TCP connection to the next worker in turn, without looking at load. Behind a reverse proxy that opens a connection per request this means: a user whose request lands on a worker that is busy for 20 seconds with a heavy export waits, while another worker is idle.

The built-in balancer fixes that:

* each worker listens on a **private loopback port**; the supervisor owns the public port;
* every HTTP request goes to the worker with the **fewest requests in flight**; a worker that stopped answering heartbeats (blocked event loop) is avoided while any other worker is available;
* WebSockets are tunnelled to the worker with the fewest sockets; `X-Forwarded-For` is added;
* a bodyless request is retried once on another worker if the connection fails; with no ready worker the client gets a clean JSON `503` with `Retry-After`;
* during a rolling replace the old worker leaves the balancer first and is stopped only after its in-flight requests finished.

Live numbers (requests in flight / served per worker) are in the admin page and in `storage/multicore/status.json`. `MULTICORE_BALANCER=off` returns to the plain shared-port mode.

**Worker affinity (optional, off by default).** Normally two requests of the same user may be served by different workers. That is fine for everything NocoBase keeps in the database or Redis, but some third-party plugins keep state in the memory of one process (see [known issues](docs/KNOWN-ISSUES.md#plugins-that-keep-state-in-process-memory-users-kicked-out-401-reload-loop)). For them switch on *Settings → Multi-core mode → Worker affinity*: **by login token** (recommended) or **by client IP**. The same user then keeps going to the same worker; if that worker is stalled or clearly busier than the others (more than 4 requests ahead), the request goes to the least busy one instead, so nobody is pinned to a frozen process. It is applied instantly, without restarting workers, and can be turned off in the same place. Cost: the load is spread less evenly. Totals such as "users online" stay wrong in that case — each worker counts only its own users.

> A worker that is executing one huge synchronous request (for example a 5000-row list with many appended relations) cannot answer anything else until it finishes — JavaScript is single-threaded. The balancer routes everybody else around it, but the real cure is smaller pages / fewer appended relations in heavy blocks.

## Requirements

* NocoBase **2.x** community (tested: `nocobase/nocobase:2.2.33`), Docker or a local project (`yarn nocobase ...`), Node.js ≥ 20.
* PostgreSQL or MySQL/MariaDB shared by all workers (the one NocoBase already uses). *SQLite is not suitable.*
* **Redis ≥ 6**, `maxmemory-policy noeviction`. With `install.sh --docker` on Docker Compose it is created for you; otherwise pass `--redis-url` / set `REDIS_URL`.
* Shared `storage/` directory (one machine / one volume).
* Memory: every worker is a full NocoBase process (≈350–400 MB). Do not start more workers than physical cores.

## Installation methods

### 1. One command — `install.sh` (recommended)

Download the bundle from the [latest release](https://github.com/rosaloverdue-dev/nocobase-multicore/releases/latest) (or from [`releases/v0.1.2`](releases/v0.1.2)), unpack, run:

```bash
./install.sh --docker <container-name> [--workers N]      # Docker (Compose: Redis + entrypoint are configured for you)
./install.sh --local /path/to/nocobase --redis-url URL     # project folder / VM
```

| Option | Meaning |
|---|---|
| `--workers N` | also switch multi-core mode on right away (otherwise switch it in the UI) |
| `--redis-url URL` | use your own Redis instead of creating one (always needed for `--local`) |
| `--no-switch` | install plugins only; do not touch compose, entrypoint or Redis |
| `--no-enable` | register the plugins but do not enable them |
| `--from DIR` | folder with the `*.tgz` packages |
| `--restart` | (with `--no-switch`) restart the container afterwards |

For a Docker Compose container the script reads the compose labels, writes `docker-compose.multicore.yml` next to your compose file (supervisor entrypoint, `REDIS_URL`, a `multicore-redis` service on the app's network) and runs `docker compose up -d` for the app. It is idempotent. `./uninstall.sh --docker <container> [--purge]` removes the override again and recreates the app with its original entrypoint.

### 2. Upload the TGZ files in the browser

*Settings → Plugin manager → Add plugin → Upload*, one by one: the five `nb-multicore-plugin-*.tgz` files, then **enable** each. The supervisor and Redis are not plugins — you still need to give the app a `REDIS_URL` and start it through the supervisor (see [Launch methods](#launch-methods)); `install.sh --no-enable` / the manual commands below copy the supervisor. Upload/enable from the UI inside a running cluster affects only one worker, so **restart the container afterwards**. This is the only path where Redis must be set up by hand.

### 3. Manual commands

```bash
# inside the NocoBase container / project directory
for p in pubsub-adapter-redis lock-adapter-redis queue-adapter-redis worker-id-allocator-redis multicore; do
  mkdir -p storage/plugins/@nb-multicore/plugin-$p
  tar xzf nb-multicore-plugin-$p-0.1.2.tgz -C storage/plugins/@nb-multicore/plugin-$p
done
mkdir -p storage/multicore/supervisor && tar xzf nocobase-multicore-supervisor-0.1.2.tgz -C storage/multicore/supervisor
yarn nocobase postinstall          # links storage/plugins into node_modules
yarn nocobase pm enable @nb-multicore/plugin-pubsub-adapter-redis @nb-multicore/plugin-lock-adapter-redis \
  @nb-multicore/plugin-queue-adapter-redis @nb-multicore/plugin-worker-id-allocator-redis @nb-multicore/plugin-multicore
```
Then start NocoBase through the supervisor with a `REDIS_URL` (next section).

## Launch methods

| Method | Command | When |
|---|---|---|
| Docker Compose (official image) | entrypoint `/bin/sh /app/nocobase/storage/multicore/supervisor/docker/entrypoint.sh` + `REDIS_URL` (`install.sh` does it) | production |
| Local / PM2 / systemd | `REDIS_URL=redis://127.0.0.1:6379/0 node storage/multicore/supervisor/bin/nocobase-multicore.js` | NocoBase from a project folder |
| Stock mode (no supervisor) | the usual `yarn start` / image entrypoint | the plugins stay inactive, nothing changes |
| Test stand | `docker compose -f docker/docker-compose.example.yml up -d` | try everything from scratch (NocoBase + PostgreSQL + Redis) |

A compose file by hand:
```yaml
services:
  app:
    image: nocobase/nocobase:2.2.33
    entrypoint: ["/bin/sh", "/app/nocobase/storage/multicore/supervisor/docker/entrypoint.sh"]
    environment:
      REDIS_URL: redis://redis:6379/0
      # behind a proxy / another host name, if you see "Invalid sign-in origin":
      # CORS_ORIGIN_WHITELIST: "https://crm.example.com"
    volumes: ["./storage:/app/nocobase/storage"]
  redis:
    image: redis:7-alpine
    command: ["redis-server", "--maxmemory-policy", "noeviction", "--appendonly", "yes"]
```

## Admin page

*Settings → Multi-core mode* (English, Russian and Simplified Chinese; other UI languages fall back to English):

* **switch** and **number of workers** with the number of server CPU cores shown next to it; *Apply* does a rolling replace;
* **worker affinity** (off / by login token / by client IP), applied instantly;
* **live process table**: slot, PID, state, uptime, CPU %, memory, event-loop lag, **requests in flight / served**, instance id, host;
* **adapter status** (pub/sub, locks, queue, worker ids, cache) and Redis latency/version;
* **cluster self-test**: pub/sub reaches every worker, locks exclude other processes, 20 queue jobs run exactly once, worker ids are distinct.

If something blocks the switch (Redis down, a plugin disabled, app not started under the supervisor) the page says exactly why. The page needs the `pm.multicore` permission (root has it).

## Test commands

| What | Command |
|---|---|
| Cluster self-test (pub/sub, locks, queue, worker ids) | UI: *Run check*; API: `curl -X POST $BASE/api/multicore:selftest -H "Authorization: Bearer $TOKEN"` |
| Status | `curl $BASE/api/multicore:status -H "Authorization: Bearer $TOKEN"` and `cat storage/multicore/status.json` |
| Data consistency across workers (writes on one, reads on all) | `BASE=http://host:13000 USER_NAME=admin PASSWORD=... node tests/consistency.js` (env `READS`, `ROUNDS`) |
| Load / benchmark | `BASE=... TOKEN=... CONC=64 SECONDS=20 GET_URL=/api/... node tests/bench.js` |
| Workflows: record trigger + "create record" node, N rows | `BASE_URL=... NB_USER=admin NB_PASSWORD=... node tests/workflow.js 150 12 0` (3rd arg `1` = synchronous workflow, `KEEP=1` keeps the test data) |
| Install / uninstall on a clean Docker Compose project | `./install.sh --docker <c> --workers 2` then `./uninstall.sh --docker <c> --purge` |
| Build all packages | `node scripts/build.mjs` (needs `esbuild`; `MINIFY=1` optional) → `build/*.tgz` |
Results of the runs done so far: [docs/TEST-REPORT.md](docs/TEST-REPORT.md).

## Configuration reference

| Variable | Meaning |
|---|---|
| `REDIS_URL` | Redis address (**required** for cluster mode). |
| `MULTICORE_MAX_WORKERS` | Upper bound for the worker count (default `min(cpus×2, 32)`). |
| `MULTICORE_BALANCER` | `off` = plain shared-port round-robin instead of the least-busy balancer (default on). |
| `MULTICORE_APP_ENTRY` | Path to `@nocobase/app/lib/index.js` (auto-detected). |
| `MULTICORE_QUICKSTART` | `0` = do not run `--quickstart` on the first start. |
| `MULTICORE_EXIT_GRACE_MS` | Time a stopping worker gets before `process.exit` (default 10000). |
| `MULTICORE_REDIS_PREFIX`, `MULTICORE_NAMESPACE` | Redis key prefix `<prefix>:<namespace>` (default `mcore:<DB name>`). |
| `MULTICORE_STORAGE`, `MULTICORE_CONFIG` | Where `config.json` / `status.json` live (default `storage/multicore/`). |
| `CORS_ORIGIN_WHITELIST` | NocoBase's own: allowed origins when you log in through another host name or a proxy. |

## Workflows, safety and removal (FAQ)

**Will workflows and triggers (record created, scheduled …) keep working?** Yes. This was tested with a collection trigger + a "create record" node (asynchronous and synchronous) at 150 and 600 executions: every execution was created and finished exactly once, no duplicates, no losses, the same as in single-process mode. Scheduled triggers fire once per tick (the Redis lock prevents double firing). The plugins do not touch the workflow tables or any of your data.

**What did the tests find?** A real bug (the worker-id adapter was installed too late, so several workers could get the same random id and ~25 % of trigger executions were lost with `id must be unique`). It is fixed in this release (`afterAdd` hook) and covered by the self-test and `tests/workflow.js`.

**What are the limits?** (1) The queue is *at-least-once*: after a crash in the middle of a job it can run again, so make workflow actions idempotent. (2) Synchronous workflows under very high concurrency (hundreds of simultaneous requests) hang on stock NocoBase too, single process included. (3) Enabling plugins from the UI inside a running cluster affects only one worker — restart afterwards. (4) Metadata changes (new collections/fields) reach all workers in ≈1 s.

**If I remove the plugins, will the server keep working?** Yes, no manual repair is needed. Disabling/removing any of the five plugins first writes `enabled:false` into the config (the *safeguard*), and the supervisor returns to **one ordinary process**. The plugins create no database tables and change no data; the leftover Redis keys are harmless and expire by themselves. Tested: the site answered 200 during the whole removal, the container restarted normally, persisted workflows kept firing. Use `./uninstall.sh --docker <container>` for a clean removal (add `--purge` to also delete the supervisor folder — do it only after you returned the container to the stock entrypoint).

**Recommended for production:** make a database backup; try on a staging copy first; switch on in a quiet hour; start with 2–3 workers; keep Redis persistent/monitored.

## Restart and update

**Restart the app** (Docker Compose, from the project folder): `docker compose restart app` — the supervisor starts again and brings the workers back (a minute or so). Without downtime you can instead change the number of workers in the admin page (rolling replace). A restart requested by NocoBase itself (for example after enabling a plugin) just makes a worker exit; the supervisor starts it again. Bare-metal: restart the process that runs `nocobase-multicore.js`.

> `install.sh` writes `COMPOSE_FILE=…docker-compose.yml:…docker-compose.multicore.yml` into the project's `.env`, so a plain `docker compose up -d` / `restart` keeps the supervisor and Redis. If you removed that line, or run compose from another folder, use `docker compose -f docker-compose.yml -f docker-compose.multicore.yml up -d` — otherwise compose ignores the override and NocoBase silently starts as a single process.

**Update NocoBase itself** (verified: 2.2.33 → 2.2.34, Docker Compose):
1. Back up the database and `storage/`.
2. In `docker-compose.yml` change the image tag, e.g. `nocobase/nocobase:2.2.33` → `nocobase/nocobase:2.2.34`.
3. `docker compose pull && docker compose up -d`.
4. Wait 1–3 minutes: the entrypoint runs NocoBase's own upgrade, the supervisor starts the workers again. Check `docker logs <container> | grep '\[multicore\]'` and *Settings → Multi-core mode*.

The multi-core files live in `storage/`, so they survive a new image; you do **not** need to run `install.sh` again. If a new image changes its start script, `entrypoint.sh` stops with a clear message — put the old tag back and open an issue. Rollback: previous tag + restore the backup. NocoBase versions other than 2.2.x are untested. Without Docker: stop the supervisor, update NocoBase as described in its documentation (`yarn nocobase upgrade`), start the supervisor again.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| The switch refuses to turn on | The message says why: Redis does not answer, a plugin is not enabled, or the app was not started through the supervisor (step 2). |
| *Invalid sign-in origin* | Set `CORS_ORIGIN_WHITELIST` to the address you open in the browser (NocoBase's own check behind proxies). |
| A "Script error for @nb-multicore/…" full-screen error | An old build without the client stub; use the files from this release. |
| Plugin enabled in the UI but adapter inactive | Restart the container (cluster: only one worker saw the change). |
| Log line `… adapter not activated: REDIS_URL is not set` | Single mode or no Redis: expected, nothing is broken. |

## The parts in detail

### Supervisor (launcher)

_Starts NocoBase as several worker processes sharing one port, and changes their number without downtime._

**Basis**

NocoBase community edition is a single Node.js process, i.e. one CPU core. The supervisor is a tiny launcher
(plain Node.js, no NocoBase imports) built on `node:cluster`. It is the **primary** process: it does not serve requests itself, it
forks N **workers**, and every worker runs a complete NocoBase application. Incoming requests to the least busy worker (built-in balancer), so the work is spread over several cores.

**Functionality**

* Starts 1..N workers (`bin/nocobase-multicore.js`); the first start of slot 0 runs `start --quickstart` (install/upgrade of the database), like the stock image.
* **Rolling replace** when the mode or the number of workers changes: a new worker is started, the supervisor waits until it really accepts requests, then the old one leaves the balancer and finishes its in-flight requests, is told to stop (`SIGTERM`, 30 s grace, then `SIGKILL`). Users see no errors.
* Scale up / scale down (the highest slots are stopped first).
* Respawns a crashed worker with exponential back-off (1 s → 30 s).
* Writes `storage/multicore/status.json` (mode, workers, states) and reads `storage/multicore/config.json` (what the admin page saved). Re-reads the config on an IPC message from a worker, on `SIGHUP`, and every 10 s.
* Passes the environment to workers: `MULTICORE_SUPERVISED=1`, `MULTICORE_MODE=cluster|single`, `MULTICORE_SLOT`, and in cluster mode `REDIS_URL`, `CACHE_DEFAULT_STORE=redis`, `CACHE_REDIS_URL`.
* `lib/worker-entry.js` is what each worker executes: it runs the NocoBase CLI `initEnv()` (loads `.env`), delays opening the HTTP port until the application is in the `running` state (so no request ever gets "503 app is starting"), and guarantees the process exits after `SIGTERM`.

**How it is built**

`docker/entrypoint.sh` (inside the supervisor package) patches the **last line** of the official image entrypoint
(`yarn start --quickstart`) so that it runs the supervisor instead; everything else the image does (nginx, client assets) is kept.
If a future image changes that line the script stops with a clear message instead of starting something wrong.

**Configuration**

| Setting | Default | Meaning |
|---|---|---|
| `storage/multicore/config.json` | `{enabled:false, workers:1}` | Written by the admin page (or by hand). `enabled:false` = one stock process. |
| `MULTICORE_MAX_WORKERS` | `min(cpus×2, 32)`, at least 2 | Upper bound of workers. |
| `MULTICORE_QUICKSTART` | on | `0` = do not run `--quickstart` on first start. |
| `MULTICORE_EXIT_GRACE_MS` | `10000` | How long a worker may take to stop before `process.exit`. |
| `MULTICORE_APP_ENTRY` | auto | Path to `@nocobase/app/lib/index.js`. |
| `MULTICORE_REDIS_PREFIX`, `MULTICORE_NAMESPACE` | `mcore`, DB name | Redis key prefix (several clusters on one Redis). |
| `MULTICORE_DEFER_LISTEN` | on | `0` = open the port immediately (not recommended). |
| `MULTICORE_STORAGE`, `MULTICORE_CONFIG` | `storage` | Where config/status files live. |

**Safety / removal**

Switching the mode off (or removing the plugins) always returns the supervisor to **one plain worker**, which behaves like stock NocoBase.
Keep the `storage/multicore/supervisor` folder as long as the container still starts through it.

**How to test**

```bash
docker exec <container> cat storage/multicore/status.json     # desired mode and every worker state
docker logs <container> 2>&1 | grep '\[multicore\]'           # supervisor events
```

### Manager plugin — `@nb-multicore/plugin-multicore`

_The admin page with the multi-core switch, the worker table and the cluster self-test._

**Basis**

This is the only plugin you interact with. It adds **Settings → Multi-core mode** to NocoBase, exposes the same functions
as an API, and watches the cluster. It does not move any NocoBase function itself — the four adapter plugins do that.

**Functionality**

* **Switch + worker counter** and the *Apply* button. Before it saves, the plugin checks that Redis answers, that all four adapter plugins are enabled and that the app really runs under the supervisor; otherwise it refuses with a readable reason.
* **Live table of processes**: slot, PID, state, uptime, CPU %, memory, event-loop lag, snowflake worker id, host. Data comes from a heartbeat every 5 s through Redis (TTL 20 s).
* **Adapter table**: for every adapter the plugin state (enabled/disabled/missing) and whether the adapter is really in effect in this process.
* **Cluster self-test** (button *Run check*, or `POST /api/multicore:selftest`): (1) a pub/sub message reaches every worker, (2) a held lock keeps every other worker out, (3) 20 queue jobs are processed exactly once each, (4) every worker has its own snowflake worker id.
* **API** (ACL snippet `pm.multicore`, root has it): `GET /api/multicore:status`, `POST /api/multicore:apply {"enabled":true,"workers":3}`, `POST /api/multicore:selftest`, `GET /api/multicore:whoami`.
* **Safeguard**: if this or any adapter plugin is disabled or removed while the cluster is on, the plugin writes `enabled:false` to the config and tells the supervisor, which returns to one process — the site never runs with a half-installed cluster.

**How it is built**

Server: registers the `multicore` resource and the ACL snippet, talks to the supervisor through Node IPC (`process.send`), writes the
config atomically (tmp file + rename). Client: a normal NocoBase client plugin (React + Ant Design) registered as a settings page; the UI language (English, Russian or Simplified Chinese) follows the NocoBase language.

**Configuration**

No settings of its own. The file it controls is `storage/multicore/config.json`. Permissions: Settings → Roles → *Plugin settings* → *Multi-core mode*.

**Safety / removal**

Disabling/removing it switches the cluster off first (safeguard above). It creates **no database tables** and changes no data.

**How to test**

```bash
curl -s -X POST $BASE/api/multicore:selftest -H "Authorization: Bearer $TOKEN"   # "ok": true expected
curl -s $BASE/api/multicore:status -H "Authorization: Bearer $TOKEN"
```

### Pub/Sub adapter — `@nb-multicore/plugin-pubsub-adapter-redis`

_Makes events visible to all workers (Redis Pub/Sub)._

**Basis**

NocoBase has an internal event bus (`app.pubSubManager`). Out of the box it is an in-memory bus: a message published in one
process reaches only that process. With several workers this breaks everything that must be told to *all* processes. This plugin
plugs a Redis Pub/Sub adapter into the bus, so a message published by one worker reaches all of them.

**Functionality**

What travels over this bus in NocoBase:
* **metadata changes** — a collection or field created/changed in the UI appears on every worker (≈1 s, NocoBase's own debounce);
* **cache invalidation** messages;
* **workflow status messages** — enabling/disabling a workflow registers/removes its trigger on every worker;
* messages of any other plugin that uses `pubSubManager` / `syncMessageManager`.

**How it is built**

Two dedicated Redis connections (a connection in subscriber mode cannot publish) are taken from NocoBase's own
`redisConnectionManager` (the plugin does not bundle a Redis client). Channels are named `mcore:<database>:ps:<channel>`. An error in one handler is
logged and does not stop the others. The adapter is installed in `beforeLoad` and connects on `afterStart`.

**Configuration**

Active only when `MULTICORE_MODE=cluster` and `REDIS_URL` is set; otherwise the log says `pub/sub adapter not activated` and NocoBase keeps its stock in-memory bus. Redis prefix: `MULTICORE_REDIS_PREFIX` / `MULTICORE_NAMESPACE`.

**Safety / removal**

No data is stored in Redis (fire-and-forget channels). Disabling/removing the plugin first switches the cluster off. Nothing is written to the database.

**How to test**

The *Run check* button of the manager page (pub/sub reaches N of N workers), or create a collection in the UI and open it on another browser tab: it is visible within ~1 s. `node tests/consistency.js` automates this.

### Lock adapter — `@nb-multicore/plugin-lock-adapter-redis`

_Makes locks work between processes (Redis `SET NX PX`)._

**Basis**

NocoBase uses locks (`app.lockManager`) so that two actions do not run at the same time — for example processing one workflow
execution, recovering unfinished executions, firing a scheduled trigger. The stock lock exists only inside one process. With several workers two of
them could both think they hold the same lock. This plugin registers a Redis lock adapter and makes it the default.

**Functionality**

* Mutual exclusion **across processes and hosts**: only one worker runs a critical section for a given key.
* Same semantics as the stock adapter: `tryAcquire`, `acquire(key, ttl)` (waits), `runExclusive(key, fn, ttl)` (waits, runs, always releases).
* While a critical section is running the lock is **renewed** every ttl/3, so a long job never loses it; if it is lost anyway a warning is written to the log.
* This is what prevents **duplicate firing of schedule triggers** and double processing of one workflow execution.

**How it is built**

`SET key token NX PX ttl` to take the lock, a Lua script to release/extend **only if the token matches** (a late worker can never release someone else's lock).
A lock taken by a crashed worker expires by itself after its TTL. Connection: `redisConnectionManager` of NocoBase.

**Configuration**

Active only in cluster mode with `REDIS_URL`. It registers the adapter `redis` and sets it as `lockManager.options.defaultAdapter`; in single-process mode the stock lock stays. Keys: `mcore:<database>:lock:*`.

**Safety / removal**

Locks are short-lived keys with TTL: a crash leaves nothing behind that blocks the system for longer than the TTL. Nothing is written to the database.

**How to test**

*Run check* on the manager page: a lock held by the page's worker must keep out every other worker (`lockblocked = N-1`, `lockleak = 0`). `node tests/workflow.js` and a 5-second schedule workflow check the practical effect (exactly one run per tick).

### Queue adapter — `@nb-multicore/plugin-queue-adapter-redis`

_One shared job queue for all workers (Redis Streams): every job is processed by exactly one worker._

**Basis**

NocoBase puts background work into an event queue (`app.eventQueue`): asynchronous workflow executions, some notifications and tasks of other plugins.
The stock queue is in memory and private to one process. With several workers each process would see only its own jobs. This plugin
replaces it with a Redis Streams queue shared by all workers.

**Functionality**

* Each message goes to **exactly one** worker in the whole cluster (consumer group), so the load is shared.
* After success the message is acknowledged and deleted; after an error it is re-published with a retry counter (as the stock queue does).
* **Crash recovery**: a message left half-processed by a dead worker is taken over by another one (`XAUTOCLAIM`) after `timeout×2 + 5 s`.
* Delivery is **at-least-once** — in the rare case of a crash in the middle of a job it may run a second time (design workflow actions so that repeating them is harmless).

**How it is built**

`XADD` to publish, `XREADGROUP` (group `nb`, consumer `<pid>-<random>`) to consume, `XACK` + `XDEL` on success; the stream is capped at 100 000 entries; polling interval 250 ms by default. Stream key `mcore:<database>:q:<channel>`.

**Configuration**

Active only in cluster mode with `REDIS_URL`. Redis should not evict keys (`maxmemory-policy noeviction`) so that queued jobs are never dropped.

**Safety / removal**

Unfinished jobs live in Redis. When you switch the cluster off, the stock in-memory queue takes over; jobs still waiting in the Redis stream at that moment are not moved — switch off in a quiet moment (the manager and `uninstall.sh` wait for workers to finish their current work; workflow executions that were queued are re-discovered from the database by NocoBase's own recovery at start).

**How to test**

*Run check*: 20 test jobs → 20 processed, 0 duplicates, spread over workers. `node tests/workflow.js 600 24 0` sends 600 real workflow executions through the queue: expect 600/600.

### Worker-id allocator — `@nb-multicore/plugin-worker-id-allocator-redis`

_Gives every process its own id so that two workers never create the same record id._

**Basis**

NocoBase generates primary keys of many tables (workflow executions, jobs, notifications ...) with a **snowflake** algorithm: time + **worker id** (0–31) + counter. Out of the box
every process picks its worker id **at random**. With one process that is fine; with several workers two of them can pick the same number and then create identical ids in the same
millisecond — the database answers `id must be unique` and the record (for instance a workflow execution) is lost. This plugin hands out unique ids.

**Functionality**

* Every process **leases** a free id in 0–31 from Redis (`SET NX PX 60 s`), renews it every 10 s and keeps it for as long as the process lives.
* A crashed process frees its id automatically after 60 s. A lost lease is re-acquired (same id) or, if another process took the id, the supervised worker exits and is respawned with a new id. At most 32 processes can run at once (the supervisor allows at most 32 workers by default).
* The manager page shows the id of every worker, and the self-test fails if two workers share an id.

**How it is built**

The core asks the allocator for the id right after the plugins are initialised, **before** `beforeLoad` of plugins runs, so the adapter is installed in `afterAdd()`. (An earlier build used
`beforeLoad`, was too late and let random ids through — found by the workflow test, fixed in this release.) `release()` is deliberately a no-op: the core calls it on every app *reload* while the process keeps using the id.

**Configuration**

Active only in cluster mode with `REDIS_URL`. Keys: `mcore:<database>:wid:<0-31>`.

**Safety / removal**

Ids already stored in your database are untouched; the plugin only influences new ids. Disabling it switches the cluster off first.

**How to test**

```bash
curl -s -X POST $BASE/api/multicore:selftest -H "Authorization: Bearer $TOKEN"   # checks.workerIds.ok must be true
docker exec <redis> redis-cli --scan --pattern '*:wid:*'                           # one key per running worker
```

## Support the project

nocobase-multicore is free and open source. If it saves you time or money, you can support its development with a donation. It is voluntary and gives no extra rights or priority support.

<p align="center"><a href="https://boosty.to/lipsept/donate"><img alt="Donate on Boosty" src="https://img.shields.io/badge/Donate-on%20Boosty-F15F2C?style=for-the-badge"></a></p>

## More

* [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/OPERATIONS.md](docs/OPERATIONS.md) · [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md) · [docs/TEST-REPORT.md](docs/TEST-REPORT.md) · [CHANGELOG.md](CHANGELOG.md) · [AGENTS.md](AGENTS.md)

## License and legal notice

nocobase-multicore is free software under the **GNU AGPL v3.0 only**: see [LICENSE](LICENSE) and [NOTICE](NOTICE). Running it unmodified on your own servers puts no obligations on you. If you modify it and let other people use your modified version over a network, the AGPL requires you to offer them your source code.

**This is an independent community project. It is not affiliated with, sponsored by or endorsed by NocoBase.** "NocoBase" is a name and trademark of its owner and is used here only to say what the software works with. This repository contains no NocoBase code: it installs into *your own* NocoBase and does not change any NocoBase branding. NocoBase itself is licensed separately, under the [NocoBase License Agreement](https://github.com/nocobase/nocobase/blob/main/LICENSE.txt) (Apache-2.0 plus additional terms). Please read it for your own installation.
