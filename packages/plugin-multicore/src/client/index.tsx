import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, InputNumber, Select, Space, Switch, Table, Tag, Typography, message } from 'antd';
import { Plugin, useAPIClient, useApp } from '@nocobase/client';

const { Text, Paragraph } = Typography;

const DICT: Record<string, Record<string, string>> = {
  ru: {
    title: 'Многоядерный режим',
    subtitle: 'Запуск NocoBase на нескольких ядрах процессора: несколько процессов-воркеров делят один порт и общий Redis.',
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
    running: 'Проверяем…',
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
  },
  en: {
    title: 'Multi-core mode',
    subtitle: 'Run NocoBase on several CPU cores: worker processes share one port and a shared Redis.',
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
    running: 'Testing…',
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
  },
  zh: {
    title: '多核模式',
    subtitle: '让 NocoBase 运行在多个 CPU 核心上：多个工作进程共用一个端口和共享的 Redis。',
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
    running: '检查中…',
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
  },
};

function useT() {
  const app = useApp();
  const lang = String((app as any)?.i18n?.language || 'en').toLowerCase();
  const dict = lang.startsWith('ru') ? DICT.ru : lang.startsWith('zh') ? DICT.zh : DICT.en;
  return (key: string) => dict[key] || key;
}

function fmtUptime(sec: number) {
  if (sec == null) return '—';
  if (sec < 90) return `${sec}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

const MulticoreSettings: React.FC = () => {
  const api = useAPIClient();
  const t = useT();
  const [status, setStatus] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [workers, setWorkers] = useState(2);
  const [affinity, setAffinity] = useState('off');
  const [dirty, setDirty] = useState(false);
  const [applying, setApplying] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

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
      }
    } catch (e: any) {
      setError(e?.response?.data?.errors?.[0]?.message || e?.message || String(e));
    }
  }, [api]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [load]);

  const apply = async () => {
    setApplying(true);
    try {
      await api.request({ url: 'multicore:apply', method: 'post', data: { enabled, workers, affinity } });
      message.success(t('saved'));
      setDirty(false);
      await load();
    } catch (e: any) {
      message.error(`${t('error')}: ${e?.response?.data?.errors?.[0]?.message || e?.message}`);
    } finally {
      setApplying(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.request({ url: 'multicore:selftest', method: 'post' });
      setTestResult(res?.data?.data);
    } catch (e: any) {
      setTestResult({ ok: false, reason: e?.response?.data?.errors?.[0]?.message || e?.message });
    } finally {
      setTesting(false);
    }
  };

  const missingAdapters = status
    ? Object.entries(status.adapters || {})
        .filter(([key, v]: any) => key !== 'cache' && v.plugin && v.plugin !== 'enabled')
        .map(([key]) => t(key))
    : [];
  const supervisedWorkers = status?.supervisor?.workers?.length;
  const columns: any[] = [
    { title: t('slot'), dataIndex: 'slot', width: 70 },
    { title: t('pid'), dataIndex: 'pid', width: 90 },
    { title: t('state'), width: 140, render: (_: any, r: any) => (
      <Space size={4}>
        <Tag color="green">{r.mode === 'cluster' ? 'cluster' : 'single'}</Tag>
        {status?.self?.pid === r.pid ? <Tag color="blue">{t('you')}</Tag> : null}
      </Space>
    ) },
    { title: t('uptime'), dataIndex: 'uptimeSec', width: 90, render: fmtUptime },
    { title: t('cpu'), dataIndex: 'cpuPercent', width: 90 },
    { title: t('rss'), dataIndex: 'rssMb', width: 110 },
    { title: t('lag'), dataIndex: 'loopLagMs', width: 120 },
    { title: t('inflight'), dataIndex: 'inflight', width: 120 },
    { title: t('served'), dataIndex: 'served', width: 130 },
    { title: t('instance'), dataIndex: 'instanceId', width: 110 },
    { title: t('host'), dataIndex: 'hostname' },
  ];

  const adapterRows = status
    ? (['pubsub', 'lock', 'queue', 'workerId', 'cache'] as const).map((key) => ({ key, ...(status.adapters?.[key] || {}) }))
    : [];

  return (
    <div style={{ maxWidth: 1100 }}>
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
          <Button type="primary" loading={applying} disabled={!dirty} onClick={apply}>
            {applying ? t('applying') : t('apply')}
          </Button>
        </Space>
        <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 4 }}>{t('affinityHint')}</Paragraph>
        <Paragraph type="secondary" style={{ marginTop: 0, marginBottom: 0 }}>
          {t('current')}: <b>{status?.workers?.length ?? '…'}</b> {t('processes')},{' '}
          {status?.clusterModeActive ? t('cluster') : t('single')}
          {supervisedWorkers != null ? ` · supervisor: ${supervisedWorkers}` : ''}. {t('restartNote')}
        </Paragraph>
      </Card>

      <Card title={t('workersTable')} style={{ marginTop: 16 }}>
        <Table size="small" rowKey={(r: any) => `${r.pid}`} columns={columns} dataSource={status?.workers || []} pagination={false} scroll={{ x: true }} />
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
        <Button loading={testing} disabled={!status?.clusterModeActive} onClick={runTest}>{testing ? t('running') : t('run')}</Button>
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
