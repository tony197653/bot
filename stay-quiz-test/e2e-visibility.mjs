/**
 * E2E：N1 回饋切背景後下一題卡住；N2 重播中連續切背景兩次。
 * 用法：cd stay-quiz-test && node e2e-visibility.mjs
 */
import { chromium } from 'playwright';
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

async function setHidden(page, hidden) {
  await page.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (h ? 'hidden' : 'visible'),
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

async function startQuiz(page, base) {
  await page.goto(`${base}/index.html?test=1`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => {
    const b = document.querySelector('.btn-player');
    return b && !b.disabled;
  });
  await page.click('.btn-player[data-player="羽蕎"]');
  await page.waitForSelector('#screen-quiz.is-active');
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__stayQuiz.forceFirstSound());
}

const { server, base } = await startServer();
const browser = await chromium.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const results = [];

try {
  // —— N1：回饋畫面切背景再回來 → 下一題 → 倒數要開始 ——
  {
    const page = await browser.newPage();
    const name = 'N1 feedback->hidden->visible->next->timer starts';
    try {
      await startQuiz(page, base);
      await page.evaluate(() => window.__stayQuiz.pickCorrect());
      await page.waitForSelector('#btnNext:not([disabled])');
      // 回饋畫面：切背景再回來（無「繼續」遮罩）
      await setHidden(page, true);
      await setHidden(page, false);
      const maskHidden = await page.evaluate(() => document.getElementById('resumeMask').hidden);
      assert.equal(maskHidden, true, '回饋畫面不應出現繼續遮罩');
      await page.click('#btnNext');
      await page.waitForFunction(() => !window.__stayQuiz.state.answered);
      await page.waitForTimeout(400);
      // 走真實 playing 路徑（不可用 forceFirstSound 繞過 suppress）
      await page.evaluate(() => {
        document.getElementById('audio').dispatchEvent(new Event('playing'));
      });
      await page.waitForTimeout(200);
      const afterPlay = await page.evaluate(() => ({
        ...window.__stayQuiz.state,
        hint: document.getElementById('playHint').classList.contains('hidden')
          ? ''
          : document.getElementById('playHint').textContent,
        playDisabled: document.getElementById('btnPlay').disabled,
        label: document.getElementById('timerLabel').textContent,
        docHidden: document.hidden,
        maskHidden: document.getElementById('resumeMask').hidden,
      }));
      assert.equal(
        afterPlay.timerState,
        'running',
        `timer should run after playing, got ${JSON.stringify(afterPlay)}`,
      );
      assert.equal(afterPlay.playDisabled, false, 'play should not stuck loading');
      assert.notEqual(afterPlay.hint, '載入中');
      const before = afterPlay.remainingMs;
      await page.waitForTimeout(600);
      const later = await page.evaluate(() => window.__stayQuiz.state.remainingMs);
      assert.ok(later < before - 200, `countdown should decrease ${before}→${later}`);
      results.push({ name, ok: true });
    } catch (e) {
      results.push({ name, ok: false, error: String(e.message || e) });
    }
    await page.close();
  }

  // —— N2：重播中連續切背景兩次 → 繼續 → 應續播或倒數恢復 ——
  {
    const page = await browser.newPage();
    const name = 'N2 replay->bg->bg->continue not frozen';
    try {
      await startQuiz(page, base);
      // 進入重播並標記播放中
      await page.evaluate(() => {
        window.__stayQuiz.pauseReplay();
      });
      // 模擬「重播播放中」：先設 wasPlaying 語意靠第一次 hide
      await page.evaluate(() => {
        const a = document.getElementById('audio');
        // 假裝正在播：讓 pause 狀態為 false 不可靠；改用 API 路徑
        Object.defineProperty(a, 'paused', { configurable: true, get: () => false });
        Object.defineProperty(a, 'ended', { configurable: true, get: () => false });
      });
      await setHidden(page, true); // 第一次：記錄 wasPlaying=true，顯示遮罩
      await setHidden(page, false); // 回來看到遮罩，尚未按繼續
      await setHidden(page, true); // 第二次：音訊已暫停，不可覆寫 wasPlaying
      await setHidden(page, false);
      await page.click('#btnResume');
      await page.waitForTimeout(200);
      const st = await page.evaluate(() => ({
        ...window.__stayQuiz.state,
        label: document.getElementById('timerLabel').textContent,
        mask: document.getElementById('resumeMask').hidden,
      }));
      assert.equal(st.mask, true, 'mask closed');
      // 不應永久停在「重播中，倒數暫停」且 remaining 永不減
      // 若續播重播：pauseReason 可為 replay；若倒數恢復：running
      const frozenReplay =
        st.timerState === 'paused' &&
        st.pauseReason === 'replay' &&
        st.label.includes('重播中');
      // 允許仍暫停（重播續播中），但不允許 wasPlaying 被清掉導致「無聲且永遠卡 replay 卻沒在播」
      // 判定：按繼續後若 paused+replay，必須曾嘗試 play（is-playing 或 currentTime 前進）或之後可 resume
      if (frozenReplay) {
        // 給重播一點時間；若完全沒續播，playing UI 不會亮且 remaining 不變
        const rem1 = st.remainingMs;
        await page.waitForTimeout(800);
        const st2 = await page.evaluate(() => ({
          ...window.__stayQuiz.state,
          playing: document.getElementById('btnPlay').classList.contains('is-playing'),
          label: document.getElementById('timerLabel').textContent,
        }));
        // 若仍完全凍結（沒播、倒數也不跑）→ fail
        const stillFrozen =
          st2.timerState === 'paused' &&
          !st2.playing &&
          Math.abs(st2.remainingMs - rem1) < 50;
        assert.equal(stillFrozen, false, `stuck after double-bg continue: ${JSON.stringify(st2)}`);
      } else {
        assert.ok(
          st.timerState === 'running' || st.timerState === 'paused',
          `unexpected state ${JSON.stringify(st)}`,
        );
      }
      results.push({ name, ok: true });
    } catch (e) {
      results.push({ name, ok: false, error: String(e.message || e) });
    }
    await page.close();
  }

  // —— 開始／結果畫面切背景也不應污染下一輪 ——
  {
    const page = await browser.newPage();
    const name = 'start screen bg then start quiz timer works';
    try {
      await page.goto(`${base}/index.html?test=1`, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => document.querySelector('.btn-player:not([disabled])'));
      await setHidden(page, true);
      await setHidden(page, false);
      await page.click('.btn-player[data-player="Stay"]');
      await page.waitForSelector('#screen-quiz.is-active');
      await page.waitForTimeout(300);
      await page.evaluate(() => {
        document.getElementById('audio').dispatchEvent(new Event('playing'));
      });
      await page.waitForTimeout(200);
      const st = await page.evaluate(() => window.__stayQuiz.state);
      assert.equal(st.timerState, 'running', JSON.stringify(st));
      assert.ok(st.remainingMs <= 15000);
      results.push({ name, ok: true });
    } catch (e) {
      results.push({ name, ok: false, error: String(e.message || e) });
    }
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}

const ok = results.every((r) => r.ok);
console.log(JSON.stringify({ ok, results }, null, 2));
process.exitCode = ok ? 0 : 1;
