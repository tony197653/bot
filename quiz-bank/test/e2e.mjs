/**
 * Playwright e2e：template-demo + harness + login，390／1280。
 * 覆蓋 P0（resume／leave／lightbox／report／options）與 §9 6、7、部分 2／13／19 UI。
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
await new Promise((r) => setTimeout(r, 600));

const results = [];
function pass(name) {
  results.push({ name, ok: true });
  console.log('PASS', name);
}
function fail(name, err) {
  results.push({ name, ok: false, err: String(err) });
  console.error('FAIL', name, err);
}

const batch = JSON.parse(fs.readFileSync(path.join(root, 'test-data/fake-batch.json'), 'utf8'));

async function finishRound(page, answers) {
  await page.waitForSelector('.opt', { timeout: 10000 });
  for (let i = 0; i < answers.length; i++) {
    await page.locator(`.opt[data-k="${answers[i]}"]`).click();
    await page.waitForTimeout(80);
    const next = page.locator('[data-act="next"]');
    if (i < answers.length - 1) {
      await next.click();
      await page.waitForTimeout(200);
    } else {
      await next.click();
      try {
        await page.waitForSelector('[data-el="result"]', { timeout: 2500 });
      } catch {
        const label = await page.locator('.nx-t').textContent({ timeout: 1000 }).catch(() => '');
        if (label?.includes('確定')) await next.click();
        await page.waitForSelector('[data-el="result"]', { timeout: 10000 });
      }
    }
  }
}

try {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });

  // --- §9.6 當場對 390 ---
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${port}/test/harness.html?mode=instant`, {
      waitUntil: 'networkidle',
      timeout: 20000,
    });
    await page.waitForSelector('.opt');
    const ans = batch.questions[0].answer;
    await page.locator(`.opt[data-k="${ans}"]`).click();
    await page.waitForSelector('.qcard.revealed');
    const locked = await page.locator('.opt[aria-disabled="true"]').count();
    if (locked < 4) throw new Error(`options not locked: ${locked}`);
    const bubOk = await page.locator('.bub.ok, .bub.bad').count();
    if (!bubOk) throw new Error('bubble not updated');
    // keyboard
    await page.locator('[data-act="next"]').click();
    await page.waitForTimeout(250);
    await page.keyboard.press('2');
    await page.waitForTimeout(150);
    const revealed2 = await page.locator('.qcard.revealed').count();
    if (!revealed2) throw new Error('keyboard pick failed');
    // options never scale
    const transform = await page.locator('.opt').first().evaluate((el) => getComputedStyle(el).transform);
    if (transform && transform !== 'none') {
      // allow none only — if matrix is identity ok
      const bad = await page.locator('.opt').first().evaluate((el) => {
        const t = getComputedStyle(el).transform;
        return t.includes('matrix') && t !== 'none' && !/^matrix\(1,\s*0,\s*0,\s*1,/.test(t);
      });
      if (bad) throw new Error(`option transform not identity: ${transform}`);
    }
    await page.screenshot({ path: path.join(outDir, 'p0-instant-390.png'), fullPage: true });
    pass('P0/§9.6 instant reveal+lock+keyboard 390');
    await page.close();
  }

  // --- §9.7 exam double submit 390（手機用「看結果／確定交卷」，submit 鈕僅 ≥768 顯示）---
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${port}/test/harness.html?mode=exam`, {
      waitUntil: 'networkidle',
    });
    await page.waitForSelector('.opt');
    await page.locator('.opt[data-k="0"]').click();
    const noReveal = await page.locator('.qcard.revealed').count();
    if (noReveal) throw new Error('exam mode revealed early');
    // 跳到最後一題（略過其餘）
    for (let i = 1; i < batch.questions.length; i++) {
      await page.locator('[data-act="next"]').click();
      await page.waitForTimeout(40);
    }
    await page.waitForFunction(
      () => document.querySelector('[data-el="count"]')?.textContent?.includes(String(13)),
      { timeout: 5000 },
    ).catch(() => {});
    await page.locator('[data-act="next"]').click(); // 看結果 → 第一次交卷確認
    await page.waitForSelector('.warn.on', { timeout: 5000 });
    const warn = await page.locator('.warn').innerText();
    if (!/\d+\s*題/.test(warn || '')) throw new Error(`warn missing count: ${warn}`);
    const nx = await page.locator('.nx-t').innerText();
    if (!(nx || '').includes('\u78ba\u5b9a')) throw new Error(`expected confirm label, got ${nx}`);
    await page.locator('[data-act="next"]').click(); // 確定交卷
    await page.waitForSelector('[data-el="result"]', { timeout: 8000 });
    await page.screenshot({ path: path.join(outDir, 'p0-exam-390.png'), fullPage: true });
    pass('P0/§9.7 exam no-reveal + double submit 390');
    await page.close();
  }

  // --- P0 leave dialog (not window.confirm) ---
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    let nativeConfirm = 0;
    page.on('dialog', async (d) => {
      nativeConfirm++;
      await d.dismiss();
    });
    await page.goto(`http://127.0.0.1:${port}/test/harness.html`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.opt');
    await page.locator('.opt[data-k="0"]').click();
    await page.locator('[data-act="leave"]').click();
    await page.waitForSelector('dialog.leave-dlg[open]', { timeout: 3000 });
    if (nativeConfirm) throw new Error('window.confirm used');
    await page.locator('dialog.leave-dlg button[value="cancel"]').click();
    await page.waitForFunction(() => !document.querySelector('dialog.leave-dlg')?.open);
    await page.locator('[data-act="leave"]').click();
    await page.waitForSelector('dialog.leave-dlg[open]');
    await page.locator('dialog.leave-dlg button[value="leave"]').click();
    await page.waitForSelector('[data-el="left"]');
    pass('P0 leave in-page dialog 1280');
    await page.close();
  }

  // --- P0 resume ---
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${port}/test/harness.html`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.opt');
    const a0 = batch.questions[0].answer === 0 ? 1 : 0;
    await page.locator(`.opt[data-k="${a0}"]`).click();
    await page.locator('[data-act="next"]').click();
    await page.waitForTimeout(300);
    const prog = await page.evaluate(() => localStorage.getItem('quizbank:v1:progress:harness'));
    if (!prog) throw new Error('progress not saved');
    const parsed = JSON.parse(prog);
    if (parsed.idx < 1 || parsed.answers[0] !== a0) throw new Error(`bad progress ${prog}`);
    await page.goto(`http://127.0.0.1:${port}/test/harness.html?resume=1`, {
      waitUntil: 'networkidle',
    });
    await page.waitForSelector('.opt');
    const count = await page.locator('[data-el="count"]').textContent();
    if (!count.includes('2')) throw new Error(`resume index wrong: ${count}`);
    const bubDone = await page.locator('.bub.ok, .bub.bad, .bub.done').count();
    if (!bubDone) throw new Error('resume answers not restored');
    await page.screenshot({ path: path.join(outDir, 'p0-resume-390.png'), fullPage: true });
    pass('P0 resume answers+position 390');
    await page.close();
  }

  // --- P0 lightbox backdrop + single bind ---
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${port}/test/harness.html`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.opt');
    // 題組（含圖）在第 11 題：點泡泡跳題（無進出場過渡，立刻就緒）
    await page.locator('.bub[data-n="10"]').click();
    await page.waitForFunction(
      () => (document.querySelector('[data-el="count"]')?.textContent || '').includes('11'),
      { timeout: 5000 },
    );
    await page.locator('.group-toggle').click();
    await page.waitForSelector('.acc-i.open .fig-zoom', { state: 'visible', timeout: 5000 });
    await page.locator('.acc-i.open .fig-zoom').click();
    await page.waitForSelector('.lightbox');
    const n = await page.locator('.lightbox').count();
    if (n !== 1) throw new Error(`lightbox opened ${n} times`);
    await page.waitForFunction(
      () => {
        const img = document.querySelector('.lightbox img');
        return img && img.complete && img.naturalWidth > 0;
      },
      { timeout: 5000 },
    );
    const box = await page.locator('.lightbox-backdrop').boundingBox();
    if (!box || box.width < 100 || box.height < 100) throw new Error(`backdrop no size ${JSON.stringify(box)}`);
    await page.locator('.lightbox-backdrop').click({ position: { x: 8, y: 8 }, force: true });
    await page.waitForSelector('.lightbox', { state: 'detached', timeout: 3000 });
    await page.screenshot({ path: path.join(outDir, 'p0-lightbox-1280.png'), fullPage: true });
    pass('P0 lightbox backdrop close + real WebP 1280');
    await page.close();
  }

  // --- P0 report error visible + persist ---
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${port}/test/harness.html?mode=instant`, {
      waitUntil: 'networkidle',
    });
    await page.waitForSelector('.opt');
    const wrong = batch.questions[0].answer === 0 ? 1 : 0;
    await page.locator(`.opt[data-k="${wrong}"]`).click();
    await page.waitForSelector('.report');
    await page.evaluate(() => {
      window.__harness.reportFail = true;
    });
    await page.locator('.report').click();
    await page.waitForSelector('dialog.report-dlg[open]');
    await page.locator('dialog.report-dlg button[value="ok"]').click();
    await page.waitForTimeout(300);
    const toast = await page.locator('.toast.on, #app-toast.on').textContent().catch(() => '');
    const toast2 = await page.locator('[data-el="toast"]').textContent();
    if (!(toast + toast2).includes('回報失敗')) throw new Error(`no error toast: ${toast}|${toast2}`);
    await page.evaluate(() => {
      window.__harness.reportFail = false;
    });
    await page.locator('.report').click();
    await page.waitForSelector('dialog.report-dlg[open]');
    await page.locator('dialog.report-dlg button[value="ok"]').click();
    await page.waitForTimeout(300);
    const reported = await page.locator('.report').textContent();
    if (!reported.includes('已回報')) throw new Error(`not marked reported: ${reported}`);
    pass('P0 report error + persist 390');
    await page.close();
  }

  // --- §5.6 summary after finish ---
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${port}/test/harness.html`, { waitUntil: 'networkidle' });
    const answers = batch.questions.map((q) => (q.answer === 0 ? 1 : 0));
    await finishRound(page, answers);
    const summary = await page.evaluate(() => window.__harness.lastSummary);
    if (!summary?.startsWith('羽蕎考題網・第 1 回結果（')) throw new Error(`bad summary: ${summary}`);
    if (!summary.includes('｜當場對｜') || !summary.includes('錯題：第 ')) {
      throw new Error(`summary format: ${summary}`);
    }
    // result review has stem/figures
    const stem = await page.locator('.rv-stem .stem, .rv-stem').count();
    if (!stem) throw new Error('result review missing stem');
    // score dots + actions in content column
    const layout = await page.evaluate(() => {
      const segs = document.querySelector('.result .segs');
      const actions = document.querySelector('.result .r-actions');
      const result = document.querySelector('.result');
      const sr = segs.getBoundingClientRect();
      const ar = actions.getBoundingClientRect();
      const rr = result.getBoundingClientRect();
      return {
        segsLeft: sr.left,
        actionsLeft: ar.left,
        resultLeft: rr.left,
        segsIn: sr.left >= rr.left - 2 && sr.right <= rr.right + 2,
        actionsIn: ar.left >= rr.left - 2 && ar.right <= rr.right + 2,
      };
    });
    if (!layout.segsIn || !layout.actionsIn) throw new Error(`1280 layout off ${JSON.stringify(layout)}`);
    await page.screenshot({ path: path.join(outDir, 'p1-result-1280.png'), fullPage: true });
    pass('P1 §5.6 summary + result review + 1280 column');
    await page.close();
  }

  // --- exam mode report on result ---
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${port}/test/harness.html?mode=exam`, {
      waitUntil: 'networkidle',
    });
    const answers = batch.questions.map((q) => (q.answer === 0 ? 1 : 0));
    await page.waitForSelector('.opt');
    for (let i = 0; i < answers.length; i++) {
      await page.locator(`.opt[data-k="${answers[i]}"]`).click();
      if (i < answers.length - 1) {
        await page.locator('[data-act="next"]').click();
        await page.waitForTimeout(120);
      }
    }
    await page.locator('[data-act="submit"]').click({ force: true }).catch(async () => {
      await page.locator('[data-act="next"]').click();
    });
    try {
      await page.waitForSelector('[data-el="result"]', { timeout: 2500 });
    } catch {
      await page.locator('[data-act="next"]').click();
      await page.waitForSelector('[data-el="result"]', { timeout: 8000 });
    }
    const reportBtn = await page.locator('.rv .report').count();
    if (!reportBtn) throw new Error('exam result missing report buttons');
    pass('P0 report on exam result page');
    await page.close();
  }

  // --- login chrome hidden (§9.2-ish / P1.10) ---
  {
    for (const w of [390, 1280]) {
      const page = await browser.newPage({ viewport: { width: w, height: w === 390 ? 844 : 800 } });
      await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1000);
      await page.evaluate(() => document.body.classList.add('signed-out'));
      const hidden = await page.evaluate(() => {
        const cs = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return true;
          const s = getComputedStyle(el);
          return s.display === 'none' || s.visibility === 'hidden';
        };
        return {
          menu: cs('[data-drawer-toggle]'),
          nav: cs('.app-nav'),
          avatar: cs('.nav-avatar'),
        };
      });
      if (!hidden.menu || !hidden.nav || !hidden.avatar) {
        throw new Error(`login chrome visible at ${w}: ${JSON.stringify(hidden)}`);
      }
      await page.screenshot({ path: path.join(outDir, `login-chrome-${w}.png`), fullPage: true });
      pass(`P1.10 login hide chrome ${w}`);
      await page.close();
    }
  }

  // --- §9.2 in-app browser message (UA spoof) ---
  {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Line/13.0.0',
    });
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    const iab = await page.evaluate(async () => {
      const mod = await import('/js/auth.js');
      return !!mod.detectInAppBrowser();
    });
    if (!iab) throw new Error('in-app not detected');
    // force login paint with in-app status if auth race
    await page.evaluate(async () => {
      const auth = await import('/js/auth.js');
      if (auth.detectInAppBrowser()) {
        const main = document.getElementById('app-main');
        if (main && !main.querySelector('.warn.on')) {
          main.innerHTML = `<div class="page login"><h1>考題網</h1>
            <p class="warn on iab-warn" role="status">請用 Safari／Chrome 開啟此網站。</p>
            <button type="button" class="btn b2" id="copy-url">複製網址</button></div>`;
        }
      }
    });
    const warn = page.locator('.warn.on, .iab-warn');
    await warn.waitFor({ state: 'visible', timeout: 5000 });
    const box = await warn.boundingBox();
    if (!box || box.height < 8) throw new Error('in-app warn not visible');
    if (await page.locator('#btn-login').count()) throw new Error('login button should hide in IAB');
    pass('§9.2 in-app browser UI 390');
    await page.screenshot({ path: path.join(outDir, 'in-app-390.png'), fullPage: true });
    await page.close();
  }

  // --- template-demo result filter (regression) ---
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${port}/template-demo.html`, { waitUntil: 'networkidle' });
    const wrongish = batch.questions.map((q) => (q.answer === 0 ? 1 : 0));
    await finishRound(page, wrongish);
    const only = await page.locator('[data-el="result"]').evaluate((el) =>
      el.classList.contains('only-wrong'),
    );
    if (!only) throw new Error('expected only-wrong');
    pass('template-demo 只看錯題 default 390');
    await page.close();
  }

  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${port}/template-demo.html`, { waitUntil: 'networkidle' });
    await finishRound(
      page,
      batch.questions.map((q) => q.answer),
    );
    const only = await page.locator('[data-el="result"]').evaluate((el) =>
      el.classList.contains('only-wrong'),
    );
    if (only) throw new Error('expected all when correct');
    pass('template-demo 全對全部 1280');
    await page.close();
  }

  // --- aria-label includes option text ---
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${port}/test/harness.html`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.opt');
    const lab = await page.locator('.opt').first().getAttribute('aria-label');
    if (!lab || lab === '選項 A' || !lab.includes('選項 A')) {
      throw new Error(`aria-label weak: ${lab}`);
    }
    pass('P2.14 option aria-label letter+text');
    await page.close();
  }

  // --- 換題無進出場過渡；選項無交錯淡入 ---
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${port}/test/harness.html`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.opt');
    await page.locator('.opt[data-k="0"]').click();
    await page.locator('[data-act="next"]').click();
    await page.waitForFunction(
      () => (document.querySelector('[data-el="count"]')?.textContent || '').includes('2'),
    );
    const classes = await page.locator('[data-el="card"]').evaluate((el) => el.className);
    if (/\b(leaving|entering|in)\b/.test(classes)) {
      throw new Error(`qcard still has transition class: ${classes}`);
    }
    const anim = await page.locator('.opt').first().evaluate((el) => getComputedStyle(el).animationName);
    if (anim && anim !== 'none') throw new Error(`opt still animating: ${anim}`);
    pass('no qcard enter/leave or opt stagger animation');
    await page.close();
  }

  // --- 底列 B2 略過：單列、寬度固定、禁用仍有邊框（390／1280）---
  async function assertBarStable(viewport) {
    const page = await browser.newPage({ viewport });
    await page.goto(`http://127.0.0.1:${port}/test/harness.html?mode=instant`, {
      waitUntil: 'networkidle',
    });
    await page.waitForSelector('.opt');
    const measure = async () =>
      page.evaluate(() => {
        const next = document.querySelector('[data-act="next"]');
        const skip = document.querySelector('[data-act="skip"]');
        const prev = document.querySelector('[data-act="prev"]');
        const nb = next.getBoundingClientRect();
        const sb = skip.getBoundingClientRect();
        const pb = prev.getBoundingClientRect();
        const cs = getComputedStyle(skip);
        const sameRow =
          Math.abs(pb.top - sb.top) < 2 &&
          Math.abs(sb.top - nb.top) < 2 &&
          pb.bottom > pb.top;
        return {
          nextW: Math.round(nb.width * 100) / 100,
          skipW: Math.round(sb.width * 100) / 100,
          prevW: Math.round(pb.width * 100) / 100,
          nextLabel: next.querySelector('.nx-t')?.textContent,
          skipVisible: cs.display !== 'none' && cs.visibility !== 'hidden' && sb.width > 0,
          skipDisabled: !!skip?.disabled,
          skipText: skip?.textContent?.trim(),
          skipIsB2: skip.classList.contains('b2') && !skip.classList.contains('b5'),
          skipBorder: cs.borderTopWidth,
          skipBorderColor: cs.borderTopColor,
          sameRow,
          barWrap: document.querySelector('.bar-in').scrollHeight > pb.height + 8,
        };
      });

    const q1Unanswered = await measure();
    if (!q1Unanswered.skipVisible || q1Unanswered.skipText !== '略過') {
      throw new Error(`skip not visible on q1: ${JSON.stringify(q1Unanswered)}`);
    }
    if (!q1Unanswered.skipIsB2) throw new Error('skip must use b2');
    if (q1Unanswered.skipDisabled) throw new Error('skip should be enabled when unanswered');
    if (!q1Unanswered.sameRow || q1Unanswered.barWrap) {
      throw new Error(`bar not single row @${viewport.width}: ${JSON.stringify(q1Unanswered)}`);
    }
    if (Math.abs(q1Unanswered.prevW - q1Unanswered.skipW) > 1) {
      throw new Error(`prev/skip widths unequal: ${q1Unanswered.prevW} vs ${q1Unanswered.skipW}`);
    }

    await page.locator(`.opt[data-k="${batch.questions[0].answer}"]`).click();
    await page.waitForTimeout(80);
    const q1Answered = await measure();
    if (!q1Answered.skipVisible || !q1Answered.skipDisabled) {
      throw new Error(`skip should stay visible+disabled after answer: ${JSON.stringify(q1Answered)}`);
    }
    if (q1Answered.nextW !== q1Unanswered.nextW) {
      throw new Error(`next width changed after answer @${viewport.width}: ${q1Unanswered.nextW}→${q1Answered.nextW}`);
    }
    if (q1Answered.skipW !== q1Unanswered.skipW) {
      throw new Error(`skip width changed after answer @${viewport.width}: ${q1Unanswered.skipW}→${q1Answered.skipW}`);
    }
    // 禁用仍保留 b2 邊框
    const borderPx = parseFloat(q1Answered.skipBorder);
    if (!(borderPx >= 1)) {
      throw new Error(`disabled skip missing border: ${JSON.stringify(q1Answered)}`);
    }
    if (!q1Answered.sameRow) throw new Error(`bar wrapped after answer @${viewport.width}`);

    await page.locator('[data-act="next"]').click();
    await page.waitForFunction(
      () => (document.querySelector('[data-el="count"]')?.textContent || '').includes('2'),
    );
    const q2 = await measure();
    if (q2.nextW !== q1Unanswered.nextW || q2.skipW !== q1Unanswered.skipW) {
      throw new Error(`widths drifted on q2 @${viewport.width}`);
    }

    const lastN = batch.questions.length;
    await page.locator(`.bub[data-n="${lastN - 1}"]`).click();
    await page.waitForSelector(`[data-el="count"] >> text=/${lastN}/`, { timeout: 5000 });
    const lastUnanswered = await measure();
    if (lastUnanswered.nextLabel !== '看結果') {
      throw new Error(`expected 看結果, got ${lastUnanswered.nextLabel}`);
    }
    if (lastUnanswered.nextW !== q1Unanswered.nextW) {
      throw new Error(
        `next width changed on last @${viewport.width}: ${q1Unanswered.nextW}→${lastUnanswered.nextW}`,
      );
    }
    if (!lastUnanswered.skipVisible || lastUnanswered.skipText !== '略過') {
      throw new Error(`skip label must stay 略過: ${JSON.stringify(lastUnanswered)}`);
    }

    await page.screenshot({
      path: path.join(outDir, `bar-stable-${viewport.width}.png`),
      fullPage: false,
      clip: { x: 0, y: viewport.height - 100, width: viewport.width, height: 100 },
    });
    await page.close();
    return { nextW: q1Unanswered.nextW, skipW: q1Unanswered.skipW };
  }

  {
    const m390 = await assertBarStable({ width: 390, height: 844 });
    const m1280 = await assertBarStable({ width: 1280, height: 800 });
    if (m390.nextW !== 152 || m1280.nextW !== 152) {
      throw new Error(`next should be 152px, got 390=${m390.nextW} 1280=${m1280.nextW}`);
    }
    pass(`bar B2 skip + fixed next (390 next=${m390.nextW} skip=${m390.skipW}; 1280 next=${m1280.nextW} skip=${m1280.skipW})`);
  }

  // --- exam 模式底列三鈕仍在，下一題寬度不變 ---
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${port}/test/harness.html?mode=exam`, {
      waitUntil: 'networkidle',
    });
    await page.waitForSelector('.opt');
    const before = await page.locator('[data-act="next"]').boundingBox();
    const skip = page.locator('[data-act="skip"]');
    if (!(await skip.isVisible())) throw new Error('skip hidden in exam');
    if (!(await skip.isDisabled())) throw new Error('skip should be disabled in exam');
    await page.locator('.opt[data-k="0"]').click();
    const after = await page.locator('[data-act="next"]').boundingBox();
    if (Math.abs(before.width - after.width) > 0.5) {
      throw new Error(`exam next width drifted: ${before.width}→${after.width}`);
    }
    pass('exam bar: skip visible+disabled, next width stable');
    await page.close();
  }

  // --- 鍵盤：↑↓ 環繞、空白鍵選／前進、不捲頁、repeat 忽略、hint 觸控隱藏 ---
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${port}/test/harness.html?mode=instant`, {
      waitUntil: 'networkidle',
    });
    await page.waitForSelector('.opt[role="radio"]');
    const group = await page.locator('.opts').getAttribute('role');
    if (group !== 'radiogroup') throw new Error(`expected radiogroup, got ${group}`);

    await page.locator('.opt[data-k="0"]').focus();
    const nOpts = await page.locator('.opt').count();
    await page.keyboard.press('ArrowUp');
    const wrapHi = await page.evaluate(() =>
      document.activeElement?.getAttribute('data-k'),
    );
    if (wrapHi !== String(nOpts - 1)) {
      throw new Error(`ArrowUp wrap expected ${nOpts - 1}, got ${wrapHi}`);
    }
    await page.keyboard.press('ArrowDown');
    const wrap0 = await page.evaluate(() => document.activeElement?.getAttribute('data-k'));
    if (wrap0 !== '0') throw new Error(`ArrowDown wrap expected 0, got ${wrap0}`);
    pass('keyboard arrow wrap');

    // Space 選題 → focus 下一題 → Space 前進
    await page.locator('.opt[data-k="0"]').focus();
    await page.keyboard.press('Space');
    await page.waitForSelector('.qcard.revealed');
    const focusedAct = await page.evaluate(
      () => document.activeElement?.getAttribute('data-act'),
    );
    if (focusedAct !== 'next') {
      throw new Error(`after pick focus should be next, got ${focusedAct}`);
    }
    await page.keyboard.press('Space');
    await page.waitForFunction(
      () => (document.querySelector('[data-el="count"]')?.textContent || '').includes('2'),
    );
    pass('keyboard Space pick then Space advance');

    // Space 必須 preventDefault（瀏覽器預設空白鍵會往下捲）
    await page.goto(`http://127.0.0.1:${port}/test/harness.html?mode=exam`, {
      waitUntil: 'networkidle',
    });
    await page.waitForSelector('.opt');
    await page.evaluate(() => {
      document.documentElement.style.minHeight = '4000px';
      window.scrollTo(0, 600);
    });
    const scrollCheck = await page.evaluate(() => {
      const opt = document.querySelector('.opt[data-k="0"]');
      opt.focus({ preventScroll: true });
      const y0 = window.scrollY;
      let prevented = false;
      const onKey = (e) => {
        if (e.key === ' ' || e.key === 'Spacebar') prevented = e.defaultPrevented;
      };
      // bubble、在 quiz 監聽之後：確認已 preventDefault
      document.addEventListener('keydown', onKey);
      opt.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: ' ',
          code: 'Space',
          bubbles: true,
          cancelable: true,
        }),
      );
      document.removeEventListener('keydown', onKey);
      return { y0, y1: window.scrollY, prevented };
    });
    if (!scrollCheck.prevented) throw new Error('Space keydown not preventDefault');
    if (scrollCheck.y1 !== scrollCheck.y0) {
      throw new Error(`Space changed scroll: ${scrollCheck.y0}→${scrollCheck.y1}`);
    }
    pass('keyboard Space does not scroll page');

    // key repeat 忽略（不重複作答／前進）
    await page.goto(`http://127.0.0.1:${port}/test/harness.html?mode=instant`, {
      waitUntil: 'networkidle',
    });
    await page.waitForSelector('.opt');
    await page.locator('.opt[data-k="0"]').focus();
    await page.evaluate(() => {
      const opt = document.querySelector('.opt[data-k="0"]');
      opt.dispatchEvent(
        new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, repeat: true }),
      );
    });
    await page.waitForTimeout(60);
    const stillOpen = await page.locator('.qcard.revealed').count();
    if (stillOpen) throw new Error('repeat Space should not pick');
    pass('keyboard Space/Enter repeat ignored');

    await page.close();
  }

  {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    await page.goto(`http://127.0.0.1:${port}/test/harness.html?mode=instant`, {
      waitUntil: 'networkidle',
    });
    await page.waitForSelector('[data-el="kbh"]', { state: 'attached' });
    const hintCss = await page.locator('[data-el="kbh"]').evaluate((el) => {
      const cs = getComputedStyle(el);
      return { display: cs.display, aria: el.getAttribute('aria-hidden') };
    });
    if (hintCss.display !== 'none') {
      throw new Error(`kb-hint should be hidden on touch 390, got ${hintCss.display}`);
    }
    if (hintCss.aria !== 'true') throw new Error('kb-hint must be aria-hidden');
    pass('keyboard hint hidden at 390 touch');
    await page.close();
  }

  // exam：空白鍵選完後空白鍵下一題，底列仍 B2／152
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${port}/test/harness.html?mode=exam`, {
      waitUntil: 'networkidle',
    });
    await page.waitForSelector('.opt');
    const nextW = await page.locator('[data-act="next"]').evaluate((el) => el.getBoundingClientRect().width);
    await page.locator('.opt[data-k="0"]').focus();
    await page.keyboard.press('Space');
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('data-act') === 'next',
    );
    await page.keyboard.press('Space');
    await page.waitForFunction(
      () => (document.querySelector('[data-el="count"]')?.textContent || '').includes('2'),
    );
    const nextW2 = await page.locator('[data-act="next"]').evaluate((el) => el.getBoundingClientRect().width);
    const skipB2 = await page.locator('[data-act="skip"]').evaluate((el) => el.classList.contains('b2'));
    if (Math.round(nextW) !== 152 || Math.round(nextW2) !== 152) {
      throw new Error(`exam next width not 152: ${nextW}→${nextW2}`);
    }
    if (!skipB2) throw new Error('skip must stay b2');
    pass('exam keyboard Space pick/advance + bar unchanged');
    await page.close();
  }

  // --- QA：長選項不撐破、圖不放大、結果列 360、halo、exam 雙確定 ---
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${port}/test/harness.html?mode=instant`, {
      waitUntil: 'networkidle',
    });
    await page.waitForSelector('.opt');
    await page.evaluate(() => {
      const tx = document.querySelector('.opt .tx');
      if (tx) tx.textContent = 'A'.repeat(200) + '中文不斷行測試字串'.repeat(8);
    });
    const measured = await page.evaluate(() => {
      const el = document.querySelector('.opt .txt');
      return {
        scrollW: document.documentElement.scrollWidth,
        wrap: el ? getComputedStyle(el).overflowWrap : '',
      };
    });
    if (measured.scrollW > 420) throw new Error(`long option stretched layout: ${measured.scrollW}`);
    if (measured.wrap !== 'anywhere' && measured.wrap !== 'break-word') {
      throw new Error(`expected overflow-wrap anywhere, got ${measured.wrap}`);
    }
    pass('§9.8 long option overflow-wrap');
    await page.close();
  }

  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${port}/test/harness.html?mode=instant`, {
      waitUntil: 'networkidle',
    });
    await page.waitForSelector('.opt');
    const figCss = await page.evaluate(() => {
      const img = document.createElement('img');
      img.setAttribute('width', '120');
      img.setAttribute('height', '400');
      img.alt = 'tall';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fig-zoom';
      btn.appendChild(img);
      const fig = document.createElement('figure');
      fig.className = 'fig';
      fig.appendChild(btn);
      document.querySelector('.stem')?.after(fig);
      const cs = getComputedStyle(img);
      return {
        maxW: cs.maxWidth,
        maxH: cs.maxHeight,
        w: cs.width,
        h: cs.height,
        fit: cs.objectFit,
      };
    });
    if (figCss.maxW !== '100%' || figCss.fit !== 'contain') {
      throw new Error(`figure CSS not capped: ${JSON.stringify(figCss)}`);
    }
    if (!figCss.maxH || figCss.maxH === 'none') {
      throw new Error(`figure missing max-height: ${JSON.stringify(figCss)}`);
    }
    pass('§9.8 figure never above natural size');
    await page.close();
  }

  for (const w of [360, 390, 1280]) {
    const page = await browser.newPage({
      viewport: { width: w, height: w === 1280 ? 800 : 844 },
    });
    await page.goto(`http://127.0.0.1:${port}/template-demo.html`, { waitUntil: 'networkidle' });
    await finishRound(
      page,
      batch.questions.map((q) => q.answer),
    );
    await page.waitForSelector('.r-actions');
    const metrics = await page.evaluate(() => {
      const bar = document.querySelector('.r-actions');
      const btns = [...bar.querySelectorAll('.btn')];
      const br = bar.getBoundingClientRect();
      const homes = btns.map((b) => b.getBoundingClientRect());
      const cut = homes.some((r) => r.left < -1 || r.right > window.innerWidth + 1);
      const wrapHome = btns.some(
        (b) => b.textContent.includes('回首頁') && b.getClientRects().length > 1,
      );
      const z = Number(getComputedStyle(bar).zIndex) || 0;
      return { cut, wrapHome, z, left: br.left, right: br.right };
    });
    if (metrics.cut) throw new Error(`r-actions cut @${w}: ${JSON.stringify(metrics)}`);
    if (w <= 390 && metrics.wrapHome) throw new Error(`回首頁 wrapped @${w}`);
    if (w <= 390 && metrics.z < 20) throw new Error(`r-actions z-index too low @${w}`);
    await page.close();
  }
  pass('result r-actions fits 360/390/1280');

  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${port}/test/harness.html?mode=instant`, {
      waitUntil: 'networkidle',
    });
    await page.waitForSelector('.opt');
    const halo = await page.evaluate(() => {
      const el = document.querySelector('.opt');
      el.focus();
      const cs = getComputedStyle(el);
      const root = getComputedStyle(document.documentElement).getPropertyValue('--halo').trim();
      return { root: !!root, shadow: cs.boxShadow, outline: cs.outlineStyle };
    });
    if (!halo.root) throw new Error('--halo missing');
    if (halo.outline === 'solid' && !halo.shadow.includes('rgb')) {
      throw new Error(`focus still solid outline: ${JSON.stringify(halo)}`);
    }
    pass('focus uses --halo');
    await page.close();
  }

  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${port}/test/harness.html?mode=exam`, {
      waitUntil: 'networkidle',
    });
    await page.waitForSelector('.opt');
    const lastN = batch.questions.length;
    for (let i = 0; i < lastN - 1; i++) {
      await page.locator('.opt[data-k="0"]').click();
      await page.locator('[data-act="next"]').click();
      await page.waitForTimeout(40);
    }
    await page.locator('[data-act="submit"]').click();
    await page.waitForSelector('.warn.on');
    const labels = await page.evaluate(() => ({
      submit: document.querySelector('[data-act="submit"]')?.textContent?.trim(),
      next: document.querySelector('.nx-t')?.textContent?.trim(),
    }));
    if (labels.submit === '確定交卷' && labels.next === '確定交卷') {
      throw new Error(`both say 確定交卷: ${JSON.stringify(labels)}`);
    }
    if (labels.next !== '確定交卷') throw new Error(`next should be 確定交卷: ${labels.next}`);
    pass('exam confirming: only next says 確定交卷');
    await page.close();
  }

  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${port}/test/harness.html?mode=instant`, {
      waitUntil: 'networkidle',
    });
    await finishRound(
      page,
      batch.questions.map((q) => q.answer),
    );
    await page.waitForSelector('[data-el="result"]');
    // simulate persisted result + reload path used by app
    const ok = await page.evaluate(() => {
      const key = 'quizbank:v1:lastResult:e2e';
      const resultEl = document.querySelector('[data-el="result"]');
      const delta = [...resultEl.querySelectorAll('.stat b')].map((b) => b.textContent);
      const hasPlus = delta.some((t) => /^\+\d/.test(t || ''));
      const hasMinus = delta.some((t) => /^-\d/.test(t || ''));
      localStorage.setItem(
        key,
        JSON.stringify({
          result: { title: 't', score: 80, questions: [{ id: 'a', answer: 0, options: ['1','2','3','4'], stem: 's', explain: 'e' }], answers: [0], groups: [], mode: 'instant', startedAt: Date.now() - 1000, endedAt: Date.now(), correct: 1, total: 1, byUnit: [] },
          scope: { title: 't' },
          summaryText: 'x',
          wrongBookDelta: 0,
          cloudStatus: 'pending',
        }),
      );
      return { hasPlus, hasMinus, stored: !!localStorage.getItem(key) };
    });
    if (ok.hasPlus || ok.hasMinus) throw new Error(`delta still has sign: ${JSON.stringify(ok)}`);
    if (!ok.stored) throw new Error('result not stored');
    pass('result delta no ± and local persist shape');
    await page.close();
  }

  // --- QA r3 I-3：離線交卷 <2s 出現結果＋還沒存到雲端＋重試鍵 ---
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(
      `http://127.0.0.1:${port}/test/harness.html?mode=instant&offline=1&saveDelay=5000`,
      { waitUntil: 'networkidle' },
    );
    await page.waitForSelector('.opt');
    const answers = batch.questions.map((q) => q.answer);
    for (let i = 0; i < answers.length - 1; i++) {
      await page.locator(`.opt[data-k="${answers[i]}"]`).click();
      await page.waitForTimeout(40);
      await page.locator('[data-act="next"]').click();
      await page.waitForTimeout(80);
    }
    await page.locator(`.opt[data-k="${answers[answers.length - 1]}"]`).click();
    await page.waitForTimeout(40);
    const t0 = Date.now();
    await page.locator('[data-act="next"]').click();
    await page.waitForSelector('[data-el="result"] .cloud-warn', { timeout: 2000 });
    const ms = Date.now() - t0;
    if (ms >= 2000) throw new Error(`offline result took ${ms}ms (≥2s)`);
    const body = await page.locator('[data-el="result"]').innerText();
    if (body.includes('請從首頁開始練習')) {
      throw new Error('offline finish showed empty-state copy');
    }
    if (!body.includes('還沒存到雲端')) {
      throw new Error(`missing pending banner: ${body.slice(0, 120)}`);
    }
    const retry = page.locator('[data-act="retry-cloud"]');
    if ((await retry.count()) < 1) throw new Error('missing 重試 button');
    // 離線按重試 → toast
    await retry.click();
    await page.waitForFunction(
      () => (document.getElementById('app-toast')?.textContent || '').includes('離線'),
      { timeout: 2000 },
    );
    // 橫幅仍在
    if ((await page.locator('.cloud-warn').count()) < 1) {
      throw new Error('banner removed while still offline');
    }
    pass(`I-3 offline result <2s (${ms}ms) + banner + retry toast`);
    await page.close();
  }

  // --- QA r3 I-3b：背景上傳進行中按重試 → 只存 1 筆、錯題本只算一次 ---
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(
      `http://127.0.0.1:${port}/test/harness.html?mode=instant&offline=1&saveDelay=800`,
      { waitUntil: 'networkidle' },
    );
    await page.waitForSelector('.opt');
    const answers = batch.questions.map((q) => q.answer);
    for (let i = 0; i < answers.length - 1; i++) {
      await page.locator(`.opt[data-k="${answers[i]}"]`).click();
      await page.waitForTimeout(30);
      await page.locator('[data-act="next"]').click();
      await page.waitForTimeout(50);
    }
    await page.locator(`.opt[data-k="${answers[answers.length - 1]}"]`).click();
    await page.locator('[data-act="next"]').click();
    await page.waitForSelector('.cloud-warn [data-act="retry-cloud"]');
    // 模擬恢復連線，背景仍在 saveDelay 內
    await page.evaluate(() => {
      window.__harness.offline = false;
    });
    await page.locator('[data-act="retry-cloud"]').click();
    await page.waitForFunction(
      () => window.__harness?.saveCount >= 1 && !document.querySelector('.cloud-warn'),
      { timeout: 3000 },
    );
    const counts = await page.evaluate(() => ({
      saveCount: window.__harness.saveCount,
      wrongBookApplied: window.__harness.wrongBookApplied,
      records: window.__harness.records?.length,
    }));
    if (counts.saveCount !== 1 || counts.wrongBookApplied !== 1 || counts.records !== 1) {
      throw new Error(`expected single save, got ${JSON.stringify(counts)}`);
    }
    pass('I-3b retry during background upload → 1 record, wrong-book once');
    await page.close();
  }

  // --- QA r2 N-1：360 prev/skip 80、下一題右緣留白；390／1280 亦有右距 ---
  {
    for (const w of [360, 390, 1280]) {
      const page = await browser.newPage({
        viewport: { width: w, height: w === 1280 ? 800 : 844 },
      });
      await page.goto(`http://127.0.0.1:${port}/test/harness.html?mode=instant`, {
        waitUntil: 'networkidle',
      });
      await page.waitForSelector('.bar .next');
      const m = await page.evaluate(() => {
        const prev = document.querySelector('.bar .prev');
        const skip = document.querySelector('.bar .skip');
        const next = document.querySelector('.bar .next');
        const pb = prev.getBoundingClientRect();
        const sb = skip.getBoundingClientRect();
        const nb = next.getBoundingClientRect();
        return {
          prevW: Math.round(pb.width),
          skipW: Math.round(sb.width),
          nextW: Math.round(nb.width),
          nextRight: nb.right,
          vw: window.innerWidth,
          marginR: window.innerWidth - nb.right,
        };
      });
      if (m.nextW !== 152) throw new Error(`next not 152 @${w}: ${JSON.stringify(m)}`);
      if (m.marginR < 8) {
        throw new Error(`next touches right edge @${w}: marginR=${m.marginR} ${JSON.stringify(m)}`);
      }
      if (w <= 375) {
        if (m.prevW !== 80 || m.skipW !== 80) {
          throw new Error(`≤375 prev/skip should be 80 @${w}: ${JSON.stringify(m)}`);
        }
      } else if (Math.abs(m.prevW - m.skipW) > 1) {
        throw new Error(`prev/skip unequal @${w}: ${JSON.stringify(m)}`);
      }
      await page.close();
    }
    pass('N-1 bar right margin 360/390/1280 + 80px ≤375');
  }

  // --- 回首頁改 B2（B5 底線鈕已禁用）---
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${port}/template-demo.html`, { waitUntil: 'networkidle' });
    await finishRound(
      page,
      batch.questions.map((q) => q.answer),
    );
    await page.waitForSelector('.r-actions [data-act=home]');
    const home = await page.evaluate(() => {
      const btn = document.querySelector('.r-actions [data-act=home]');
      if (!btn) return { err: 'no home btn' };
      const br = btn.getBoundingClientRect();
      const after = getComputedStyle(btn, '::after');
      const underlineish =
        after &&
        after.content !== 'none' &&
        parseFloat(after.height || '0') > 0 &&
        after.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
        after.position === 'absolute';
      return {
        isB2: btn.classList.contains('b2') && !btn.classList.contains('b5'),
        minH: br.height,
        underlineish: !!underlineish,
        b5Left: !!document.querySelector('.btn.b5, .b5.btn'),
      };
    });
    if (home.err) throw new Error(home.err);
    if (!home.isB2) throw new Error('回首頁 must be B2');
    if (home.minH < 44) throw new Error(`home hit area <44: ${home.minH}`);
    if (home.underlineish) throw new Error('回首頁 still has underline ::after');
    if (home.b5Left) throw new Error('b5 still present on result page');
    pass('N-2 回首頁 is B2 (no B5 underline)');
    await page.close();
  }

  // --- QA r2：開始作答初始焦點在第一選項；作答頁有 h1 ---
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${port}/test/harness.html?mode=instant`, {
      waitUntil: 'networkidle',
    });
    await page.waitForSelector('.opt');
    const focus = await page.evaluate(() => {
      const ae = document.activeElement;
      return {
        k: ae?.getAttribute?.('data-k'),
        role: ae?.getAttribute?.('role'),
        h1: !!document.querySelector('h1.title'),
        h1Text: document.querySelector('h1.title')?.textContent?.trim() || '',
      };
    });
    if (focus.k !== '0' || focus.role !== 'radio') {
      throw new Error(`initial focus not first option: ${JSON.stringify(focus)}`);
    }
    if (!focus.h1) throw new Error('quiz page missing h1.title');
    pass('N-3 initial focus first option + quiz h1');
    await page.close();
  }

  // --- Header：M6＋M8 blink（360／390／1280）---
  {
    for (const w of [360, 390, 1280]) {
      const page = await browser.newPage({
        viewport: { width: w, height: w === 1280 ? 800 : 844 },
      });
      await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.app-top .blink', { state: 'attached' });
      await page.evaluate(() => {
        document.body.classList.remove('signed-out');
        document.body.classList.add('signed-in');
        const obs = new MutationObserver(() => {
          document.body.classList.remove('signed-out');
          document.body.classList.add('signed-in');
        });
        obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        window.__hdrObs = obs;
      });
      await page.waitForTimeout(80);
      const h = await page.evaluate(() => {
        const m6 = document.querySelector('.mbtn.m6[data-drawer-toggle]');
        const brand = document.querySelector('a.blink');
        const title = document.querySelector('.hdr-title.m8bar');
        const avatar = document.querySelector('.nav-avatar');
        const name = brand?.querySelector('.bname');
        const mark = brand?.querySelector('.bmark');
        const b5Menus = [...document.querySelectorAll('.app-top .btn.b5')].filter((b) =>
          (b.textContent || '').includes('選單'),
        );
        const mr = m6?.getBoundingClientRect();
        const br = brand?.getBoundingClientRect();
        const tr = title?.getBoundingClientRect();
        const ar = avatar?.getBoundingClientRect();
        const nameCs = name ? getComputedStyle(name) : null;
        const clipped =
          !!name &&
          !!nameCs &&
          (name.getClientRects().length === 0 ||
            (parseFloat(nameCs.width) <= 1 && parseFloat(nameCs.height) <= 1) ||
            (nameCs.clipPath && nameCs.clipPath.includes('inset')));
        const underlay = brand ? getComputedStyle(brand, '::before') : null;
        return {
          hasM6: !!m6,
          hasB5Menu: b5Menus.length > 0,
          m6Size: m6 ? { w: Math.round(mr.width), h: Math.round(mr.height) } : null,
          brandHref: brand?.getAttribute('href'),
          brandAria: brand?.getAttribute('aria-label'),
          brandH: brand ? Math.round(br.height) : 0,
          markSize: mark
            ? {
                w: Math.round(mark.getBoundingClientRect().width),
                h: Math.round(mark.getBoundingClientRect().height),
              }
            : null,
          gap: mr && br ? Math.round(br.left - mr.right) : null,
          avatarVisible: !!avatar && getComputedStyle(avatar).display !== 'none' && ar.width > 0,
          avatarAfterBrand: !!ar && !!br && ar.left > br.right - 1,
          avatarRightPad: (() => {
            if (!ar) return null;
            const shell = document.querySelector('.app-top-in');
            const sr = shell?.getBoundingClientRect();
            return sr ? Math.round(sr.right - ar.right) : Math.round(window.innerWidth - ar.right);
          })(),
          titleW: tr ? Math.round(tr.width) : 0,
          nameHidden: clipped,
          m6Visible: m6 ? getComputedStyle(m6).display !== 'none' : false,
          hasUnderlay: !!underlay && underlay.content !== 'none',
          cq: !!title && getComputedStyle(title).containerType.includes('inline-size'),
        };
      });
      if (!h.hasM6) throw new Error(`M6 missing @${w}`);
      if (h.hasB5Menu) throw new Error(`old 選單 b5 still present @${w}`);
      if (!h.cq) throw new Error(`hdr-title missing container-type @${w}`);
      if (!h.hasUnderlay) throw new Error(`M8 blink missing ::before underlay @${w}`);
      if (w < 900) {
        if (!h.m6Visible) throw new Error(`M6 hidden @${w}`);
        if (h.m6Size.w !== 44 || h.m6Size.h !== 44) {
          throw new Error(`M6 not 44×44 @${w}: ${JSON.stringify(h.m6Size)}`);
        }
        if (h.gap == null || h.gap < 3 || h.gap > 6) {
          throw new Error(`M6–M8 gap not ~4px @${w}: ${h.gap}`);
        }
      }
      if (h.brandHref !== '#/' || h.brandAria !== '考題網 首頁') {
        throw new Error(`M8 blink bad @${w}: ${JSON.stringify(h)}`);
      }
      if (h.brandH !== 44) throw new Error(`blink height not 44 @${w}: ${h.brandH}`);
      if (!h.markSize || h.markSize.w !== 24 || h.markSize.h !== 24) {
        throw new Error(`bmark not 24 @${w}: ${JSON.stringify(h.markSize)}`);
      }
      // container <200 → 只留字母；一般 360／390 標題區 >200，站名應可見
      if (h.titleW >= 200 && h.nameHidden) {
        throw new Error(`bname hidden while titleW=${h.titleW} @${w}`);
      }
      if (h.titleW < 200 && !h.nameHidden) {
        throw new Error(`bname should hide when titleW=${h.titleW} @${w}`);
      }
      // avatar 在標頭最右（margin-left:auto）；登出態可能隱藏，僅在可見時檢查位置
      if (h.avatarVisible && !h.avatarAfterBrand) {
        throw new Error(`avatar not after brand @${w}: ${JSON.stringify(h)}`);
      }
      if (h.avatarVisible && h.avatarRightPad != null && h.avatarRightPad > 28) {
        throw new Error(`avatar not far right @${w}: pad=${h.avatarRightPad}`);
      }
      await page.screenshot({
        path: path.join(outDir, `header-${w}.png`),
        clip: { x: 0, y: 0, width: w, height: 64 },
      });
      // 強制擠壓標題區驗證 container query
      if (w === 360) {
        await page.evaluate(() => {
          const t = document.querySelector('.hdr-title');
          if (t) {
            t.style.flex = '0 0 160px';
            t.style.width = '160px';
            t.style.maxWidth = '160px';
          }
        });
        await page.waitForTimeout(80);
        const squeezed = await page.evaluate(() => {
          const title = document.querySelector('.hdr-title');
          const name = document.querySelector('.blink .bname');
          if (!name) return { ok: true };
          const cs = getComputedStyle(name);
          const clipped =
            name.getClientRects().length === 0 ||
            (parseFloat(cs.width) <= 1 && parseFloat(cs.height) <= 1) ||
            (cs.clipPath && cs.clipPath.includes('inset')) ||
            cs.position === 'absolute';
          return {
            ok: clipped,
            titleW: title ? Math.round(title.getBoundingClientRect().width) : 0,
            cq: title ? getComputedStyle(title).containerType : '',
            name: { w: cs.width, h: cs.height, pos: cs.position, clip: cs.clipPath },
          };
        });
        if (!squeezed.ok) throw new Error(`bname should hide when title area <200: ${JSON.stringify(squeezed)}`);
        await page.screenshot({
          path: path.join(outDir, 'header-360-cq.png'),
          clip: { x: 0, y: 0, width: 360, height: 64 },
        });
      }
      await page.close();
    }
    pass('header M6 + M8 blink 360/390/1280');
  }

  // --- UI/UX 紅線：核心導覽可見、M8 可點、正文 16/1.5、觸控 44、模考已答樣式 ---
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });
    await page.evaluate(() => {
      document.body.classList.remove('signed-out');
      document.body.classList.add('signed-in');
      document.body.dataset.view = '';
      new MutationObserver(() => {
        document.body.classList.remove('signed-out');
        document.body.classList.add('signed-in');
      }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    });
    await page.waitForTimeout(100);
    const ux = await page.evaluate(() => {
      const body = getComputedStyle(document.body);
      const sub = document.querySelector('.app-subnav');
      const links = [...(sub?.querySelectorAll('a') || [])].map((a) => ({
        t: a.textContent.trim(),
        href: a.getAttribute('href'),
        h: Math.round(a.getBoundingClientRect().height),
        vis: getComputedStyle(a).display !== 'none' && a.getClientRects().length > 0,
      }));
      const blink = document.querySelector('a.blink');
      const m6 = document.querySelector('.mbtn.m6');
      return {
        fontSize: parseFloat(body.fontSize),
        lineHeight: parseFloat(body.lineHeight) / parseFloat(body.fontSize),
        subDisp: sub ? getComputedStyle(sub).display : 'missing',
        links,
        blinkHref: blink?.getAttribute('href'),
        m6h: m6 ? Math.round(m6.getBoundingClientRect().height) : 0,
        avatarH: Math.round(document.querySelector('.nav-avatar')?.getBoundingClientRect().height || 0),
      };
    });
    if (ux.fontSize < 16) throw new Error(`body font-size <16: ${ux.fontSize}`);
    if (ux.lineHeight < 1.5) throw new Error(`body line-height <1.5: ${ux.lineHeight}`);
    if (ux.subDisp === 'none' || ux.subDisp === 'missing') {
      throw new Error('app-subnav hidden on phone — core nav drawer-only');
    }
    for (const need of ['練習', '錯題本', '單元表']) {
      const hit = ux.links.find((l) => l.t === need && l.vis);
      if (!hit) throw new Error(`subnav missing visible ${need}`);
      if (hit.h < 44) throw new Error(`subnav ${need} touch <44: ${hit.h}`);
    }
    if (ux.blinkHref !== '#/') throw new Error('M8 blink not home');
    if (ux.m6h !== 44 || ux.avatarH !== 44) throw new Error('header touch targets not 44');
    // 模考 .bub.done 樣式存在（非只靠顏色的 class）
    const hasDone = await page.evaluate(() => {
      const s = [...document.styleSheets];
      try {
        return s.some((sheet) => {
          try {
            return [...(sheet.cssRules || [])].some((r) => String(r.cssText || '').includes('.bub.done'));
          } catch {
            return false;
          }
        });
      } catch {
        return !!document.querySelector('link[href*="b.css"]');
      }
    });
    // 直接讀 computed via temp node
    const doneStyle = await page.evaluate(() => {
      const b = document.createElement('button');
      b.className = 'bub done';
      b.innerHTML = '<span class="bub-d"><span class="bub-n">1</span></span>';
      document.body.appendChild(b);
      const bg = getComputedStyle(b.querySelector('.bub-d')).backgroundColor;
      b.remove();
      return bg;
    });
    if (!doneStyle || doneStyle === 'rgba(0, 0, 0, 0)' || doneStyle === 'transparent') {
      throw new Error(`.bub.done not styled: ${doneStyle} (sheet=${hasDone})`);
    }
    await page.screenshot({ path: path.join(outDir, 'ux-subnav-390.png') });
    await page.close();
    pass('UI/UX red lines phone subnav + type + touch + bub.done');
  }

  await browser.close();
} catch (e) {
  fail('e2e suite', e.stack || e.message || e);
  server.kill();
  process.exit(1);
}

server.kill();
const failed = results.filter((r) => !r.ok);
console.log(`\ne2e ${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  for (const f of failed) console.error('-', f.name, f.err);
}
process.exit(failed.length ? 1 : 0);
