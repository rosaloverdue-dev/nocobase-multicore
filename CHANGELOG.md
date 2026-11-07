# Changelog

## 0.1.0 — 2026-11-07
First release. Verified on NocoBase 2.2.33 (see `docs/TEST-REPORT.md`).

* Supervisor (`node:cluster`) with rolling mode switch, scale up/down, crash respawn with backoff.
* Redis adapters as plugins: pub/sub, lock, event queue (Streams), worker-id allocator.
* Manager plugin: settings page with a multi-core switch and worker counter, live worker table, cluster self-test (ru/en).
* Fixes found while testing on the stand: worker bootstrap (`initEnv`), workers now exit on SIGTERM, scale-down before replace, worker leaves the round-robin before SIGTERM, worker accepts connections only when the app is `running`, `listening` of the IPC socket no longer counts as ready, real slot ids in the worker table, client stub for server-only plugins (the UI failed with a requirejs `Script error` without it).
* **Fix:** worker-id allocator is installed in `afterAdd` (the core asks for the id before `beforeLoad`); previously ~27 % of workflow executions were lost with `id must be unique`. `release()` is a no-op (the lease lives as long as the process).
* Self-test checks that every worker has a distinct worker id; the worker table marks the adapter as active only if its id is really in use.
* Safeguard: disabling/removing any of the five plugins switches cluster mode off first (`packages/shared/src/safeguard.ts`).
* `scripts/install.sh` / `scripts/uninstall.sh`, bundle `nocobase-multicore-bundle-<ver>.tgz` (5 plugin tgz + supervisor + scripts), entrypoint moved to `packages/supervisor/docker/entrypoint.sh`.
* `tests/workflow.js`; trilingual (EN/RU/ZH) README and per-package READMEs; plugin descriptions/homepage links (en/ru/zh) for the plugin manager.
