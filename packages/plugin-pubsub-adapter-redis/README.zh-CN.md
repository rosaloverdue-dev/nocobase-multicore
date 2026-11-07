[English](README.md) · [Русский](README.ru.md) · **简体中文**

# Pub/Sub 适配器 — `@rosal-nb/plugin-pubsub-adapter-redis`

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

---
属于 [nocobase-multicore](../../README.zh-CN.md) 项目。包名：`@rosal-nb/plugin-pubsub-adapter-redis` · v0.1.0 · AGPL-3.0-only
