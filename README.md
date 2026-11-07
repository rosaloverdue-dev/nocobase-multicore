**English** · [Русский](README.ru.md) · [简体中文](README.zh-CN.md)

# nocobase-multicore

Run **NocoBase 2.x (community edition) on several CPU cores** — with an admin switch in *Settings → Multi-core mode*.

NocoBase is a single Node.js process, i.e. one CPU core. This project starts it as **several worker processes on one port** and moves everything that must be shared between the workers (events, locks, queues, record ids, cache) to Redis. The NocoBase core is **not patched**: it is done with five ordinary plugins and a small launcher.

> Status `0.1.0`, tested on NocoBase **2.2.33** on a test stand (see [docs/TEST-REPORT.md](docs/TEST-REPORT.md)). The repository is private. AI agents continuing the work: start with [AGENTS.md](AGENTS.md).

## What is inside

| Part | Purpose |
|---|---|
| `supervisor` — launcher | Starts N workers (`node:cluster`), changes their number smoothly, restarts crashed ones. |
| `plugin-multicore` | The admin page: switch, worker count, process table, cluster self-test, safeguard. |
| `plugin-pubsub-adapter-redis` | Shared event bus between workers. |
| `plugin-lock-adapter-redis` | Locks between processes. |
| `plugin-queue-adapter-redis` | Shared job queue (each job goes to exactly one worker). |
| `plugin-worker-id-allocator-redis` | Unique worker ids so two processes never create the same record id. |

Each part is described in detail below (and in its own `README` inside `packages/<name>/`). When the mode is off — or Redis is not configured — the adapters change nothing and NocoBase runs as usual in one process.

## How it works

```
 browser ─► :13000 ─► supervisor (node:cluster primary, does not serve requests)
                        ├─ worker 1  (full NocoBase app)  ┐
                        ├─ worker 2  (full NocoBase app)  ├─► PostgreSQL / MySQL  (shared database)
                        └─ worker N  (full NocoBase app)  ┘
                                  │ pub/sub · locks · job queue · worker ids · cache
                                  ▼
                                Redis
```
1. The OS spreads incoming connections between the workers (round-robin).
2. Everything that used to live in the memory of the single process is now in Redis, through the extension points NocoBase itself provides (`pubSubManager`, `lockManager`, `eventQueue`, `workerIdAllocator`, cache store).
3. The admin page writes `storage/multicore/config.json`; the supervisor reads it and does a **rolling replace** (a new worker must accept requests before the old one is stopped), so users see no downtime.

## Requirements

* NocoBase **2.x** community (tested: `nocobase/nocobase:2.2.33`), Docker or a local project (`yarn nocobase ...`), Node.js ≥ 20.
* PostgreSQL or MySQL/MariaDB shared by all workers (the same one NocoBase already uses). *SQLite is not suitable.*
* **Redis ≥ 6** reachable as `REDIS_URL` (e.g. `redis://redis:6379/0`), `maxmemory-policy noeviction`.
* Shared `storage/` directory (it is one machine / one volume).

## Installation

### Option A — one command (recommended)

Download the bundle `nocobase-multicore-bundle-0.1.0.tgz` from [`releases/v0.1.0`](https://github.com/rosaloverdue-dev/nocobase-multicore/tree/main/releases/v0.1.0) (or from a GitHub Release), unpack and run:

```bash
tar xzf nocobase-multicore-bundle-0.1.0.tgz && cd nocobase-multicore-bundle-0.1.0

# NocoBase in Docker (give the container name):
./install.sh --docker <container-name> --restart

# NocoBase from a project directory:
./install.sh --local /path/to/nocobase-project
```
The script (idempotent — safe to run again): copies the five plugins to `storage/plugins/@rosal-nb/`, the supervisor to `storage/multicore/supervisor/`, runs `pm add` and `pm enable` for every plugin. Options: `--no-enable`, `--restart`, `--from <dir>`.

### Option B — upload the TGZ files in the browser

*Settings → Plugin manager → Add plugin → Upload*, one by one: `rosal-nb-plugin-pubsub-adapter-redis`, `…lock-adapter-redis`, `…queue-adapter-redis`, `…worker-id-allocator-redis`, `…plugin-multicore` (the `*.tgz` files from the release folder), then **enable** each of them. The supervisor (it is not a plugin) still has to be copied once — see step 2 below. Upload/enable from the UI in a running cluster only affects the process that handled the request, so **restart the container afterwards**.

### Option C — manual commands

```bash
# in the NocoBase container / project directory
for p in pubsub-adapter-redis lock-adapter-redis queue-adapter-redis worker-id-allocator-redis multicore; do
  mkdir -p storage/plugins/@rosal-nb/plugin-$p
  tar xzf rosal-nb-plugin-$p-0.1.0.tgz -C storage/plugins/@rosal-nb/plugin-$p
  yarn nocobase pm add @rosal-nb/plugin-$p
done
yarn nocobase pm enable @rosal-nb/plugin-pubsub-adapter-redis @rosal-nb/plugin-lock-adapter-redis \
  @rosal-nb/plugin-queue-adapter-redis @rosal-nb/plugin-worker-id-allocator-redis @rosal-nb/plugin-multicore
mkdir -p storage/multicore/supervisor && tar xzf nocobase-multicore-supervisor-0.1.0.tgz -C storage/multicore/supervisor
```

### Step 2 — start NocoBase through the supervisor (once)

**Docker** — add Redis and change the container entrypoint (see the full example `docker/docker-compose.example.yml`):
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
    image: redis:7
    command: ["redis-server", "--maxmemory-policy", "noeviction"]
```
**Local project** — start the launcher instead of `yarn start`:
```bash
REDIS_URL=redis://127.0.0.1:6379/0 node storage/multicore/supervisor/bin/nocobase-multicore.js
```
Then open **Settings → Multi-core mode**, switch it on, choose the number of workers (start with the number of CPU cores) and press *Apply*. *Run check* runs the cluster self-test.

## Launch methods used

| Method | Command | When |
|---|---|---|
| Docker (official image) | entrypoint `…/supervisor/docker/entrypoint.sh` | production, the example stand |
| Local / PM2 / systemd | `node storage/multicore/supervisor/bin/nocobase-multicore.js` | NocoBase from a project folder |
| Stock mode (no supervisor) | the usual `yarn start` / image entrypoint | the plugins stay inactive, nothing changes |
| Test stand | `docker compose -f docker/docker-compose.example.yml up -d` | try everything from scratch (NocoBase + PostgreSQL + Redis) |

## Test commands

| What | Command |
|---|---|
| Cluster self-test (pub/sub, locks, queue, worker ids) | UI: *Run check*; API: `curl -X POST $BASE/api/multicore:selftest -H "Authorization: Bearer $TOKEN"` |
| Status | `curl $BASE/api/multicore:status -H "Authorization: Bearer $TOKEN"` and `cat storage/multicore/status.json` |
| Data consistency across workers (writes on one, reads on all) | `BASE=http://host:13000 USER_NAME=admin PASSWORD=... node tests/consistency.js` (env `READS`, `ROUNDS`) |
| Load / benchmark | `BASE=... TOKEN=... CONC=64 SECONDS=20 GET_URL=/api/... node tests/bench.js` |
| Workflows: record trigger + "create record" node, N rows | `BASE_URL=... NB_USER=admin NB_PASSWORD=... node tests/workflow.js 150 12 0` (3rd arg `1` = synchronous workflow, `KEEP=1` keeps the test data) |
| Build all packages | `node scripts/build.mjs` (needs `esbuild`; `MINIFY=1` optional) → `build/*.tgz` |
Results of the runs done so far: [docs/TEST-REPORT.md](docs/TEST-REPORT.md).

## Configuration reference

| Variable | Meaning |
|---|---|
| `REDIS_URL` | Redis address (**required** for cluster mode). |
| `MULTICORE_MAX_WORKERS` | Upper bound for the worker count (default `min(cpus×2, 32)`). |
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

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| The switch refuses to turn on | The message says why: Redis does not answer, a plugin is not enabled, or the app was not started through the supervisor (step 2). |
| *Invalid sign-in origin* | Set `CORS_ORIGIN_WHITELIST` to the address you open in the browser (NocoBase's own check behind proxies). |
| A "Script error for @rosal-nb/…" full-screen error | An old build without the client stub; use the files from this release. |
| Plugin enabled in the UI but adapter inactive | Restart the container (cluster: only one worker saw the change). |
| Log line `… adapter not activated: REDIS_URL is not set` | Single mode or no Redis: expected, nothing is broken. |

## The parts in detail

### Supervisor (launcher)

_Starts NocoBase as several worker processes sharing one port, and changes their number without downtime._

**Basis**

NocoBase community edition is a single Node.js process, i.e. one CPU core. The supervisor is a tiny launcher
(plain Node.js, no NocoBase imports) built on `node:cluster`. It is the **primary** process: it does not serve requests itself, it
forks N **workers**, and every worker runs a complete NocoBase application. The operating system hands incoming
connections to the workers round-robin, so the work is spread over several cores.

**Functionality**

* Starts 1..N workers (`bin/nocobase-multicore.js`); the first start of slot 0 runs `start --quickstart` (install/upgrade of the database), like the stock image.
* **Rolling replace** when the mode or the number of workers changes: a new worker is started, the supervisor waits until it really accepts requests, then the old one leaves the round-robin (`disconnect`), is told to stop (`SIGTERM`, 30 s grace, then `SIGKILL`). Users see no errors.
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

### Manager plugin — `@rosal-nb/plugin-multicore`

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
config atomically (tmp file + rename). Client: a normal NocoBase client plugin (React + Ant Design) registered as a settings page; the UI language is English or Russian following the NocoBase language.

**Configuration**

No settings of its own. The file it controls is `storage/multicore/config.json`. Permissions: Settings → Roles → *Plugin settings* → *Multi-core mode*.

**Safety / removal**

Disabling/removing it switches the cluster off first (safeguard above). It creates **no database tables** and changes no data.

**How to test**

```bash
curl -s -X POST $BASE/api/multicore:selftest -H "Authorization: Bearer $TOKEN"   # "ok": true expected
curl -s $BASE/api/multicore:status -H "Authorization: Bearer $TOKEN"
```

### Pub/Sub adapter — `@rosal-nb/plugin-pubsub-adapter-redis`

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

### Lock adapter — `@rosal-nb/plugin-lock-adapter-redis`

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

### Queue adapter — `@rosal-nb/plugin-queue-adapter-redis`

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

### Worker-id allocator — `@rosal-nb/plugin-worker-id-allocator-redis`

_Gives every process its own id so that two workers never create the same record id._

**Basis**

NocoBase generates primary keys of many tables (workflow executions, jobs, notifications ...) with a **snowflake** algorithm: time + **worker id** (0–31) + counter. Out of the box
every process picks its worker id **at random**. With one process that is fine; with several workers two of them can pick the same number and then create identical ids in the same
millisecond — the database answers `id must be unique` and the record (for instance a workflow execution) is lost. This plugin hands out unique ids.

**Functionality**

* Every process **leases** a free id in 0–31 from Redis (`SET NX PX 30 s`), renews it every 10 s and keeps it for as long as the process lives.
* A crashed process frees its id automatically after 30 s. At most 32 processes can run at once (the supervisor allows at most 32 workers by default).
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

## More

* [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/OPERATIONS.md](docs/OPERATIONS.md) · [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md) · [docs/TEST-REPORT.md](docs/TEST-REPORT.md) · [CHANGELOG.md](CHANGELOG.md) · [AGENTS.md](AGENTS.md)

## License

AGPL-3.0-only (same as NocoBase community edition).
