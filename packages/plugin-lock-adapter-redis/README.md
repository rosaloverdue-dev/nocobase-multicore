**English** · [Русский](README.ru.md) · [简体中文](README.zh-CN.md)

# Lock adapter — `@nb-multicore/plugin-lock-adapter-redis`

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

---
Part of [nocobase-multicore](../../README.md). Package: `@nb-multicore/plugin-lock-adapter-redis` · v0.1.1 · AGPL-3.0-only
