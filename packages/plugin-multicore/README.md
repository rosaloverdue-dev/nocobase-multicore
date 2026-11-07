**English** · [Русский](README.ru.md) · [简体中文](README.zh-CN.md)

# Manager plugin — `@rosal-nb/plugin-multicore`

_The admin page with the multi-core switch, the worker table and the cluster self-test._

**Basis**

This is the only plugin you interact with. It adds **Settings → Multi-core mode** to NocoBase, exposes the same functions
as an API, and watches the cluster. It does not move any NocoBase function itself — the four adapter plugins do that.

**Functionality**

* **Switch + worker counter** and the *Apply* button. Before it saves, the plugin checks that Redis answers, that all four adapter plugins are enabled and that the app really runs under the supervisor; otherwise it refuses with a readable reason.
* **Live table of processes**: slot, PID, state, uptime, CPU %, memory, event-loop lag, snowflake worker id, host. Data comes from a heartbeat every 5 s through Redis (TTL 20 s).
* **Adapter table**: for every adapter the plugin state (enabled/disabled/missing) and whether the adapter is really in effect in this process.
* **Cluster self-test** (button *Run check*, or `POST /api/multicore:selftest`): (1) a pub/sub message reaches every worker, (2) a held lock keeps every other worker out, (3) 20 queue jobs are processed exactly once each, (4) every worker has its own snowflake worker id.
* **API** (ACL snippet `pm.multicore`, root has it): `GET /api/multicore:status`, `POST /api/multicore:apply {"enabled":true,"workers":3}`, `POST /api/multicore:selftest`, `GET /api/multicore:whoami`.
* **Safeguard**: if this or any adapter plugin is disabled or removed while the cluster is on, the plugin writes `enabled:false` to the config and tells the supervisor, which returns to one process — the site never runs with a half-installed cluster.

**How it is built**

Server: registers the `multicore` resource and the ACL snippet, talks to the supervisor through Node IPC (`process.send`), writes the
config atomically (tmp file + rename). Client: a normal NocoBase client plugin (React + Ant Design) registered as a settings page; the UI language is English or Russian following the NocoBase language.

**Configuration**

No settings of its own. The file it controls is `storage/multicore/config.json`. Permissions: Settings → Roles → *Plugin settings* → *Multi-core mode*.

**Safety / removal**

Disabling/removing it switches the cluster off first (safeguard above). It creates **no database tables** and changes no data.

**How to test**

```bash
curl -s -X POST $BASE/api/multicore:selftest -H "Authorization: Bearer $TOKEN"   # "ok": true expected
curl -s $BASE/api/multicore:status -H "Authorization: Bearer $TOKEN"
```

---
Part of [nocobase-multicore](../../README.md). Package: `@rosal-nb/plugin-multicore` · v0.1.0 · AGPL-3.0-only
