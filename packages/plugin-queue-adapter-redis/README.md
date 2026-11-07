**English** · [Русский](README.ru.md) · [简体中文](README.zh-CN.md)

# Queue adapter — `@nb-multicore/plugin-queue-adapter-redis`

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

---
Part of [nocobase-multicore](../../README.md). Package: `@nb-multicore/plugin-queue-adapter-redis` · v0.1.0 · AGPL-3.0-only
