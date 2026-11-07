**English** · [Русский](README.ru.md) · [简体中文](README.zh-CN.md)

# Pub/Sub adapter — `@nb-multicore/plugin-pubsub-adapter-redis`

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

---
Part of [nocobase-multicore](../../README.md). Package: `@nb-multicore/plugin-pubsub-adapter-redis` · v0.1.0 · AGPL-3.0-only
