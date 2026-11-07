**English** · [Русский](README.ru.md) · [简体中文](README.zh-CN.md)

# Supervisor (launcher)

_Starts NocoBase as several worker processes sharing one port, and changes their number without downtime._

**Basis**

NocoBase community edition is a single Node.js process, i.e. one CPU core. The supervisor is a tiny launcher
(plain Node.js, no NocoBase imports) built on `node:cluster`. It is the **primary** process: it does not serve requests itself, it
forks N **workers**, and every worker runs a complete NocoBase application. The operating system hands incoming
connections to the workers round-robin, so the work is spread over several cores.

**Functionality**

* Starts 1..N workers (`bin/nocobase-multicore.js`); the first start of slot 0 runs `start --quickstart` (install/upgrade of the database), like the stock image.
* **Rolling replace** when the mode or the number of workers changes: a new worker is started, the supervisor waits until it really accepts requests, then the old one leaves the round-robin (`disconnect`), is told to stop (`SIGTERM`, 30 s grace, then `SIGKILL`). Users see no errors.
* Scale up / scale down (the highest slots are stopped first).
* Respawns a crashed worker with exponential back-off (1 s → 30 s).
* Writes `storage/multicore/status.json` (mode, workers, states) and reads `storage/multicore/config.json` (what the admin page saved). Re-reads the config on an IPC message from a worker, on `SIGHUP`, and every 10 s.
* Passes the environment to workers: `MULTICORE_SUPERVISED=1`, `MULTICORE_MODE=cluster|single`, `MULTICORE_SLOT`, and in cluster mode `REDIS_URL`, `CACHE_DEFAULT_STORE=redis`, `CACHE_REDIS_URL`.
* `lib/worker-entry.js` is what each worker executes: it runs the NocoBase CLI `initEnv()` (loads `.env`), delays opening the HTTP port until the application is in the `running` state (so no request ever gets "503 app is starting"), and guarantees the process exits after `SIGTERM`.

**How it is built**

`docker/entrypoint.sh` (inside the supervisor package) patches the **last line** of the official image entrypoint
(`yarn start --quickstart`) so that it runs the supervisor instead; everything else the image does (nginx, client assets) is kept.
If a future image changes that line the script stops with a clear message instead of starting something wrong.

**Configuration**

| Setting | Default | Meaning |
|---|---|---|
| `storage/multicore/config.json` | `{enabled:false, workers:1}` | Written by the admin page (or by hand). `enabled:false` = one stock process. |
| `MULTICORE_MAX_WORKERS` | `min(cpus×2, 32)`, at least 2 | Upper bound of workers. |
| `MULTICORE_QUICKSTART` | on | `0` = do not run `--quickstart` on first start. |
| `MULTICORE_EXIT_GRACE_MS` | `10000` | How long a worker may take to stop before `process.exit`. |
| `MULTICORE_APP_ENTRY` | auto | Path to `@nocobase/app/lib/index.js`. |
| `MULTICORE_REDIS_PREFIX`, `MULTICORE_NAMESPACE` | `mcore`, DB name | Redis key prefix (several clusters on one Redis). |
| `MULTICORE_DEFER_LISTEN` | on | `0` = open the port immediately (not recommended). |
| `MULTICORE_STORAGE`, `MULTICORE_CONFIG` | `storage` | Where config/status files live. |

**Safety / removal**

Switching the mode off (or removing the plugins) always returns the supervisor to **one plain worker**, which behaves like stock NocoBase.
Keep the `storage/multicore/supervisor` folder as long as the container still starts through it.

**How to test**

```bash
docker exec <container> cat storage/multicore/status.json     # desired mode and every worker state
docker logs <container> 2>&1 | grep '\[multicore\]'           # supervisor events
```

---
Part of [nocobase-multicore](../../README.md). Package: `@nb-multicore/multicore-supervisor` · v0.1.1 · AGPL-3.0-only
