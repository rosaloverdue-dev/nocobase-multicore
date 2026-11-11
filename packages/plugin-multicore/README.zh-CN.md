[English](README.md) · [Русский](README.ru.md) · **简体中文**

# 管理插件 — `@nb-multicore/plugin-multicore`

_带有多核模式开关、进程表格和集群自检的管理页面。_

**基础**

这是您唯一需要直接操作的插件。它在 NocoBase 中增加 **设置 → Multi-core mode（多核模式）** 页面，提供同样功能的 API，并监控集群。
它本身不迁移 NocoBase 的任何功能——这些由另外四个适配器插件完成。

**功能**

* **开关与进程数量**，以及“应用”按钮。保存前插件会检查：Redis 是否可用、四个适配器插件是否都已启用、应用是否确实运行在守护进程之下；否则会给出易懂的拒绝原因。
* **实时进程表**：槽位、PID、状态、运行时间、CPU %、内存、事件循环延迟、snowflake 工作进程 ID、主机。数据来自每 5 秒一次、经 Redis 传递的心跳（TTL 20 秒）。
* **适配器表**：每个适配器对应插件的状态（已启用/已禁用/缺失），以及该适配器在当前进程中是否真正生效。
* **集群自检**（按钮“运行检查”，或 `POST /api/multicore:selftest`）：(1) pub/sub 消息能到达每个工作进程；(2) 被持有的锁会挡住其他所有工作进程；(3) 20 个队列任务每个恰好处理一次；(4) 每个工作进程都有各自的 snowflake 工作进程 ID。
* **工作进程内存上限**（`--max-old-space-size`）位于开关旁边；修改后工作进程会逐个替换。
* **概览**：工作进程数、在线用户、打开的标签页、每秒请求数、负载均衡错误、服务器内存。
* **重启**单个工作进程或逐个重启全部——不中断服务（`POST /api/multicore:restart {"slot": 1 | "all"}`）。
* **谁连接在上面**：点击某个工作进程的用户数（或概览中的“查看”）——用户、登录名、打开的标签页、连接时间、IP、所在工作进程。数据取自 NocoBase 已经保存的 WebSocket 连接（`GET /api/multicore:connections?slot=N`）。
* **事件日志**：工作进程的启动、退出及原因、卡顿及时长、重启、“Bad gateway” 响应。
* 事件循环被阻塞的工作进程会保留在表中并标记为“无响应 N 秒”；每个进程的崩溃和卡顿次数都有统计。
* 当 `(工作进程数 + 1) × DB_POOL_MAX` 超过数据库的 `max_connections` 时给出**警告**。
* **API**（ACL 片段 `pm.multicore`，root 默认拥有）：`GET /api/multicore:status`、`POST /api/multicore:apply {"enabled":true,"workers":3}`、`POST /api/multicore:selftest`、`GET /api/multicore:whoami`。
* **保护机制**：如果集群开启时本插件或任一适配器插件被禁用或删除，插件会把 `enabled:false` 写入配置并通知守护进程，守护进程随即回到单进程——网站不会在“安装不完整”的集群状态下运行。

**实现方式**

服务端：注册 `multicore` 资源和 ACL 片段，通过 Node IPC（`process.send`）与守护进程通信，原子地写入配置（临时文件 + rename）。客户端：标准的 NocoBase 客户端插件（React + Ant Design），以设置页面形式注册；界面语言为英文或俄文（跟随 NocoBase 语言）。

**配置**

本身没有设置项。它控制的文件是 `storage/multicore/config.json`。权限：设置 → 角色 → *插件设置* → *Multi-core mode*。

**安全 / 卸载**

禁用/删除时会先关闭集群（见上面的保护机制）。插件**不创建任何数据库表**，也不修改任何数据。

**如何测试**

```bash
curl -s -X POST $BASE/api/multicore:selftest -H "Authorization: Bearer $TOKEN"   # 期望 "ok": true
curl -s $BASE/api/multicore:status -H "Authorization: Bearer $TOKEN"
```

---
属于 [nocobase-multicore](../../README.zh-CN.md) 项目。包名：`@nb-multicore/plugin-multicore` · v0.2.0 · AGPL-3.0-only
