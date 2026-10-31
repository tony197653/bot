/**
 * N9：320/360/390 × 對／錯／逾時／跳過 — 無「正確歌／名」類斷詞、無橫向捲動。
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../stay-quiz');
const OUT = '/opt/cursor/artifacts';
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
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

/** 依行盒檢查「正確歌名」相關標籤是否被拆開 */
async function inspectBreaks(page) {
  return page.evaluate(() => {
    const fb = document.getElementById('fbText');
    const spans = [...fb.querySelectorAll('.nowrap')];
    const lines = [];
    for (const s of spans) {
      const r = s.getBoundingClientRect();
      const cs = getComputedStyle(s);
      lines.push({
        text: s.textContent,
        top: Math.round(r.top),
        height: Math.round(r.height),
        whiteSpace: cs.whiteSpace,
        // 單行 nowrap 高度應接近 line-height；若跨兩行 height 會明顯變大
        multiLine: r.height > 28,
      });
    }
    const doc = document.documentElement;
    const text = fb.innerText.replace(/\s+/g, '');
    const bad =
      /正確歌名(?!是|：)/.test(fb.innerText) === false &&
      (/正確歌[^名]|歌名是(?![\u4e00-\u9fffA-Za-z0-9'& ])/.test(fb.innerText));
    return {
      spans: lines,
      pageOverflow: doc.scrollWidth > doc.clientWidth + 1,
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      innerText: fb.innerText,
      compact: text,
      // 標籤字串必須完整出現（未被斷成「正確歌」單獨一行的語意檢查靠 multiLine）
      hasLabelColon: text.includes('正確歌名：') || text.includes('正確歌名是'),
    };
  });
}

const { server, base } = await startServer();
const browser = await chromium.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const cases = [];

try {
  for (const [w, h, tag] of [
    [320, 568, '320'],
    [360, 640, '360'],
    [390, 844, '390'],
  ]) {
    for (const mode of ['wrong', 'correct', 'timeout', 'skip']) {
      const page = await browser.newPage();
      await page.setViewportSize({ width: w, height: h });
      await page.goto(`${base}/index.html?test=1`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.btn-player:not([disabled])');
      await page.click('.btn-player[data-player="羽蕎"]');
      await page.waitForSelector('#screen-quiz.is-active');
      await page.evaluate(() => window.__stayQuiz.forceFirstSound());
      if (mode === 'wrong') await page.evaluate(() => window.__stayQuiz.pickWrong());
      else if (mode === 'correct') await page.evaluate(() => window.__stayQuiz.pickCorrect());
      else if (mode === 'timeout') await page.evaluate(() => window.__stayQuiz.forceTimeout());
      else {
        await page.evaluate(() => {
          document.getElementById('audioError').classList.remove('hidden');
          document.getElementById('btnSkipQ').classList.remove('hidden');
        });
        await page.click('#btnSkipQ');
      }
      await page.waitForSelector('#feedbackCard:not(.hidden)');
      const info = await inspectBreaks(page);
      const labelSpans = info.spans.filter((s) => /正確歌名/.test(s.text));
      const titleSpans = info.spans.filter((s) => !/正確歌名/.test(s.text));
      const midBreak =
        mode !== 'correct' &&
        (labelSpans.some((s) => s.multiLine || s.whiteSpace !== 'nowrap') ||
          titleSpans.some((s) => s.multiLine));
      const shot = join(OUT, `stay-quiz-n9-${tag}-${mode}.png`);
      await page.screenshot({ path: shot, fullPage: true });
      cases.push({
        tag,
        mode,
        ok: !info.pageOverflow && !midBreak && (mode === 'correct' || info.hasLabelColon),
        midBreak,
        pageOverflow: info.pageOverflow,
        spans: info.spans,
        innerText: info.innerText,
        shot,
      });
      await page.close();
    }
  }
  // PR 證據：320/360 wrong + skip
  for (const tag of ['320', '360']) {
    for (const mode of ['wrong', 'skip']) {
      writeFileSync(
        join(OUT, `stay-quiz-r4-${tag}-${mode}.png`),
        readFileSync(join(OUT, `stay-quiz-n9-${tag}-${mode}.png`)),
      );
    }
  }
} finally {
  await browser.close();
  server.close();
}

const ok = cases.every((c) => c.ok);
console.log(JSON.stringify({ ok, cases }, null, 2));
process.exitCode = ok ? 0 : 1;
