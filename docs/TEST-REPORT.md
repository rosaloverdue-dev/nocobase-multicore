# Test report

Dates: 2026-11-07. Environment: a dedicated development server (2 vCPU, Docker), Postgres 16 + Redis 7.4 + `nocobase/nocobase:2.2.33`. Postgres, Redis, the load generator and the app shared those 2 cores, so absolute numbers are modest — ratios matter. There is no automated CI; everything was run by hand with the scripts in `tests/` and `curl`.

## 0.2.0 (2026-11-11) — local tests only, not yet re-run on a NocoBase stand
No NocoBase stand was reachable when 0.2.0 was written. What was run: the automated tests in this repository, on a 2-core machine with Node 22 and a real Redis 7 (no NocoBase). What was **not** run: anything inside a real NocoBase (see the last table).

| Check (`npm run test:unit`, 47 tests) | Result |
|---|---|
| Client aborts 40 slow `GET`s (the browser leaves the page) | 0.1.2: 80 upstream hits, "in flight" stuck at 10/9/11/10, next 200 requests split **0/200/0/0**. 0.2.0: 40 hits, in flight 0/0/0/0, split **50/50/50/50** |
| 4 `POST`s sent to a worker 0.4 s into a 7 s event-loop block (stock 5 s keep-alive on the worker) | 0.1.2: **4 × 502 Bad gateway**. 0.2.0: 4 × 200 (replayed); with the 10 min worker keep-alive of 0.2.0 no replay is needed at all |
| `POST` replay rules | replayed when the worker is unreachable or resets a reused idle socket while alive; **not** replayed (502) when the worker is gone; uploads > 1 MiB and chunked bodies streamed untouched |
| Requests longer than the balancer's idle-socket timeout (11 s answer, stream with 10 s pauses) | delivered; idle sockets closed after 8 s |
| Supervisor end-to-end with 3 fake workers: boot | 90 sequential requests split 30/30/30; workers keep idle connections ≥ 10 min |
| Manual restart of one worker under load (4 parallel clients) | new pid in the slot, other workers untouched, **0 failed requests**, journal has `restart-requested` + `restarted` |
| Worker exits with code 3 | respawned, `restarts = 1`, journal `worker-exit` with reason and code |
| One worker blocked for 5.6 s while 30 `POST`s arrive | all 200, none routed to the blocked worker, max latency < 1 s, journal `stall` ≥ 5 s, 0 balancer errors |
| `heapMb: 300` in the config + `SIGHUP` | rolling replace of all workers, `v8` heap limit ≈ 300 MB in every worker |
| Mode off | one worker in single mode; `SIGTERM` → clean exit, `events.log` complete |
| Queue adapter on a real Redis | 60 messages over 2 consumers exactly once; a job running 4× longer than the takeover threshold runs **once** (without the refresh: started a second time by the other worker); a dead worker's job is taken over; `maxRetries` honoured |
| Worker-id allocator on a real Redis | distinct ids, renew extends to 60 s, an expired lease is reclaimed, a stolen id makes the worker exit; ids in `MULTICORE_WID_AVOID` are not taken |
| Manager plugin (stub app, real Redis) | heartbeat + connection list + index written; worker list without `SCAN`; "who is connected" merges two workers, resolves names, filters by slot; `restart` refused without a supervisor and forwarded with one; `heapMb` saved and preserved; stalled worker stays in the table |
| Proxy throughput, 2 workers, 64 parallel keep-alive clients | 0.1.2: 8.2–8.7k req/s `GET`, 7.6–8.3k `POST`; 0.2.0: 8.8–9.0k `GET`, 8.1–8.7k `POST` (no regression from buffering small bodies) |

| Check (`npm run test:ui`, 28 checks, headless Chromium, mock API, stand-in components instead of antd) | Result |
|---|---|
| Page renders in ru / en / zh | no page errors, no untranslated keys |
| Worker table | 4 rows; a stalled worker shows "not responding 7 s"; "you are here"; requests per second after the second poll |
| Who is connected | opens per worker and for all workers, asks the server for the right slot, search filters |
| Restart | confirmation → `multicore:restart {slot: 0}` / `{slot: "all"}`; a refused restart shows the server's message |
| Settings | `apply` sends `heapMb`; warning when limits exceed RAM; database budget warning for 5 × 20 of 100 connections; self-test result |

| Still to do on a stand with real NocoBase 2.2.x | Why it matters |
|---|---|
| Open the new settings page | layout and antd props were only exercised with stand-in components |
| "Who is connected" with real signed-in tabs | depends on `Gateway.getInstance().wsServer.webSocketClients` and the `userId#<id>` tag of the auth plugin |
| Restart a worker / all workers from the page while clicking around | end-to-end through plugin → IPC → supervisor |
| Self-test, `tests/workflow.js`, `tests/consistency.js` | regression check of the adapters inside NocoBase |
| Heavy block (thousands of rows) + writes in another tab | the original Bad-gateway scenario on a real app |

## Install / uninstall on a clean Docker Compose project
| Check | Result |
|---|---|
| `install.sh --docker <container> --workers 2` on a stock NocoBase + Postgres compose project | one command: plugins installed and enabled, Redis container created, app recreated under the supervisor, `reconcile done: mode=cluster workers=2` |
| Settings page in English, Russian and Simplified Chinese (headless browser) | renders, translated, no page errors |
| Cluster self-test right after install | pub/sub 2/2, lock 1/1 blocked 0 leaked, queue 20/20 no duplicates, worker ids distinct |
| `uninstall.sh --docker <container> --purge` | plugins removed, compose override and Redis volume removed, app recreated with its original entrypoint, `storage/multicore` deleted |

## Functional
| Check | Result |
|---|---|
| Single process ⇄ cluster (2, 3 workers), scale 3 → 2 | rolling, clean |
| Scale-down 3 → 2 under a constant request stream (400 sequential requests) | **400 × HTTP 200**, no errors |
| WebSocket `/ws` through the balancer | `101 Switching Protocols` |
| `tests/workflow.js`: collection trigger + "create record" node, asynchronous 150/150, synchronous 40/40 (and earlier 600/600) | every execution exactly once, no duplicates, no losses |
| `tests/consistency.js`: collection / field create visible on all workers | convergence 0.6–1.1 s (NocoBase's 1 s debounce) |
| Schedule trigger every 5 s with 3 workers | exactly one run per tick (56 ticks), no duplicates |
| `kill -9` of each worker in turn under load | the supervisor respawns it (backoff 1 s), the self-test passes afterwards |
| Disabling / removing any plugin while the cluster is on | cluster switched off automatically, site answers 200 all the time |
| Balancer unit tests (`npm run test:unit`) | 7/7: even sharing, busy and stalled workers avoided, 3 MB request body intact, 503 without upstream and retry on a dead upstream, WebSocket tunnel, graceful drain |
| Balancer counters after the workflow runs | 231 requests, 0 errors, 0 no-upstream, in-flight returns to 0 when idle |

## Throughput (before the balancer)
`bench_rows:list?pageSize=2000` (≈700 KB JSON, CPU-bound), 8 concurrent clients, 15 s:

| Mode | req/s | p50, ms | p95, ms |
|---|---|---|---|
| cluster, 1 worker | 6.2 | 1238 | 1938 |
| cluster, 2 workers | **12.7** | 555 | 1179 |
| cluster, 3 workers (on 2 cores) | 10.2 | 677 | 1821 |
| single process (no adapters) | 6.7 | 1234 | 1530 |

Two workers on two cores give ≈2×; a third worker on two cores does not help (it competes with Postgres and the load generator).

## Defects found and fixed during testing
1. Workers started without the NocoBase CLI environment → `worker-entry.js` runs `initEnv()`.
2. A worker did not exit on SIGTERM → exit timer in `worker-entry.js`.
3. The old worker still received new connections during a replace → it leaves the balancer first and drains.
4. The new worker opened its port before the app was loaded (503 "app is starting") → `listen()` is deferred until the app is `running`.
5. `listening` of the IPC unix socket was taken for readiness → only events with `port > 0` count.
6. An extra worker was started and immediately stopped on mode change → scale-down happens before the replace.
7. A temporary slot 1000+ showed in the worker table → the slot is taken from the supervisor snapshot.
8. Server-only plugins without `dist/client/index.js` broke the whole NocoBase UI → the build generates a client stub.
9. The worker-id adapter was installed too late: workers received identical random ids and ~27 % of trigger executions were lost (`id must be unique`) → set in `afterAdd`.
10. Round-robin on a new connection ignored load → least-busy balancer (see [ARCHITECTURE.md](ARCHITECTURE.md)).
11. `install.sh` relied on `pm add`, which does nothing for plugins already placed in `storage/plugins` on NocoBase 2.2.33 → the installer runs `postinstall` (links the plugins) and then `pm enable`.

## Not verified
Redis outage behaviour; long soak runs; file uploads from several workers with local storage on separate volumes; NocoBase versions other than 2.2.33; MySQL; `install.sh --local` on a physical host with a system service manager (it was verified end-to-end inside a clean container: install, supervisor start, workflows).
