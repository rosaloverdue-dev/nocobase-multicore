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
* **Least-busy balancer** (`lib/balancer.js`). The supervisor owns the public port; each worker listens on its own private loopback port (`cluster.schedulingPolicy = SCHED_NONE`). Every HTTP *request* (not connection) is sent to the worker with the fewest requests in flight. A worker that has not sent a heartbeat for 2.5 s (event loop blocked by a heavy request) is avoided while any other worker is available. WebSockets are tunnelled byte-for-byte to the worker with the fewest sockets. `X-Forwarded-For` is appended; idempotent bodyless requests are retried once on another worker if the connection fails; with no ready worker the client gets a JSON 503 with `Retry-After`. `MULTICORE_BALANCER=off` restores the plain shared-port round-robin of `node:cluster`.
  *Why:* nginx opens a new TCP connection per request, and `node:cluster` round-robin hands connections out in turn without looking at load — a user whose request lands on the worker busy with a 20 s export waits, while the other worker idles.
* Config `storage/multicore/config.json`. A switch is a **rolling replace**: a new worker is forked, the supervisor waits until it is `running`, then the old one is removed from the balancer, waits for its in-flight requests (up to 30 s), receives SIGTERM, and SIGKILL after the grace period. Scale-down happens before the replace so a worker that would be killed at once is never started.
* **A worker opens its port only when the app is ready.** The NocoBase gateway opens the HTTP port before the app is loaded and answers 503 until then, so `worker-entry.js` defers the first `listen()` until the app status is `running` (`MULTICORE_DEFER_LISTEN=0` disables it).
* The cluster `listening` event also fires for the gateway's IPC unix socket (port `-1`); only events with `port > 0` count as ready.
* A worker exits by itself: after SIGTERM NocoBase stops the app but the process stays alive, so `worker-entry.js` sets a `process.exit(0)` timer (10 s).
* A crashed worker is respawned with backoff 1 → 2 → … → 30 s; the delay resets after a minute of stable work.
* Workers >0 and replacement workers get a unique `SOCKET_PATH` (the gateway IPC socket belongs to one process).
* IPC: `{cmd:'multicore', type:'apply'|'status'|'hb', reqId}`. Fallbacks: `SIGHUP`, polling the config every 10 s, `status.json` (includes balancer stats).

## Adapters
Each plugin activates only when `MULTICORE_MODE=cluster` and `REDIS_URL` is set; otherwise it logs why and changes nothing.

| Plugin | NocoBase extension point | Implementation |
|---|---|---|
| pubsub | `app.pubSubManager.setAdapter` | Two dedicated connections; channel `${prefix}:ps:${channel}`; connects on `afterStart`. |
| lock | `app.lockManager.registerAdapter('redis')` | `SET NX PX`, Lua compare-and-delete/extend, timer renewal, `LockAcquireError` like the stock adapter. |
| queue | `app.eventQueue.setAdapter` | Redis Streams, group `nb`, `XREADGROUP` on its own connection, `XACK`+`XDEL`, retry by republishing with `retried+1`, `XAUTOCLAIM` of abandoned messages, `MAXLEN ~100000`. |
| worker-id | `app.workerIdAllocator.setAdapter` | 32 leases `${prefix}:wid:${id}` (TTL 60 s, renewed every 10 s; a lost lease is reclaimed, or a supervised worker exits and is respawned); singleton with `rebind(app)` that survives app reloads. |
| cache | `CACHE_DEFAULT_STORE=redis`, `CACHE_REDIS_URL` | Set by the supervisor for cluster workers. |

Key prefix: `${MULTICORE_REDIS_PREFIX||'mcore'}:${MULTICORE_NAMESPACE||DB_DATABASE||'nocobase'}`.

## Manager (`@nb-multicore/plugin-multicore`)
* Resource `multicore`: `status`, `apply`, `selftest`, `whoami`; ACL snippet `pm.multicore`.
* `apply` checks Redis, that all four adapters are enabled and that the app runs under the supervisor; writes the config atomically (tmp + rename) and notifies the supervisor.
* Heartbeat: every 5 s each worker writes `${prefix}:workers:${pid}` (TTL 20 s) with pid, slot, CPU %, RSS, heap, event-loop lag p99. Requests in flight / served counters come from the balancer.
* `selftest`: a pub/sub ping must reach every worker; a lock held by one worker must exclude the others (and not leak); 20 queue messages must each be processed exactly once; every worker must hold a distinct worker id.
* Client: settings page in English, Russian and Simplified Chinese (other locales fall back to English), polling every 4 s.
* Safeguard: disabling or removing any of the five plugins first writes `enabled:false` so the site returns to a single process.
