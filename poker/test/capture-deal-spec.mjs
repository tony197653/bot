/**
 * Spec v1 evidence: deal recordings, frame sheet, hero flip, checklist.
 * Run: node test/capture-deal-spec.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  unlinkSync,
} from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ART = existsSync('/opt/cursor/artifacts')
  ? '/opt/cursor/artifacts'
  : join(ROOT, 'test-artifacts');
mkdirSync(ART, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

function startServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let path = decodeURIComponent(req.url.split('?')[0]);
      if (path === '/') path = '/index.html';
      const file = join(ROOT, path.replace(/^\//, ''));
      if (!file.startsWith(ROOT) || !existsSync(file)) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/` });
    });
  });
}

async function configureLobby(page, seatCount, timerOn = true) {
  await page.waitForSelector('#playerRows .p-row');
  const rows = page.locator('#playerRows .p-row');
  const nRows = await rows.count();
  for (let i = 0; i < nRows; i++) {
    const row = rows.nth(i);
    const input = row.locator('input');
    const disabled = await input.isDisabled();
    const wantOn = i < seatCount;
    if (wantOn === disabled) await row.locator('button[data-toggle]').click();
  }
  // Verify seat toggles stuck
  const enabled = await page.evaluate(
    () =>
      [...document.querySelectorAll('#playerRows .p-row input')].filter((el) => !el.disabled)
        .length,
  );
  if (enabled !== seatCount) {
    throw new Error(`lobby seat configure failed: want ${seatCount}, got ${enabled}`);
  }
  const t = page.locator('#timerToggle');
  if (timerOn) {
    if (!(await t.isChecked())) await t.check();
  } else if (await t.isChecked()) await t.uncheck();
}

async function sampleDeal(page, { label, maxMs = 4500 }) {
  const bursts = [];
  const checklist = {
    label,
    sawDeck: false,
    sawFlyingCard: false,
    sawOpaqueFlight: false,
    sawBlindStay: false,
    potBeforeBlind: false,
    actLocked: false,
    passAfterDeal: false,
    heroBacksNoFace: false,
    samples: 0,
  };
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const snap = await page.evaluate(() => {
      const dealing = document.documentElement.classList.contains('is-dealing');
      const deck = document.querySelector('.fx-deck');
      const cards = [...document.querySelectorAll('.fx-deal-card')];
      const chips = document.querySelectorAll('.fx-chip-fly').length;
      const betsVisible = [...document.querySelectorAll('#bets .bet:not(.is-pending)')].length;
      const potPending = document.querySelector('.pot')?.classList.contains('is-pending');
      const actLocked = document.getElementById('act')?.classList.contains('is-deal-locked');
      const passOn = !!document.querySelector('#passScreen.is-on');
      const heroFace = !!document.querySelector('#heroHole .card:not(.is-back):not(.is-flipping) .rk, #heroHole .card.hero:not(.is-back) .rk');
      const heroBack = document.querySelectorAll('#heroHole .card.is-back').length;
      const opaque = cards.every((c) => {
        const op = parseFloat(getComputedStyle(c).opacity);
        return op >= 0.99;
      });
      return {
        dealing,
        hasDeck: !!deck,
        fxCards: cards.length,
        fxChips: chips,
        betsVisible,
        potPending: !!potPending,
        actLocked: !!actLocked,
        passOn,
        heroFace,
        heroBack,
        opaque: cards.length ? opaque : null,
        t: performance.now(),
      };
    });
    if (snap.hasDeck) checklist.sawDeck = true;
    if (snap.fxCards > 0) {
      checklist.sawFlyingCard = true;
      if (snap.opaque) checklist.sawOpaqueFlight = true;
    }
    if (snap.betsVisible > 0 && snap.dealing) checklist.sawBlindStay = true;
    if (!snap.potPending && snap.betsVisible === 0 && snap.dealing && snap.fxCards === 0 && snap.t < 800) {
      checklist.potBeforeBlind = true;
    }
    if (snap.actLocked) checklist.actLocked = true;
    if (snap.passOn) {
      checklist.passAfterDeal = true;
      if (snap.heroBack >= 2 && !snap.heroFace) checklist.heroBacksNoFace = true;
    }
    if (snap.dealing || snap.fxCards || snap.fxChips) {
      const buf = await page.screenshot({ type: 'png' });
      bursts.push({ ...snap, buf });
      checklist.samples += 1;
    }
    if (snap.passOn && bursts.length >= 8) break;
    await page.waitForTimeout(80);
  }
  return { bursts, checklist };
}

async function recordDeal(browser, url, { seats, viewport, videoName, sheetName }) {
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: viewport.width <= 430 ? 2 : 1,
    recordVideo: { dir: ART, size: { width: viewport.width, height: viewport.height } },
  });
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForSelector('#lobbyScreen');
  await configureLobby(page, seats, true);
  await page.click('#btnStart');
  await page.waitForFunction(() => document.documentElement.classList.contains('is-dealing'), {
    timeout: 6000,
  });

  const { bursts, checklist } = await sampleDeal(page, { label: videoName });

  await page.waitForSelector('#passScreen.is-on', { timeout: 10000 });
  await page.waitForTimeout(400);

  // Pick ~6 spaced frames for sheet
  const picked = [];
  for (const b of bursts) {
    if (picked.length >= 6) break;
    if (picked.length && b.t - picked[picked.length - 1].t < 280) continue;
    if (b.fxCards > 0 || b.fxChips > 0 || b.hasDeck) picked.push(b);
  }
  while (picked.length < 6 && bursts.length) {
    const b = bursts[Math.min(picked.length * 2, bursts.length - 1)];
    if (!picked.includes(b)) picked.push(b);
    else break;
  }
  const tag = `${seats}p-${viewport.width}`;
  for (let i = 0; i < picked.length; i++) {
    writeFileSync(join(ART, `poker-deal-spec-frame-${tag}-${i + 1}.png`), picked[i].buf);
  }
  checklist.frameTag = tag;
  checklist.seatCount = await page.evaluate(() => {
    const s = window.__poker?.getState?.();
    return s ? s.seats.filter(Boolean).length : 0;
  });

  // Frame sheet (2x3) without canvas lib if unavailable
  try {
    await buildSheet(
      picked.map((p) => p.buf),
      join(ART, sheetName),
      viewport,
    );
  } catch (e) {
    console.warn('sheet skip', e.message);
    // fallback: just keep individual frames
  }

  const vpath = await page.video()?.path();
  await ctx.close();
  if (vpath && existsSync(vpath)) {
    const dest = join(ART, videoName);
    copyFileSync(vpath, dest);
    try {
      unlinkSync(vpath);
    } catch {
      /* ignore */
    }
  }
  return checklist;
}

async function buildSheet(bufs, outPath, viewport) {
  // Pure PNG stitch via playwright screenshots already saved — use simple HTML→screenshot if no canvas
  if (!bufs.length) return;
  // Try dynamic import of canvas; else write a simple vertical strip via playwright
  let useCanvas = false;
  try {
    await import('canvas');
    useCanvas = true;
  } catch {
    useCanvas = false;
  }
  if (!useCanvas) {
    // Write a meta list; individual frames are the sheet
    writeFileSync(
      outPath.replace(/\.png$/, '.json'),
      JSON.stringify({ frames: bufs.length, note: 'canvas not installed; see poker-deal-spec-frame-*.png' }),
    );
    // Still produce a sheet by concatenating with a headless page
    return;
  }
}

async function recordHeroFlip(browser, url) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    recordVideo: { dir: ART, size: { width: 390, height: 844 } },
  });
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForSelector('#lobbyScreen');
  await configureLobby(page, 4, true);
  await page.click('#btnStart');
  await page.waitForSelector('#passScreen.is-on', { timeout: 12000 });
  // Confirm → flip
  await page.click('#btnPassOk');
  await page.waitForTimeout(900);
  const meta = await page.evaluate(() => ({
    handUiReady: window.__poker?.handUiReady,
    actLocked: document.getElementById('act')?.classList.contains('is-deal-locked'),
    hasFaces: !!document.querySelector('#heroHole .card.hero .rk'),
    deadline: window.__poker?.getState()?.deadline,
    timerEnabled: window.__poker?.getState()?.config?.timerEnabled,
  }));
  const vpath = await page.video()?.path();
  await ctx.close();
  if (vpath && existsSync(vpath)) {
    copyFileSync(vpath, join(ART, 'poker-hero-flip-phone-390.webm'));
    try {
      unlinkSync(vpath);
    } catch {
      /* ignore */
    }
  }
  return meta;
}

async function stitchSheetWithPlaywright(browser, tag, outName, cellW, cellH) {
  const frames = [];
  for (let i = 1; i <= 6; i++) {
    const p = join(ART, `poker-deal-spec-frame-${tag}-${i}.png`);
    if (existsSync(p)) frames.push(p);
  }
  if (frames.length < 2) return;
  const cols = 3;
  const rows = Math.ceil(frames.length / cols);
  const ctx = await browser.newContext({
    viewport: { width: cellW * cols + 16, height: cellH * rows + 12 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  const imgs = frames
    .map(
      (f) =>
        `<img src="data:image/png;base64,${readFileSync(f).toString('base64')}" style="width:${cellW}px;height:${cellH}px;object-fit:cover">`,
    )
    .join('');
  await page.setContent(
    `<html><body style="margin:0;background:#111;display:grid;grid-template-columns:repeat(${cols},${cellW}px);gap:4px;padding:4px">${imgs}</body></html>`,
  );
  await page.screenshot({ path: join(ART, outName), fullPage: true });
  await ctx.close();
}

async function main() {
  const { server, url } = await startServer();
  const browser = await chromium.launch({ headless: true });
  const report = { url, checks: [], generatedAt: new Date().toISOString() };

  try {
    const c6 = await recordDeal(browser, url, {
      seats: 6,
      viewport: { width: 390, height: 844 },
      videoName: 'poker-deal-6p-phone-390.webm',
      sheetName: 'poker-deal-frame-sheet-6p-phone-390.png',
    });
    report.checks.push(c6);
    await stitchSheetWithPlaywright(browser, c6.frameTag, 'poker-deal-frame-sheet-6p-phone-390.png', 390, 844);

    const c4 = await recordDeal(browser, url, {
      seats: 4,
      viewport: { width: 390, height: 844 },
      videoName: 'poker-deal-4p-phone-390.webm',
      sheetName: 'poker-deal-frame-sheet-4p-phone-390.png',
    });
    report.checks.push(c4);
    await stitchSheetWithPlaywright(browser, c4.frameTag, 'poker-deal-frame-sheet-4p-phone-390.png', 390, 844);

    const cDesk = await recordDeal(browser, url, {
      seats: 6,
      viewport: { width: 1440, height: 900 },
      videoName: 'poker-deal-6p-desktop-1440.webm',
      sheetName: 'poker-deal-frame-sheet-6p-desktop-1440.png',
    });
    report.checks.push(cDesk);
    await stitchSheetWithPlaywright(
      browser,
      cDesk.frameTag,
      'poker-deal-frame-sheet-6p-desktop-1440.png',
      480,
      300,
    );

    const flip = await recordHeroFlip(browser, url);
    report.heroFlip = flip;

    // Acceptance checklist (spec §15)
    report.acceptance = {
      'cards fly from deck opaque along arc and stay': c6.sawDeck && c6.sawFlyingCard && c6.sawOpaqueFlight,
      'blinds stay on table; pot after BB': c6.sawBlindStay && !c6.potBeforeBlind,
      'act locked during deal': c6.actLocked,
      'pass after deal; hero backs no face in DOM': c6.passAfterDeal && c6.heroBacksNoFace,
      'after flip: faces + timer armed + act unlocked':
        !!flip.hasFaces && flip.handUiReady === true && flip.actLocked === false && flip.deadline != null,
    };
  } finally {
    await browser.close();
    server.close();
  }

  writeFileSync(join(ART, 'poker-deal-spec-checklist.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
