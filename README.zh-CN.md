[English](README.md) · [Русский](README.ru.md) · **简体中文**

<h1 align="center">nocobase-multicore</h1>
<p align="center"><b>让 NocoBase 2.x 用上所有 CPU 核心——一键开启，一条命令安装。</b></p>
<p align="center">
  <img alt="license" src="https://img.shields.io/badge/license-AGPL--3.0-blue">
  <img alt="NocoBase" src="https://img.shields.io/badge/NocoBase-2.x-2f54eb">
  <img alt="tested" src="https://img.shields.io/badge/tested-2.2.33-brightgreen">
  <img alt="Redis" src="https://img.shields.io/badge/Redis-6%2B-dc382d">
  <img alt="languages" src="https://img.shields.io/badge/UI-en%20%C2%B7%20ru%20%C2%B7%20zh--CN-lightgrey">
</p>

NocoBase（社区版）只有一个 Node.js 进程，也就是**只用一个 CPU 核心**，服务器再大也一样。`nocobase-multicore` 把它启动为**同一端口后的多个工作进程**，按负载分配请求，并把必须共享的内容（事件、锁、任务队列、记录 ID、缓存）迁移到 Redis。**不修改 NocoBase 内核**：由五个普通插件和一个小型启动器组成，管理页面位于 *设置 → 多核模式*。

| | 原生 NocoBase | 使用 nocobase-multicore |
|---|---|---|
| 使用的核心数 | 1 | 最多全部（工作进程数由你决定） |
| 一个繁重请求 | 卡住整个站点 | 只占用一个工作进程，负载均衡器把其他用户引向空闲进程 |
| 重启 / 切换模式 | 站点中断 | 滚动替换，用户无感知 |
| 安装 | — | 一条命令（Docker Compose：自动带 Redis） |
| 卸载 | — | 一条命令，恢复原生 NocoBase；移除插件会自动关闭集群 |

> 状态 `0.1.0`，已针对 NocoBase **2.2.33** 验证（见 [docs/TEST-REPORT.md](docs/TEST-REPORT.md)）。继续开发的 AI 代理请先阅读 [AGENTS.md](AGENTS.md)。

## 快速开始

NocoBase 运行在 **Docker Compose** 中？一条命令（在 Docker 主机上执行；`<container>` 为 `docker ps` 中的应用容器名）：

```bash
tar xzf nocobase-multicore-bundle-0.1.0.tgz && cd nocobase-multicore-bundle-0.1.0
./install.sh --docker <container> --workers 2
```

脚本会安装并启用五个插件，**在你的 compose 项目中加入 Redis 容器**，把应用切换到守护进程入口并重建应用容器。然后打开 *设置 → 多核模式* 点击“运行检查”。恢复原状：`./uninstall.sh --docker <container>`。

NocoBase 从项目目录运行（不用 Docker）？
```bash
./install.sh --local /path/to/nocobase --redis-url redis://127.0.0.1:6379/0
cd /path/to/nocobase && node storage/multicore/supervisor/bin/nocobase-multicore.js   # 代替 `yarn start`
```
安装包位于 [`releases/v0.1.0`](releases/v0.1.0)（或自行构建：`node scripts/build.mjs`）。

## 包含的内容

| 部分 | 作用 |
|---|---|
| `supervisor` — 启动器 | 启动 N 个工作进程（`node:cluster`），分配请求，平滑调整进程数，重启崩溃的进程。 |
| `plugin-multicore` | 管理页面：开关、进程数、实时进程表、集群自检、安全保护。 |
| `plugin-pubsub-adapter-redis` | 工作进程之间共享的事件总线。 |
| `plugin-lock-adapter-redis` | 跨进程的锁。 |
| `plugin-queue-adapter-redis` | 共享任务队列（每个任务只交给一个工作进程）。 |
| `plugin-worker-id-allocator-redis` | 唯一的工作进程 ID，避免两个进程生成相同的记录 ID。 |

模式关闭或未配置 Redis 时，适配器不做任何改变，NocoBase 照常以单进程运行。

## 工作原理

```
 浏览器 ─► nginx ─► :13000 守护进程（node:cluster 主进程 + “最空闲优先”负载均衡）
                      ├─► 工作进程 1（完整 NocoBase 应用，私有端口） ┐
                      ├─► 工作进程 2（完整 NocoBase 应用，私有端口） ├─► PostgreSQL / MySQL
                      └─► 工作进程 N（完整 NocoBase 应用，私有端口） ┘
                                │ pub/sub · 锁 · 任务队列 · 工作进程 ID · 缓存
                                ▼
                              Redis
```
1. 公共端口由守护进程持有，每个 HTTP **请求**和 WebSocket 都交给当前最空闲的工作进程。
2. 原本在单进程内存里的内容都放进 Redis，使用 NocoBase 自带的扩展点（`pubSubManager`、`lockManager`、`eventQueue`、`workerIdAllocator`、缓存存储）。
3. 管理页面写入 `storage/multicore/config.json`，守护进程读取后执行**滚动替换**（新进程能处理请求后才停止旧进程），没有停机时间。

## 负载均衡

原生 `node:cluster` 按顺序把每个新 TCP 连接交给下一个工作进程，不看负载。当反向代理每个请求都新建连接时，如果某个请求落到正忙于 20 秒大导出的进程上，用户就得等待，而另一个进程却是空闲的。

内置负载均衡器解决了这个问题：

* 每个工作进程监听**私有回环端口**，公共端口由守护进程持有；
* 每个 HTTP 请求交给**处理中请求最少**的工作进程；停止响应心跳（事件循环被阻塞）的进程在有其他可用进程时会被绕开；
* WebSocket 被转发到连接数最少的进程，并添加 `X-Forwarded-For`；
* 无请求体的请求在连接失败时会在另一个进程上重试一次；没有可用进程时返回带 `Retry-After` 的 JSON `503`；
* 滚动替换时，旧进程先退出负载均衡，等其处理中的请求完成后才停止。

实时数据（每个进程的处理中 / 已处理请求数）显示在管理页面和 `storage/multicore/status.json` 中。`MULTICORE_BALANCER=off` 可恢复为普通共享端口模式。

> 正在执行一个巨大同步请求的进程（例如带大量关联的 5000 行列表）在完成之前无法处理其他请求——JavaScript 是单线程的。均衡器会让其他用户绕开它，但根本办法是在繁重的区块中减小分页并减少附加关联。

## 环境要求

* NocoBase **2.x** 社区版（已测试：`nocobase/nocobase:2.2.33`），Docker 或项目目录（`yarn nocobase ...`），Node.js ≥ 20。
* 所有工作进程共用的 PostgreSQL 或 MySQL/MariaDB。*不支持 SQLite。*
* **Redis ≥ 6**，`maxmemory-policy noeviction`。在 Docker Compose 中使用 `install.sh --docker` 会自动创建；否则请传入 `--redis-url` / 设置 `REDIS_URL`。
* 共享的 `storage/` 目录（同一台机器 / 同一个卷）。
* 内存：每个工作进程是完整的 NocoBase 进程（约 350–400 MB）。进程数不要超过物理核心数。

## 安装方式

### 1. 一条命令 — `install.sh`（推荐）

从 [`releases/v0.1.0`](releases/v0.1.0) 下载安装包，解压后运行：

```bash
./install.sh --docker <容器名> [--workers N]               # Docker（Compose：自动配置 Redis 和入口）
./install.sh --local /path/to/nocobase --redis-url URL      # 项目目录 / 虚拟机
```

| 选项 | 含义 |
|---|---|
| `--workers N` | 立即开启多核模式（否则在界面中开启） |
| `--redis-url URL` | 使用自己的 Redis 而不是自动创建（`--local` 必须提供） |
| `--no-switch` | 只安装插件，不改动 compose、入口和 Redis |
| `--no-enable` | 只注册插件，不启用 |
| `--from DIR` | 存放 `*.tgz` 的目录 |
| `--restart` | （配合 `--no-switch`）之后重启容器 |

对于 Docker Compose 容器，脚本会读取 compose 标签，在你的 compose 文件旁写入 `docker-compose.multicore.yml`（守护进程入口、`REDIS_URL`、位于应用网络中的 `multicore-redis` 服务），并对应用执行 `docker compose up -d`。脚本是幂等的。`./uninstall.sh --docker <container> [--purge]` 会删除该文件，并用原始入口重建应用。

### 2. 在浏览器中上传 TGZ

*设置 → 插件管理器 → 添加 → 上传*，依次上传五个 `nb-multicore-plugin-*.tgz` 文件，然后**启用**。守护进程和 Redis 不是插件：应用仍需设置 `REDIS_URL` 并通过守护进程启动（见“启动方式”）。在运行中的集群里通过界面上传/启用只影响一个工作进程，因此**之后请重启容器**。只有这种方式需要手动配置 Redis。

### 3. 手动命令

```bash
# 在 NocoBase 容器 / 项目目录内
for p in pubsub-adapter-redis lock-adapter-redis queue-adapter-redis worker-id-allocator-redis multicore; do
  mkdir -p storage/plugins/@nb-multicore/plugin-$p
  tar xzf nb-multicore-plugin-$p-0.1.0.tgz -C storage/plugins/@nb-multicore/plugin-$p
done
mkdir -p storage/multicore/supervisor && tar xzf nocobase-multicore-supervisor-0.1.0.tgz -C storage/multicore/supervisor
yarn nocobase postinstall          # 把 storage/plugins 链接到 node_modules
yarn nocobase pm enable @nb-multicore/plugin-pubsub-adapter-redis @nb-multicore/plugin-lock-adapter-redis \
  @nb-multicore/plugin-queue-adapter-redis @nb-multicore/plugin-worker-id-allocator-redis @nb-multicore/plugin-multicore
```
然后带上 `REDIS_URL` 通过守护进程启动 NocoBase。

## 启动方式

| 方式 | 命令 | 适用场景 |
|---|---|---|
| Docker Compose（官方镜像） | 入口 `/bin/sh /app/nocobase/storage/multicore/supervisor/docker/entrypoint.sh` + `REDIS_URL`（`install.sh` 自动完成） | 生产环境 |
| 本地 / PM2 / systemd | `REDIS_URL=redis://127.0.0.1:6379/0 node storage/multicore/supervisor/bin/nocobase-multicore.js` | 从项目目录运行的 NocoBase |
| 原生模式（无守护进程） | 通常的 `yarn start` / 镜像入口 | 插件保持不活动，不改变任何行为 |
| 测试环境 | `docker compose -f docker/docker-compose.example.yml up -d` | 从零体验（NocoBase + PostgreSQL + Redis） |

## 管理页面

*设置 → 多核模式*（英文、俄文和简体中文；其他界面语言回退为英文）：

* **开关**和**工作进程数量**（旁边显示服务器 CPU 核心数）；点击“应用”执行滚动替换；
* **实时进程表**：槽位、PID、状态、运行时间、CPU %、内存、事件循环延迟、**处理中 / 已处理请求数**、实例 ID、主机；
* **适配器状态**（pub/sub、锁、队列、工作进程 ID、缓存）以及 Redis 延迟与版本；
* **集群自检**：pub/sub 送达每个进程，锁能排斥其他进程，20 个队列任务各执行一次，工作进程 ID 互不相同。

如果开关被阻止（Redis 不可用、插件未启用、应用未通过守护进程启动），页面会明确说明原因。需要 `pm.multicore` 权限（root 拥有）。

## 测试命令

| 内容 | 命令 |
|---|---|
| 集群自检（pub/sub、锁、队列、工作进程 ID） | 界面：“运行检查”；API：`curl -X POST $BASE/api/multicore:selftest -H "Authorization: Bearer $TOKEN"` |
| 状态 | `curl $BASE/api/multicore:status -H "Authorization: Bearer $TOKEN"` 以及 `cat storage/multicore/status.json` |
| 跨进程数据一致性（在一个进程写入，在所有进程读取） | `BASE=http://host:13000 USER_NAME=admin PASSWORD=... node tests/consistency.js`（环境变量 `READS`、`ROUNDS`） |
| 压力 / 基准测试 | `BASE=... TOKEN=... CONC=64 SECONDS=20 GET_URL=/api/... node tests/bench.js` |
| 工作流：记录触发器 +“创建记录”节点，N 行 | `BASE_URL=... NB_USER=admin NB_PASSWORD=... node tests/workflow.js 150 12 0`（第 3 个参数 `1` = 同步工作流，`KEEP=1` 保留测试数据） |
| 构建全部包 | `node scripts/build.mjs`（需要 `esbuild`；可选 `MINIFY=1`）→ `build/*.tgz` |
已完成的测试结果见 [docs/TEST-REPORT.md](docs/TEST-REPORT.md)。

## 配置参考

| 变量 | 含义 |
|---|---|
| `REDIS_URL` | Redis 地址（集群模式**必填**）。 |
| `MULTICORE_MAX_WORKERS` | 工作进程数量上限（默认 `min(核心数×2, 32)`）。 |
| `MULTICORE_BALANCER` | `off` = 使用普通共享端口模式而不是“最空闲优先”负载均衡（默认开启）。 |
| `MULTICORE_APP_ENTRY` | `@nocobase/app/lib/index.js` 的路径（自动检测）。 |
| `MULTICORE_QUICKSTART` | `0` = 首次启动时不执行 `--quickstart`。 |
| `MULTICORE_EXIT_GRACE_MS` | 停止中的工作进程在 `process.exit` 之前的时限（默认 10000）。 |
| `MULTICORE_REDIS_PREFIX`、`MULTICORE_NAMESPACE` | Redis 键前缀 `<前缀>:<命名空间>`（默认 `mcore:<数据库名>`）。 |
| `MULTICORE_STORAGE`、`MULTICORE_CONFIG` | `config.json` / `status.json` 所在位置（默认 `storage/multicore/`）。 |
| `CORS_ORIGIN_WHITELIST` | NocoBase 自带：通过其他主机名或代理登录时允许的来源。 |

## 工作流、安全与卸载（常见问题）

**工作流和触发器（创建记录、定时等）还能正常工作吗？** 可以。已测试：数据表触发器 +“创建记录”节点（异步和同步），150 和 600 次执行：每次执行都恰好创建并完成一次，没有重复、没有丢失，与单进程模式一致。定时触发器每个周期只触发一次（Redis 锁避免重复触发）。插件不会触碰工作流相关的表和您的数据。

**测试发现了什么？** 一个真实的缺陷：worker-id 适配器安装得太晚，多个工作进程可能得到相同的随机 ID，约 25% 的触发器执行因 `id must be unique` 而丢失。本版本已修复（`afterAdd` 钩子），并由自检和 `tests/workflow.js` 覆盖。

**有哪些限制？** (1) 队列是*至少一次*投递：任务中途崩溃后可能再次执行，请让工作流动作具备幂等性。(2) 极高并发（数百个同时请求）下同步工作流会卡住，原生 NocoBase 单进程也是如此。(3) 在运行中的集群里通过界面启用插件只影响一个进程——之后请重启。(4) 元数据变更（新数据表/字段）约 1 秒后到达所有进程。

**如果我删除这些插件，服务器还能继续正常运行吗？** 可以，无需手动修复。禁用/删除五个插件中的任何一个，都会先把 `enabled:false` 写入配置（*保护机制*），守护进程随即回到**单个普通进程**。插件不创建数据库表，也不修改数据；残留的 Redis 键无害，会自行过期。已测试：整个卸载过程中网站始终返回 200，容器正常重启，已保存的工作流继续触发。请使用 `./uninstall.sh --docker <容器>` 进行干净卸载（加 `--purge` 还会删除守护进程目录——仅在容器已恢复为原生入口之后再执行）。

**生产环境建议：** 先备份数据库；先在预发布副本上试用；在业务低峰期开启；从 2–3 个工作进程开始；关注 Redis（持久化、监控）。

## 故障排查

| 现象 | 原因 / 解决 |
|---|---|
| 开关无法打开 | 提示中会说明原因：Redis 无响应、插件未启用，或应用不是通过守护进程启动的（第 2 步）。 |
| *Invalid sign-in origin* | 将 `CORS_ORIGIN_WHITELIST` 设为您在浏览器中打开的地址（NocoBase 在代理后的自带检查）。 |
| 全屏错误 “Script error for @nb-multicore/…” | 旧版本缺少客户端占位文件；请使用本发布版中的文件。 |
| 界面中已启用插件，但适配器未生效 | 重启容器（集群中只有一个进程看到了该变更）。 |
| 日志出现 `… adapter not activated: REDIS_URL is not set` | 单进程模式或没有 Redis：属预期情况，没有任何问题。 |

## 各部分详细说明

### 守护进程（启动器）

_以多个工作进程共享同一端口的方式启动 NocoBase，并可在不中断服务的情况下调整进程数量。_

**基础**

NocoBase 社区版只有一个 Node.js 进程，也就是只用到一个 CPU 核心。守护进程（supervisor）是一个很小的启动器（纯 Node.js，不引用 NocoBase 代码），基于 `node:cluster`。
它是**主进程**：自己不处理请求，而是启动 N 个**工作进程**，每个工作进程都是一个完整的 NocoBase 应用。内置负载均衡器把每个请求交给最空闲的工作进程，从而把负载分摊到多个核心上。

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

### 管理插件 — `@nb-multicore/plugin-multicore`

_带有多核模式开关、进程表格和集群自检的管理页面。_

**基础**

这是您唯一需要直接操作的插件。它在 NocoBase 中增加 **设置 → Multi-core mode（多核模式）** 页面，提供同样功能的 API，并监控集群。
它本身不迁移 NocoBase 的任何功能——这些由另外四个适配器插件完成。

**功能**

* **开关与进程数量**，以及“应用”按钮。保存前插件会检查：Redis 是否可用、四个适配器插件是否都已启用、应用是否确实运行在守护进程之下；否则会给出易懂的拒绝原因。
* **实时进程表**：槽位、PID、状态、运行时间、CPU %、内存、事件循环延迟、snowflake 工作进程 ID、主机。数据来自每 5 秒一次、经 Redis 传递的心跳（TTL 20 秒）。
* **适配器表**：每个适配器对应插件的状态（已启用/已禁用/缺失），以及该适配器在当前进程中是否真正生效。
* **集群自检**（按钮“运行检查”，或 `POST /api/multicore:selftest`）：(1) pub/sub 消息能到达每个工作进程；(2) 被持有的锁会挡住其他所有工作进程；(3) 20 个队列任务每个恰好处理一次；(4) 每个工作进程都有各自的 snowflake 工作进程 ID。
* **API**（ACL 片段 `pm.multicore`，root 默认拥有）：`GET /api/multicore:status`、`POST /api/multicore:apply {"enabled":true,"workers":3}`、`POST /api/multicore:selftest`、`GET /api/multicore:whoami`。
* **保护机制**：如果集群开启时本插件或任一适配器插件被禁用或删除，插件会把 `enabled:false` 写入配置并通知守护进程，守护进程随即回到单进程——网站不会在“安装不完整”的集群状态下运行。

**实现方式**

服务端：注册 `multicore` 资源和 ACL 片段，通过 Node IPC（`process.send`）与守护进程通信，原子地写入配置（临时文件 + rename）。客户端：标准的 NocoBase 客户端插件（React + Ant Design），以设置页面形式注册；界面语言为英文、俄文或简体中文（跟随 NocoBase 语言）。

**配置**

本身没有设置项。它控制的文件是 `storage/multicore/config.json`。权限：设置 → 角色 → *插件设置* → *Multi-core mode*。

**安全 / 卸载**

禁用/删除时会先关闭集群（见上面的保护机制）。插件**不创建任何数据库表**，也不修改任何数据。

**如何测试**

```bash
curl -s -X POST $BASE/api/multicore:selftest -H "Authorization: Bearer $TOKEN"   # 期望 "ok": true
curl -s $BASE/api/multicore:status -H "Authorization: Bearer $TOKEN"
```

### Pub/Sub 适配器 — `@nb-multicore/plugin-pubsub-adapter-redis`

_让事件对所有工作进程可见（Redis Pub/Sub）。_

**基础**

NocoBase 内部有一条事件总线（`app.pubSubManager`）。默认它在内存中工作：某个进程发布的消息只会到达它自己。
有多个工作进程时，所有需要通知*每一个*进程的功能都会失效。本插件为总线接入 Redis Pub/Sub 适配器，使一个工作进程发布的消息能到达全部进程。

**功能**

NocoBase 中通过这条总线传递的内容：
* **元数据变更**——在界面中创建/修改的数据表或字段会出现在每个工作进程上（约 1 秒，这是 NocoBase 自身的防抖时间）；
* **缓存失效**消息；
* **工作流状态**消息——启用/停用工作流时，在每个工作进程上注册/移除其触发器；
* 其他任何使用 `pubSubManager` / `syncMessageManager` 的插件消息。

**实现方式**

从 NocoBase 自带的 `redisConnectionManager` 获取两个独立的 Redis 连接（订阅模式的连接无法发布消息），插件本身不捆绑 Redis 客户端。频道名为 `mcore:<数据库>:ps:<频道>`。某个处理函数出错只会写入日志，不影响其他处理函数。适配器在 `beforeLoad` 中安装，在 `afterStart` 时连接。

**配置**

仅在 `MULTICORE_MODE=cluster` 且设置了 `REDIS_URL` 时生效；否则日志显示 `pub/sub adapter not activated`，NocoBase 继续使用自带的内存总线。Redis 前缀：`MULTICORE_REDIS_PREFIX` / `MULTICORE_NAMESPACE`。

**安全 / 卸载**

Redis 中不保存任何数据（发后即忘的频道）。禁用/删除插件会先关闭集群。不会向数据库写入任何内容。

**如何测试**

管理页面的“运行检查”按钮（pub/sub 送达 N/N 个工作进程）；或在界面中创建一个数据表，并在另一个浏览器标签页中打开：约 1 秒内可见。`node tests/consistency.js` 将此过程自动化。

### 锁适配器 — `@nb-multicore/plugin-lock-adapter-redis`

_让锁在进程之间生效（Redis `SET NX PX`）。_

**基础**

NocoBase 使用锁（`app.lockManager`）避免两个操作同时执行——例如处理同一个工作流执行、恢复未完成的执行、触发定时任务。原生的锁只在单个进程内有效。
有多个工作进程时，其中两个可能都认为自己持有同一把锁。本插件注册 Redis 锁适配器并将其设为默认。

**功能**

* **跨进程、跨服务器**的互斥：同一个键的临界区同一时间只有一个工作进程执行。
* 与原生适配器语义一致：`tryAcquire`、`acquire(key, ttl)`（等待）、`runExclusive(key, fn, ttl)`（等待、执行、始终释放）。
* 临界区执行期间每 ttl/3 **自动续期**，长任务不会丢锁；若仍然丢失，会在日志中给出警告。
* 正是它避免了**定时触发器重复触发**以及同一个工作流执行被重复处理。

**实现方式**

用 `SET 键 令牌 NX PX ttl` 获取锁，用 Lua 脚本**仅在令牌匹配时**释放/续期（迟到的进程无法释放别人的锁）。
崩溃的工作进程所持有的锁会在 TTL 到期后自动失效。连接来自 NocoBase 的 `redisConnectionManager`。

**配置**

仅在集群模式且设置了 `REDIS_URL` 时生效。它注册适配器 `redis` 并设为 `lockManager.options.defaultAdapter`；单进程模式下仍使用原生锁。键：`mcore:<数据库>:lock:*`。

**安全 / 卸载**

锁是带 TTL 的短期键：故障后不会有任何东西阻塞系统超过 TTL。不会向数据库写入任何内容。

**如何测试**

管理页面“运行检查”：页面所在工作进程持有的锁必须挡住其他所有工作进程（`lockblocked = N-1`，`lockleak = 0`）。实际效果可通过 `node tests/workflow.js` 以及一个 5 秒间隔的定时工作流验证（每个周期恰好运行一次）。

### 队列适配器 — `@nb-multicore/plugin-queue-adapter-redis`

_所有工作进程共用一个任务队列（Redis Streams）：每个任务只会被一个工作进程处理。_

**基础**

NocoBase 把后台工作放入事件队列（`app.eventQueue`）：异步工作流执行、部分通知以及其他插件的任务。
原生队列在内存中，只属于一个进程。有多个工作进程时，每个进程只能看到自己的任务。本插件用所有工作进程共享的 Redis Streams 队列替换它。

**功能**

* 每条消息在整个集群中**恰好**交给一个工作进程（消费者组），因此负载被分摊。
* 成功后消息被确认并删除；失败后带重试计数重新发布（与原生队列相同）。
* **崩溃恢复**：崩溃的工作进程留下的未完成消息，会在 `timeout×2 + 5 秒` 后被其他进程接管（`XAUTOCLAIM`）。
* 投递语义为**至少一次**——在任务执行中途崩溃的少见情况下可能会再执行一次（请让工作流动作可安全重复）。

**实现方式**

用 `XADD` 发布，`XREADGROUP`（组 `nb`，消费者 `<pid>-<随机>`）消费，成功后 `XACK` + `XDEL`；流长度上限 100 000 条；默认轮询间隔 250 毫秒。流键 `mcore:<数据库>:q:<频道>`。

**配置**

仅在集群模式且设置了 `REDIS_URL` 时生效。Redis 不应淘汰键（`maxmemory-policy noeviction`），以免队列任务丢失。

**安全 / 卸载**

未完成的任务保存在 Redis 中。关闭集群后原生内存队列接管；此刻仍在 Redis 流中等待的任务不会被迁移——请在业务空闲时关闭（管理页面和 `uninstall.sh` 会等待工作进程完成当前工作；已排队的工作流执行会由 NocoBase 自身启动时的恢复机制从数据库重新发现）。

**如何测试**

“运行检查”：20 个测试任务 → 处理 20 个、重复 0 个，并分散到各工作进程。`node tests/workflow.js 600 24 0` 通过队列发送 600 个真实的工作流执行：期望 600/600。

### 工作进程 ID 分配器 — `@nb-multicore/plugin-worker-id-allocator-redis`

_为每个进程分配唯一的 ID，避免两个工作进程生成相同的记录 ID。_

**基础**

NocoBase 用 **snowflake** 算法生成很多表的主键（工作流执行、任务、通知等）：时间 + **工作进程 ID**（0–31）+ 计数器。默认情况下
每个进程**随机**选择工作进程 ID。单进程没有问题；有多个工作进程时，其中两个可能选到同一个数字，并在同一毫秒内生成相同的 ID——
数据库返回 `id must be unique`，该记录（例如一次工作流执行）就会丢失。本插件负责分配唯一的 ID。

**功能**

* 每个进程从 Redis **租用**一个 0–31 中空闲的 ID（`SET NX PX 30 秒`），每 10 秒续租，并在进程存活期间一直持有。
* 崩溃的进程在 30 秒后自动释放其 ID。同时最多可运行 32 个进程（守护进程默认最多允许 32 个工作进程）。
* 管理页面会显示每个工作进程的 ID；若两个工作进程 ID 相同，自检会失败。

**实现方式**

内核在插件初始化之后、插件 `beforeLoad` 之前就会向分配器索取 ID，所以适配器必须在 `afterAdd()` 中安装。（早期构建使用 `beforeLoad`，时机太晚，随机 ID 仍会漏过——
这个问题由工作流测试发现，并已在本版本修复。）`release()` 被刻意设为空操作：内核在每次应用*重载*时都会调用它，而进程仍在继续使用该 ID。

**配置**

仅在集群模式且设置了 `REDIS_URL` 时生效。键：`mcore:<数据库>:wid:<0-31>`。

**安全 / 卸载**

数据库中已有的 ID 不受影响；插件只影响新生成的 ID。禁用时会先关闭集群。

**如何测试**

```bash
curl -s -X POST $BASE/api/multicore:selftest -H "Authorization: Bearer $TOKEN"   # checks.workerIds.ok 必须为 true
docker exec <redis> redis-cli --scan --pattern '*:wid:*'                           # 每个运行中的工作进程对应一个键
```

## 更多

* [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/OPERATIONS.md](docs/OPERATIONS.md) · [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md) · [docs/TEST-REPORT.md](docs/TEST-REPORT.md) · [CHANGELOG.md](CHANGELOG.md) · [AGENTS.md](AGENTS.md)

## 许可证

AGPL-3.0-only（与 NocoBase 社区版相同）。
