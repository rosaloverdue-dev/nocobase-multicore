#!/usr/bin/env node
'use strict';
/**
 * Throughput probe. Two modes:
 *   sign-in (default):  PASSWORD=... node tests/bench.js          (NB: password hashing runs in the libuv threadpool,
 *                        so it already uses several cores in ONE process - not a good test of multi-core gains)
 *   JSON-heavy list:    TOKEN=<jwt> GET_URL='bench_rows:list?pageSize=2000' node tests/bench.js
 *                        (Sequelize hydration + JSON serialisation = main-thread CPU, which is what multi-core helps)
 * Env: BASE (default http://127.0.0.1:13100), CONC (8), SECONDS (15), USER_NAME (admin).
 */
const BASE = process.env.BASE || 'http://127.0.0.1:13100';
const CONC = Number(process.env.CONC || 8);
const SECONDS = Number(process.env.SECONDS || 15);
const signInBody = JSON.stringify({ account: process.env.USER_NAME || 'admin', password: process.env.PASSWORD });
let ok = 0;
let fail = 0;
const lat = [];
const end = Date.now() + SECONDS * 1000;

function request() {
  if (process.env.GET_URL) {
    return fetch(`${BASE}/api/${process.env.GET_URL}`, { headers: { Authorization: `Bearer ${process.env.TOKEN}`, Connection: 'close' } });
  }
  return fetch(`${BASE}/api/auth:signIn`, { method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' }, body: signInBody });
}

async function client() {
  while (Date.now() < end) {
    const t = Date.now();
    try {
      const res = await request();
      await res.arrayBuffer();
      if (res.status === 200) {
        ok += 1;
        lat.push(Date.now() - t);
      } else fail += 1;
    } catch (e) {
      fail += 1;
    }
  }
}

(async () => {
  await Promise.all(Array.from({ length: CONC }, client));
  lat.sort((a, b) => a - b);
  const p = (q) => lat[Math.min(lat.length - 1, Math.floor(lat.length * q))] ?? 0;
  console.log(JSON.stringify({ conc: CONC, seconds: SECONDS, ok, fail, rps: Math.round((ok / SECONDS) * 10) / 10, p50: p(0.5), p95: p(0.95), p99: p(0.99) }));
})();
