# Changelog

## 0.1.0 — 2026-11-07
Highlights of the release:

* **Least-busy load balancer** inside the supervisor: workers listen on private loopback ports, each HTTP request / WebSocket goes to the least busy worker, stalled workers are avoided, rolling replace drains in-flight requests. `MULTICORE_BALANCER=off` restores the shared-port mode. Live counters in the admin page and `status.json`.
* **One-command install**: `install.sh --docker <container> [--workers N]` adds Redis to the Docker Compose project, switches the entrypoint and recreates the app; `--local <dir> --redis-url URL` for project folders; `uninstall.sh` reverts everything (`--purge` also removes the Redis volume).
* Installer uses `postinstall` + `pm enable` (`pm add` does nothing for local plugins on NocoBase 2.2.33).
* Worker entry works with a bare `.env` (no `APP_PACKAGE_ROOT`), as in local installs.
* Admin page in English, Russian and Simplified Chinese; menu title is localised; per-worker requests in flight / served.
* English documentation and README with language switcher (EN / RU / 中文); Russian originals of the long docs in `docs/ru/`.
* Unit tests for the balancer (`npm run test:unit`).
* Optional donations: Boosty button in the three READMEs and `.github/FUNDING.yml`.
* Legal: `LICENSE` now holds the full AGPL-3.0 text; new `NOTICE` (independent project, NocoBase trademark, NocoBase's own license terms); both ship inside every archive.

Details:

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
