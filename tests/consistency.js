#!/usr/bin/env node
'use strict';
/**
 * Cross-worker consistency probe. Usage:
 *   BASE=http://127.0.0.1:13100 USER_NAME=admin PASSWORD=... node tests/consistency.js
 * It mutates metadata (collection/fields) through one request and immediately reads it back through many requests
 * (the kernel round-robins connections, so they land on different workers; /api/multicore:whoami tells which).
 * Exits non-zero when any worker answered with a stale view.
 */
const BASE = process.env.BASE || 'http://127.0.0.1:13100';
const READS = Number(process.env.READS || 24);
const ROUNDS = Number(process.env.ROUNDS || 5);
const NAME = `mc_probe_${Date.now().toString(36)}`;
let token;

async function api(method, url, body) {
  const res = await fetch(`${BASE}/api/${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), Connection: 'close' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* empty */ }
  return { status: res.status, json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const note = (msg) => { problems.push(msg); console.log('  DESYNC:', msg); };

/** Polls until READS consecutive reads all return `expectStatus`; returns how long the cluster needed to converge. */
async function converge(url, expectStatus, label, limitMs = 15000) {
  const started = Date.now();
  for (;;) {
    const rs = await Promise.all(Array.from({ length: READS }, () => api('GET', url)));
    if (rs.every((r) => r.status === expectStatus)) break;
    if (Date.now() - started > limitMs) { note(`${label}: not converged after ${limitMs} ms`); return limitMs; }
    await sleep(150);
  }
  const ms = Date.now() - started;
  console.log(`${label}: converged on all workers after ${ms} ms`);
  return ms;
}

async function readAll(url, expectStatus, label, informational = false) {
  const results = await Promise.all(Array.from({ length: READS }, async () => {
    const who = await api('GET', 'multicore:whoami');
    const r = await api('GET', url);
    return { pid: who.json?.data?.pid, status: r.status };
  }));
  const bad = results.filter((r) => r.status !== expectStatus);
  const pids = new Set(results.map((r) => r.pid));
  console.log(`${label}: ${results.length - bad.length}/${results.length} ok, workers seen: ${[...pids].join(',')}`);
  if (bad.length && !informational) note(`${label}: ${bad.length} stale answers from pids ${[...new Set(bad.map((b) => b.pid))].join(',')} (status ${[...new Set(bad.map((b) => b.status))].join(',')})`);
  return pids.size;
}

(async () => {
  const login = await api('POST', 'auth:signIn', { account: process.env.USER_NAME || 'admin', password: process.env.PASSWORD });
  token = login.json?.data?.token;
  if (!token) throw new Error('sign-in failed: ' + JSON.stringify(login.json));

  const create = await api('POST', 'collections:create', { name: NAME, title: NAME, fields: [{ name: 'title', type: 'string', interface: 'input' }] });
  console.log('create collection', create.status);
  await readAll(`${NAME}:list`, 200, 'immediately after create (informational, NocoBase syncs metadata with a ~1 s debounce)', true);
  await converge(`${NAME}:list`, 200, 'collection create');

  for (let i = 1; i <= ROUNDS; i += 1) {
    const field = `f${i}`;
    const add = await api('POST', `collections/${NAME}/fields:create`, { name: field, type: 'string', interface: 'input' });
    if (add.status >= 300) note(`add field ${field} -> ${add.status}`);
    await sleep(Number(process.env.SETTLE_MS || 2500)); // let the sync message reach every worker (debounce 1 s)
    // writes go to random workers; each must accept the NEW field
    const writes = await Promise.all(Array.from({ length: READS }, (_, n) => api('POST', `${NAME}:create`, { title: `r${i}-${n}`, [field]: `v${n}` })));
    const failed = writes.filter((w) => w.status >= 300).length;
    console.log(`round ${i}: writes with new field ${field}: ${writes.length - failed}/${writes.length} ok`);
    if (failed) note(`round ${i}: ${failed} writes failed`);
    const list = await api('GET', `${NAME}:list?pageSize=200&paginate=false`);
    const withField = (list.json?.data || []).filter((r) => r[field] != null).length;
    if (withField !== READS - failed) note(`round ${i}: rows with ${field} = ${withField}, expected ${READS - failed}`);
  }

  const total = await api('GET', `${NAME}:list?paginate=false`);
  console.log('total rows', (total.json?.data || []).length, 'expected', READS * ROUNDS);
  if ((total.json?.data || []).length !== READS * ROUNDS) note('row count mismatch');

  await api('POST', `collections:destroy?filterByTk=${NAME}`);
  await converge(`${NAME}:list`, 404, 'collection destroy');

  console.log(problems.length ? `\nFAILED: ${problems.length} problem(s)` : '\nOK: no cross-worker desync');
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
