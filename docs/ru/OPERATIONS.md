# Эксплуатация

## Требования
* NocoBase 2.x (проверено 2.2.33), Node.js 20+ внутри образа.
* Redis 6+ (проверено 7.4) c `maxmemory-policy noeviction` или без вытеснения ключей `mcore:*`.
* PostgreSQL/MySQL — как для обычного NocoBase. Соединений с БД понадобится ×N воркеров: проверьте `max_connections`.

## Установка и удаление (скрипты)
Из распакованного бандла `nocobase-multicore-bundle-<версия>.tgz` (или из `scripts/` репозитория):
```bash
./install.sh --docker <контейнер> --restart     # либо: ./install.sh --local /путь/к/проекту
./uninstall.sh --docker <контейнер>             # --purge дополнительно удаляет папку супервизора
```
`install.sh` идемпотентен: копирует плагины в `storage/plugins/@nb-multicore/<имя>/`, супервизор в `storage/multicore/supervisor/`, выполняет `pm add` + `pm enable`. Опции: `--no-enable`, `--from <папка с tgz>`, `--restart`.
`uninstall.sh`: (1) записывает `enabled:false` и ждёт, пока супервизор вернётся к одному процессу; (2) `pm disable`; (3) `pm remove` и удаление `storage/plugins/@nb-multicore`; (4) папку `storage/multicore/supervisor` **оставляет**, пока контейнер запускается через неё (удаляйте с `--purge` только после возврата на штатный entrypoint).

## Файлы лаунчера
Лаунчер лежит в `storage/multicore/supervisor/` (его кладёт `install.sh`; в репозитории — `packages/supervisor`). Точка входа: `node storage/multicore/supervisor/bin/nocobase-multicore.js`, запускать из корня проекта NocoBase (в образе `/app/nocobase`).

## Docker (официальный образ `nocobase/nocobase`)
Образ запускает приложение последней строкой своего `/app/docker-entrypoint.sh` (`yarn start --quickstart`). Скрипт `packages/supervisor/docker/entrypoint.sh` берёт штатный entrypoint, заменяет только эту строку на запуск лаунчера и выполняет его — остальная подготовка образа (nginx, клиентские файлы) сохраняется. Если в новой версии образа строка изменилась, скрипт остановится с понятной ошибкой.

В сервис `app` нужно добавить:
```yaml
entrypoint: ["/bin/sh", "/app/nocobase/storage/multicore/supervisor/docker/entrypoint.sh"]
environment:
  REDIS_URL: redis://redis:6379/0
  # CORS_ORIGIN_WHITELIST: "https://ваш-адрес"   # если «Invalid sign-in origin» за прокси
```
Готовый пример — `docker/docker-compose.example.yml` (там лаунчер примонтирован как `/multicore`).

## Не Docker
Из корня проекта: `node storage/multicore/supervisor/bin/nocobase-multicore.js` вместо `yarn start`. Переменные окружения те же, что у обычного запуска (`.env` читается воркерами так же, как это делает `nocobase start`).

## Подключение плагинов вручную
```bash
cd /app/nocobase   # корень проекта в контейнере
# распакуйте каждый nb-multicore-plugin-<имя>-<версия>.tgz в storage/plugins/@nb-multicore/plugin-<имя>/
yarn nocobase postinstall   # в NocoBase 2.x `pm add` для уже лежащих в storage/plugins плагинов ничего не делает
yarn nocobase pm enable @nb-multicore/plugin-pubsub-adapter-redis @nb-multicore/plugin-lock-adapter-redis \
  @nb-multicore/plugin-queue-adapter-redis @nb-multicore/plugin-worker-id-allocator-redis @nb-multicore/plugin-multicore
```
Папки плагинов лежат в `storage/plugins/@nb-multicore/<имя>/`. Либо загрузите `.tgz` из релиза через «Менеджер плагинов → Добавить → Загрузить». **Включение/загрузка из интерфейса в работающем кластере затрагивает только обработавший запрос воркер — после этого перезапустите контейнер.**

## Рабочие процессы и удаление плагинов
* Триггеры и рабочие процессы работают как в одном процессе (тесты `tests/workflow.js`: 150/150, 600/600, синхронный 40/40, без дублей и потерь). Плагины не создают таблиц и не меняют данные.
* Удаление/отключение любого плагина сначала выключает кластер (страховка `turnOffClusterMode`, пишет `enabled:false`), супервизор возвращается к одному процессу; ручное восстановление NocoBase не требуется.
* Очередь — «хотя бы один раз»: действия рабочих процессов должны быть идемпотентными.

## Чек-лист для боевого сервера
1. Резервная копия БД и `storage/`.
2. Сначала проверить на копии/тестовом сервере (`tests/workflow.js`, самопроверка).
3. Redis: `maxmemory-policy noeviction`, мониторинг; `max_connections` БД ≥ воркеры × пул.
4. Включать в тихий час, начать с 2–3 воркеров.
5. Откат: переключатель выключить в UI (или `{"enabled": false}` в `config.json`), либо `uninstall.sh`.

## Управление
* UI: Настройки → Многоядерный режим.
* API (нужна роль с правом `pm.multicore`, у root оно есть): `POST /api/multicore:apply {"enabled":true,"workers":2}`, `GET /api/multicore:status`, `POST /api/multicore:selftest`, `GET /api/multicore:whoami`.
* Файл настроек: `storage/multicore/config.json`; состояние лаунчера: `storage/multicore/status.json`. Лаунчер перечитывает конфиг по сообщению от воркера, по `SIGHUP` и раз в 10 секунд.
* Откат без UI: поставьте `{"enabled": false}` в `config.json` (или удалите файл) — лаунчер вернёт один процесс.

## Переменные окружения
| Переменная | По умолчанию | Смысл |
|---|---|---|
| `REDIS_URL` | — | Redis для кластера (обязательна для включения). |
| `MULTICORE_APP_ENTRY` | поиск `@nocobase/app` | Путь к `@nocobase/app/lib/index.js`. |
| `MULTICORE_MAX_WORKERS` | `min(ядра×2, 32)`, не меньше 2 | Верхняя граница числа воркеров. |
| `MULTICORE_QUICKSTART` | включён | `0` — не выполнять `start --quickstart` при первом старте. |
| `MULTICORE_EXIT_GRACE_MS` | `10000` | Сколько воркер может завершаться до `process.exit`. |
| `MULTICORE_REDIS_PREFIX` / `MULTICORE_NAMESPACE` | `mcore` / имя БД | Префикс ключей Redis; разные кластеры на одном Redis. |
| `MULTICORE_STORAGE` / `MULTICORE_CONFIG` | `storage` | Где лежат `config.json` и `status.json`. |

## Сколько воркеров ставить
Не больше числа физических ядер (минус ядра под БД и Redis, если они на том же сервере). Каждый воркер — полноценный процесс NocoBase: примерно 350–400 МБ памяти и своё подключение к БД.

## Диагностика
* `docker logs <контейнер> | grep '\[multicore\]'` — события лаунчера (запуск, замена, выход воркеров).
* Вкладка показывает слот, PID, CPU, память и лаг цикла событий каждого воркера; значения берутся из heartbeat в Redis (раз в 5 с, TTL 20 с).
* Самотест: pub/sub доходит до всех, блокировка исключает другой процесс, 20 задач очереди обработаны по одному разу.
