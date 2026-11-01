/**
 * E2E：「再玩一次」回歸（問題 A／B）
 * - 結果／開始畫面須捲回頂端
 * - 再玩一次後 150ms／400ms 同點再點不可開新局
 * 用法：cd stay-quiz-test && node e2e-replay.mjs
 * 可選：STAY_QUIZ_ROOT=/path/to/stay-quiz  RUN_WEBKIT=1
 */
import { chromium, webkit } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.STAY_QUIZ_ROOT || join(__dirname, '../stay-quiz');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
  '.svg': 'image/svg+xml',
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

async function bootStart(page, base) {
  await page.goto(`${base}/index.html?test=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const b = document.querySelector('.btn-player');
    return b && !b.disabled;
  });
}

async function playTenAndSeeResult(page) {
  await page.click('.btn-player[data-player="羽蕎"]');
  await page.waitForSelector('#screen-quiz.is-active');
  await page.waitForTimeout(200);
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => {
      window.__stayQuiz.forceFirstSound();
      window.__stayQuiz.pickWrong();
    });
    await page.waitForSelector('#btnNext:not([disabled]):not(.hidden)');
    await page.click('#btnNext');
  }
  await page.waitForSelector('#screen-result.is-active');
  // 等淡入與版面穩定
  await page.waitForTimeout(250);
}

async function assertResultTop(page, label) {
  const info = await page.evaluate(() => {
    const score = document.getElementById('resultScore');
    const r = score.getBoundingClientRect();
    return {
      scrollY: window.scrollY,
      scoreTop: r.top,
      scoreBottom: r.bottom,
      vh: window.innerHeight,
      active: document.activeElement?.id || document.activeElement?.tagName,
    };
  });
  assert.equal(info.scrollY, 0, `${label}: result scrollY should be 0, got ${info.scrollY}`);
  assert.ok(info.scoreTop >= 0 && info.scoreTop < info.vh, `${label}: #resultScore should be in view, top=${info.scoreTop}`);
  return info;
}

async function againThenAssertStart(page, label) {
  const again = page.locator('#btnAgain');
  await again.scrollIntoViewIfNeeded();
  await page.waitForTimeout(100);
  const box = await again.boundingBox();
  assert.ok(box, `${label}: #btnAgain box`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  await page.locator('#btnAgain').tap({ force: true }).catch(async () => {
    await page.mouse.click(x, y);
  });
  await page.waitForSelector('#screen-start.is-active');
  await page.waitForTimeout(220);

  const startInfo = await page.evaluate(() => {
    const brand = document.querySelector('#startHeading, h1.brand');
    const r = brand.getBoundingClientRect();
    return {
      scrollY: window.scrollY,
      brandTop: r.top,
      focusId: document.activeElement?.id || '',
      focusTag: document.activeElement?.tagName,
      focusText: (document.activeElement?.textContent || '').slice(0, 40),
      quizActive: document.getElementById('screen-quiz').classList.contains('is-active'),
      quizHidden: document.getElementById('screen-quiz').hidden,
    };
  });
  assert.equal(startInfo.scrollY, 0, `${label}: start scrollY should be 0, got ${startInfo.scrollY}`);
  assert.ok(startInfo.brandTop >= 0, `${label}: brand top should be >= 0, got ${startInfo.brandTop}`);
  assert.ok(
    startInfo.focusId === 'startHeading' || /STAY/.test(startInfo.focusText),
    `${label}: focus should be start heading, got ${startInfo.focusId || startInfo.focusTag}:${startInfo.focusText}`,
  );
  return { x, y, startInfo };
}

async function assertGhostTapsIgnored(page, x, y, label) {
  for (const ms of [150, 400]) {
    await page.waitForTimeout(ms === 150 ? 150 : 250); // 150 then +250 ≈ 400 from again
    // 同點再點（手指還在「再玩一次」原位置，底下已是 Stay）
    try {
      await page.touchscreen.tap(x, y);
    } catch {
      await page.mouse.click(x, y);
    }
    await page.waitForTimeout(80);
    const st = await page.evaluate(() => ({
      quizActive: document.getElementById('screen-quiz').classList.contains('is-active'),
      quizHidden: document.getElementById('screen-quiz').hidden,
      startActive: document.getElementById('screen-start').classList.contains('is-active'),
      player: window.__stayQuiz?.state?.player ?? null,
    }));
    assert.equal(st.quizActive, false, `${label}: @${ms}ms must NOT start quiz`);
    assert.equal(st.quizHidden, true, `${label}: @${ms}ms quiz still hidden`);
    assert.equal(st.startActive, true, `${label}: @${ms}ms stay on start`);
  }
}

async function assertPlayerWorksAfterArm(page, label) {
  // 再玩一次後合計約 600ms+ 應可開始
  await page.waitForTimeout(250);
  await page.click('.btn-player[data-player="Stay"]');
  await page.waitForSelector('#screen-quiz.is-active', { timeout: 2000 });
  const player = await page.evaluate(() => window.__stayQuiz.state.player);
  assert.equal(player, 'Stay', `${label}: Stay should start after arm window`);
}

async function runRoundFlow(page, label) {
  await playTenAndSeeResult(page);
  await assertResultTop(page, `${label}/result`);
  const { x, y } = await againThenAssertStart(page, `${label}/again`);
  // 從「再玩一次」當下起算 150／400：重置計時較精準
  // againThenAssertStart 已花 ~220ms 等待；改為重新一輪專測 ghost
  return { x, y };
}

async function runGhostIsolated(page, base, label) {
  await bootStart(page, base);
  await playTenAndSeeResult(page);
  const again = page.locator('#btnAgain');
  await again.scrollIntoViewIfNeeded();
  const box = await again.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const t0 = Date.now();
  await again.tap({ force: true }).catch(async () => page.mouse.click(x, y));
  await page.waitForSelector('#screen-start.is-active');

  const waitUntil = async (targetMs) => {
    const left = targetMs - (Date.now() - t0);
    if (left > 0) await page.waitForTimeout(left);
  };
  await waitUntil(150);
  try {
    await page.touchscreen.tap(x, y);
  } catch {
    await page.mouse.click(x, y);
  }
  let st = await page.evaluate(() => ({
    quizActive: document.getElementById('screen-quiz').classList.contains('is-active'),
    startActive: document.getElementById('screen-start').classList.contains('is-active'),
  }));
  assert.equal(st.quizActive, false, `${label}: 150ms ghost must not start`);
  assert.equal(st.startActive, true, `${label}: 150ms still start`);

  await waitUntil(400);
  try {
    await page.touchscreen.tap(x, y);
  } catch {
    await page.mouse.click(x, y);
  }
  st = await page.evaluate(() => ({
    quizActive: document.getElementById('screen-quiz').classList.contains('is-active'),
    startActive: document.getElementById('screen-start').classList.contains('is-active'),
  }));
  assert.equal(st.quizActive, false, `${label}: 400ms ghost must not start`);
  assert.equal(st.startActive, true, `${label}: 400ms still start`);

  await waitUntil(600);
  await page.click('.btn-player[data-player="Stay"]');
  await page.waitForSelector('#screen-quiz.is-active', { timeout: 2000 });
}

async function runBrowser(engine, name) {
  const { server, base } = await startServer();
  const browser = await engine.launch({
    headless: true,
    args: engine === chromium ? ['--autoplay-policy=no-user-gesture-required'] : undefined,
  });
  const results = [];
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 664 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
    });
    const page = await context.newPage();

    // Round 1：結果／開始頂端 + 焦點
    await bootStart(page, base);
    await playTenAndSeeResult(page);
    await assertResultTop(page, `${name}/r1-result`);
    await againThenAssertStart(page, `${name}/r1-again`);
    results.push({ name: `${name} r1 scroll/focus`, ok: true });

    // Round 1 ghost taps（獨立計時）
    await context.clearCookies();
    await page.evaluate(() => localStorage.clear());
    await runGhostIsolated(page, base, `${name}/r1-ghost`);
    results.push({ name: `${name} r1 ghost 150/400`, ok: true });

    // Round 2：再玩一次→玩完→再玩一次（頂端 + ghost）
    await page.evaluate(() => localStorage.clear());
    await bootStart(page, base);
    await playTenAndSeeResult(page);
    await assertResultTop(page, `${name}/r2a-result`);
    await againThenAssertStart(page, `${name}/r2a-again`);
    // 第二輪完整作答
    await page.waitForTimeout(500);
    await playTenAndSeeResult(page);
    await assertResultTop(page, `${name}/r2b-result`);
    await againThenAssertStart(page, `${name}/r2b-again`);
    await runGhostIsolated(page, base, `${name}/r2-ghost`);
    results.push({ name: `${name} r2 scroll/focus + ghost`, ok: true });

    // Desktop 1280 smoke：再玩一次後頂端
    await context.close();
    const desk = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const dpage = await desk.newPage();
    await bootStart(dpage, base);
    await playTenAndSeeResult(dpage);
    await assertResultTop(dpage, `${name}/desk-result`);
    await againThenAssertStart(dpage, `${name}/desk-again`);
    results.push({ name: `${name} 1280 scroll/focus`, ok: true });
    await desk.close();
  } catch (err) {
    results.push({ name: `${name} FAILED`, ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    await browser.close();
    server.close();
  }
  return results;
}

const all = [];
all.push(...(await runBrowser(chromium, 'chromium-390')));
if (process.env.RUN_WEBKIT !== '0') {
  try {
    all.push(...(await runBrowser(webkit, 'webkit-390')));
  } catch (err) {
    all.push({ name: 'webkit skipped/failed', ok: false, error: String(err.message || err) });
  }
}

const ok = all.every((r) => r.ok);
console.log(JSON.stringify({ ok, root: ROOT, results: all }, null, 2));
process.exit(ok ? 0 : 1);
