[English](README.md) · [Русский](README.ru.md) · **简体中文**

# 守护进程（启动器）

_以多个工作进程共享同一端口的方式启动 NocoBase，并可在不中断服务的情况下调整进程数量。_

**基础**

NocoBase 社区版只有一个 Node.js 进程，也就是只用到一个 CPU 核心。守护进程（supervisor）是一个很小的启动器（纯 Node.js，不引用 NocoBase 代码），基于 `node:cluster`。
它是**主进程**：自己不处理请求，而是启动 N 个**工作进程**，每个工作进程都是一个完整的 NocoBase 应用。操作系统把新连接轮流分给各个工作进程，从而把负载分摊到多个核心上。

**功能**

* 启动 1..N 个工作进程（`bin/nocobase-multicore.js`）；槽位 0 首次启动时执行 `start --quickstart`（安装/升级数据库），与官方镜像一致。
* 切换模式或调整进程数时**滚动替换**：先启动新进程，等它真正能接收请求后，旧进程退出分发队列（`disconnect`），再收到 `SIGTERM`（30 秒宽限，之后 `SIGKILL`）。用户不会看到错误。
* 扩容与缩容（缩容时先停止编号最大的槽位）。
* 崩溃的工作进程会按指数退避自动重启（1 秒 → 30 秒）。
* 写入 `storage/multicore/status.json`（模式、进程、状态），读取 `storage/multicore/config.json`（管理页面保存的设置）。配置会在收到工作进程的 IPC 消息、`SIGHUP` 信号时重新读取，并且每 10 秒检查一次。
* 向工作进程传递环境变量：`MULTICORE_SUPERVISED=1`、`MULTICORE_MODE=cluster|single`、`MULTICORE_SLOT`，集群模式下还有 `REDIS_URL`、`CACHE_DEFAULT_STORE=redis`、`CACHE_REDIS_URL`。
* `lib/worker-entry.js` 是每个工作进程实际执行的入口：运行 NocoBase CLI 的 `initEnv()`（加载 `.env`），推迟打开 HTTP 端口直到应用进入 `running` 状态（因此不会有请求收到 “503 app is starting”），并保证收到 `SIGTERM` 后进程会退出。

**实现方式**

`docker/entrypoint.sh`（位于守护进程包内）会修改官方镜像入口脚本的**最后一行**（`yarn start --quickstart`），让它改为启动守护进程；镜像做的其他事情（nginx、前端静态文件）全部保留。
如果未来镜像改动了这一行，脚本会给出明确提示并停止，而不是错误地启动。

**配置**

| 设置 | 默认值 | 含义 |
|---|---|---|
| `storage/multicore/config.json` | `{enabled:false, workers:1}` | 由管理页面（或手工）写入。`enabled:false` = 单个原生进程。 |
| `MULTICORE_MAX_WORKERS` | `min(核心数×2, 32)`，至少 2 | 工作进程数量上限。 |
| `MULTICORE_QUICKSTART` | 开启 | `0` = 首次启动时不执行 `--quickstart`。 |
| `MULTICORE_EXIT_GRACE_MS` | `10000` | 工作进程在 `process.exit` 之前允许的停止时间。 |
| `MULTICORE_APP_ENTRY` | 自动 | `@nocobase/app/lib/index.js` 的路径。 |
| `MULTICORE_REDIS_PREFIX`、`MULTICORE_NAMESPACE` | `mcore`、数据库名 | Redis 键前缀（同一 Redis 上运行多个集群）。 |
| `MULTICORE_DEFER_LISTEN` | 开启 | `0` = 立即打开端口（不推荐）。 |
| `MULTICORE_STORAGE`、`MULTICORE_CONFIG` | `storage` | 配置与状态文件所在位置。 |

**安全 / 卸载**

关闭多核模式（或删除插件）后，守护进程始终回到**单个普通工作进程**，行为与原生 NocoBase 相同。
只要容器仍通过它启动，请不要删除 `storage/multicore/supervisor` 目录。

**如何测试**

```bash
docker exec <容器> cat storage/multicore/status.json     # 目标模式及每个进程的状态
docker logs <容器> 2>&1 | grep '\[multicore\]'           # 守护进程事件
```

---
属于 [nocobase-multicore](../../README.zh-CN.md) 项目。包名：`@nb-multicore/multicore-supervisor` · v0.1.0 · AGPL-3.0-only
