/**
 * Playwright e2e（Chromium）：template-demo 於 390／1280。
 * 覆蓋：作答、結算、題目回顧預設篩選（有錯→只看錯題；全對→全部）、
 * 泡泡橫向捲、無頁面橫向捲動。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 8765;
const outDir = path.join(root, 'test-artifacts');
fs.mkdirSync(outDir, { recursive: true });

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

try {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });

  async function runRound(page, { answers, shotPrefix, viewport }) {
    await page.setViewportSize(viewport);
    await page.goto(`http://127.0.0.1:${port}/template-demo.html`, {
      waitUntil: 'networkidle',
      timeout: 20000,
    });
    await page.waitForSelector('.opt', { timeout: 10000 });
    const titleText = await page.locator('.quiz-top .title').textContent();
    if (!titleText?.includes('示範')) throw new Error('title missing');

    // 泡泡列橫向捲（題數 >12）：只測作答頁；頁面本身不可橫捲
    if (answers.length > 12 && viewport.width <= 390) {
      const strip = page.locator('.bub-strip.strip-scroll, .strip.strip-scroll').first();
      await strip.waitFor({ timeout: 3000 });
      const metrics = await strip.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        pageScroll:
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }));
      if (metrics.scrollWidth <= metrics.clientWidth + 2) {
        throw new Error(`bubble strip should scroll: ${JSON.stringify(metrics)}`);
      }
      if (metrics.pageScroll > 1) {
        throw new Error(`page must not scroll horizontally: ${metrics.pageScroll}`);
      }
    }

    // answer each question then next
    for (let i = 0; i < answers.length; i++) {
      await page.locator(`.opt[data-k="${answers[i]}"]`).click();
      await page.waitForTimeout(120);
      const next = page.locator('[data-act="next"]');
      if (i < answers.length - 1) {
        await next.click();
        await page.waitForTimeout(250);
      } else {
        // 最後一題：看結果；若仍有未答才會進入「確定交卷」
        await next.click();
        try {
          await page.waitForSelector('[data-el="result"]', { timeout: 2500 });
        } catch {
          const label = await page.locator('.nx-t').textContent({ timeout: 1000 }).catch(() => '');
          if (label.includes('確定')) await next.click();
          await page.waitForSelector('[data-el="result"]', { timeout: 10000 });
        }
      }
    }
    await page.waitForSelector('[data-el="result"]', { timeout: 5000 });
    await page.screenshot({
      path: path.join(outDir, `${shotPrefix}-${viewport.width}.png`),
      fullPage: true,
    });
    return titleText.trim();
  }

  // --- 390：有錯題 → 預設只看錯題 ---
  {
    const page = await browser.newPage();
    // first 3 questions: wrong, wrong, correct — use known answers from fake-batch
    // We'll answer 0 for all to guarantee some wrongs (answers vary)
    const batch = JSON.parse(
      fs.readFileSync(path.join(root, 'test-data/fake-batch.json'), 'utf8'),
    );
    const wrongish = batch.questions.map((q) => (q.answer === 0 ? 1 : 0));
    await runRound(page, {
      answers: wrongish,
      shotPrefix: 'result-has-wrong',
      viewport: { width: 390, height: 844 },
    });
    const result = page.locator('[data-el="result"]');
    const hasOnlyWrong = await result.evaluate((el) => el.classList.contains('only-wrong'));
    const wrongSelected = await page
      .locator('.g1 button[data-f="wrong"]')
      .getAttribute('aria-selected');
    const allSelected = await page
      .locator('.g1 button[data-f="all"]')
      .getAttribute('aria-selected');
    if (!hasOnlyWrong || wrongSelected !== 'true' || allSelected !== 'false') {
      throw new Error(
        `expected 只看錯題 default, got only-wrong=${hasOnlyWrong} wrong=${wrongSelected} all=${allSelected}`,
      );
    }
    // visible review items should be wrong only
    const visibleOk = await page.locator('.rv-list .rv.ok').evaluateAll((els) =>
      els.filter((e) => getComputedStyle(e).display !== 'none').length,
    );
    if (visibleOk !== 0) throw new Error(`ok items still visible: ${visibleOk}`);
    // no page horizontal scroll on result
    const scrollW = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (scrollW > 1) throw new Error(`horizontal page scroll ${scrollW}`);
    await page.locator('.panel.review .rv-head').scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({
      path: path.join(outDir, 'result-wrong-filter-390.png'),
      fullPage: false,
    });
    pass('390 有錯題預設只看錯題＋泡泡列可橫捲／頁面不橫捲');
    await page.close();
  }

  // --- 1280：全對 → 預設全部 ---
  {
    const page = await browser.newPage();
    const batch = JSON.parse(
      fs.readFileSync(path.join(root, 'test-data/fake-batch.json'), 'utf8'),
    );
    const correct = batch.questions.map((q) => q.answer);
    await runRound(page, {
      answers: correct,
      shotPrefix: 'result-all-correct',
      viewport: { width: 1280, height: 800 },
    });
    const result = page.locator('[data-el="result"]');
    const hasOnlyWrong = await result.evaluate((el) => el.classList.contains('only-wrong'));
    const wrongSelected = await page
      .locator('.g1 button[data-f="wrong"]')
      .getAttribute('aria-selected');
    const allSelected = await page
      .locator('.g1 button[data-f="all"]')
      .getAttribute('aria-selected');
    if (hasOnlyWrong || wrongSelected !== 'false' || allSelected !== 'true') {
      throw new Error(
        `expected 全部 default when all correct, got only-wrong=${hasOnlyWrong} wrong=${wrongSelected} all=${allSelected}`,
      );
    }
    await page.locator('.panel.review .rv-head').scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({
      path: path.join(outDir, 'result-all-correct-filter-1280.png'),
      fullPage: false,
    });
    pass('1280 全對預設全部');
    await page.close();
  }

  // --- login screen smoke at 390 ---
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${port}/index.html`, {
      waitUntil: 'networkidle',
      timeout: 15000,
    });
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(outDir, 'login-390.png'), fullPage: true });
    pass('login screen 390 screenshot');
    await page.close();
  }

  // --- reduced motion: still finishes ---
  {
    const page = await browser.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const batch = JSON.parse(
      fs.readFileSync(path.join(root, 'test-data/fake-batch.json'), 'utf8'),
    );
    // answer first 3 then jump via submit for speed — still full round for reliability
    const answers = batch.questions.map((q) => q.answer);
    await runRound(page, {
      answers,
      shotPrefix: 'reduced-motion',
      viewport: { width: 390, height: 844 },
    });
    pass('reduced-motion full round');
    await page.close();
  }

  await browser.close();
} catch (e) {
  fail('e2e suite', e.message || e);
  server.kill();
  process.exit(1);
}

server.kill();
const failed = results.filter((r) => !r.ok);
console.log(`\ne2e ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
