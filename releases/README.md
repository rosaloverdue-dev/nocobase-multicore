# Ready-made builds / Готовые сборки / 预构建包

GitHub Releases cannot be created from the agent session, so the archives live here: `releases/v<version>/`.
Релизы GitHub из сессии агента создавать нельзя, поэтому архивы лежат здесь. / 无法在代理会话中创建 GitHub Release，因此构建产物放在此处。

* `nocobase-multicore-bundle-<ver>.tgz` — **everything + `install.sh` / `uninstall.sh`** (unpack, run `./install.sh --docker <container>`).
* `rosal-nb-plugin-*-<ver>.tgz` — each plugin for *Settings → Plugin manager → Add → Upload*.
* `nocobase-multicore-supervisor-<ver>.tgz` — the launcher (not a plugin).
* `SHA256SUMS` — checksums.

Rebuild: `node scripts/build.mjs` → `build/`. Docs: [../README.md](../README.md) · [RU](../README.ru.md) · [中文](../README.zh-CN.md).
