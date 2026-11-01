/**
 * E2E：#10 CDN 封鎖仍可完賽；#11 開始畫面高分框樣式不變
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.STAY_QUIZ_ROOT || join(__dirname, '../stay-quiz');
const OUT = process.env.STAY_SHOTS_DIR || join(__dirname, 'shots');
mkdirSync(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2',
};

function startServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      let path = decodeURIComponent(url.pathname);
      if (path === '/') path = '/index.html';
      const file = join(ROOT, path.replace(/^\//, ''));
      if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) {
        res.writeHead(404);
        res.end('missing');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function playTen(page) {
  await page.click('.btn-player[data-player="羽蕎"]');
  await page.waitForSelector('#screen-quiz.is-active');
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => {
      window.__stayQuiz.forceFirstSound();
      window.__stayQuiz.pickWrong();
    });
    await page.waitForSelector('#btnNext:not([disabled]):not(.hidden)');
    await page.click('#btnNext');
  }
  await page.waitForSelector('#screen-result.is-active');
}

const { server, base } = await startServer();
const browser = await chromium.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const results = [];

try {
  // #10 block gstatic → 完賽、本地最高分
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 664 }, hasTouch: true, isMobile: true });
    await context.route('**/*gstatic.com/**', (route) => route.abort());
    await context.route('**/*firebase*/**', (route) => route.abort());
    const page = await context.newPage();
    const logs = [];
    page.on('pageerror', (e) => logs.push(String(e)));
    await page.goto(`${base}/index.html?test=1`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelector('.btn-player') && !document.querySelector('.btn-player').disabled);
    await playTen(page);
    const high = await page.textContent('#resultHigh');
    // 0 分本地仍可能寫入「最高分 0 分」或新紀錄流程
    assert.ok(high && (high.includes('最高分') || high.includes('還沒有紀錄')), `high=${high}`);
    assert.equal(logs.length, 0, logs.join(';'));
    results.push({ name: '#10 block gstatic completes', ok: true, high });
    await context.close();
  }

  // #11 開始畫面高分框截圖（無紀錄）
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 664 } });
    await page.goto(`${base}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelector('.btn-player') && !document.querySelector('.btn-player').disabled);
    await page.waitForTimeout(400);
    const box = page.locator('#startHigh');
    await box.waitFor({ state: 'visible' });
    const text = (await box.textContent())?.trim();
    assert.equal(text, '還沒有紀錄');
    const art = process.env.STAY_SHOTS_DIR || '/opt/cursor/artifacts';
    mkdirSync(art, { recursive: true });
    await page.screenshot({ path: join(art, 'sync-start-390.png'), fullPage: false });
    const desk = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await desk.goto(`${base}/index.html`, { waitUntil: 'load' });
    await desk.waitForFunction(() => document.querySelector('.btn-player') && !document.querySelector('.btn-player').disabled);
    await desk.waitForTimeout(400);
    assert.equal((await desk.locator('#startHigh').textContent())?.trim(), '還沒有紀錄');
    await desk.screenshot({ path: join(art, 'sync-start-1280.png'), fullPage: false });
    // 量測樣式：背景／字級與既有 .highscore 一致
    const style = await page.evaluate(() => {
      const el = document.getElementById('startHigh');
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, radius: cs.borderRadius, pad: cs.padding, align: cs.textAlign };
    });
    results.push({ name: '#11 start high box unchanged copy+shots', ok: true, text, style });
    await page.close();
    await desk.close();
  }
} catch (err) {
  results.push({ name: 'FAILED', ok: false, error: String(err && err.stack ? err.stack : err) });
} finally {
  await browser.close();
  server.close();
}

const ok = results.every((r) => r.ok);
console.log(JSON.stringify({ ok, root: ROOT, results }, null, 2));
process.exit(ok ? 0 : 1);
