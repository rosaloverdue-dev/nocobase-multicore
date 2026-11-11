# Architecture

## Why not `pm2 -i` / `CLUSTER_MODE`
Stock `nocobase start` can run several pm2 instances, but every adapter is in-process by default: events, locks and the job queue do not cross process borders and generated record ids can collide. This project adds a managed launcher (a switch in the UI) and shared Redis adapters.

## Diagram
```
Browser ─► nginx (image) ─► public port (13000)
                              │
              nocobase-multicore supervisor (node:cluster primary)
                ├─ balancer: least-busy HTTP / WebSocket routing
                ├─ worker 0 ─ NocoBase ─ private 127.0.0.1:<port>
                ├─ worker 1 ─ NocoBase ─ private 127.0.0.1:<port>
                └─ worker N ─ NocoBase ─ private 127.0.0.1:<port>
                           │ Redis: pub/sub · locks · queue (Streams)
                           │        worker ids (leases) · cache · heartbeats
                           ▼
                     PostgreSQL / MySQL (shared database)
```

## Supervisor (`packages/supervisor`)
* The **primary** `node:cluster` process. It never loads NocoBase code, so it cannot crash with the app.
* `worker-entry.js` is the worker entry: runs the NocoBase CLI `initEnv()` (reads `.env`, sets `APP_PACKAGE_ROOT`, …) and loads `@nocobase/app/lib/index.js` in the same process. Without it the app fails with `Cannot find @nocobase/preset-nocobase package.json`.
* **Least-busy balancer** (`lib/balancer.js`). The supervisor owns the public port; each worker listens on its own private loopback port (`cluster.schedulingPolicy = SCHED_NONE`). Every HTTP *request* (not connection) is sent to the worker with the lowest load score: requests in flight + event-loop lag / 100 ms (capped at 10; lag under 50 ms is timer jitter and counts as zero) + 1000 while the worker has not sent a heartbeat for 1.5 s. Workers send a heartbeat over IPC every 500 ms together with how late that timer fired, so a worker busy with one CPU-heavy request gets fewer new ones long before it counts as stalled. WebSockets are tunnelled byte-for-byte to the worker with the fewest sockets. `X-Forwarded-For` is appended; with no ready worker the client gets a JSON 503 with `Retry-After`. `MULTICORE_BALANCER=off` restores the plain shared-port round-robin of `node:cluster`.
  *Accounting rules* (each was a real bug before 0.2.0): a request is "in flight" on exactly one worker and is released exactly once per attempt; a request whose client went away is cancelled upstream and **never retried** (retrying it both ran the request twice and leaked an in-flight count on the second worker, which in the end sent all traffic to one worker); a request is retried only when its body can be replayed (no body, or ≤ 1 MiB buffered by the balancer) and the first worker certainly did not process it — connection refused, any failure of a read (`GET`/`HEAD`/`OPTIONS`), or a reset of a *reused* keep-alive socket before the first response byte while that worker is still alive.
  *Keep-alive:* the balancer keeps connections to the workers and closes idle ones after 8 s; `worker-entry.js` raises the worker's HTTP `keepAliveTimeout` to 10 min. With Node's default 5 s a worker whose event loop was blocked for longer ran its overdue keep-alive timers first when it woke up and destroyed connections that already carried unread requests (clients saw "Bad gateway").
  *Why:* nginx opens a new TCP connection per request, and `node:cluster` round-robin hands connections out in turn without looking at load — a user whose request lands on the worker busy with a 20 s export waits, while the other worker idles.
* Config `storage/multicore/config.json`. A switch is a **rolling replace**: a new worker is forked, the supervisor waits until it is `running`, then the old one is removed from the balancer, waits for its in-flight requests (up to 30 s), receives SIGTERM, and SIGKILL after the grace period. Scale-down happens before the replace so a worker that would be killed at once is never started.
* **A worker opens its port only when the app is ready.** The NocoBase gateway opens the HTTP port before the app is loaded and answers 503 until then, so `worker-entry.js` defers the first `listen()` until the app status is `running` (`MULTICORE_DEFER_LISTEN=0` disables it).
* The cluster `listening` event also fires for the gateway's IPC unix socket (port `-1`); only events with `port > 0` count as ready.
* A worker exits by itself: after SIGTERM NocoBase stops the app but the process stays alive, so `worker-entry.js` sets a `process.exit(0)` timer (10 s).
* A crashed worker is respawned with backoff 1 → 2 → … → 30 s; the delay resets after a minute of stable work. The exit is classified (`oom` = SIGABRT/134, `killed` = SIGKILL/137, `crash`, `signal`, `error`) and written to the journal.
* **Manual restart** of a slot (or of all, one by one) is the same rolling replace; if the replacement never reaches `listening`, it is removed and the old worker keeps serving.
* **Heap limit**: `heapMb` from the config is passed as `--max-old-space-size` in `execArgv` (overrides `NODE_OPTIONS`); a changed value makes the slots stale and they are replaced one by one.
* **Journal**: `Supervisor.event()` keeps the last 200 events in memory (returned with the status) and appends them to `storage/multicore/events.log`. A heartbeat that arrives ≥ 5 s after the previous one is recorded as a `stall` with its duration.
* **Snowflake ids of live workers**: the worker-id plugin reports its leased id over IPC (`type:'wid'`); the supervisor passes the ids of the live workers to every new worker as `MULTICORE_WID_AVOID`.
* Workers >0 and replacement workers get a unique `SOCKET_PATH` (the gateway IPC socket belongs to one process).
* IPC: `{cmd:'multicore', type:'apply'|'status'|'restart'|'hb'|'wid', reqId}` (`hb` carries `lag`, `restart` carries `slot`). Fallbacks: `SIGHUP`, polling the config every 10 s, `status.json` (includes balancer stats and the journal tail).

## Adapters
Each plugin activates only when `MULTICORE_MODE=cluster` and `REDIS_URL` is set; otherwise it logs why and changes nothing.

| Plugin | NocoBase extension point | Implementation |
|---|---|---|
| pubsub | `app.pubSubManager.setAdapter` | Two dedicated connections; channel `${prefix}:ps:${channel}`; connects on `afterStart`. |
| lock | `app.lockManager.registerAdapter('redis')` | `SET NX PX`, Lua compare-and-delete/extend, timer renewal, `LockAcquireError` like the stock adapter. |
| queue | `app.eventQueue.setAdapter` | Redis Streams, group `nb`, `XREADGROUP` on its own connection, `XACK`+`XDEL`, retry by republishing with `retried+1`, `MAXLEN ~100000`. While a handler runs, its worker refreshes the message every 10 s (`XCLAIM … JUSTID` to itself); messages nobody refreshed for 90 s belong to a dead worker and are taken over with `XAUTOCLAIM`. (Before 0.2.0 any job longer than 35 s was taken over by another worker and started a second time.) |
| worker-id | `app.workerIdAllocator.setAdapter` | 32 leases `${prefix}:wid:${id}` (TTL 60 s, renewed every 10 s; a lost lease is reclaimed, or a supervised worker exits and is respawned); singleton with `rebind(app)` that survives app reloads. Ids listed in `MULTICORE_WID_AVOID` (held by live sibling workers) are not taken even when their lease has expired. |
| cache | `CACHE_DEFAULT_STORE=redis`, `CACHE_REDIS_URL` | Set by the supervisor for cluster workers. |

Key prefix: `${MULTICORE_REDIS_PREFIX||'mcore'}:${MULTICORE_NAMESPACE||DB_DATABASE||'nocobase'}`.

## Manager (`@nb-multicore/plugin-multicore`)
* Resource `multicore`: `status`, `apply`, `selftest`, `whoami`, `restart`, `connections`; ACL snippet `pm.multicore`.
* `apply` checks Redis, that all four adapters are enabled and that the app runs under the supervisor; writes the config atomically (tmp + rename) and notifies the supervisor.
* Heartbeat: every 5 s each worker writes `${prefix}:workers:${pid}` (TTL 20 s) with pid, slot, CPU %, RSS, heap and heap limit, event-loop lag p99, number of WebSocket clients and signed-in users; `${prefix}:conn:${pid}` with the list `[userId, tabs, since, ip]` of its signed-in WebSocket clients (read from `Gateway.getInstance().wsServer.webSocketClients`, tag `userId#<id>` set by the auth plugin); and adds itself to the sorted set `${prefix}:workers:index` (the list of live workers without a keyspace `SCAN`). All in one pipeline.
* The worker table is built from the supervisor's slot list (authoritative: a worker with a blocked event loop sends no heartbeat but still exists) and enriched with the Redis heartbeats and the balancer counters.
* `connections` merges the lists of all workers (or one slot), resolves user names from the `users` collection (cached 60 s) and returns users with their tabs per worker.
* `selftest`: a pub/sub ping must reach every worker; a lock held by one worker must exclude the others (and not leak); 20 queue messages must each be processed exactly once; every worker must hold a distinct worker id.
* Client: settings page in English, Russian and Simplified Chinese (other locales fall back to English), polling every 4 s.
* Safeguard: disabling or removing any of the five plugins first writes `enabled:false` so the site returns to a single process.
