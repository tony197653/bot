/**
 * Playwright 截圖／錄影：390 與 1280 各畫面 + 390 完整一輪短片。
 * 用法：cd stay-quiz && node test/capture.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.STAY_QUIZ_ROOT || join(__dirname, '../stay-quiz');
const OUT = '/opt/cursor/artifacts';
mkdirSync(OUT, { recursive: true });

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
      if (path === '/' ) path = '/index.html';
      const file = join(ROOT, path.replace(/^\//, ''));
      if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) {
        res.writeHead(404);
        res.end('missing');
        return;
      }
      const body = readFileSync(file);
      res.writeHead(200, {
        'Content-Type': MIME[extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

async function quietConsole(page, bag) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') bag.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => bag.push(`pageerror: ${err.message}`));
}

async function noOverflow(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      overflow: doc.scrollWidth > doc.clientWidth + 1,
    };
  });
}

async function shot(page, name) {
  const path = join(OUT, `stay-quiz-${name}.png`);
  await page.screenshot({ path, fullPage: true });
  return path;
}

async function waitReady(page, base) {
  await page.goto(`${base}/index.html?test=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const b = document.querySelector('.btn-player');
    return b && !b.disabled && b.textContent !== '準備中…';
  });
}

/** 從作答畫面連續答完剩餘題並進結果 */
async function finishRound(page) {
  for (;;) {
    const st = await page.evaluate(() => window.__stayQuiz.state);
    if (!st.answered) {
      await page.evaluate(() => {
        window.__stayQuiz.forceFirstSound();
        window.__stayQuiz.pickCorrect();
      });
      await page.waitForFunction(() => window.__stayQuiz.state.answered);
      await page.waitForSelector('#btnNext:not([disabled])');
    }
    const after = await page.evaluate(() => window.__stayQuiz.state);
    if (after.qIndex >= 9 && after.answered) {
      await page.click('#btnNext');
      await page.waitForSelector('#screen-result.is-active');
      return;
    }
    await page.click('#btnNext');
    await page.waitForFunction(() => !window.__stayQuiz.state.answered);
    await page.waitForTimeout(200);
  }
}

async function captureViewport(browser, base, w, h, tag) {
  const page = await browser.newPage();
  const errors = [];
  await page.setViewportSize({ width: w, height: h });
  await quietConsole(page, errors);
  await page.addInitScript(() => {
    try { localStorage.clear(); } catch { /* ignore */ }
  });
  await waitReady(page, base);

  const files = [];
  const overflow = [];

  files.push(await shot(page, `${tag}-01-start`));
  overflow.push({ screen: 'start', ...(await noOverflow(page)) });

  await page.evaluate(() => {
    localStorage.setItem(
      'stayQuiz.v2',
      JSON.stringify({ best: { score: 92, player: '羽蕎', at: '2026-11-01' } }),
    );
  });
  await page.reload({ waitUntil: 'load' });
  await waitReady(page, base);
  files.push(await shot(page, `${tag}-01b-highscore`));

  await page.click('.btn-player[data-player="羽蕎"]');
  await page.waitForSelector('#screen-quiz.is-active');
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    if (window.__stayQuiz.state.timerState === 'idle') window.__stayQuiz.forceFirstSound();
  });
  files.push(await shot(page, `${tag}-02-question`));
  overflow.push({ screen: 'question', ...(await noOverflow(page)) });

  await page.evaluate(() => {
    window.__stayQuiz.pauseReplay();
    document.getElementById('listenHint').textContent = '已聽 2 次・本題可得 9 分';
  });
  files.push(await shot(page, `${tag}-03-replaying`));

  await page.evaluate(() => window.__stayQuiz.showResumeMask());
  files.push(await shot(page, `${tag}-04-resume`));
  await page.evaluate(() => window.__stayQuiz.hideResumeMask());

  await page.evaluate(() => window.__stayQuiz.forceRunning(4500));
  files.push(await shot(page, `${tag}-05-last5s`));

  await page.evaluate(() => window.__stayQuiz.pickWrong());
  await page.waitForSelector('#feedbackCard:not(.hidden)');
  files.push(await shot(page, `${tag}-06-feedback`));

  await finishRound(page);
  files.push(await shot(page, `${tag}-07-result`));
  overflow.push({ screen: 'result', ...(await noOverflow(page)) });

  await page.close();
  return { files, overflow, consoleErrors: errors };
}

async function recordFullPlay(browser, base) {
  const page = await browser.newPage();
  const errors = [];
  await page.setViewportSize({ width: 390, height: 844 });
  await quietConsole(page, errors);
  await page.addInitScript(() => {
    try { localStorage.clear(); } catch { /* ignore */ }
  });
  await waitReady(page, base);

  const frames = [];
  const push = async (label) => {
    const buf = await page.screenshot({ type: 'png' });
    const p = join(OUT, `stay-quiz-frame-${String(frames.length).padStart(3, '0')}-${label}.png`);
    writeFileSync(p, buf);
    frames.push(p);
  };

  await push('start');
  await page.click('.btn-player[data-player="容亘"]');
  await page.waitForSelector('#screen-quiz.is-active');
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__stayQuiz.forceFirstSound());
  await push('q1');

  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => {
      window.__stayQuiz.forceFirstSound();
      window.__stayQuiz.pickCorrect();
    });
    await page.waitForSelector('#btnNext:not([disabled])');
    await push(`fb${i + 1}`);
    await page.click('#btnNext');
    if (i < 9) {
      await page.waitForFunction(() => !window.__stayQuiz.state.answered);
      await page.waitForTimeout(250);
      await page.evaluate(() => window.__stayQuiz.forceFirstSound());
      await push(`q${i + 2}`);
    }
  }
  await page.waitForSelector('#screen-result.is-active');
  await push('result');

  const listFile = join(OUT, 'stay-quiz-frames.txt');
  writeFileSync(
    listFile,
    frames.map((f) => `file '${f}'\nduration 0.4`).join('\n') + `\nfile '${frames.at(-1)}'\n`,
  );
  const video = join(OUT, 'stay-quiz-fullplay-390.mp4');
  const ff = spawnSync(
    'ffmpeg',
    ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-vf', 'fps=8,scale=390:-2', '-pix_fmt', 'yuv420p', video],
    { encoding: 'utf8' },
  );

  await page.close();
  return {
    video: ff.status === 0 ? video : null,
    ffmpeg: ff.status === 0 ? 'ok' : (ff.stderr || ff.stdout || 'ffmpeg failed').slice(-500),
    frames: frames.length,
    consoleErrors: errors,
  };
}

const { server, base } = await startServer();
const browser = await chromium.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});

try {
  const viewports = [
    [320, 568, '320'],
    [360, 640, '360'],
    [390, 844, '390'],
    [1280, 800, '1280'],
    [1440, 900, '1440'],
  ];
  const runs = [];
  for (const [w, h, tag] of viewports) {
    runs.push(await captureViewport(browser, base, w, h, tag));
  }

  // reduced-motion：倒數條寬度應按整秒跳變
  const rmPage = await browser.newPage();
  const rmErrors = [];
  await rmPage.emulateMedia({ reducedMotion: 'reduce' });
  await rmPage.setViewportSize({ width: 390, height: 844 });
  await quietConsole(rmPage, rmErrors);
  await rmPage.addInitScript(() => { try { localStorage.clear(); } catch {} });
  await waitReady(rmPage, base);
  await rmPage.click('.btn-player[data-player="Stay"]');
  await rmPage.waitForSelector('#screen-quiz.is-active');
  await rmPage.evaluate(() => window.__stayQuiz.forceFirstSound());
  const widths = [];
  for (const ms of [14900, 14000, 13500, 12900, 12000, 11500]) {
    await rmPage.evaluate((m) => window.__stayQuiz.forceRunning(m), ms);
    const t = await rmPage.evaluate(() => getComputedStyle(document.getElementById('timerBar')).transform);
    widths.push(t);
  }
  const uniqueWidths = new Set(widths);
  // 6 個取樣對應約 15/14/13/12 秒 → unique 應明顯少於 6（每秒一格）
  const reducedMotionOk = uniqueWidths.size <= 4 && rmErrors.length === 0;
  await rmPage.close();

  const video = await recordFullPlay(browser, base);

  const report = {
    ok:
      runs.every((r) => r.consoleErrors.length === 0 && r.overflow.every((o) => !o.overflow)) &&
      video.consoleErrors.length === 0 &&
      !!video.video &&
      reducedMotionOk,
    runs: runs.map((r, i) => ({
      tag: viewports[i][2],
      consoleErrors: r.consoleErrors,
      overflow: r.overflow,
      files: r.files,
    })),
    reducedMotion: { ok: reducedMotionOk, transforms: widths, errors: rmErrors },
    video,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
