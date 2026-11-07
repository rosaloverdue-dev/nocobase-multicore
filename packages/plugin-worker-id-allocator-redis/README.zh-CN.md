[English](README.md) · [Русский](README.ru.md) · **简体中文**

# 工作进程 ID 分配器 — `@nb-multicore/plugin-worker-id-allocator-redis`

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

---
属于 [nocobase-multicore](../../README.zh-CN.md) 项目。包名：`@nb-multicore/plugin-worker-id-allocator-redis` · v0.1.0 · AGPL-3.0-only
