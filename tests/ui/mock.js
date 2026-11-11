/* Mock of the plugin's HTTP API for tests/ui/run.mjs: a 4-worker cluster with some history. Loaded before the page. */
(function () {
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  let requests = 1345000;
  const served = [331200, 338900, 329800, 336400];
  const workers = [0, 1, 2, 3].map((slot) => ({
    pid: 222 + slot * 16, slot: String(slot), replacement: false, state: 'listening', mode: 'cluster', uptimeSec: 198700 - slot * 14,
    cpuPercent: [11.4, 9.8, 43.2, 12.1][slot], rssMb: [712, 698, 934, 705][slot], heapMb: [402, 388, 611, 395][slot], heapLimitMb: 2096,
    loopLagMs: [21.3, 22.2, 180.4, 20.9][slot], inflight: [1, 0, 3, 1][slot], served: served[slot], failed: 0, avgMs: [38.2, 35.9, 212.7, 37.4][slot],
    websockets: [78, 81, 76, 80][slot], wsClients: [78, 81, 76, 80][slot], wsUsers: [61, 66, 60, 63][slot], wsAnonymous: 2,
    restarts: slot === 3 ? 1 : 0, stalls: slot === 2 ? 2 : 0, silentMs: slot === 2 ? 7400 : 300, stalled: slot === 2,
    lastStall: slot === 2 ? { at: iso(3600_000), ms: 41200 } : null,
    lastExit: slot === 3 ? { at: iso(7200_000), code: null, signal: 'SIGABRT', reason: 'oom' } : null,
    instanceId: [2, 6, 3, 28][slot], hostname: 'a1b2c3d4e5f6', noHeartbeat: false, heapLimitCfgMb: 0,
  }));
  const events = [
    { at: iso(198800_000), type: 'boot', pid: 1, cpus: 4 },
    { at: iso(198700_000), type: 'worker-ready', slot: 0, pid: 222, bootMs: 14100 },
    { at: iso(198600_000), type: 'reconcile', reason: 'boot', mode: 'cluster', workers: 4 },
    { at: iso(90000_000), type: 'apply', by: 'admin' },
    { at: iso(7200_000), type: 'worker-exit', slot: 3, pid: 254, code: null, signal: 'SIGABRT', reason: 'oom', respawnInMs: 1000 },
    { at: iso(7180_000), type: 'worker-ready', slot: 3, pid: 270, bootMs: 15800 },
    { at: iso(3600_000), type: 'stall', slot: 2, pid: 254, ms: 41200 },
    { at: iso(3590_000), type: 'bad-gateway', count: 3, codes: { ECONNRESET: 3 }, slots: { 2: 3 } },
    { at: iso(600_000), type: 'restart-requested', slot: 1, by: 'admin' },
    { at: iso(580_000), type: 'restarted', slot: 1, ms: 19400 },
  ];
  const names = ['Иванов Иван', 'Петрова Анна', 'Сидоров Пётр', 'Кузнецова Мария', 'Смирнов Олег', 'Попова Елена', 'Васильев Дмитрий', 'Новикова Ольга'];
  const users = [];
  for (let i = 0; i < 61; i += 1) {
    users.push({ id: 100 + i, nickname: `${names[i % names.length]} ${i + 1}`, username: `user${i + 1}`, tabs: 1 + (i % 3 === 0 ? 1 : 0), since: iso((i + 1) * 97_000), ip: `10.20.${i % 7}.${10 + i}`, workers: [{ slot: String(i % 4), tabs: 1 }] });
  }
  window.__calls = [];
  window.__api = {
    async request({ url, method, params, data }) {
      window.__calls.push({ url, method, params: params || null, data: data || null });
      const ok = (body) => ({ data: { data: body } });
      if (url === 'multicore:status') {
        requests += 26;
        served.forEach((_, i) => { served[i] += [7, 8, 3, 8][i]; workers[i].served = served[i]; });
        return ok({
          self: { pid: 238, slot: '1' }, cpus: 4, maxWorkers: 8, supervised: true, clusterModeActive: true,
          config: { enabled: true, workers: 4, affinity: 'off', heapMb: 0 },
          redis: { configured: true, ok: true, latencyMs: 0.31, version: '7.4.1' },
          database: { dialect: 'postgres', poolMax: 20, maxConnections: 100 },
          adapters: { pubsub: { plugin: 'enabled', active: true }, lock: { plugin: 'enabled', active: true }, queue: { plugin: 'enabled', active: true }, workerId: { plugin: 'enabled', active: true }, cache: { active: true } },
          supervisor: {
            host: { totalMemMb: 7941, freeMemMb: 2610, load: [1.42, 1.18, 0.97] },
            balancer: { mode: 'least-busy', affinity: 'off', requests, errors: 3, noUpstream: 0, retries: 41, aborted: 912, upgrades: 5210, sticky: 0, upstreams: workers.map((w) => ({ slot: Number(w.slot), served: w.served })) },
            workers: workers.map((w) => ({ slot: Number(w.slot), pid: w.pid })), events,
          },
          workers, online: { connections: 315 }, serverTime: new Date().toISOString(),
        });
      }
      if (url === 'multicore:connections') {
        if (params && params.summary) return ok({ totals: { users: 244, connections: 315, anonymous: 8 } });
        const slot = params && params.slot != null ? String(params.slot) : null;
        const list = slot === null ? users : users.filter((u) => u.workers[0].slot === slot);
        return ok({ slot, totals: { users: list.length, connections: list.reduce((s, u) => s + u.tabs, 0), anonymous: 2 }, workers: [], users: list });
      }
      if (url === 'multicore:restart') {
        if (data.slot === 2) { const e = new Error('x'); e.response = { data: { errors: [{ message: 'There is no worker in slot 2' }] } }; throw e; }
        return ok({ accepted: true, slot: data.slot });
      }
      if (url === 'multicore:apply') return ok({ config: data, applied: true });
      if (url === 'multicore:selftest') {
        return ok({ ok: true, workers: 4, checks: { pubsub: { expected: 4, received: 4, ok: true }, lock: { expectedBlocked: 3, blocked: 3, leaked: 0, ok: true }, queue: { published: 20, processed: 20, duplicates: 0, byWorker: { 222: 5, 238: 6, 254: 4, 270: 5 }, ok: true }, workerIds: { ok: true } } });
      }
      throw new Error(`unexpected call ${url}`);
    },
  };
})();
