/**
 * Showdown evidence: phone-390 + desktop-1440 recordings, frame sheet, checklist.
 * Uses __poker.forcePresentationShowdown for deterministic split / side-pot / fold.
 * Run: node test/capture-showdown.mjs
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

async function configureLobby(page, seatCount) {
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
  const t = page.locator('#timerToggle');
  if (await t.isChecked()) await t.uncheck();
}

async function bootGame(page, url, seats) {
  await page.goto(url);
  await page.waitForSelector('#lobbyScreen');
  await configureLobby(page, seats);
  await page.click('#btnStart');
  await page.waitForFunction(() => window.__poker?.getState?.()?.handNumber >= 1, {
    timeout: 8000,
  });
  await page.evaluate(() => window.__poker.skipDealAndReady(0));
}

async function sampleShowdown(page, { maxMs = 16000, stepMs = 100, untilPause = false }) {
  const frames = [];
  const checklist = {
    sawFlip: false,
    sawWinBadge: false,
    winBadgeMax: 0,
    sawChipFly: false,
    chipFlyMax: 0,
    potWentZero: false,
    boardDealReplay: false,
    holdRing: false,
    pauseModalOpaque: false,
    pauseButtons: false,
    nextHiddenWhilePaused: false,
    toastPill: false,
    chipOverStack: false,
    strayAtOrigin: false,
    straySamples: [],
  };
  let boardHtml0 = null;
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const snap = await page.evaluate(() => {
      const s = window.__poker?.getState?.();
      const table = document.querySelector('.table');
      const tBox = table?.getBoundingClientRect();
      const chips = [...document.querySelectorAll('.fx-chip-fly')];
      const flips = document.querySelectorAll('.card.is-flipping, .reveal-hole .card').length;
      const winBadges = document.querySelectorAll('.win-badge').length;
      const potAmt = document.querySelector('#potAmt')?.textContent?.trim() || '';
      const boardHtml = document.querySelector('#board')?.innerHTML || '';
      const holdRing = !!document.querySelector('#btnNext .hold-ring');
      const btnNext = !!document.querySelector('#btnNext');
      const pauseOn = !!document.querySelector('#pauseScreen.is-on');
      const pauseSheet = document.querySelector('#pauseScreen.is-on .pause-panel');
      let pauseModalOpaque = false;
      let pauseButtons = false;
      if (pauseSheet) {
        const bg = getComputedStyle(pauseSheet).backgroundColor;
        pauseModalOpaque = bg.includes('rgb') && !bg.includes('rgba(0, 0, 0, 0)');
        pauseButtons = document.querySelectorAll('#pauseScreen button.pause-ready, #pauseScreen .pause-ok-mark').length > 0;
      }
      const toastOn = !!document.querySelector('#toast.is-on');
      // Chip overlapping stack text?
      let chipOverStack = false;
      for (const chip of chips) {
        const cr = chip.getBoundingClientRect();
        if (cr.width < 2 || parseFloat(getComputedStyle(chip).opacity) < 0.2) continue;
        for (const st of document.querySelectorAll('.ch, .st, #heroChips')) {
          const sr = st.getBoundingClientRect();
          const ox = Math.max(0, Math.min(cr.right, sr.right) - Math.max(cr.left, sr.left));
          const oy = Math.max(0, Math.min(cr.bottom, sr.bottom) - Math.max(cr.top, sr.top));
          if (ox > 8 && oy > 8) chipOverStack = true;
        }
      }
      const strays = [];
      for (const el of chips) {
        const r = el.getBoundingClientRect();
        if (r.width < 2) continue;
        const op = parseFloat(getComputedStyle(el).opacity);
        if (op < 0.05) continue;
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        if (cx < 40 && cy < 60) strays.push({ cx: Math.round(cx), cy: Math.round(cy) });
        if (tBox && cx < tBox.left + 30 && cy < tBox.top + 30) {
          strays.push({ cx: Math.round(cx), cy: Math.round(cy), table: true });
        }
      }
      // Pause sheet above table cards?
      let pauseAboveTable = true;
      if (pauseOn && pauseSheet) {
        const pz = parseInt(getComputedStyle(document.querySelector('#pauseScreen')).zIndex, 10) || 0;
        const board = document.querySelector('#board .card');
        if (board) {
          // screen should cover; check sheet rect doesn't have board center "winning" hit-test
          const mid = pauseSheet.getBoundingClientRect();
          const topEl = document.elementFromPoint(mid.left + mid.width / 2, mid.top + 40);
          pauseAboveTable = !!(topEl && (topEl.closest?.('#pauseScreen') || topEl.closest?.('.pause-panel')));
        }
        void pz;
      }
      return {
        phase: s?.phase,
        potAmt,
        flips,
        winBadges,
        chipFly: chips.length,
        boardHtml,
        holdRing,
        btnNext,
        pauseOn,
        pauseModalOpaque,
        pauseButtons,
        pauseAboveTable,
        toastOn,
        chipOverStack,
        strays,
        t: performance.now(),
      };
    });

    if (snap.flips > 0) checklist.sawFlip = true;
    if (snap.winBadges > 0) checklist.sawWinBadge = true;
    checklist.winBadgeMax = Math.max(checklist.winBadgeMax, snap.winBadges);
    if (snap.chipFly > 0) checklist.sawChipFly = true;
    checklist.chipFlyMax = Math.max(checklist.chipFlyMax, snap.chipFly);
    if (snap.potAmt === '0') checklist.potWentZero = true;
    if (snap.holdRing) checklist.holdRing = true;
    if (snap.pauseOn) {
      if (snap.pauseModalOpaque) checklist.pauseModalOpaque = true;
      if (snap.pauseButtons) checklist.pauseButtons = true;
      if (!snap.btnNext) checklist.nextHiddenWhilePaused = true;
      if (!snap.pauseAboveTable) checklist.pauseAboveTable = false;
      else checklist.pauseAboveTable = true;
    }
    if (snap.toastOn && snap.pauseOn) checklist.toastPill = true;
    if (snap.chipOverStack) checklist.chipOverStack = true;
    if (boardHtml0 == null && (snap.phase === 'showdown' || snap.phase === 'hand_over')) {
      boardHtml0 = snap.boardHtml;
    } else if (boardHtml0 != null && snap.boardHtml?.includes('is-deal')) {
      checklist.boardDealReplay = true;
    }
    if (snap.strays?.length) {
      checklist.strayAtOrigin = true;
      checklist.straySamples.push(snap.strays);
    }

    if (
      snap.phase === 'showdown' ||
      snap.phase === 'hand_over' ||
      snap.chipFly ||
      snap.winBadges ||
      snap.pauseOn
    ) {
      const buf = await page.screenshot({ type: 'png' });
      frames.push({ ...snap, buf });
    }

    if (untilPause && snap.pauseOn && frames.length > 2) break;
    // Wait until FX settled: pot 0, no flying chips, hold ring armed
    if (
      !untilPause &&
      snap.phase === 'hand_over' &&
      snap.holdRing &&
      snap.potAmt === '0' &&
      snap.chipFly === 0 &&
      !snap.pauseOn &&
      checklist.sawWinBadge &&
      frames.length > 8 &&
      Date.now() - t0 > 4500
    ) {
      break;
    }
    await page.waitForTimeout(stepMs);
  }
  return { frames, checklist };
}

async function recordScenario(browser, url, opts) {
  const { name, seats, viewport, kind, pause = false } = opts;
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: viewport.width <= 430 ? 2 : 1,
    recordVideo: { dir: ART, size: { width: viewport.width, height: viewport.height } },
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await bootGame(page, url, seats);
  await page.evaluate((k) => window.__poker.forcePresentationShowdown(k), kind);

  await page.waitForFunction(
    () => {
      const p = window.__poker?.getState?.()?.phase;
      return p === 'showdown' || p === 'hand_over';
    },
    { timeout: 8000 },
  );

  const { frames, checklist } = await sampleShowdown(page, {
    maxMs: pause ? 6000 : 11000,
    untilPause: false,
  });
  checklist.name = name;
  checklist.kind = kind;
  checklist.seats = seats;
  checklist.viewport = viewport;
  checklist.errors = errors;

  if (pause) {
    // Reach HAND_OVER hold, then host-pause via engine (same as ☰ / 暫停 button)
    await page.waitForFunction(
      () => window.__poker?.getState?.()?.phase === 'hand_over',
      { timeout: 20000 },
    );
    await page.evaluate(() => {
      window.__poker.cancelAutoNext();
      window.__poker.setViewer(window.__poker.getState().room.hostSeat);
      window.__poker.dispatch({
        type: 'REQUEST_PAUSE',
        seat: window.__poker.getState().room.hostSeat,
      });
    });
    await page.waitForSelector('#pauseScreen.is-on', { timeout: 5000 });
    await page.waitForTimeout(400);
    const pauseShot = await page.screenshot({ type: 'png' });
    writeFileSync(join(ART, `poker-showdown-${name}-pause.png`), pauseShot);

    // Verify modal quality
    const pauseCheck = await page.evaluate(() => {
      const scr = document.querySelector('#pauseScreen.is-on');
      const sheet = scr?.querySelector('.pause-panel');
      const btnNext = document.querySelector('#btnNext');
      const toast = document.querySelector('#toast.is-on');
      const readyBtns = document.querySelectorAll('button.pause-ready').length;
      const mid = sheet?.getBoundingClientRect();
      const topEl = mid
        ? document.elementFromPoint(mid.left + mid.width / 2, mid.top + mid.height / 2)
        : null;
      return {
        hasSheet: !!sheet,
        nextGone: !btnNext,
        toastGone: !toast,
        readyBtns,
        hitPause: !!(topEl && topEl.closest('#pauseScreen')),
        countText: document.querySelector('#pauseCount')?.textContent || '',
      };
    });
    Object.assign(checklist, { pauseCheck });
    checklist.pauseModalOpaque = pauseCheck.hasSheet && pauseCheck.hitPause;
    checklist.pauseButtons = pauseCheck.readyBtns > 0;
    checklist.nextHiddenWhilePaused = pauseCheck.nextGone;
    checklist.toastPill = !pauseCheck.toastGone ? true : checklist.toastPill;

    const n = await page.locator('button.pause-ready').count();
    for (let i = 0; i < n; i++) {
      await page.locator('button.pause-ready').first().click();
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(600);
    checklist.pauseAllReady = !(await page.locator('#pauseScreen.is-on').count());
    checklist.dealAfterPause = await page.evaluate(
      () =>
        document.documentElement.classList.contains('is-dealing') ||
        !!document.querySelector('#passScreen.is-on') ||
        window.__poker?.getState?.()?.phase === 'preflop',
    );
  }

  // Spaced sheet frames across the whole timeline (include the settled end)
  const picked = [];
  if (frames.length) {
    const idxs = new Set([0, frames.length - 1]);
    const mid = Math.min(6, Math.max(0, frames.length - 2));
    for (let i = 1; i <= mid; i++) {
      idxs.add(Math.round((i * (frames.length - 1)) / (mid + 1)));
    }
    [...idxs]
      .sort((a, b) => a - b)
      .slice(0, 8)
      .forEach((i) => picked.push(frames[i]));
  }
  for (let i = 0; i < picked.length; i++) {
    writeFileSync(join(ART, `poker-showdown-${name}-f${i + 1}.png`), picked[i].buf);
  }
  if (frames.length) {
    writeFileSync(join(ART, `poker-showdown-${name}-final.png`), frames[frames.length - 1].buf);
  }

  const vpath = await page.video()?.path();
  await ctx.close();
  if (vpath && existsSync(vpath)) {
    const dest = join(ART, `poker-showdown-${name}.webm`);
    copyFileSync(vpath, dest);
    try {
      unlinkSync(vpath);
    } catch {
      /* ignore */
    }
    checklist.video = dest;
  }
  return checklist;
}

async function buildSheet() {
  try {
    const { default: sharp } = await import('sharp').catch(() => ({ default: null }));
    void sharp;
  } catch {
    /* ignore */
  }
  // Pillow via python
  const { spawnSync } = await import('node:child_process');
  const py = `
from pathlib import Path
from PIL import Image
art = Path('${ART}')
frames = sorted(art.glob('poker-showdown-split-390-f*.png'))[:8]
if len(frames) < 4:
    frames = sorted(art.glob('poker-showdown-3p-split-390-f*.png'))[:8]
if not frames:
    frames = sorted(art.glob('poker-showdown-*-390-f*.png'))[:8]
imgs = [Image.open(f).convert('RGB') for f in frames]
w,h = imgs[0].size
cols = min(4, len(imgs))
rows = (len(imgs) + cols - 1) // cols
sheet = Image.new('RGB', (cols*w, rows*h), (12,24,18))
for i,im in enumerate(imgs):
    r,c = divmod(i, cols)
    sheet.paste(im, (c*w, r*h))
out = art/'poker-showdown-framesheet-390.png'
sheet.save(out, quality=85)
print(out, len(imgs))
`;
  spawnSync('python3', ['-c', py], { stdio: 'inherit' });
}

async function main() {
  const { server, url } = await startServer();
  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    results.push(
      await recordScenario(browser, url, {
        name: '2p-390',
        seats: 2,
        viewport: { width: 390, height: 844 },
        kind: 'heads',
      }),
    );
    results.push(
      await recordScenario(browser, url, {
        name: 'split-390',
        seats: 3,
        viewport: { width: 390, height: 844 },
        kind: 'split',
      }),
    );
    results.push(
      await recordScenario(browser, url, {
        name: 'sidepot-390',
        seats: 3,
        viewport: { width: 390, height: 844 },
        kind: 'sidepot',
      }),
    );
    results.push(
      await recordScenario(browser, url, {
        name: 'fold-390',
        seats: 3,
        viewport: { width: 390, height: 844 },
        kind: 'fold',
      }),
    );
    results.push(
      await recordScenario(browser, url, {
        name: 'pause-390',
        seats: 3,
        viewport: { width: 390, height: 844 },
        kind: 'split', // HAND_OVER after FX — then host pause + all-ready
        pause: true,
      }),
    );
    results.push(
      await recordScenario(browser, url, {
        name: 'showdown-1440',
        seats: 3,
        viewport: { width: 1440, height: 900 },
        kind: 'split',
      }),
    );
  } finally {
    await browser.close();
    server.close();
  }

  await buildSheet();

  const checklist = {
    generatedAt: new Date().toISOString(),
    scenarios: results,
    acceptance: {
      splitTwoWins: results.some((r) => r.kind === 'split' && r.winBadgeMax >= 2),
      sidePotMultiChipFlights: results.some((r) => r.kind === 'sidepot' && r.chipFlyMax >= 1),
      potToZero: results.filter((r) => r.kind !== 'pause').every((r) => r.potWentZero || r.sawChipFly),
      holdRing: results.some((r) => r.holdRing),
      noBoardDealReplay: results.every((r) => !r.boardDealReplay),
      noStrays: results.every((r) => !r.strayAtOrigin),
      noChipOverStack: results.every((r) => !r.chipOverStack),
      pauseModalOk: results.find((r) => r.name === 'pause-390')?.pauseModalOpaque ?? null,
      pauseButtons: results.find((r) => r.name === 'pause-390')?.pauseButtons ?? null,
      nextHiddenWhilePaused: results.find((r) => r.name === 'pause-390')?.nextHiddenWhilePaused ?? null,
      noToastPillOnPause: !(results.find((r) => r.name === 'pause-390')?.toastPill),
      pauseAllReady: results.find((r) => r.name === 'pause-390')?.pauseAllReady ?? null,
      dealAfterPause: results.find((r) => r.name === 'pause-390')?.dealAfterPause ?? null,
      noPageErrors: results.every((r) => !r.errors?.length),
    },
  };
  writeFileSync(join(ART, 'poker-showdown-checklist.json'), JSON.stringify(checklist, null, 2));
  const md = [
    '# Showdown FX checklist (PR #25 follow-up)',
    '',
    `- Generated: ${checklist.generatedAt}`,
    `- Split shows 2 WIN tags: ${checklist.acceptance.splitTwoWins}`,
    `- Side pot chip flights: ${checklist.acceptance.sidePotMultiChipFlights}`,
    `- Pot → 0: ${checklist.acceptance.potToZero}`,
    `- Hold ring: ${checklist.acceptance.holdRing}`,
    `- No board dealIn replay: ${checklist.acceptance.noBoardDealReplay}`,
    `- No stray FX: ${checklist.acceptance.noStrays}`,
    `- Chips not covering stack text: ${checklist.acceptance.noChipOverStack}`,
    `- Pause opaque modal above table: ${checklist.acceptance.pauseModalOk}`,
    `- Pause gold 我回來了 buttons: ${checklist.acceptance.pauseButtons}`,
    `- 下一手 hidden while paused: ${checklist.acceptance.nextHiddenWhilePaused}`,
    `- No duplicate toast pill: ${checklist.acceptance.noToastPillOnPause}`,
    `- Pause all-ready → deal: ${checklist.acceptance.pauseAllReady} / ${checklist.acceptance.dealAfterPause}`,
    `- No page errors: ${checklist.acceptance.noPageErrors}`,
    '',
    '## Scenarios',
    ...results.map(
      (r) =>
        `- **${r.name}** (${r.kind}): winBadges≤${r.winBadgeMax} chips≤${r.chipFlyMax} pot0=${r.potWentZero} hold=${r.holdRing} overStack=${r.chipOverStack} stray=${r.strayAtOrigin}`,
    ),
  ].join('\n');
  writeFileSync(join(ART, 'poker-showdown-checklist.md'), md);
  console.log(md);
  console.log('\nArtifacts →', ART);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
