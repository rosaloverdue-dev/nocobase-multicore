# Known limitations

## Behaviour of NocoBase itself (also reproducible with a single process)
* **Destroying a collection that was already used keeps its resource definition in memory.** After `collections:destroy`, requests to `<name>:list` return 500 instead of 404 until the app restarts. Verified in single-process mode on 2.2.33 — not caused by these plugins.
* **Metadata is synchronised between processes with a ≈1 s delay** (`SyncMessageManager`, 1000 ms debounce). Right after creating a collection a request that lands on another worker may return 404, and `fields:create` on it 500. After ~1 s everything is consistent. Change the data model one action at a time.
* Redis without the RedisBloom module logs a `BF.RESERVE` warning from the token blacklist; the app works (a fallback is used).
* Very high concurrency of **synchronous** workflows (≈200 requests × 12) can stall even stock single-process NocoBase.

## Plugins that keep state in process memory (users kicked out, 401 reload loop)
Some NocoBase plugins remember things in a plain JavaScript `Map` / variable of the running process instead of the database or Redis. With one process that is fine; with several workers each worker knows only its own part of the picture.

*Example (found while testing):* `@nocobase/plugin-online-count` keeps the "online sessions" and "kicked tokens" in memory. A user whose requests are served by worker A is heartbeating only to A; worker B has never seen the session, decides it is gone and answers `401 SESSION_KICKED_OUT`. The browser then reloads the page again and again ("request failed with status code 401" loop).

How to recognise it: some users randomly get logged out / 401 / "session expired" only when several workers are on; with **one worker everything is fine**; the log of one worker shows no problem, the other answers 401.

What you can do (from the simplest):
1. **Turn on worker affinity** in *Settings → Multi-core mode → "Worker affinity"* ("By login token"). The same user is then always served by the same worker, so a per-process memory is consistent for that user. It is **off by default**, takes effect instantly (no restart) and can be turned off again at any time. Trade-offs: the load is spread less evenly (a user who works a lot keeps the same worker); a worker that is stalled or much busier than the others is skipped (so a request may still land on another worker — rare, but the guarantee is "best effort", not absolute); numbers that are *global by nature* ("how many users are online in total") are still wrong, because each worker counts only its own users.
2. Disable the plugin, or run with **1 worker** (switch multi-core mode off).
3. Ask the plugin author to keep that state in the database or Redis. Plugins that only use the database, cache (Redis is the cache store in cluster mode), `app.lockManager`, `app.pubSubManager` and `app.eventQueue` are fine.

How to look for such plugins yourself: search the plugin's server code for module-level `new Map()` / `new Set()` / arrays that are written while handling requests, and for `setInterval` jobs that act on them.

## Limitations of this project
* Worker affinity (optional, off by default) is best effort: it does not make a per-process memory of a third-party plugin correct for numbers that are global by nature.
* `pm enable` / uploading a plugin from the UI while the cluster is running reaches only one worker — restart the app afterwards.
* Local-storage file uploads need a volume shared by all workers (automatic inside one container).
* Queue delivery is *at-least-once*: if a worker dies mid-job another one runs it again. Make workflow actions idempotent.
* Jobs held by a worker that was killed (`kill -9`, OOM) are taken over by another worker after ≈65 s and run again; if the data they refer to was deleted in the meantime they end in an execution error.
* Memory grows linearly with the number of workers (≈350–400 MB each).
* A worker whose event loop is blocked by one very heavy request cannot serve others until that request finishes; the balancer avoids sending it new work, but cannot preempt it. Reduce page sizes / appended relations in heavy blocks.
* Tested on NocoBase 2.2.x only; PostgreSQL only (MySQL is untested).

## Sign-in behind a reverse proxy: "Invalid sign-in origin"
NocoBase 2.x compares the `Origin` header with the request address (`X-Forwarded-Host`/`Host`). If your proxy rewrites the Host header, sign-in is rejected with 403. Forward the original `Host`/`X-Forwarded-Host` or set `CORS_ORIGIN_WHITELIST=https://your-address`. Unrelated to multi-core mode.
