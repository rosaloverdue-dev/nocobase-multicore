# Ready-made builds

The archives live here: `releases/v<version>/`.

* `nocobase-multicore-bundle-<ver>.tgz` — **everything + `install.sh` / `uninstall.sh`** (unpack, run `./install.sh --docker <container>`).
* `nb-multicore-plugin-*-<ver>.tgz` — each plugin for *Settings → Plugin manager → Add → Upload*.
* `nocobase-multicore-supervisor-<ver>.tgz` — the launcher (not a plugin).
* `SHA256SUMS` — checksums (`sha256sum -c SHA256SUMS`).

Rebuild: `node scripts/build.mjs` → `build/`. Docs: [../README.md](../README.md) · [RU](../README.ru.md) · [中文](../README.zh-CN.md).
