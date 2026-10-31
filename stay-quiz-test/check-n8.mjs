/**
 * N8：320/360/390 回饋畫面（對／錯／逾時／跳過）不可橫向溢出。
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../stay-quiz');
const OUT = '/opt/cursor/artifacts';
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

async function overflow(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const fb = document.getElementById('feedbackCard');
    const mv = document.getElementById('btnMv');
    const fr = fb.getBoundingClientRect();
    const mr = mv.getBoundingClientRect();
    return {
      page: doc.scrollWidth > doc.clientWidth + 1,
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      mvOutside: mr.right > fr.right + 1 || mr.left < fr.left - 1,
      mvRight: mr.right,
      fbRight: fr.right,
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
          document.getElementById('btnSkipQ').classList.remove('hidden');
          document.getElementById('audioError').classList.remove('hidden');
        });
        await page.click('#btnSkipQ');
      }
      await page.waitForSelector('#feedbackCard:not(.hidden)');
      const ov = await overflow(page);
      const shot = join(OUT, `stay-quiz-n8-${tag}-${mode}.png`);
      await page.screenshot({ path: shot, fullPage: true });
      cases.push({ tag, mode, ok: !ov.page && !ov.mvOutside, ...ov, shot });
      await page.close();
    }
  }

  // 額外：390／1280 wrong 給 PR
  for (const [w, h, tag] of [
    [390, 844, '390'],
    [1280, 800, '1280'],
  ]) {
    const page = await browser.newPage();
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`${base}/index.html?test=1`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.btn-player:not([disabled])');
    await page.click('.btn-player[data-player="羽蕎"]');
    await page.waitForSelector('#screen-quiz.is-active');
    await page.evaluate(() => {
      window.__stayQuiz.forceFirstSound();
      window.__stayQuiz.pickWrong();
    });
    await page.waitForSelector('#feedbackCard:not(.hidden)');
    await page.screenshot({ path: join(OUT, `stay-quiz-r3-feedback-wrong-${tag}.png`), fullPage: true });
    await page.close();
  }
  // 320 wrong alias
  writeFileSync(
    join(OUT, 'stay-quiz-r3-feedback-wrong-320.png'),
    readFileSync(join(OUT, 'stay-quiz-n8-320-wrong.png')),
  );
} finally {
  await browser.close();
  server.close();
}

const ok = cases.every((c) => c.ok);
console.log(JSON.stringify({ ok, cases }, null, 2));
process.exitCode = ok ? 0 : 1;
