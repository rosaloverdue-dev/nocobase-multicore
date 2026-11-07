# Архитектура

## Почему не `pm2 -i` / `CLUSTER_MODE`
Штатный `nocobase start` умеет запускать pm2 с несколькими инстансами, но все адаптеры по умолчанию внутрипроцессные: события, блокировки и очередь не пересекают границу процесса, идентификаторы записей могут совпасть. Вместо этого здесь есть управляемый запуск (переключатель в UI) и общие адаптеры на Redis.

## Схема
```
Браузер ─► порт 80/13000 ─► nginx (образ) ─► порт приложения
                                              │
                    nocobase-multicore (primary, node:cluster)
                      ├─ slot 0 ─ NocoBase ─┐
                      ├─ slot 1 ─ NocoBase ─┤  общий слушающий сокет, round-robin
                      └─ slot N ─ NocoBase ─┘
                                 │ Redis: pub/sub · блокировки · очередь (Streams)
                                 │        worker id (аренды) · кэш · heartbeat воркеров
                                 ▼
                              PostgreSQL / MySQL (общая БД)
```

## Лаунчер (`packages/supervisor`)
* **primary**-процесс `node:cluster`. Не загружает код NocoBase, поэтому не может «упасть» вместе с приложением.
* `worker-entry.js` — вход воркера: выполняет `initEnv()` из CLI NocoBase (читает `.env`, выставляет `APP_PACKAGE_ROOT` и др.) и загружает `@nocobase/app/lib/index.js` в этом же процессе → воркер делит слушающий порт лаунчера. Без этого шага приложение падает с `Cannot find @nocobase/preset-nocobase package.json`.
* Конфиг `storage/multicore/config.json`; переключение — «плавная замена»: поднимается новый воркер (временный слот 1000+n), ждётся событие `listening`, старый **сначала отключается от раздачи соединений** (`worker.disconnect()`), через 1.5 с получает SIGTERM, через 30 с — SIGKILL. Уменьшение числа воркеров выполняется до замены, чтобы не поднимать воркер, который тут же погасят.
* **Воркер открывает порт только когда приложение готово.** Шлюз NocoBase открывает HTTP-порт раньше, чем загружает приложение, и до этого отвечает 503. В кластере primary уже направлял бы на такой воркер живой трафик. Поэтому `worker-entry.js` откладывает первый TCP `listen()` до статуса приложения `running` (`AppSupervisor.getAppStatus('main')`); отключается `MULTICORE_DEFER_LISTEN=0`.
* Событие `listening` кластера приходит и для unix-сокета IPC шлюза (порт `-1`), поэтому лаунчер считает воркер готовым только по событию с `port > 0`.
* Воркер завершается сам: после SIGTERM NocoBase останавливает приложение, но процесс остаётся (открытые дескрипторы), поэтому `worker-entry.js` ставит таймер `process.exit(0)` (10 с).
* Упавший воркер перезапускается с задержкой 1 → 2 → … → 30 с; задержка сбрасывается после минуты стабильной работы.
* Слоты >0 и заменяющие воркеры получают уникальный `SOCKET_PATH` (сокет IPC шлюза NocoBase принадлежит одному процессу).
* IPC: `{cmd:'multicore', type:'apply'|'status', reqId}` ↔ `apply:ack` / `status:res`. Запасные каналы: `SIGHUP`, опрос файла раз в 10 с, `status.json`.

## Адаптеры
Каждый плагин включается только при `MULTICORE_MODE=cluster` и заданном `REDIS_URL`; иначе пишет в лог причину и ничего не меняет.

| Плагин | Точка расширения NocoBase | Реализация |
|---|---|---|
| pubsub | `app.pubSubManager.setAdapter` | Отдельные pub/sub-подключения; канал `${prefix}:ps:${channel}`; подключение на `afterStart`. |
| lock | `app.lockManager.registerAdapter('redis')` + `options.defaultAdapter` | `SET NX PX`, Lua для сравнения-и-удаления/продления, продление по таймеру, `LockAcquireError` как у штатного адаптера. |
| queue | `app.eventQueue.setAdapter` | Redis Streams, группа `nb`, `XREADGROUP` на отдельном подключении, `XACK`+`XDEL`, повтор публикацией с `retried+1`, `XAUTOCLAIM` брошенных сообщений через `timeout*2+5с`, `MAXLEN ~100000`. |
| worker-id | `app.workerIdAllocator.setAdapter` | 32 аренды `${prefix}:wid:${id}` (TTL 30 с, продление раз в 10 с); синглтон `globalThis.__mcoreWorkerId` с `rebind(app)` — переживает перезагрузку приложения. |
| кэш | переменные `CACHE_DEFAULT_STORE=redis`, `CACHE_REDIS_URL` | Выставляет лаунчер для воркеров кластера. |

Префикс ключей: `${MULTICORE_REDIS_PREFIX||'mcore'}:${MULTICORE_NAMESPACE||DB_DATABASE||'nocobase'}`.

## Менеджер (`@nb-multicore/plugin-multicore`)
* Ресурс `multicore`: `status`, `apply`, `selftest`, `whoami`; ACL-сниппет `pm.multicore`.
* `apply` проверяет Redis, что все четыре адаптера включены и что приложение запущено под лаунчером; пишет конфиг атомарно (tmp + rename) и сообщает лаунчеру.
* Heartbeat: каждый воркер раз в 5 с пишет в `${prefix}:workers:${pid}` (TTL 20 с) pid, слот, CPU %, RSS, heap, p99 лага цикла событий. Слот в таблице берётся из снимка лаунчера (у заменённого воркера в окружении остаётся временный).
* `selftest`: pub/sub-пинг должен дойти до всех воркеров; блокировка, взятая инициатором, должна блокировать остальных (и не «протекать»); 20 сообщений очереди должны обработаться ровно по разу.
* Клиент: страница настроек (ru/en), опрос статуса каждые 4 с.
