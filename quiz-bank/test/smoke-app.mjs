/**
 * 正式站 index.html 煙霧測試：模組載入失敗／pageerror 必須紅；
 * 登入畫面要能畫出來；並載入會拉進 import／views 的模組頁。
 * 不依賴真實 Firebase 登入（允許 auth／firestore 網路失敗）。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 8766;

const server = spawn(
  'python3',
  ['-m', 'http.server', String(port), '--bind', '127.0.0.1'],
  { cwd: root, stdio: 'ignore' },
);
await new Promise((r) => setTimeout(r, 500));

const results = [];
function pass(name) {
  results.push({ name, ok: true });
  console.log('PASS', name);
}
function fail(name, err) {
  results.push({ name, ok: false, err: String(err) });
  console.error('FAIL', name, err);
}

function attachErrorCollectors(page) {
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e?.message || e)));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const t = msg.text();
    // 允許 Firebase／網路未登入環境的雜訊；模組語法／export 一律算失敗
    if (/firebase|Firestore|Failed to load resource|net::ERR|CDN|fonts\.google/i.test(t)) return;
    consoleErrors.push(t);
  });
  return {
    pageErrors,
    consoleErrors,
    assertClean(label) {
      const bad = [...pageErrors, ...consoleErrors].filter((m) =>
        /Export |is not defined|SyntaxError|TypeError|Failed to fetch dynamically imported module|error loading module/i.test(
          m,
        ),
      );
      if (bad.length) {
        throw new Error(`${label}: ${bad.join(' | ')}`);
      }
      if (pageErrors.length) {
        throw new Error(`${label} pageerror: ${pageErrors.join(' | ')}`);
      }
    },
  };
}

const browser = await chromium.launch();
try {
  // --- 正式 index.html：模組圖必須起來，登入畫面要出現 ---
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const err = attachErrorCollectors(page);
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    err.assertClean('index.html module load');
    const loginOk = await page.evaluate(() => {
      const main = document.getElementById('app-main');
      const loginBtn = document.getElementById('btn-login');
      const loginPage = document.querySelector('.page.login');
      const iab = document.querySelector('.iab-warn');
      return !!(main && (loginBtn || loginPage || iab));
    });
    if (!loginOk) {
      const body = await page.locator('#app-main').innerText().catch(() => '');
      throw new Error(`login screen not rendered; main="${body.slice(0, 120)}"`);
    }
    pass('smoke index.html loads + login UI (no module errors)');
    await page.close();
  }

  // --- 直接 import 關鍵模組（涵蓋 import／views／result／quiz／stats）---
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const err = attachErrorCollectors(page);
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
    const mods = [
      '/js/import.js',
      '/js/import-draft.js',
      '/js/views.js',
      '/js/result.js',
      '/js/quiz.js',
      '/js/stats.js',
      '/js/errors.js',
      '/js/schema.js',
    ];
    for (const url of mods) {
      await page.evaluate(async (u) => {
        const m = await import(u);
        if (!m || typeof m !== 'object') throw new Error(`empty module ${u}`);
      }, url);
    }
    err.assertClean('dynamic import graph');
    pass('smoke dynamic import import/views/result/quiz/stats');
    await page.close();
  }

  // --- hash 路由頁：錯題本／單元表／匯入（未登入也不可炸模組）---
  {
    for (const hash of ['#/wrong', '#/fav', '#/import']) {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      const err = attachErrorCollectors(page);
      await page.goto(`http://127.0.0.1:${port}/index.html${hash}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(700);
      err.assertClean(`route ${hash}`);
      const hasShell = await page.evaluate(() => !!document.getElementById('app-main'));
      if (!hasShell) throw new Error(`no app-main on ${hash}`);
      // 未登入應落在登入或空主區，但不可空白整頁無腳本
      const alive = await page.evaluate(() => {
        const main = document.getElementById('app-main');
        return !!(main && (main.childElementCount > 0 || document.getElementById('btn-login')));
      });
      if (!alive) throw new Error(`blank main on ${hash}`);
      pass(`smoke route ${hash} no module error`);
      await page.close();
    }
  }
} catch (e) {
  fail('smoke suite', e);
} finally {
  await browser.close();
  server.kill();
}

const failed = results.filter((r) => !r.ok).length;
const passed = results.filter((r) => r.ok).length;
console.log(`\nsmoke-app ${passed}/${results.length || 1} passed`);
if (failed || !results.length) process.exit(1);
process.exit(0);
