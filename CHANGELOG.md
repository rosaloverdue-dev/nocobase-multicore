# Changelog

## 0.1.0 — 2026-11-07
First release. Verified on NocoBase 2.2.33 (see `docs/TEST-REPORT.md`).

* Supervisor (`node:cluster`) with rolling mode switch, scale up/down, crash respawn with backoff.
* Redis adapters as plugins: pub/sub, lock, event queue (Streams), worker-id allocator.
* Manager plugin: settings page with a multi-core switch and worker counter, live worker table, cluster self-test (ru/en).
* Fixes found while testing on the stand: worker bootstrap (`initEnv`), workers now exit on SIGTERM, scale-down before replace, worker leaves the round-robin before SIGTERM, worker accepts connections only when the app is `running`, `listening` of the IPC socket no longer counts as ready, real slot ids in the worker table, client stub for server-only plugins (the UI failed with a requirejs `Script error` without it).
