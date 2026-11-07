[English](README.md) · [Русский](README.ru.md) · **简体中文**

# 锁适配器 — `@rosal-nb/plugin-lock-adapter-redis`

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

---
属于 [nocobase-multicore](../../README.zh-CN.md) 项目。包名：`@rosal-nb/plugin-lock-adapter-redis` · v0.1.0 · AGPL-3.0-only
