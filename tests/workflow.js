#!/usr/bin/env node
'use strict';
/**
 * Workflow safety probe: does a "record created" trigger + a "create record" node behave exactly like in
 * single-process mode when several workers are running?
 *
 *   BASE_URL=http://127.0.0.1:13100 NB_USER=admin NB_PASSWORD=... node tests/workflow.js [records=150] [concurrency=12] [sync=0|1]
 *
 * It creates two throw-away collections (wfsrc_<ts>, wflog_<ts>), one workflow with a collection trigger on the first
 * and one "create record" node that writes into the second, inserts N source rows through the public API
 * (the HTTP load balancer spreads them over the workers), waits for the workflow executions to finish and checks:
 *   - exactly N executions, all resolved (status 1)
 *   - exactly N log rows, one per source row, no duplicates, no losses
 * Everything it created is removed at the end (set KEEP=1 to keep it). Exit code 0 = OK.
 */
const BASE = (process.env.BASE_URL || 'http://127.0.0.1:13000').replace(/\/$/, '') + '/api';
const USER = process.env.NB_USER || 'admin';
const PASSWORD = process.env.NB_PASSWORD || 'admin123';
const N = Number(process.argv[2]) || 150;
const CONC = Number(process.argv[3]) || 12;
const SYNC = process.argv[4] === '1';
const ts = Date.now().toString(36);
const SRC = `wfsrc_${ts}`;
const LOG = `wflog_${ts}`;
let token = '';

async function api(method, path, body, query) {
  const url = BASE + path + (query ? '?' + new URLSearchParams(query) : '');
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Authenticator': 'basic' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return json;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) process.exitCode = 1; };

async function retry(fn, tries = 8) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; await sleep(1200); }
  }
  throw last;
}

(async () => {
  const signIn = await api('POST', '/auth:signIn', { account: USER, password: PASSWORD });
  token = signIn.data.token;
  console.log(`signed in; records=${N} concurrency=${CONC} sync=${SYNC}`);

  await api('POST', '/collections:create', { name: SRC, title: SRC, fields: [{ name: 'title', type: 'string', interface: 'input' }] });
  await api('POST', '/collections:create', {
    name: LOG, title: LOG,
    fields: [{ name: 'src_id', type: 'bigInt', interface: 'integer' }, { name: 'note', type: 'string', interface: 'input' }],
  });
  await sleep(3000); // metadata propagation between workers (~1 s)

  const wf = (await api('POST', '/workflows:create', {
    title: `wf-${ts}`, type: 'collection', sync: SYNC, enabled: false,
    config: { mode: 1, collection: `main:${SRC}` },
  })).data;
  await api('POST', `/workflows/${wf.id}/nodes:create`, {
    type: 'create', title: 'write log',
    config: { collection: `main:${LOG}`, params: { values: { src_id: '{{$context.data.id}}', note: 'from-workflow' } } },
  });
  await api('POST', '/workflows:update', { enabled: true }, { filterByTk: wf.id });
  await sleep(3000);

  // fire N inserts
  const created = [];
  let next = 0, errors = 0;
  const started = Date.now();
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (next < N) {
      const i = next++;
      try {
        const r = await retry(() => api('POST', `/${SRC}:create`, { title: `row-${i}` }));
        created.push(r.data.id);
      } catch (e) { errors++; console.log('insert error:', e.message); }
    }
  }));
  console.log(`inserted ${created.length}/${N} rows in ${((Date.now() - started) / 1000).toFixed(1)} s (errors: ${errors})`);

  // wait until executions are done (or timeout)
  let execs = [], logs = [];
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    execs = (await api('GET', '/executions:list', null, { filter: JSON.stringify({ workflowId: wf.id }), pageSize: 1000, fields: 'id,status' })).data;
    const running = execs.filter((e) => e.status === 0).length;
    logs = (await api('GET', `/${LOG}:list`, null, { pageSize: 1000 })).data;
    if (execs.length >= created.length && running === 0 && logs.length >= created.length) break;
    await sleep(1500);
  }
  await sleep(2500); // give any duplicate a chance to show up
  execs = (await api('GET', '/executions:list', null, { filter: JSON.stringify({ workflowId: wf.id }), pageSize: 1000, fields: 'id,status' })).data;
  logs = (await api('GET', `/${LOG}:list`, null, { pageSize: 1000 })).data;

  const bySrc = new Map();
  for (const l of logs) bySrc.set(String(l.src_id), (bySrc.get(String(l.src_id)) || 0) + 1);
  const dup = [...bySrc.values()].filter((c) => c > 1).length;
  const missing = created.filter((id) => !bySrc.has(String(id))).length;

  ok(errors === 0, `all ${N} inserts accepted`);
  ok(execs.length === created.length, `executions = ${execs.length} (expected ${created.length})`);
  ok(execs.every((e) => e.status === 1), `all executions resolved (${execs.filter((e) => e.status === 1).length}/${execs.length})`);
  ok(logs.length === created.length, `log rows = ${logs.length} (expected ${created.length})`);
  ok(dup === 0, `duplicate log rows: ${dup}`);
  ok(missing === 0, `missing log rows: ${missing}`);

  if (!process.env.KEEP) {
    try {
      await api('POST', '/workflows:update', { enabled: false }, { filterByTk: wf.id });
      await api('POST', '/workflows:destroy', null, { filterByTk: wf.id });
      await api('POST', '/collections:destroy', null, { filterByTk: SRC });
      await api('POST', '/collections:destroy', null, { filterByTk: LOG });
      console.log('cleaned up');
    } catch (e) { console.log('cleanup problem:', e.message); }
  }
  console.log(process.exitCode ? 'RESULT: FAIL' : 'RESULT: OK');
})().catch((e) => { console.error('ERROR', e.message); process.exit(2); });
