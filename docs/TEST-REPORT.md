# Test report

Dates: 2026-11-07. Environment: a dedicated development server (2 vCPU, Docker), Postgres 16 + Redis 7.4 + `nocobase/nocobase:2.2.33`. Postgres, Redis, the load generator and the app shared those 2 cores, so absolute numbers are modest — ratios matter. There is no automated CI; everything was run by hand with the scripts in `tests/` and `curl`.

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
