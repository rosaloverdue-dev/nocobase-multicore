import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Col, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Statistic, Switch, Table, Tag, Tooltip, Typography, message } from 'antd';
import { Plugin, useAPIClient, useApp } from '@nocobase/client';

const { Text, Paragraph } = Typography;

const DICT: Record<string, Record<string, string>> = {
  ru: {
    title: 'Многоядерный режим',
    subtitle: 'Запуск NocoBase на нескольких ядрах процессора: несколько процессов-воркеров за одним балансировщиком и с общим Redis.',
    notSupervised:
      'Приложение запущено без лаунчера nocobase-multicore, поэтому переключатель не сможет запускать воркеры. См. docs/OPERATIONS.md.',
    redisDown: 'Redis недоступен',
    redisOk: 'Redis',
    adaptersMissing: 'Не включены плагины адаптеров',
    control: 'Управление',
    enable: 'Включить многоядерный режим',
    workers: 'Число воркеров',
    apply: 'Применить',
    applying: 'Применяем…',
    current: 'Сейчас',
    processes: 'процессов',
    cpus: 'ядер на сервере',
    single: 'одноядерный режим',
    cluster: 'многоядерный режим',
    workersTable: 'Воркеры',
    slot: 'Слот',
    pid: 'PID',
    state: 'Состояние',
    uptime: 'Аптайм',
    cpu: 'CPU, %',
    rss: 'Память, МБ',
    lag: 'Лаг цикла, мс',
    inflight: 'Запросов в работе',
    served: 'Обработано запросов',
    host: 'Хост',
    instance: 'ID экземпляра',
    you: 'вы здесь',
    selftest: 'Проверка кластера',
    selftestHint: 'Проверяет в реальном времени: доходят ли сообщения до всех воркеров, держится ли блокировка между процессами, обрабатывается ли каждое задание очереди ровно один раз.',
    run: 'Запустить проверку',
    running_test: 'Проверяем…',
    pass: 'Всё в порядке',
    fail: 'Найдены проблемы',
    pubsub: 'Pub/Sub',
    lock: 'Блокировки',
    queue: 'Очередь',
    workerId: 'Worker ID',
    cache: 'Кэш',
    active: 'активен',
    inactive: 'не активен',
    adapters: 'Адаптеры',
    plugin: 'Плагин',
    saved: 'Настройки сохранены',
    error: 'Ошибка',
    received: 'получили',
    blocked: 'заблокировано',
    leaked: 'утечек',
    processed: 'обработано',
    duplicates: 'дублей',
    distribution: 'распределение по воркерам',
    restartNote: 'Переключение происходит плавно: новые воркеры стартуют, старые завершаются. Это занимает до минуты.',
    affinity: 'Привязка пользователя к воркеру',
    affinityOff: 'Выключена (по умолчанию)',
    affinityToken: 'По токену входа (рекомендуется)',
    affinityIp: 'По IP-адресу клиента',
    affinityHint: 'Нужна, если какие-то плагины хранят состояние в памяти процесса (например, счётчик онлайна): тогда каждый пользователь стабильно попадает на «свой» воркер. Применяется сразу, без перезапуска. Минус: нагрузка распределяется менее ровно; воркер, который завис или сильно перегружен, пользователя не держит.',
    enabledState: 'включён',
    disabledState: 'отключён',
    missingState: 'не установлен',
    heap: 'Лимит памяти воркера, МБ',
    heapAuto: 'авто',
    heapHint: 'Пусто или 0 — не задавать: лимит берётся из NODE_OPTIONS или из настроек Node по умолчанию. При изменении воркеры перезапускаются по очереди, без простоя.',
    heapWarn: 'Сумма лимитов ({sum} МБ) больше памяти сервера ({total} МБ). Если все воркеры одновременно займут свой лимит, серверу не хватит памяти.',
    dbWarn: 'Соединений с базой может не хватить: {workers} воркеров + 1 на время перезапуска × пул {pool} = {need}, а база принимает {max} (max_connections). Под нагрузкой запросы начнут падать с «too many clients». Уменьшите DB_POOL_MAX до {safe} или увеличьте max_connections в базе.',
    overview: 'Сейчас',
    tWorkers: 'Воркеров',
    tOnline: 'Пользователей онлайн',
    tTabs: 'Открытых вкладок',
    tRps: 'Запросов в секунду',
    tErrors: 'Ошибок балансера',
    tErrorsHint: '502 (воркер не ответил): {e} · 503 (нет готового воркера): {n} · с момента запуска супервизора',
    tMem: 'Память сервера',
    tMemHint: 'занято {used} из {total} ГБ · нагрузка {load}',
    show: 'показать',
    running: 'работает',
    stalledFor: 'не отвечает {s} с',
    starting: 'запускается',
    restarting: 'перезапуск',
    draining: 'завершается',
    replacement: 'замена',
    mem: 'Память: процесс / куча',
    memHint: 'RSS процесса · использовано кучи JavaScript из лимита',
    rps: 'Запр./с',
    avg: 'Ср. ответ, мс',
    tabs: 'Вкладок',
    users: 'Пользователей',
    restarts: 'Падений',
    stalls: 'Зависаний',
    actions: 'Действия',
    restart: 'Перезапустить',
    restartConfirm: 'Перезапустить воркер {slot}? Сначала стартует новый воркер, затем старый завершит текущие запросы. Сайт остаётся доступен.',
    restartAll: 'Перезапустить все по очереди',
    restartAllConfirm: 'Перезапустить все воркеры по одному? Сайт остаётся доступен, это займёт несколько минут.',
    restartSent: 'Перезапуск запущен',
    yes: 'Да',
    no: 'Отмена',
    lastExit: 'Последнее завершение: {reason}{code}, {when}',
    lastStall: 'Последнее зависание: {s} с, {when}',
    noBeat: 'Воркер не присылает данные о себе (занят или запускается)',
    usersOn: 'Пользователи на воркере {slot}',
    usersAll: 'Пользователи онлайн',
    usersHint: 'Пользователь считается подключённым к воркеру, пока в его браузере открыта вкладка сайта (WebSocket-соединение). Обычные запросы при выключенной привязке распределяются между всеми воркерами.',
    search: 'Поиск по имени, логину или IP',
    user: 'Пользователь',
    login: 'Логин',
    since: 'Подключён',
    ip: 'IP-адрес',
    onWorkers: 'Воркеры',
    totalsLine: 'Пользователей: {u} · вкладок: {c} · без входа: {a}',
    ago: 'назад',
    journal: 'Журнал событий',
    journalHint: 'Что происходило с воркерами: запуски, падения с причиной, зависания, перезапуски. Хранится в storage/multicore/events.log.',
    time: 'Время',
    event: 'Событие',
    details: 'Подробности',
    'ev.boot': 'Супервизор запущен',
    'ev.reconcile': 'Конфигурация применена',
    'ev.worker-ready': 'Воркер готов',
    'ev.worker-exit': 'Воркер завершился',
    'ev.stall': 'Воркер не отвечал',
    'ev.restart-requested': 'Запрошен перезапуск',
    'ev.restarted': 'Воркер перезапущен',
    'ev.bad-gateway': 'Ошибки «Bad gateway»',
    'ev.apply': 'Настройки изменены',
    'ev.failed': 'Операция не удалась',
    'ev.shutdown': 'Остановка',
    'r.oom': 'нехватка памяти (лимит кучи)',
    'r.killed': 'процесс убит (нехватка памяти на сервере или таймаут остановки)',
    'r.crash': 'сбой процесса',
    'r.signal': 'сигнал',
    'r.exit': 'штатный выход',
    'r.error': 'ошибка',
    dSlot: 'слот {v}',
    dAll: 'все воркеры',
    dBy: 'кто: {v}',
    dSec: '{v} с',
    dBoot: 'запуск за {v} с',
    dCount: '{v} шт.',
    dWorkers: 'воркеров: {v}',
    dRespawn: 'новый через {v} с',
    balancer: 'Балансировщик',
    bRequests: 'Запросов',
    bRetries: 'Повторено на другом воркере',
    bAborted: 'Отменено клиентом',
    bUpgrades: 'WebSocket-подключений',
    bSticky: 'По привязке',
    bMode: 'Режим',
  },
  en: {
    title: 'Multi-core mode',
    subtitle: 'Run NocoBase on several CPU cores: worker processes behind one balancer, sharing one Redis.',
    notSupervised: 'The app is not running under the nocobase-multicore launcher, so this switch cannot start workers. See docs/OPERATIONS.md.',
    redisDown: 'Redis is unavailable',
    redisOk: 'Redis',
    adaptersMissing: 'Adapter plugins are not enabled',
    control: 'Control',
    enable: 'Enable multi-core mode',
    workers: 'Number of workers',
    apply: 'Apply',
    applying: 'Applying…',
    current: 'Right now',
    processes: 'processes',
    cpus: 'CPU cores on the server',
    single: 'single-core mode',
    cluster: 'multi-core mode',
    workersTable: 'Workers',
    slot: 'Slot',
    pid: 'PID',
    state: 'State',
    uptime: 'Uptime',
    cpu: 'CPU, %',
    rss: 'Memory, MB',
    lag: 'Loop lag, ms',
    inflight: 'Requests in flight',
    served: 'Requests served',
    host: 'Host',
    instance: 'Instance ID',
    you: 'you are here',
    selftest: 'Cluster self-test',
    selftestHint: 'Checks live: does pub/sub reach every worker, does a lock hold across processes, is each queue job processed exactly once.',
    run: 'Run self-test',
    running_test: 'Testing…',
    pass: 'All good',
    fail: 'Problems found',
    pubsub: 'Pub/Sub',
    lock: 'Locks',
    queue: 'Queue',
    workerId: 'Worker ID',
    cache: 'Cache',
    active: 'active',
    inactive: 'inactive',
    adapters: 'Adapters',
    plugin: 'Plugin',
    saved: 'Settings saved',
    error: 'Error',
    received: 'received',
    blocked: 'blocked',
    leaked: 'leaks',
    processed: 'processed',
    duplicates: 'duplicates',
    distribution: 'distribution across workers',
    restartNote: 'Switching is rolling: new workers start, old ones stop. It can take up to a minute.',
    affinity: 'Worker affinity (sticky)',
    affinityOff: 'Off (default)',
    affinityToken: 'By login token (recommended)',
    affinityIp: 'By client IP address',
    affinityHint: 'Use it when some plugins keep state in process memory (e.g. an online-users counter): each user then consistently lands on the same worker. Applied instantly, no restart. Trade-off: the load is spread less evenly; a stalled or heavily loaded worker does not hold on to its users.',
    enabledState: 'enabled',
    disabledState: 'disabled',
    missingState: 'not installed',
    heap: 'Worker memory limit, MB',
    heapAuto: 'auto',
    heapHint: 'Empty or 0 = do not set: the limit comes from NODE_OPTIONS or from Node defaults. Changing it restarts the workers one by one, without downtime.',
    heapWarn: 'The limits add up to {sum} MB, more than the server has ({total} MB). If every worker fills its limit at once the server runs out of memory.',
    dbWarn: 'The database may run out of connections: {workers} workers + 1 during a restart × pool {pool} = {need}, but the database accepts {max} (max_connections). Under load requests would fail with "too many clients". Lower DB_POOL_MAX to {safe} or raise max_connections in the database.',
    overview: 'Right now',
    tWorkers: 'Workers',
    tOnline: 'Users online',
    tTabs: 'Open tabs',
    tRps: 'Requests per second',
    tErrors: 'Balancer errors',
    tErrorsHint: '502 (worker did not answer): {e} · 503 (no worker ready): {n} · since the supervisor started',
    tMem: 'Server memory',
    tMemHint: '{used} of {total} GB used · load {load}',
    show: 'show',
    running: 'running',
    stalledFor: 'not responding {s} s',
    starting: 'starting',
    restarting: 'restarting',
    draining: 'stopping',
    replacement: 'replacement',
    mem: 'Memory: process / heap',
    memHint: 'process RSS · JavaScript heap used of the limit',
    rps: 'Req/s',
    avg: 'Avg response, ms',
    tabs: 'Tabs',
    users: 'Users',
    restarts: 'Crashes',
    stalls: 'Stalls',
    actions: 'Actions',
    restart: 'Restart',
    restartConfirm: 'Restart worker {slot}? A new worker starts first, then the old one finishes its requests. The site stays available.',
    restartAll: 'Restart all, one by one',
    restartAllConfirm: 'Restart every worker, one at a time? The site stays available; it takes a few minutes.',
    restartSent: 'Restart started',
    yes: 'Yes',
    no: 'Cancel',
    lastExit: 'Last exit: {reason}{code}, {when}',
    lastStall: 'Last stall: {s} s, {when}',
    noBeat: 'The worker is not reporting about itself (busy or starting)',
    usersOn: 'Users on worker {slot}',
    usersAll: 'Users online',
    usersHint: 'A user counts as connected to a worker while a tab of the site is open in the browser (WebSocket connection). With affinity off, ordinary requests are spread over all workers.',
    search: 'Search by name, login or IP',
    user: 'User',
    login: 'Login',
    since: 'Connected',
    ip: 'IP address',
    onWorkers: 'Workers',
    totalsLine: 'Users: {u} · tabs: {c} · not signed in: {a}',
    ago: 'ago',
    journal: 'Event journal',
    journalHint: 'What happened to the workers: starts, crashes with the reason, stalls, restarts. Stored in storage/multicore/events.log.',
    time: 'Time',
    event: 'Event',
    details: 'Details',
    'ev.boot': 'Supervisor started',
    'ev.reconcile': 'Configuration applied',
    'ev.worker-ready': 'Worker ready',
    'ev.worker-exit': 'Worker exited',
    'ev.stall': 'Worker did not respond',
    'ev.restart-requested': 'Restart requested',
    'ev.restarted': 'Worker restarted',
    'ev.bad-gateway': '"Bad gateway" errors',
    'ev.apply': 'Settings changed',
    'ev.failed': 'Operation failed',
    'ev.shutdown': 'Shutdown',
    'r.oom': 'out of memory (heap limit)',
    'r.killed': 'process killed (server out of memory or stop timeout)',
    'r.crash': 'process crash',
    'r.signal': 'signal',
    'r.exit': 'normal exit',
    'r.error': 'error',
    dSlot: 'slot {v}',
    dAll: 'all workers',
    dBy: 'by: {v}',
    dSec: '{v} s',
    dBoot: 'started in {v} s',
    dCount: '{v}x',
    dWorkers: 'workers: {v}',
    dRespawn: 'new one in {v} s',
    balancer: 'Balancer',
    bRequests: 'Requests',
    bRetries: 'Retried on another worker',
    bAborted: 'Cancelled by the client',
    bUpgrades: 'WebSocket connections',
    bSticky: 'Sticky',
    bMode: 'Mode',
  },
  zh: {
    title: '多核模式',
    subtitle: '让 NocoBase 运行在多个 CPU 核心上：多个工作进程位于同一个负载均衡器之后，共享一个 Redis。',
    notSupervised: '应用没有通过 nocobase-multicore 启动器运行，因此该开关无法启动工作进程。请参阅 docs/OPERATIONS.md。',
    redisDown: 'Redis 不可用',
    redisOk: 'Redis',
    adaptersMissing: '适配器插件未全部启用',
    control: '控制',
    enable: '启用多核模式',
    workers: '工作进程数量',
    apply: '应用',
    applying: '正在应用…',
    current: '当前状态',
    processes: '个进程',
    cpus: '服务器 CPU 核心数',
    single: '单核模式',
    cluster: '多核模式',
    workersTable: '工作进程',
    slot: '槽位',
    pid: 'PID',
    state: '状态',
    uptime: '运行时间',
    cpu: 'CPU，%',
    rss: '内存，MB',
    lag: '事件循环延迟，毫秒',
    inflight: '处理中的请求',
    served: '已处理请求数',
    host: '主机',
    instance: '实例 ID',
    you: '当前进程',
    selftest: '集群自检',
    selftestHint: '实时检查：pub/sub 消息是否送达每个工作进程、跨进程的锁是否生效、每个队列任务是否恰好处理一次、每个进程的 ID 是否唯一。',
    run: '运行检查',
    running_test: '检查中…',
    pass: '一切正常',
    fail: '发现问题',
    pubsub: 'Pub/Sub',
    lock: '锁',
    queue: '队列',
    workerId: '工作进程 ID',
    cache: '缓存',
    active: '已生效',
    inactive: '未生效',
    adapters: '适配器',
    plugin: '插件',
    saved: '设置已保存',
    error: '错误',
    received: '已收到',
    blocked: '已拦截',
    leaked: '泄漏',
    processed: '已处理',
    duplicates: '重复',
    distribution: '各工作进程的分布',
    restartNote: '切换是滚动进行的：先启动新的工作进程，再停止旧的，最多需要一分钟。',
    affinity: '工作进程亲和（粘性路由）',
    affinityOff: '关闭（默认）',
    affinityToken: '按登录令牌（推荐）',
    affinityIp: '按客户端 IP 地址',
    affinityHint: '当某些插件把状态保存在进程内存中（例如在线人数统计）时启用：同一用户将始终落到同一个工作进程。立即生效，无需重启。代价：负载分配不够均匀；卡顿或过载的工作进程不会继续占住它的用户。',
    enabledState: '已启用',
    disabledState: '已禁用',
    missingState: '未安装',
    heap: '工作进程内存上限，MB',
    heapAuto: '自动',
    heapHint: '留空或 0 表示不设置：上限来自 NODE_OPTIONS 或 Node 的默认值。修改后工作进程会逐个重启，不会中断服务。',
    heapWarn: '各进程上限之和（{sum} MB）超过了服务器内存（{total} MB）。如果所有进程同时占满上限，服务器内存将不足。',
    dbWarn: '数据库连接可能不够用：{workers} 个工作进程 + 重启期间多出的 1 个 × 连接池 {pool} = {need}，而数据库只接受 {max} 个连接（max_connections）。高负载时请求会因 “too many clients” 失败。请把 DB_POOL_MAX 降到 {safe}，或调大数据库的 max_connections。',
    overview: '当前',
    tWorkers: '工作进程',
    tOnline: '在线用户',
    tTabs: '打开的标签页',
    tRps: '每秒请求数',
    tErrors: '负载均衡错误',
    tErrorsHint: '502（工作进程未响应）：{e} · 503（没有就绪的工作进程）：{n} · 自监督进程启动以来',
    tMem: '服务器内存',
    tMemHint: '已用 {used} / {total} GB · 负载 {load}',
    show: '查看',
    running: '运行中',
    stalledFor: '无响应 {s} 秒',
    starting: '启动中',
    restarting: '重启中',
    draining: '正在停止',
    replacement: '替换中',
    mem: '内存：进程 / 堆',
    memHint: '进程 RSS · 已用 JavaScript 堆 / 上限',
    rps: '请求/秒',
    avg: '平均响应，毫秒',
    tabs: '标签页',
    users: '用户',
    restarts: '崩溃次数',
    stalls: '卡顿次数',
    actions: '操作',
    restart: '重启',
    restartConfirm: '重启工作进程 {slot}？会先启动新的进程，旧进程处理完当前请求后退出，网站保持可用。',
    restartAll: '逐个重启全部',
    restartAllConfirm: '逐个重启所有工作进程？网站保持可用，需要几分钟。',
    restartSent: '已开始重启',
    yes: '确定',
    no: '取消',
    lastExit: '上次退出：{reason}{code}，{when}',
    lastStall: '上次卡顿：{s} 秒，{when}',
    noBeat: '该工作进程没有上报自身数据（繁忙或正在启动）',
    usersOn: '工作进程 {slot} 上的用户',
    usersAll: '在线用户',
    usersHint: '只要浏览器中打开着网站的标签页（WebSocket 连接），用户就算连接在该工作进程上。未启用亲和时，普通请求会分配给所有工作进程。',
    search: '按姓名、登录名或 IP 搜索',
    user: '用户',
    login: '登录名',
    since: '连接时间',
    ip: 'IP 地址',
    onWorkers: '工作进程',
    totalsLine: '用户：{u} · 标签页：{c} · 未登录：{a}',
    ago: '前',
    journal: '事件日志',
    journalHint: '工作进程发生的事情：启动、崩溃及原因、卡顿、重启。保存在 storage/multicore/events.log。',
    time: '时间',
    event: '事件',
    details: '详情',
    'ev.boot': '监督进程已启动',
    'ev.reconcile': '配置已应用',
    'ev.worker-ready': '工作进程就绪',
    'ev.worker-exit': '工作进程已退出',
    'ev.stall': '工作进程无响应',
    'ev.restart-requested': '请求重启',
    'ev.restarted': '工作进程已重启',
    'ev.bad-gateway': '“Bad gateway” 错误',
    'ev.apply': '设置已修改',
    'ev.failed': '操作失败',
    'ev.shutdown': '停止',
    'r.oom': '内存不足（堆上限）',
    'r.killed': '进程被杀死（服务器内存不足或停止超时）',
    'r.crash': '进程崩溃',
    'r.signal': '信号',
    'r.exit': '正常退出',
    'r.error': '错误',
    dSlot: '槽位 {v}',
    dAll: '全部工作进程',
    dBy: '操作人：{v}',
    dSec: '{v} 秒',
    dBoot: '启动耗时 {v} 秒',
    dCount: '{v} 次',
    dWorkers: '工作进程：{v}',
    dRespawn: '{v} 秒后重新启动',
    balancer: '负载均衡',
    bRequests: '请求数',
    bRetries: '在其他进程上重试',
    bAborted: '被客户端取消',
    bUpgrades: 'WebSocket 连接',
    bSticky: '按亲和路由',
    bMode: '模式',
  },
};

type T = (key: string, vars?: Record<string, any>) => string;

function useT(): T {
  const app = useApp();
  const lang = String((app as any)?.i18n?.language || 'en').toLowerCase();
  const dict = lang.startsWith('ru') ? DICT.ru : lang.startsWith('zh') ? DICT.zh : DICT.en;
  return (key, vars) => {
    let text = dict[key] ?? DICT.en[key] ?? key;
    if (vars) for (const [name, value] of Object.entries(vars)) text = text.split(`{${name}}`).join(String(value));
    return text;
  };
}

function fmtUptime(sec: number) {
  if (sec == null) return '—';
  if (sec < 90) return `${sec}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  if (sec < 172800) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}

function fmtNumber(value: any) {
  return value == null ? '—' : Number(value).toLocaleString();
}

function fmtTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return sameDay ? time : `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${time}`;
}

function fmtAgo(iso: string, t: T) {
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return `${fmtUptime(sec)} ${t('ago')}`;
}

function errorText(e: any) {
  return e?.response?.data?.errors?.[0]?.message || e?.message || String(e);
}

/** Runs `fn` now and then every `ms`, but not while the browser tab is in the background. */
function usePolling(fn: () => void, ms: number, enabled = true) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return undefined;
    ref.current();
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) ref.current();
    }, ms);
    return () => clearInterval(timer);
  }, [ms, enabled]);
}

// ------------------------------------------------------------------ who is connected

const UsersModal: React.FC<{ slot: string | null; open: boolean; onClose: () => void; t: T }> = ({ slot, open, onClose, t }) => {
  const api = useAPIClient();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await api.request({ url: 'multicore:connections', method: 'get', params: slot === null ? {} : { slot } });
      setData(res?.data?.data);
      setError(null);
    } catch (e: any) {
      setError(errorText(e));
    }
  }, [api, slot]);

  useEffect(() => {
    setData(null);
    setQuery('');
  }, [slot, open]);
  usePolling(load, 5000, open);

  const rows = useMemo(() => {
    const users: any[] = data?.users || [];
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => [u.nickname, u.username, u.ip, u.id].some((v) => v != null && String(v).toLowerCase().includes(q)));
  }, [data, query]);

  const columns: any[] = [
    { title: t('user'), dataIndex: 'nickname', render: (v: string, r: any) => v || r.username || `#${r.id}` },
    { title: t('login'), dataIndex: 'username', render: (v: string) => v || '—' },
    { title: t('tabs'), dataIndex: 'tabs', width: 90, sorter: (a: any, b: any) => a.tabs - b.tabs },
    { title: t('since'), dataIndex: 'since', width: 140, render: (v: string) => fmtAgo(v, t), sorter: (a: any, b: any) => a.since.localeCompare(b.since) },
    { title: t('ip'), dataIndex: 'ip', width: 150, render: (v: string) => v || '—' },
  ];
  if (slot === null) {
    columns.push({
      title: t('onWorkers'),
      dataIndex: 'workers',
      render: (list: any[]) => (
        <Space size={2} wrap>
          {(list || []).map((w) => <Tag key={w.slot}>{w.slot}{w.tabs > 1 ? ` ×${w.tabs}` : ''}</Tag>)}
        </Space>
      ),
    });
  }

  return (
    <Modal open={open} onCancel={onClose} footer={null} width={860} destroyOnClose title={slot === null ? t('usersAll') : t('usersOn', { slot })}>
      <Paragraph type="secondary" style={{ marginBottom: 8 }}>{t('usersHint')}</Paragraph>
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 8 }} /> : null}
      <Space style={{ marginBottom: 8, width: '100%', justifyContent: 'space-between' }} wrap>
        <Input allowClear style={{ width: 320 }} placeholder={t('search')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <Text type="secondary">
          {data ? t('totalsLine', { u: data.totals.users, c: data.totals.connections, a: data.totals.anonymous }) : '…'}
        </Text>
      </Space>
      <Table size="small" rowKey={(r: any) => String(r.id)} loading={!data && !error} columns={columns} dataSource={rows}
        pagination={{ pageSize: 15, showSizeChanger: false, hideOnSinglePage: true }} scroll={{ x: true }} />
    </Modal>
  );
};

// ------------------------------------------------------------------ journal

const EVENT_COLORS: Record<string, string> = {
  'worker-exit': 'red',
  'bad-gateway': 'red',
  failed: 'red',
  stall: 'orange',
  'restart-requested': 'blue',
  restarted: 'blue',
  'worker-ready': 'green',
};

function eventDetails(e: any, t: T) {
  const parts: string[] = [];
  if (e.slot === 'all') parts.push(t('dAll'));
  else if (e.slot != null) parts.push(t('dSlot', { v: e.slot }));
  if (e.pid != null) parts.push(`pid ${e.pid}`);
  if (e.type === 'worker-exit') {
    parts.push(t(`r.${e.reason}`) + (e.signal ? ` (${e.signal})` : e.code != null ? ` (code ${e.code})` : ''));
    if (e.respawnInMs != null) parts.push(t('dRespawn', { v: Math.round(e.respawnInMs / 1000) }));
  }
  if (e.type === 'stall' && e.ms != null) parts.push(t('dSec', { v: (e.ms / 1000).toFixed(1) }));
  if (e.type === 'restarted' && e.ms != null) parts.push(t('dSec', { v: (e.ms / 1000).toFixed(1) }));
  if (e.type === 'worker-ready' && e.bootMs != null) parts.push(t('dBoot', { v: (e.bootMs / 1000).toFixed(1) }));
  if (e.type === 'reconcile') {
    if (e.mode) parts.push(e.mode);
    if (e.workers != null) parts.push(t('dWorkers', { v: e.workers }));
    if (e.reason) parts.push(e.reason);
  }
  if (e.type === 'bad-gateway') {
    parts.push(t('dCount', { v: e.count }));
    parts.push(Object.entries(e.codes || {}).map(([code, n]) => `${code}: ${n}`).join(', '));
  }
  if (e.type === 'failed') parts.push([e.what, e.error].filter(Boolean).join(': '));
  if (e.by) parts.push(t('dBy', { v: e.by }));
  return parts.filter(Boolean).join(' · ');
}

// ------------------------------------------------------------------ page

const MulticoreSettings: React.FC = () => {
  const api = useAPIClient();
  const t = useT();
  const [status, setStatus] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [workers, setWorkers] = useState(2);
  const [affinity, setAffinity] = useState('off');
  const [heapMb, setHeapMb] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [applying, setApplying] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);
  const [online, setOnline] = useState<any>(null);
  const [usersSlot, setUsersSlot] = useState<string | null | undefined>(undefined); // undefined = closed, null = all workers
  const [restarting, setRestarting] = useState<string | null>(null);
  const [rates, setRates] = useState<{ total: number | null; bySlot: Record<string, number> }>({ total: null, bySlot: {} });
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const prev = useRef<{ at: number; requests: number; served: Record<string, number> } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.request({ url: 'multicore:status', method: 'get' });
      const data = res?.data?.data;
      setStatus(data);
      setError(null);
      if (data && !dirtyRef.current) {
        setEnabled(Boolean(data.config?.enabled));
        setWorkers(Math.max(1, Number(data.config?.workers) || 2));
        setAffinity(data.config?.affinity || 'off');
        setHeapMb(data.config?.heapMb ? Number(data.config.heapMb) : null);
      }
      // requests per second = difference between two polls
      const balancer = data?.supervisor?.balancer;
      if (balancer && typeof balancer.requests === 'number' && !data.supervisor.stale) {
        const now = Date.now();
        const served: Record<string, number> = {};
        for (const u of balancer.upstreams || []) served[String(u.slot)] = u.served;
        const before = prev.current;
        if (before && now > before.at && balancer.requests >= before.requests) {
          const sec = (now - before.at) / 1000;
          const bySlot: Record<string, number> = {};
          for (const [slot, value] of Object.entries(served)) {
            if (before.served[slot] != null && value >= before.served[slot]) bySlot[slot] = (value - before.served[slot]) / sec;
          }
          setRates({ total: (balancer.requests - before.requests) / sec, bySlot });
        }
        prev.current = { at: now, requests: balancer.requests, served };
      }
    } catch (e: any) {
      setError(errorText(e));
    }
  }, [api]);

  const loadOnline = useCallback(async () => {
    try {
      const res = await api.request({ url: 'multicore:connections', method: 'get', params: { summary: 1 } });
      setOnline(res?.data?.data?.totals || null);
    } catch (e) {
      // the tile simply keeps its last value
    }
  }, [api]);

  usePolling(load, 4000);
  usePolling(loadOnline, 15000);

  const apply = async () => {
    setApplying(true);
    try {
      await api.request({ url: 'multicore:apply', method: 'post', data: { enabled, workers, affinity, heapMb: heapMb || 0 } });
      message.success(t('saved'));
      setDirty(false);
      await load();
    } catch (e: any) {
      message.error(`${t('error')}: ${errorText(e)}`);
    } finally {
      setApplying(false);
    }
  };

  const restart = async (slot: string) => {
    setRestarting(slot);
    try {
      await api.request({ url: 'multicore:restart', method: 'post', data: { slot: slot === 'all' ? 'all' : Number(slot) } });
      message.success(t('restartSent'));
      await load();
    } catch (e: any) {
      message.error(`${t('error')}: ${errorText(e)}`);
    } finally {
      setRestarting(null);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.request({ url: 'multicore:selftest', method: 'post' });
      setTestResult(res?.data?.data);
    } catch (e: any) {
      setTestResult({ ok: false, reason: errorText(e) });
    } finally {
      setTesting(false);
    }
  };

  const missingAdapters = status
    ? Object.entries(status.adapters || {})
        .filter(([key, v]: any) => key !== 'cache' && v.plugin && v.plugin !== 'enabled')
        .map(([key]) => t(key))
    : [];
  const supervisor = status?.supervisor;
  const balancer = supervisor?.balancer;
  const host = supervisor?.host;
  const rows: any[] = status?.workers || [];
  // a supervisor older than 0.2.0 (plugin updated, launcher not yet) has no journal and does not know "restart"
  const canRestart = Boolean(status?.supervised && supervisor && !supervisor.stale && Array.isArray(supervisor.events));
  // warn only about a limit the administrator typed in (Node's own default is a ceiling, not a reservation)
  const heapSum = enabled && heapMb ? heapMb * workers : 0;
  // every worker has its own database pool, and a rolling restart runs one extra worker for a while
  const db = status?.database;
  const dbNeed = enabled && db?.poolMax ? (workers + 1) * db.poolMax : 0;
  const dbShort = Boolean(db?.maxConnections && dbNeed > db.maxConnections - 3);

  const stateTag = (r: any) => {
    if (r.replacement) return <Tag color="blue">{t('replacement')}</Tag>;
    if (r.state === 'starting') return <Tag color="blue">{t('starting')}</Tag>;
    if (r.state === 'restarting') return <Tag color="orange">{t('restarting')}</Tag>;
    if (r.state === 'draining') return <Tag>{t('draining')}</Tag>;
    if (r.stalled) return <Tag color="red">{t('stalledFor', { s: Math.round((r.silentMs || 0) / 1000) })}</Tag>;
    return <Tag color="green">{t('running')}</Tag>;
  };

  const columns: any[] = [
    { title: t('slot'), dataIndex: 'slot', width: 60 },
    { title: t('pid'), dataIndex: 'pid', width: 80 },
    {
      title: t('state'),
      width: 190,
      render: (_: any, r: any) => (
        <Space size={4} wrap>
          {r.noHeartbeat && r.state === 'listening' ? <Tooltip title={t('noBeat')}>{stateTag(r)}</Tooltip> : stateTag(r)}
          {status?.self?.pid === r.pid ? <Tag color="blue">{t('you')}</Tag> : null}
        </Space>
      ),
    },
    { title: t('uptime'), dataIndex: 'uptimeSec', width: 80, render: fmtUptime },
    { title: t('cpu'), dataIndex: 'cpuPercent', width: 80, render: (v: any) => (v == null ? '—' : v) },
    {
      title: <Tooltip title={t('memHint')}>{t('mem')}</Tooltip>,
      width: 190,
      render: (_: any, r: any) =>
        r.rssMb == null ? '—' : (
          <span>
            {r.rssMb} / {r.heapMb ?? '—'}
            <Text type="secondary"> {r.heapLimitMb ? `(${r.heapLimitMb})` : ''}</Text>
          </span>
        ),
    },
    { title: t('lag'), dataIndex: 'loopLagMs', width: 100, render: (v: any) => (v == null ? '—' : v) },
    { title: t('inflight'), dataIndex: 'inflight', width: 100, render: (v: any) => (v == null ? '—' : v) },
    { title: t('served'), dataIndex: 'served', width: 120, render: fmtNumber },
    { title: t('rps'), width: 80, render: (_: any, r: any) => (rates.bySlot[r.slot] == null || r.replacement ? '—' : rates.bySlot[r.slot].toFixed(1)) },
    { title: t('avg'), dataIndex: 'avgMs', width: 110, render: (v: any) => (v == null ? '—' : v) },
    { title: t('tabs'), dataIndex: 'wsClients', width: 80, render: (v: any) => (v == null ? '—' : v) },
    {
      title: t('users'),
      dataIndex: 'wsUsers',
      width: 110,
      render: (v: any, r: any) => (v == null ? '—' : <a onClick={() => setUsersSlot(String(r.slot))}>{v}</a>),
    },
    {
      title: t('restarts'),
      dataIndex: 'restarts',
      width: 80,
      render: (v: number, r: any) =>
        r.lastExit ? (
          <Tooltip title={t('lastExit', { reason: t(`r.${r.lastExit.reason}`), code: r.lastExit.signal ? ` (${r.lastExit.signal})` : r.lastExit.code != null ? ` (code ${r.lastExit.code})` : '', when: fmtAgo(r.lastExit.at, t) })}>
            <Text type={v ? 'danger' : undefined}>{v ?? 0}</Text>
          </Tooltip>
        ) : (v ?? 0),
    },
    {
      title: t('stalls'),
      dataIndex: 'stalls',
      width: 90,
      render: (v: number, r: any) =>
        r.lastStall ? (
          <Tooltip title={t('lastStall', { s: (r.lastStall.ms / 1000).toFixed(1), when: fmtAgo(r.lastStall.at, t) })}>
            <Text type={v ? 'warning' : undefined}>{v ?? 0}</Text>
          </Tooltip>
        ) : (v ?? 0),
    },
    { title: t('instance'), dataIndex: 'instanceId', width: 100, render: (v: any) => (v == null ? '—' : v) },
  ];
  if (canRestart) {
    columns.push({
      title: t('actions'),
      width: 140,
      fixed: 'right',
      render: (_: any, r: any) =>
        r.replacement || r.state !== 'listening' ? null : (
          <Popconfirm title={t('restartConfirm', { slot: r.slot })} okText={t('yes')} cancelText={t('no')} onConfirm={() => restart(String(r.slot))}>
            <Button size="small" loading={restarting === String(r.slot)}>{t('restart')}</Button>
          </Popconfirm>
        ),
    });
  }

  const adapterRows = status
    ? (['pubsub', 'lock', 'queue', 'workerId', 'cache'] as const).map((key) => ({ key, ...(status.adapters?.[key] || {}) }))
    : [];
  const events: any[] = useMemo(() => [...(supervisor?.events || [])].reverse(), [supervisor?.events]);
  const usedGb = host ? ((host.totalMemMb - host.freeMemMb) / 1024).toFixed(1) : null;

  return (
    <div style={{ maxWidth: 1400 }}>
      <Card>
        <Typography.Title level={4} style={{ marginTop: 0 }}>{t('title')}</Typography.Title>
        <Paragraph type="secondary">{t('subtitle')}</Paragraph>
        {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
        {status && !status.supervised ? <Alert type="warning" showIcon message={t('notSupervised')} style={{ marginBottom: 12 }} /> : null}
        {status && !status.redis?.ok ? (
          <Alert type="error" showIcon message={`${t('redisDown')}: ${status.redis?.error || ''}`} style={{ marginBottom: 12 }} />
        ) : null}
        {missingAdapters.length ? (
          <Alert type="warning" showIcon message={`${t('adaptersMissing')}: ${missingAdapters.join(', ')}`} style={{ marginBottom: 12 }} />
        ) : null}
        <Space size="large" wrap align="center">
          <Space>
            <Switch checked={enabled} onChange={(v) => { setEnabled(v); setDirty(true); }} />
            <Text strong>{t('enable')}</Text>
          </Space>
          <Space>
            <Text>{t('workers')}</Text>
            <InputNumber min={1} max={status?.maxWorkers || 8} value={workers} disabled={!enabled}
              onChange={(v) => { setWorkers(Number(v) || 1); setDirty(true); }} />
            <Text type="secondary">({t('cpus')}: {status?.cpus ?? '…'})</Text>
          </Space>
          <Space>
            <Text>{t('affinity')}</Text>
            <Select
              style={{ minWidth: 240 }}
              value={affinity}
              disabled={!enabled}
              onChange={(v) => { setAffinity(v); setDirty(true); }}
              options={[
                { value: 'off', label: t('affinityOff') },
                { value: 'token', label: t('affinityToken') },
                { value: 'ip', label: t('affinityIp') },
              ]}
            />
          </Space>
          <Space>
            <Text>{t('heap')}</Text>
            <InputNumber min={0} max={host?.totalMemMb || 65536} step={256} value={heapMb} placeholder={t('heapAuto')} style={{ width: 110 }}
              onChange={(v) => { setHeapMb(v ? Number(v) : null); setDirty(true); }} />
          </Space>
          <Button type="primary" loading={applying} disabled={!dirty} onClick={apply}>
            {applying ? t('applying') : t('apply')}
          </Button>
        </Space>
        {host && heapSum > host.totalMemMb ? (
          <Alert type="warning" showIcon style={{ marginTop: 12 }} message={t('heapWarn', { sum: heapSum, total: host.totalMemMb })} />
        ) : null}
        {dbShort ? (
          <Alert type="warning" showIcon style={{ marginTop: 12 }}
            message={t('dbWarn', { workers, pool: db.poolMax, need: dbNeed, max: db.maxConnections, safe: Math.max(1, Math.floor((db.maxConnections - 3) / (workers + 1))) })} />
        ) : null}
        <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 4 }}>{t('affinityHint')}</Paragraph>
        <Paragraph type="secondary" style={{ marginTop: 0, marginBottom: 4 }}>{t('heapHint')}</Paragraph>
        <Paragraph type="secondary" style={{ marginTop: 0, marginBottom: 0 }}>
          {t('current')}: <b>{rows.length || '…'}</b> {t('processes')},{' '}
          {status?.clusterModeActive ? t('cluster') : t('single')}. {t('restartNote')}
        </Paragraph>
      </Card>

      <Card title={t('overview')} style={{ marginTop: 16 }}>
        <Row gutter={[16, 16]}>
          <Col xs={12} md={8} xl={4}><Statistic title={t('tWorkers')} value={rows.filter((r) => !r.replacement).length} suffix={<Text type="secondary" style={{ fontSize: 13 }}>/ {status?.cpus ?? '…'} CPU</Text>} /></Col>
          <Col xs={12} md={8} xl={4}>
            <Statistic title={t('tOnline')} value={online?.users ?? '…'} suffix={<a style={{ fontSize: 13 }} onClick={() => setUsersSlot(null)}>{t('show')}</a>} />
          </Col>
          <Col xs={12} md={8} xl={4}><Statistic title={t('tTabs')} value={online?.connections ?? status?.online?.connections ?? '…'} /></Col>
          <Col xs={12} md={8} xl={4}><Statistic title={t('tRps')} value={rates.total == null ? '…' : rates.total.toFixed(1)} /></Col>
          <Col xs={12} md={8} xl={4}>
            <Tooltip title={balancer ? t('tErrorsHint', { e: balancer.errors ?? 0, n: balancer.noUpstream ?? 0 }) : ''}>
              <div><Statistic title={t('tErrors')} value={balancer ? (balancer.errors ?? 0) + (balancer.noUpstream ?? 0) : '…'}
                valueStyle={balancer && (balancer.errors ?? 0) > 0 ? { color: '#cf1322' } : undefined} /></div>
            </Tooltip>
          </Col>
          <Col xs={12} md={8} xl={4}>
            <Tooltip title={host ? t('tMemHint', { used: usedGb, total: (host.totalMemMb / 1024).toFixed(1), load: (host.load || []).join(' / ') }) : ''}>
              <div><Statistic title={t('tMem')} value={host ? Math.round(((host.totalMemMb - host.freeMemMb) / host.totalMemMb) * 100) : '…'} suffix={host ? '%' : ''} /></div>
            </Tooltip>
          </Col>
        </Row>
      </Card>

      <Card
        title={t('workersTable')}
        style={{ marginTop: 16 }}
        extra={canRestart && rows.length > 1 ? (
          <Popconfirm title={t('restartAllConfirm')} okText={t('yes')} cancelText={t('no')} onConfirm={() => restart('all')}>
            <Button size="small" loading={restarting === 'all'}>{t('restartAll')}</Button>
          </Popconfirm>
        ) : null}
      >
        <Table size="small" rowKey={(r: any) => `${r.pid}`} columns={columns} dataSource={rows} pagination={false} scroll={{ x: 'max-content' }} />
        {balancer && typeof balancer.requests === 'number' ? (
          <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
            {t('balancer')}: {t('bMode')} {balancer.mode} · {t('bRequests')} {fmtNumber(balancer.requests)} · {t('bRetries')} {fmtNumber(balancer.retries)} ·{' '}
            {t('bAborted')} {fmtNumber(balancer.aborted)} · {t('bUpgrades')} {fmtNumber(balancer.upgrades)}
            {balancer.affinity && balancer.affinity !== 'off' ? ` · ${t('bSticky')} ${fmtNumber(balancer.sticky)}` : ''}
          </Paragraph>
        ) : null}
      </Card>

      <Card title={t('journal')} style={{ marginTop: 16 }}>
        <Paragraph type="secondary">{t('journalHint')}</Paragraph>
        <Table size="small" rowKey={(r: any) => `${r.at}-${r.type}-${r.pid ?? ''}-${r.slot ?? ''}`} dataSource={events}
          pagination={{ pageSize: 10, showSizeChanger: false, hideOnSinglePage: true }}
          columns={[
            { title: t('time'), dataIndex: 'at', width: 150, render: (v: string) => fmtTime(v) },
            { title: t('event'), dataIndex: 'type', width: 240, render: (v: string) => <Tag color={EVENT_COLORS[v]}>{t(`ev.${v}`)}</Tag> },
            { title: t('details'), render: (_: any, e: any) => eventDetails(e, t) },
          ]} />
      </Card>

      <Card title={t('adapters')} style={{ marginTop: 16 }}>
        <Table size="small" rowKey="key" pagination={false} dataSource={adapterRows} columns={[
          { title: t('adapters'), dataIndex: 'key', render: (k: string) => t(k) },
          { title: t('plugin'), dataIndex: 'plugin', render: (p: string) => p ? <Tag color={p === 'enabled' ? 'green' : 'orange'}>{t(`${p}State`)}</Tag> : '—' },
          { title: '', dataIndex: 'active', render: (a: boolean) => <Tag color={a ? 'green' : 'default'}>{a ? t('active') : t('inactive')}</Tag> },
        ]} />
        {status?.redis?.ok ? <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>{t('redisOk')} {status.redis.version} · {status.redis.latencyMs} ms</Paragraph> : null}
      </Card>

      <Card title={t('selftest')} style={{ marginTop: 16 }}>
        <Paragraph type="secondary">{t('selftestHint')}</Paragraph>
        <Button loading={testing} disabled={!status?.clusterModeActive} onClick={runTest}>{testing ? t('running_test') : t('run')}</Button>
        {testResult ? (
          <div style={{ marginTop: 12 }}>
            {testResult.reason ? <Alert type="warning" showIcon message={testResult.reason} /> : (
              <>
                <Alert type={testResult.ok ? 'success' : 'error'} showIcon message={testResult.ok ? t('pass') : t('fail')} style={{ marginBottom: 8 }} />
                <Space direction="vertical" size={4}>
                  <Text>{t('pubsub')}: {testResult.checks.pubsub.received}/{testResult.checks.pubsub.expected} {t('received')} <Tag color={testResult.checks.pubsub.ok ? 'green' : 'red'}>{testResult.checks.pubsub.ok ? 'OK' : 'FAIL'}</Tag></Text>
                  <Text>{t('lock')}: {testResult.checks.lock.blocked}/{testResult.checks.lock.expectedBlocked} {t('blocked')}, {testResult.checks.lock.leaked} {t('leaked')} <Tag color={testResult.checks.lock.ok ? 'green' : 'red'}>{testResult.checks.lock.ok ? 'OK' : 'FAIL'}</Tag></Text>
                  <Text>{t('queue')}: {testResult.checks.queue.processed}/{testResult.checks.queue.published} {t('processed')}, {testResult.checks.queue.duplicates} {t('duplicates')} <Tag color={testResult.checks.queue.ok ? 'green' : 'red'}>{testResult.checks.queue.ok ? 'OK' : 'FAIL'}</Tag></Text>
                  <Text type="secondary">{t('distribution')}: {Object.entries(testResult.checks.queue.byWorker || {}).map(([pid, n]) => `pid ${pid}: ${n}`).join(', ') || '—'}</Text>
                </Space>
              </>
            )}
          </div>
        ) : null}
      </Card>

      <UsersModal open={usersSlot !== undefined} slot={usersSlot === undefined ? null : usersSlot} onClose={() => setUsersSlot(undefined)} t={t} />
    </div>
  );
};

function menuTitle(lang: string) {
  const l = lang.toLowerCase();
  if (l.startsWith('ru')) return 'Многоядерный режим';
  if (l.startsWith('zh')) return '多核模式';
  return 'Multi-core mode';
}

export class PluginMulticoreClient extends Plugin {
  async load() {
    this.app.pluginSettingsManager.add('multicore', {
      title: menuTitle(String((this.app as any)?.i18n?.language || 'en')),
      icon: 'ThunderboltOutlined',
      Component: MulticoreSettings,
      aclSnippet: 'pm.multicore',
    });
  }
}

export default PluginMulticoreClient;
