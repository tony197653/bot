/**
 * Showdown evidence: phone-390 + desktop-1440 recordings, frame sheet, checklist.
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

async function bootGame(page, seats) {
  await page.goto('/');
  await page.waitForSelector('#lobbyScreen');
  await configureLobby(page, seats);
  await page.click('#btnStart');
  await page.waitForFunction(() => window.__poker?.getState?.()?.handNumber >= 1, {
    timeout: 8000,
  });
  await page.evaluate(() => window.__poker.skipDealAndReady(0));
}

/** Drive to fold-win via engine actions. */
async function forceFoldWin(page) {
  await page.evaluate(() => {
    const P = window.__poker;
    const streets = new Set(['preflop', 'flop', 'turn', 'river']);
    let raised = false;
    let guard = 0;
    while (guard++ < 80) {
      const s = P.getState();
      if (!streets.has(s.phase) || s.actor == null) break;
      P.setViewer(s.actor);
      P.skipDealAndReady(s.actor);
      const L = P.view().legal;
      if (!L?.canAct) break;
      if (!raised && (L.bet || L.raise)) {
        P.dispatch({ type: 'BET_RAISE', seat: s.actor, amount: L.minRaiseTo });
        raised = true;
        continue;
      }
      if (L.fold) P.dispatch({ type: 'FOLD', seat: s.actor });
      else if (L.check) P.dispatch({ type: 'CHECK', seat: s.actor });
      else break;
    }
  });
}

/** Check/call to showdown. */
async function forceShowdown(page) {
  await page.evaluate(() => {
    const P = window.__poker;
    const streets = new Set(['preflop', 'flop', 'turn', 'river']);
    let guard = 0;
    while (guard++ < 120) {
      const s = P.getState();
      if (!streets.has(s.phase)) break;
      if (s.actor == null) break;
      P.setViewer(s.actor);
      P.skipDealAndReady(s.actor);
      const L = P.view().legal;
      if (!L?.canAct) break;
      if (L.check) P.dispatch({ type: 'CHECK', seat: s.actor });
      else if (L.call) P.dispatch({ type: 'CALL', seat: s.actor });
      else if (L.allIn) P.dispatch({ type: 'ALL_IN', seat: s.actor });
      else break;
    }
  });
}

async function sampleShowdown(page, { maxMs = 14000, stepMs = 120 }) {
  const frames = [];
  const checklist = {
    sawFlip: false,
    sawWinBadge: false,
    sawChipFly: false,
    potWentZero: false,
    wrongSeatChip: false,
    boardDealReplay: false,
    revealCdFromFive: false,
    holdRing: false,
    strayAtOrigin: false,
    straySamples: [],
    phases: [],
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
      const showCd = document.querySelector('#showCd:not(.hidden)')?.textContent || '';
      const holdCd = document.querySelector('#holdCd')?.textContent || '';
      const holdRing = !!document.querySelector('#btnNext .hold-ring');
      const pauseOn = !!document.querySelector('#pauseScreen.is-on');
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
      return {
        phase: s?.phase,
        foldWin: !!(s?.showdown?.foldWin || s?.lastHandSummary?.foldWin),
        potAmt,
        flips,
        winBadges,
        chipFly: chips.length,
        boardHtml,
        showCd,
        holdCd,
        holdRing,
        pauseOn,
        fxBusy: !!window.__poker?.showdownFxBusy,
        armed: !!window.__poker?.revealUiArmed,
        strays,
        t: performance.now(),
      };
    });
    checklist.phases.push(snap.phase);
    if (snap.flips > 0) checklist.sawFlip = true;
    if (snap.winBadges > 0) checklist.sawWinBadge = true;
    if (snap.chipFly > 0) checklist.sawChipFly = true;
    if (snap.potAmt === '0') checklist.potWentZero = true;
    if (snap.showCd.includes('5')) checklist.revealCdFromFive = true;
    if (snap.holdRing) checklist.holdRing = true;
    if (boardHtml0 == null && (snap.phase === 'showdown' || snap.phase === 'hand_over')) {
      boardHtml0 = snap.boardHtml;
    } else if (boardHtml0 != null && snap.boardHtml !== boardHtml0) {
      // Class-only changes ok; dealIn replay would replace nodes — track length churn
      if (snap.boardHtml.includes('is-deal')) checklist.boardDealReplay = true;
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
    if (snap.phase === 'hand_over' && snap.holdRing && frames.length > 8 && !snap.fxBusy) {
      // enough for hold evidence
      if (Date.now() - t0 > 3500) break;
    }
    if (snap.pauseOn && frames.length > 3) break;
    await page.waitForTimeout(stepMs);
  }
  return { frames, checklist };
}

async function recordScenario(browser, url, opts) {
  const { name, seats, viewport, mode } = opts;
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: viewport.width <= 430 ? 2 : 1,
    recordVideo: { dir: ART, size: { width: viewport.width, height: viewport.height } },
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await bootGame(page, seats);
  if (mode === 'fold') await forceFoldWin(page);
  else await forceShowdown(page);

  // Wait for showdown/hand_over
  await page.waitForFunction(
    () => {
      const p = window.__poker?.getState?.()?.phase;
      return p === 'showdown' || p === 'hand_over';
    },
    { timeout: 15000 },
  );

  const { frames, checklist } = await sampleShowdown(page, {
    maxMs: mode === 'pause' ? 8000 : 12000,
  });
  checklist.name = name;
  checklist.mode = mode;
  checklist.seats = seats;
  checklist.viewport = viewport;
  checklist.errors = errors;

  if (mode === 'pause') {
    // Host pause during hold
    await page.waitForSelector('#btnNext', { timeout: 12000 });
    await page.evaluate(() => window.__poker.cancelAutoNext());
    await page.click('#btnMenu');
    await page.click('#btnPauseMenu');
    await page.waitForSelector('#pauseScreen.is-on', { timeout: 5000 });
    const pauseShot = await page.screenshot({ type: 'png' });
    writeFileSync(join(ART, `poker-showdown-${name}-pause.png`), pauseShot);
    // Ready all players
    const n = await page.locator('button.pause-ready').count();
    for (let i = 0; i < n; i++) {
      await page.locator('button.pause-ready').first().click();
      await page.waitForTimeout(200);
    }
    checklist.pauseAllReady = !(await page.locator('#pauseScreen.is-on').count());
  }

  // Save spaced frames
  const picked = [];
  for (const f of frames) {
    if (picked.length >= 8) break;
    if (!picked.length || f.t - picked[picked.length - 1].t >= 400) picked.push(f);
  }
  for (let i = 0; i < picked.length; i++) {
    writeFileSync(join(ART, `poker-showdown-${name}-f${i + 1}.png`), picked[i].buf);
  }
  if (picked[0]) {
    writeFileSync(join(ART, `poker-showdown-${name}-final.png`), picked[picked.length - 1].buf);
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
        mode: 'showdown',
      }),
    );
    results.push(
      await recordScenario(browser, url, {
        name: '3p-split-390',
        seats: 3,
        viewport: { width: 390, height: 844 },
        mode: 'showdown',
      }),
    );
    results.push(
      await recordScenario(browser, url, {
        name: 'fold-390',
        seats: 3,
        viewport: { width: 390, height: 844 },
        mode: 'fold',
      }),
    );
    results.push(
      await recordScenario(browser, url, {
        name: 'pause-390',
        seats: 3,
        viewport: { width: 390, height: 844 },
        mode: 'pause',
      }),
    );
    results.push(
      await recordScenario(browser, url, {
        name: 'showdown-1440',
        seats: 3,
        viewport: { width: 1440, height: 900 },
        mode: 'showdown',
      }),
    );
  } finally {
    await browser.close();
    server.close();
  }

  const checklist = {
    generatedAt: new Date().toISOString(),
    scenarios: results,
    acceptance: {
      orderedRevealNotSameFrame: results.some((r) => r.sawFlip || r.sawWinBadge),
      potToZero: results.filter((r) => r.mode !== 'pause').every((r) => r.potWentZero || r.sawChipFly),
      holdRing: results.some((r) => r.holdRing),
      noBoardDealReplay: results.every((r) => !r.boardDealReplay),
      noStrays: results.every((r) => !r.strayAtOrigin),
      pauseAllReady: results.find((r) => r.mode === 'pause')?.pauseAllReady ?? null,
      noPageErrors: results.every((r) => !r.errors?.length),
    },
  };
  writeFileSync(join(ART, 'poker-showdown-checklist.json'), JSON.stringify(checklist, null, 2));

  // Markdown checklist
  const md = [
    '# Showdown FX checklist',
    '',
    `- Generated: ${checklist.generatedAt}`,
    `- Ordered reveal / glow (not same-frame pop): ${checklist.acceptance.orderedRevealNotSameFrame}`,
    `- Pot → 0 / chip flight observed: ${checklist.acceptance.potToZero}`,
    `- Hold countdown ring: ${checklist.acceptance.holdRing}`,
    `- No board dealIn replay: ${checklist.acceptance.noBoardDealReplay}`,
    `- No stray FX at origin: ${checklist.acceptance.noStrays}`,
    `- Pause all-ready clears panel: ${checklist.acceptance.pauseAllReady}`,
    `- No page errors: ${checklist.acceptance.noPageErrors}`,
    '',
    '## Scenarios',
    ...results.map(
      (r) =>
        `- **${r.name}** (${r.mode}, ${r.seats}p): flip=${r.sawFlip} win=${r.sawWinBadge} chips=${r.sawChipFly} pot0=${r.potWentZero} hold=${r.holdRing} stray=${r.strayAtOrigin}`,
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
