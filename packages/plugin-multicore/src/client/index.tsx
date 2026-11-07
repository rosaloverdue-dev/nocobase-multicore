import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, InputNumber, Space, Switch, Table, Tag, Typography, message } from 'antd';
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
    enabledState: 'enabled',
    disabledState: 'disabled',
    missingState: 'not installed',
  },
};

function useT() {
  const app = useApp();
  const lang = String((app as any)?.i18n?.language || 'en').toLowerCase();
  const dict = lang.startsWith('ru') ? DICT.ru : DICT.en;
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
      await api.request({ url: 'multicore:apply', method: 'post', data: { enabled, workers } });
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
          <Button type="primary" loading={applying} disabled={!dirty} onClick={apply}>
            {applying ? t('applying') : t('apply')}
          </Button>
        </Space>
        <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
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

export class PluginMulticoreClient extends Plugin {
  async load() {
    this.app.pluginSettingsManager.add('multicore', {
      title: 'Multi-core mode',
      icon: 'ThunderboltOutlined',
      Component: MulticoreSettings,
      aclSnippet: 'pm.multicore',
    });
  }
}

export default PluginMulticoreClient;
