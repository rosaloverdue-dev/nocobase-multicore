# Эксплуатация

## Требования
* NocoBase 2.x (проверено 2.2.33), Node.js 20+ внутри образа.
* Redis 6+ (проверено 7.4) c `maxmemory-policy noeviction` или без вытеснения ключей `mcore:*`.
* PostgreSQL/MySQL — как для обычного NocoBase. Соединений с БД понадобится ×N воркеров: проверьте `max_connections`.

## Файлы лаунчера
`packages/supervisor` монтируется в контейнер как `/multicore` (только чтение). Точка входа: `node /multicore/bin/nocobase-multicore.js`. Запускать нужно из корня проекта NocoBase (в образе `/app/nocobase`).

## Docker (официальный образ `nocobase/nocobase`)
Образ запускает приложение последней строкой своего `/app/docker-entrypoint.sh` (`yarn start --quickstart`). Скрипт `docker/entrypoint-multicore.sh` берёт штатный entrypoint, заменяет только эту строку на запуск лаунчера и выполняет его — остальная подготовка образа (nginx, клиентские файлы) сохраняется. Если в новой версии образа строка изменилась, скрипт остановится с понятной ошибкой.

В сервис `app` нужно добавить:
```yaml
entrypoint: ["/bin/sh", "/multicore-entrypoint.sh"]
environment:
  REDIS_URL: redis://redis:6379/0
  MULTICORE_APP_ENTRY: /app/nocobase/node_modules/@nocobase/app/lib/index.js
volumes:
  - ./packages/supervisor:/multicore:ro
  - ./docker/entrypoint-multicore.sh:/multicore-entrypoint.sh:ro
```
Готовый пример — `docker/docker-compose.example.yml`.

## Не Docker
Из корня проекта: `node /путь/к/packages/supervisor/bin/nocobase-multicore.js` вместо `yarn start`. Переменные окружения те же, что у обычного запуска (`.env` читается воркерами так же, как это делает `nocobase start`).

## Подключение плагинов
```bash
cd /app/nocobase   # корень проекта в контейнере
for p in plugin-pubsub-adapter-redis plugin-lock-adapter-redis plugin-queue-adapter-redis plugin-worker-id-allocator-redis plugin-multicore; do
  yarn nocobase pm add @rosal-nb/$p
done
yarn nocobase pm enable @rosal-nb/plugin-pubsub-adapter-redis @rosal-nb/plugin-lock-adapter-redis \
  @rosal-nb/plugin-queue-adapter-redis @rosal-nb/plugin-worker-id-allocator-redis @rosal-nb/plugin-multicore
```
Папки плагинов лежат в `storage/plugins/@rosal-nb/<имя>/`. Либо загрузите `.tgz` из релиза через «Менеджер плагинов → Добавить → Загрузить».

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
