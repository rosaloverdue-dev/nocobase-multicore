# Known limitations

## Behaviour of NocoBase itself (also reproducible with a single process)
* **Destroying a collection that was already used keeps its resource definition in memory.** After `collections:destroy`, requests to `<name>:list` return 500 instead of 404 until the app restarts. Verified in single-process mode on 2.2.33 — not caused by these plugins.
* **Metadata is synchronised between processes with a ≈1 s delay** (`SyncMessageManager`, 1000 ms debounce). Right after creating a collection a request that lands on another worker may return 404, and `fields:create` on it 500. After ~1 s everything is consistent. Change the data model one action at a time.
* Redis without the RedisBloom module logs a `BF.RESERVE` warning from the token blacklist; the app works (a fallback is used).
* Very high concurrency of **synchronous** workflows (≈200 requests × 12) can stall even stock single-process NocoBase.

## Limitations of this project
* `pm enable` / uploading a plugin from the UI while the cluster is running reaches only one worker — restart the app afterwards.
* Local-storage file uploads need a volume shared by all workers (automatic inside one container).
* Queue delivery is *at-least-once*: if a worker dies mid-job another one runs it again. Make workflow actions idempotent.
* Jobs held by a worker that was killed (`kill -9`, OOM) are taken over by another worker after ≈65 s and run again; if the data they refer to was deleted in the meantime they end in an execution error.
* Memory grows linearly with the number of workers (≈350–400 MB each).
* A worker whose event loop is blocked by one very heavy request cannot serve others until that request finishes; the balancer avoids sending it new work, but cannot preempt it. Reduce page sizes / appended relations in heavy blocks.
* Tested on NocoBase 2.2.x only; PostgreSQL only (MySQL is untested).

## Sign-in behind a reverse proxy: "Invalid sign-in origin"
NocoBase 2.x compares the `Origin` header with the request address (`X-Forwarded-Host`/`Host`). If your proxy rewrites the Host header, sign-in is rejected with 403. Forward the original `Host`/`X-Forwarded-Host` or set `CORS_ORIGIN_WHITELIST=https://your-address`. Unrelated to multi-core mode.
