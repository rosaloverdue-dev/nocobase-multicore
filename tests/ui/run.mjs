#!/usr/bin/env node
/**
 * Smoke test of the settings page in a headless browser, without NocoBase:
 *   node tests/ui/run.mjs [outDir]
 * Bundles the REAL page (packages/plugin-multicore/src/client) with stand-ins for antd and @nocobase/client and a mock
 * API, opens it in Chromium (Playwright), clicks through the new functions and checks the API calls the page makes.
 * Needs esbuild, react + react-dom (UI_NODE_PATH=/dir/with/node_modules) and playwright; exits 0 with "skipped" otherwise.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const nodePaths = [process.env.UI_NODE_PATH, '/opt/npm-tools/node_modules'].filter(Boolean);
const tryRequire = (...names) => {
  for (const name of names) {
    try {
      return require(name);
    } catch (e) {
      // next
    }
  }
  return null;
};
const esbuild = tryRequire(process.env.ESBUILD_MODULE || 'esbuild', '/opt/npm-tools/node_modules/esbuild/lib/main.js');
const playwright = tryRequire('playwright');
if (!esbuild || !playwright || !nodePaths.some((p) => fs.existsSync(path.join(p, 'react-dom')))) {
  console.log('skipped: esbuild, playwright or react/react-dom not available');
  process.exit(0);
}

const out = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'mcore-ui-')));
fs.mkdirSync(out, { recursive: true });
await esbuild.build({
  entryPoints: [path.join(here, 'harness.tsx')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  outfile: path.join(out, 'app.js'),
  nodePaths,
  alias: { antd: path.join(here, 'antd-lite.tsx'), '@nocobase/client': path.join(here, 'nocobase-client-stub.tsx') },
  define: { 'process.env.NODE_ENV': '"production"' },
  jsx: 'transform',
  logLevel: 'warning',
});
for (const f of ['mock.js', 'page.css']) fs.copyFileSync(path.join(here, f), path.join(out, f));
fs.writeFileSync(
  path.join(out, 'index.html'),
  `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="page.css"><div id="root"></div>
<script>window.__app = { i18n: { language: new URLSearchParams(location.search).get('lang') || 'en' } };</script>
<script src="mock.js"></script><script src="app.js"></script>`,
);

const failures = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`);
  if (!ok) failures.push(name);
};
const browser = await playwright.chromium.launch();
try {
  for (const lang of ['ru', 'en', 'zh']) {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto(`file://${path.join(out, 'index.html')}?lang=${lang}`);
    await page.waitForSelector('table tbody tr');
    await page.waitForTimeout(300);
    const text = await page.locator('#root').innerText();
    check(`[${lang}] page renders without errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
    check(`[${lang}] no untranslated keys on the page`, !/\b(ev|r)\.[a-z-]+\b|\{[a-z]+\}/.test(text), (text.match(/\b(ev|r)\.[a-z-]+\b|\{[a-z]+\}/) || [''])[0]);
    await page.screenshot({ path: path.join(out, `page-${lang}.png`), fullPage: true });
    if (lang !== 'ru') {
      await page.close();
      continue;
    }

    const workerRows = page.locator('section:has(header:has-text("Воркеры")) tbody tr');
    check('4 worker rows', (await workerRows.count()) === 4);
    check('a stalled worker is shown as not responding', /не отвечает 7 с/.test(await workerRows.nth(2).innerText()));
    check('"you are here" marks the worker that answered', /вы здесь/.test(await workerRows.nth(1).innerText()));
    check('online users tile', /Пользователей онлайн\s*244/.test(text.replace(/\n/g, ' ')));
    check('journal: crash reason is readable', /Воркер завершился/.test(text) && /нехватка памяти/.test(text));
    check('journal: stall and bad gateway lines', /Воркер не отвечал/.test(text) && /ECONNRESET: 3/.test(text));
    check('no memory warning while the heap limit is left on auto', !/Сумма лимитов/.test(text));
    check('database connection budget warning (5 x 20 = 100 of 100)', /4 воркеров \+ 1 на время перезапуска × пул 20 = 100, а база принимает 100/.test(text) && /до 19/.test(text));

    // requests per second appear after the second poll
    await page.waitForTimeout(4500);
    const rps = await page.locator('.stat:has-text("Запросов в секунду") .stat-value').innerText();
    check('requests per second are computed from two polls', /^\d+\.\d/.test(rps.trim()), rps.trim());

    // who is connected to worker 1
    await workerRows.nth(1).locator('a').click();
    await page.waitForSelector('[role=dialog] tbody tr');
    const dialog = page.locator('[role=dialog]');
    check('users window opens for the worker', /Пользователи на воркере 1/.test(await dialog.innerText()));
    let calls = await page.evaluate(() => window.__calls);
    check('it asks the server for that slot', calls.some((c) => c.url === 'multicore:connections' && c.params && c.params.slot === '1'));
    await dialog.locator('input').fill('user10');
    await page.waitForTimeout(100);
    check('search filters the list', (await dialog.locator('tbody tr').count()) === 1 && /user10/.test(await dialog.locator('tbody').innerText()));
    await page.screenshot({ path: path.join(out, 'users-ru.png') });
    await dialog.locator('[aria-label=close]').click();
    await page.locator('.stat:has-text("Пользователей онлайн") a').click();
    await page.waitForSelector('[role=dialog] tbody tr');
    check('"all workers" window opens from the tile', /Пользователи онлайн/.test(await page.locator('[role=dialog] header').innerText()));
    await page.locator('[role=dialog] [aria-label=close]').click();

    // restart one worker
    await workerRows.nth(0).locator('button', { hasText: 'Перезапустить' }).click();
    check('restart asks for confirmation', /Перезапустить воркер 0\?/.test(await page.locator('.pop').innerText()));
    await page.locator('.pop .btn-primary').click();
    await page.waitForTimeout(200);
    calls = await page.evaluate(() => window.__calls);
    check('restart is sent for the right slot', calls.some((c) => c.url === 'multicore:restart' && c.method === 'post' && c.data.slot === 0));
    check('success message', (await page.evaluate(() => window.__toasts || [])).some((x) => /success: Перезапуск запущен/.test(x)));
    // server refuses -> the error is shown
    await workerRows.nth(2).locator('button', { hasText: 'Перезапустить' }).click();
    await page.locator('.pop .btn-primary').click();
    await page.waitForTimeout(200);
    check('a refused restart shows the server message', (await page.evaluate(() => window.__toasts)).some((x) => /error: .*There is no worker in slot 2/.test(x)));
    // restart all
    await page.locator('button', { hasText: 'Перезапустить все по очереди' }).click();
    await page.locator('.pop .btn-primary').click();
    await page.waitForTimeout(200);
    calls = await page.evaluate(() => window.__calls);
    check('restart all', calls.some((c) => c.url === 'multicore:restart' && c.data.slot === 'all'));

    // heap limit
    const heap = page.locator('input[type=number]').nth(1);
    await heap.fill('2048');
    await page.locator('button', { hasText: 'Применить' }).click();
    await page.waitForTimeout(200);
    calls = await page.evaluate(() => window.__calls);
    const applied = calls.find((c) => c.url === 'multicore:apply');
    check('apply sends the heap limit', applied && applied.data.heapMb === 2048 && applied.data.workers === 4 && applied.data.enabled === true, JSON.stringify(applied && applied.data));
    await heap.fill('4096');
    await page.waitForTimeout(100);
    check('warning when the limits exceed the server memory', /16384 МБ/.test(await page.locator('#root').innerText()));

    // self-test
    await page.locator('button', { hasText: 'Запустить проверку' }).click();
    await page.waitForTimeout(200);
    check('self-test result', /Всё в порядке/.test(await page.locator('#root').innerText()));
    check('no errors after clicking through', errors.length === 0, errors.slice(0, 2).join(' | '));
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(`\nscreenshots: ${out}`);
if (failures.length) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
