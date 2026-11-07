**English** · [Русский](README.ru.md) · [简体中文](README.zh-CN.md)

# Worker-id allocator — `@rosal-nb/plugin-worker-id-allocator-redis`

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

---
Part of [nocobase-multicore](../../README.md). Package: `@rosal-nb/plugin-worker-id-allocator-redis` · v0.1.0 · AGPL-3.0-only
