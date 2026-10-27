/**
 * Layout overlap + showdown reveal sizing for mockup A table UI.
 * Seat counts 2–6 × phone-se / phone / phone-plus / desktop viewports.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
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

const TABLE_VIEWPORTS = [
  { name: 'phone-se', w: 375, h: 667 },
  { name: 'phone', w: 390, h: 844 },
  { name: 'phone-plus', w: 430, h: 932 },
  { name: 'desktop', w: 1440, h: 900 },
];

const PHONE_SCROLL_VIEWPORTS = [
  { name: 'phone-se', w: 375, h: 667 },
  { name: 'phone', w: 390, h: 844 },
  { name: 'phone-plus', w: 430, h: 932 },
];

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

async function waitFrames(page, n = 3) {
  await page.evaluate(
    (count) =>
      new Promise((r) => {
        let i = 0;
        const step = () => {
          i += 1;
          if (i >= count) r();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    n,
  );
}

async function configureLobby(page, seatCount) {
  const rows = page.locator('#playerRows .p-row');
  const nRows = await rows.count();
  for (let i = 0; i < nRows; i++) {
    const row = rows.nth(i);
    const input = row.locator('input');
    const disabled = await input.isDisabled();
    const wantOn = i < seatCount;
    if (wantOn === disabled) await row.locator('button[data-toggle]').click();
  }
  await page.locator('#timerToggle').uncheck().catch(() => {});
}

async function startTable(page) {
  await page.click('#btnStart');
  await page.waitForSelector('#passScreen.is-on', { timeout: 10000 });
  await page.click('#btnPassOk');
  await page.waitForTimeout(180);
  await waitFrames(page, 3);
  await page.waitForTimeout(200);
}

/**
 * In-page layout audit (serialized as plain function body).
 * @param {number} seatCount
 * @param {{ raisePanelOpen?: boolean }} opts
 */
function auditTableLayoutInPage({ seatCount, opts = {} }) {
  const issues = [];
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height };
  };
  const overlaps = (a, b, pad = 0) => {
    const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return ox > pad && oy > pad;
  };
  const edgeGap = (a, b) => {
    const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (ox > 0 && oy > 0) return -Math.min(ox, oy);
    if (ox > 0) return Math.max(a.top - b.bottom, b.top - a.bottom);
    if (oy > 0) return Math.max(a.left - b.right, b.left - a.right);
    return 99;
  };

  const plates = [...document.querySelectorAll('.seat .plate, .seat .plateA, .meinfo')];
  const backs = [...document.querySelectorAll('.backs')];
  const bets = [...document.querySelectorAll('#bets .bet')];
  const dealerEl = document.getElementById('dealer');
  const potEl = document.querySelector('.pot');
  const boardCards = [...document.querySelectorAll('#board .card')];
  const heroCards = [...document.querySelectorAll('#heroHole .card')];
  const actEl = document.getElementById('act');
  const revealCards = [...document.querySelectorAll('.reveal-hole .card')];

  const targets = [];
  const tag = (name, el) => {
    if (!el || getComputedStyle(el).display === 'none' || getComputedStyle(el).visibility === 'hidden') {
      return;
    }
    const b = box(el);
    if (b.w < 0.5 && b.h < 0.5) return;
    targets.push({ name, el, b });
  };
  plates.forEach((el, i) => tag(`plate[${i}]`, el));
  backs.forEach((el, i) => tag(`backs[${i}]`, el));
  bets.forEach((el, i) => tag(`bet[${i}]`, el));
  if (dealerEl) tag('dealer', dealerEl);
  if (potEl) tag('pot', potEl);
  boardCards.forEach((el, i) => tag(`board[${i}]`, el));
  heroCards.forEach((el, i) => tag(`heroHole[${i}]`, el));
  if (actEl) tag('act', actEl);
  revealCards.forEach((el, i) => tag(`reveal[${i}]`, el));

  for (let i = 0; i < targets.length; i++) {
    for (let j = i + 1; j < targets.length; j++) {
      if (overlaps(targets[i].b, targets[j].b)) {
        issues.push(`${targets[i].name} overlaps ${targets[j].name}`);
      }
    }
  }

  // Bet → own nameplate gap 6–14px
  for (const bet of bets) {
    const seatId = bet.dataset.forSeat;
    const plate =
      bet.dataset.hero === '1'
        ? document.querySelector('.meinfo')
        : seatId != null
          ? document.querySelector(`.seat[data-seat="${seatId}"] .plate, .seat[data-seat="${seatId}"] .plateA`)
          : null;
    if (!plate) {
      issues.push(`bet missing own plate (seat=${seatId || 'hero'})`);
      continue;
    }
    const g = edgeGap(box(bet), box(plate));
    const gap = Math.round(g * 10) / 10;
    if (gap < 6 || gap > 14) {
      issues.push(`bet seat ${seatId ?? 'hero'} plate gap ${gap}px (want 6–14)`);
    }
  }

  // No empty-seat placeholders
  const emptySeats = document.querySelectorAll('.seat.is-empty');
  if (emptySeats.length > 0) issues.push(`.seat.is-empty count ${emptySeats.length} (want 0)`);
  const oppSeats = document.querySelectorAll('.seat[data-seat]');
  if (oppSeats.length !== seatCount - 1) {
    issues.push(`opponent seats ${oppSeats.length} != ${seatCount - 1}`);
  }
  for (const el of emptySeats) {
    if ((el.textContent || '').includes('空位')) issues.push('empty seat still shows 空位');
  }

  // No 莊家 / 房主 on nameplates
  for (const el of document.querySelectorAll('.seat .plate .nm, .seat .plateA .nm, #heroName')) {
    const t = el.textContent || '';
    if (t.includes('莊家')) issues.push(`nameplate has 莊家: "${t.trim()}"`);
    if (t.includes('房主')) issues.push(`nameplate has 房主: "${t.trim()}"`);
  }

  // Dealer placement
  const st = window.__poker?.getState?.();
  const viewer = window.__poker?.getViewer?.();
  const buttonSeat = st?.button;
  if (dealerEl && getComputedStyle(dealerEl).display !== 'none' && buttonSeat != null) {
    const dBox = box(dealerEl);
    const dC = { x: (dBox.left + dBox.right) / 2, y: (dBox.top + dBox.bottom) / 2 };
    const distToPlate = (p) => {
      const dx = Math.max(p.left - dC.x, 0, dC.x - p.right);
      const dy = Math.max(p.top - dC.y, 0, dC.y - p.bottom);
      return Math.hypot(dx, dy);
    };
    const dealerPlateEl =
      buttonSeat === viewer
        ? document.querySelector('.meinfo')
        : document.querySelector(`.seat[data-seat="${buttonSeat}"] .plate, .seat[data-seat="${buttonSeat}"] .plateA`);
    if (!dealerPlateEl) {
      issues.push('missing dealer nameplate for button seat');
    } else {
      const ownDist = distToPlate(box(dealerPlateEl));
      plates.forEach((el, j) => {
        if (el === dealerPlateEl) return;
        const od = distToPlate(box(el));
        if (od <= ownDist + 1) {
          issues.push(
            `dealer nearer to plate[${j}] (${od.toFixed(1)}) than button plate (${ownDist.toFixed(1)})`,
          );
        }
        if (edgeGap(dBox, box(el)) < 8) {
          issues.push(`dealer too close to other plate[${j}] (gap=${edgeGap(dBox, box(el)).toFixed(1)})`);
        }
      });
      if (ownDist > 32) issues.push(`dealer too far from button plate (edgeDist=${ownDist.toFixed(1)})`);
    }
    const minObstacleGap = 8;
    for (const bet of bets) {
      const g = edgeGap(dBox, box(bet));
      if (g < minObstacleGap) issues.push(`dealer too close to bet (gap=${g.toFixed(1)})`);
    }
    if (potEl) {
      const g = edgeGap(dBox, box(potEl));
      if (g < minObstacleGap) issues.push(`dealer too close to pot (gap=${g.toFixed(1)})`);
    }
    for (const c of boardCards) {
      if (edgeGap(dBox, box(c)) < minObstacleGap) issues.push('dealer too close to board card');
    }
    for (const c of heroCards) {
      if (overlaps(dBox, box(c))) issues.push('dealer overlaps hero hole card');
    }
    for (const c of revealCards) {
      if (overlaps(dBox, box(c))) issues.push('dealer overlaps revealed card');
    }
  }

  if (opts.raisePanelOpen) {
    const panel = document.getElementById('raisePanel');
    const scrim = document.getElementById('raiseScrim');
    if (!panel?.classList.contains('is-on')) issues.push('raisePanel not .is-on');
    if (!scrim?.classList.contains('is-on')) issues.push('raiseScrim not .is-on');
    const presets = document.getElementById('presets');
    const buttons = [...(presets?.querySelectorAll('button[data-to]') || [])];
    if (buttons.length !== 6) issues.push(`raise presets count ${buttons.length} (want 6)`);
    if (buttons.length === 6) {
      const tops = buttons.map((b) => b.getBoundingClientRect().top);
      const near = (a, b) => Math.abs(a - b) <= 3;
      const row0 = tops[0];
      const row1 = tops[3];
      if (!(near(tops[1], row0) && near(tops[2], row0))) issues.push('preset row1 not aligned');
      if (!(near(tops[4], row1) && near(tops[5], row1))) issues.push('preset row2 not aligned');
      if (!(row1 > row0 + 16)) issues.push('presets not 2 rows');
    }
    const stage = document.querySelector('.stage');
    const stageBox = stage ? box(stage) : null;
    if (panel && stageBox) {
      const pb = box(panel);
      const clipped =
        pb.bottom > stageBox.bottom + 2 &&
        pb.top < stageBox.bottom &&
        pb.height > stageBox.height * 0.35;
      if (clipped) issues.push('raise panel heavily clips table stage');
    }
    const doc = document.documentElement;
    if (doc.scrollHeight > doc.clientHeight + 4) {
      issues.push(`page scrolls with raise open (${doc.scrollHeight}>${doc.clientHeight})`);
    }
  }

  return {
    issues,
    betCount: bets.length,
    revealCount: revealCards.length,
  };
}

async function auditTableLayout(page, seatCount, opts = {}) {
  return page.evaluate(auditTableLayoutInPage, { seatCount, opts });
}

/** Fold-win showdown; bots always SHOW; viewer SHOW if still pending. */
async function forceAllSeatsRevealed(page) {
  return page.evaluate(() => {
    const api = window.__poker;
    if (!api) return { ok: false, error: 'no __poker' };
    const origRandom = Math.random;
    Math.random = () => 0;

    const seated = () =>
      api.getState().seats.map((p, i) => (p ? i : null)).filter((x) => x != null);

    const actOnce = () => {
      const st = api.getState();
      if (st.phase === 'hand_over') {
        api.dispatch({ type: 'ACK_HAND' });
        return 'next';
      }
      if (st.phase === 'showdown') return 'showdown';
      const actor = st.actor;
      if (actor == null) return 'idle';
      const occ = seated();
      const keeper = occ[0];
      if (actor !== keeper) {
        api.dispatch({ type: 'FOLD', seat: actor });
        return 'fold';
      }
      try {
        api.dispatch({ type: 'CHECK', seat: actor });
        return 'check';
      } catch {
        try {
          api.dispatch({ type: 'CALL', seat: actor });
          return 'call';
        } catch {
          api.dispatch({ type: 'FOLD', seat: actor });
          return 'fold';
        }
      }
    };

    let steps = 0;
    while (steps++ < 120) {
      const phase = api.getState().phase;
      if (phase === 'showdown') break;
      const r = actOnce();
      if (r === 'idle' && phase !== 'preflop') break;
    }

    let st = api.getState();
    if (st.phase !== 'showdown' && st.phase !== 'hand_over') {
      Math.random = origRandom;
      return { ok: false, error: `stuck in ${st.phase}` };
    }

    if (st.phase === 'hand_over') {
      // Re-run once if auto-advanced too fast
      Math.random = origRandom;
      return { ok: false, error: 'reached hand_over before reveal audit' };
    }

    const pending = [...(st.showdown?.pending || [])];
    const viewer = api.getViewer();
    for (const seat of pending) {
      if (!api.getState().showdown?.pending?.includes(seat)) continue;
      api.setViewer(seat);
      try {
        api.dispatch({ type: 'SHOW', seat, mode: 'both' });
      } catch (e) {
        Math.random = origRandom;
        return { ok: false, error: String(e.message || e) };
      }
    }
    api.setViewer(viewer);

    st = api.getState();
    Math.random = origRandom;

    const occ = seated();
    const revealedDom = document.querySelectorAll('.reveal-hole .card').length;
    return {
      ok: true,
      phase: st.phase,
      occupied: occ.length,
      pendingLeft: st.showdown?.pending?.length ?? 0,
      revealedDom,
    };
  });
}

function auditRevealLayoutInPage({ seatCount }) {
  const issues = [];
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height };
  };
  const overlaps = (a, b) => {
    const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return ox > 0 && oy > 0;
  };

  const heroRef = document.querySelector('#heroHole .card.hero');
  if (!heroRef) {
    issues.push('missing #heroHole .card.hero reference');
    return { issues };
  }
  const ref = box(heroRef);
  const cs = getComputedStyle(document.documentElement);
  const hw = parseFloat(cs.getPropertyValue('--hw')) || ref.w;
  const hh = parseFloat(cs.getPropertyValue('--hh')) || ref.h;
  const stage = document.querySelector('.stage');
  const stageBox = stage ? box(stage) : null;

  const revealCards = [...document.querySelectorAll('.reveal-hole .card')];
  const expectedOpponents = seatCount - 1;
  const seatsWithReveal = new Set(
    [...document.querySelectorAll('.seat[data-seat] .reveal-hole')].map((el) =>
      el.closest('.seat')?.dataset?.seat,
    ),
  );

  if (seatsWithReveal.size < expectedOpponents) {
    issues.push(
      `only ${seatsWithReveal.size}/${expectedOpponents} opponent seats show reveal-hole`,
    );
  }

  for (const seatEl of document.querySelectorAll('.seat[data-seat]')) {
    const seat = seatEl.dataset.seat;
    const hole = seatEl.querySelector('.reveal-hole');
    if (!hole) {
      issues.push(`reveal cards do not fit at seat ${seat} (no reveal-hole)`);
      continue;
    }
    const cards = [...hole.querySelectorAll('.card')];
    if (cards.length < 2) {
      issues.push(`reveal cards do not fit at seat ${seat} (expected 2 cards)`);
    }
    for (const card of cards) {
      const b = box(card);
      if (Math.abs(b.w - ref.w) > 1 || Math.abs(b.h - ref.h) > 1) {
        if (Math.abs(b.w - hw) > 1 || Math.abs(b.h - hh) > 1) {
          issues.push(
            `seat ${seat} reveal card size ${b.w.toFixed(1)}×${b.h.toFixed(1)} != hero ${ref.w.toFixed(1)}×${ref.h.toFixed(1)}`,
          );
        }
      }
      if (stageBox) {
        const out =
          b.left < stageBox.left - 1 ||
          b.top < stageBox.top - 1 ||
          b.right > stageBox.right + 1 ||
          b.bottom > stageBox.bottom + 1;
        if (out) issues.push(`reveal cards do not fit at seat ${seat} (clipped outside stage)`);
      }
    }
  }

  const targets = [];
  const pushTarget = (name, el) => {
    if (!el) return;
    targets.push({ name, b: box(el) });
  };
  [...document.querySelectorAll('.seat .plate, .seat .plateA, .meinfo')].forEach((el, i) =>
    pushTarget(`plate[${i}]`, el),
  );
  [...document.querySelectorAll('.backs')].forEach((el, i) => pushTarget(`backs[${i}]`, el));
  [...document.querySelectorAll('#bets .bet')].forEach((el, i) => pushTarget(`bet[${i}]`, el));
  pushTarget('dealer', document.getElementById('dealer'));
  pushTarget('pot', document.querySelector('.pot'));
  [...document.querySelectorAll('#board .card')].forEach((el, i) => pushTarget(`board[${i}]`, el));
  [...document.querySelectorAll('#heroHole .card')].forEach((el, i) => pushTarget(`hero[${i}]`, el));
  pushTarget('act', document.getElementById('act'));
  revealCards.forEach((el, i) => pushTarget(`reveal[${i}]`, el));

  for (let i = 0; i < targets.length; i++) {
    for (let j = i + 1; j < targets.length; j++) {
      if (overlaps(targets[i].b, targets[j].b)) {
        issues.push(`showdown: ${targets[i].name} overlaps ${targets[j].name}`);
      }
    }
  }

  return { issues, revealCards: revealCards.length };
}

async function ensureHeroCanRaise(page) {
  for (let i = 0; i < 40; i++) {
    const can = await page.evaluate(() => {
      const v = window.__poker?.view?.(window.__poker.getState(), window.__poker.getViewer());
      return !!document.querySelector('#btnRaiseOpen:not([disabled])') && v?.legal?.canAct;
    });
    if (can) return true;
    const phase = await page.evaluate(() => window.__poker?.getState?.()?.phase);
    if (phase === 'hand_over' || phase === 'showdown') return false;
    const actor = await page.evaluate(() => window.__poker?.getState?.()?.actor);
    if (actor != null) {
      await page.evaluate((a) => {
        window.__poker.setViewer(a);
        const st = window.__poker.getState();
        if (st.actor !== a) return;
        try {
          window.__poker.dispatch({ type: 'FOLD', seat: a });
        } catch {
          try {
            window.__poker.dispatch({ type: 'CHECK', seat: a });
          } catch {
            window.__poker.dispatch({ type: 'CALL', seat: a });
          }
        }
      }, actor);
    }
    await page.waitForTimeout(60);
  }
  return false;
}

async function checkViewport(browser, url, vp, seatCount) {
  const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('#lobbyScreen.is-on', { timeout: 15000 });
  await configureLobby(page, seatCount);
  await startTable(page);

  const report = await auditTableLayout(page, seatCount, { raisePanelOpen: false });
  const shot = join(ART, `poker-layout-${vp.name}-seats${seatCount}.png`);
  await page.screenshot({ path: shot, fullPage: true });

  await page.close();
  return {
    kind: 'layout',
    viewport: vp.name,
    seatCount,
    errors,
    issues: report.issues,
    betCount: report.betCount,
    screenshot: shot,
  };
}

async function checkRaisePanel(browser, url, vp) {
  const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = [];
  const issues = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('#lobbyScreen.is-on', { timeout: 15000 });
  await configureLobby(page, 3);
  await startTable(page);

  const heroTurn = await ensureHeroCanRaise(page);
  if (!heroTurn) {
    issues.push('could not reach hero raise turn');
  } else {
    await page.click('#btnRaiseOpen');
    await page.waitForSelector('#raisePanel.is-on', { timeout: 5000 });
    await waitFrames(page, 2);
    await page.waitForTimeout(120);
    const report = await auditTableLayout(page, 3, { raisePanelOpen: true });
    issues.push(...report.issues);
  }

  const shot = join(ART, `poker-raise-${vp.name}.png`);
  await page.screenshot({ path: shot, fullPage: true });
  await page.close();
  return {
    kind: 'raise-panel',
    viewport: vp.name,
    errors,
    issues,
    screenshot: shot,
  };
}

async function checkShowdownReveal(browser, url, vp, seatCount) {
  const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const issues = [];

  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('#lobbyScreen.is-on', { timeout: 15000 });
  await configureLobby(page, seatCount);
  await startTable(page);

  const setup = await forceAllSeatsRevealed(page);
  if (!setup.ok) issues.push(`showdown setup: ${setup.error || 'failed'}`);
  await waitFrames(page, 3);
  await page.waitForTimeout(280);

  const reveal = await page.evaluate(auditRevealLayoutInPage, { seatCount });
  issues.push(...reveal.issues);

  const shot = join(ART, `poker-reveal-${vp.name}-seats${seatCount}.png`);
  await page.screenshot({ path: shot, fullPage: true });
  await page.close();

  return {
    kind: 'showdown-reveal',
    viewport: vp.name,
    seatCount,
    errors,
    issues,
    setup,
    revealCards: reveal.revealCards,
    screenshot: shot,
  };
}

async function measureScreenReach(page, screenId, ctaSel) {
  return page.evaluate(
    ({ screenId, ctaSel }) => {
      const screen = document.getElementById(screenId);
      const cta = document.querySelector(ctaSel);
      const issues = [];
      if (!screen) return { issues: [`missing #${screenId}`] };
      if (!cta) return { issues: [`missing CTA ${ctaSel}`] };

      const body = screen.querySelector('.sheet-body');
      const vh = window.innerHeight;
      const vw = window.innerWidth;

      if (screen.scrollWidth > screen.clientWidth + 1) {
        issues.push(`#${screenId} horizontal overflow (${screen.scrollWidth}>${screen.clientWidth})`);
      }
      if (body && body.scrollWidth > body.clientWidth + 1) {
        issues.push(`.sheet-body horizontal overflow on #${screenId}`);
      }

      const tryReveal = () => {
        if (body && body.scrollHeight > body.clientHeight + 1) body.scrollTop = body.scrollHeight;
        screen.scrollTop = screen.scrollHeight;
        cta.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      };

      let r = cta.getBoundingClientRect();
      if (!(r.bottom > 0 && r.top < vh && Math.min(r.bottom, vh) - Math.max(r.top, 0) >= 36)) {
        tryReveal();
        r = cta.getBoundingClientRect();
      }

      const visible = Math.min(r.bottom, vh) - Math.max(r.top, 0);
      const reachable =
        r.bottom > 0 && r.top < vh && visible >= Math.min(r.height, 36) && r.left < vw && r.right > 0;
      if (!reachable) {
        issues.push(
          `#${screenId} CTA ${ctaSel} unreachable (top=${r.top.toFixed(1)} bottom=${r.bottom.toFixed(1)} vh=${vh})`,
        );
      }

      let lobbyStartPinned = null;
      if (screenId === 'lobbyScreen' && body) {
        body.scrollTop = 0;
        screen.scrollTop = 0;
        const r0 = cta.getBoundingClientRect();
        const pinnedVisible =
          r0.bottom > 0 &&
          r0.top < vh &&
          Math.min(r0.bottom, vh) - Math.max(r0.top, 0) >= Math.min(r0.height, 36);
        lobbyStartPinned = pinnedVisible;
        if (!pinnedVisible) issues.push('#btnStart not visible at lobby top (sticky/pinned foot failed)');
      }

      return {
        issues,
        screenScroll: {
          scrollHeight: screen.scrollHeight,
          clientHeight: screen.clientHeight,
          canScrollY: screen.scrollHeight > screen.clientHeight + 1,
        },
        bodyScroll: body
          ? {
              scrollHeight: body.scrollHeight,
              clientHeight: body.clientHeight,
              canScrollY: body.scrollHeight > body.clientHeight + 1,
            }
          : null,
        cta: { top: r.top, bottom: r.bottom, height: r.height },
        lobbyStartPinned,
        viewport: { w: vw, h: vh },
      };
    },
    { screenId, ctaSel },
  );
}

async function checkScrollScreens(browser, url, vp) {
  const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const issues = [];
  const shots = [];

  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('#lobbyScreen.is-on', { timeout: 15000 });
  await page.locator('#timerToggle').uncheck().catch(() => {});

  const lobby = await measureScreenReach(page, 'lobbyScreen', '#btnStart');
  issues.push(...lobby.issues.map((m) => `lobby: ${m}`));
  shots.push(join(ART, `poker-scroll-${vp.name}-lobby.png`));
  await page.screenshot({ path: shots.at(-1) });

  await page.click('#btnStart');
  await page.waitForSelector('#passScreen.is-on', { timeout: 10000 });

  const pass = await measureScreenReach(page, 'passScreen', '#btnPassOk');
  issues.push(...pass.issues.map((m) => `pass: ${m}`));
  shots.push(join(ART, `poker-scroll-${vp.name}-pass.png`));
  await page.screenshot({ path: shots.at(-1) });

  await page.evaluate(() => {
    const sheet = document.querySelector('#passScreen .sheet');
    if (!sheet) return;
    const pad = document.createElement('div');
    pad.id = 'scrollTestPad';
    pad.style.cssText = 'height:120vh;margin:8px 0;color:transparent;user-select:none';
    pad.textContent = '.';
    const actions = sheet.querySelector('.actions');
    sheet.insertBefore(pad, actions);
  });
  const passTall = await measureScreenReach(page, 'passScreen', '#btnPassOk');
  issues.push(...passTall.issues.map((m) => `pass-tall: ${m}`));
  if (!passTall.screenScroll?.canScrollY) {
    issues.push('pass-tall: #passScreen did not become vertically scrollable');
  }
  await page.evaluate(() => document.getElementById('scrollTestPad')?.remove());

  await page.click('#btnPassOk');
  await page.waitForTimeout(250);

  await page.evaluate(() => {
    const scr = document.getElementById('summaryScreen');
    const body = document.getElementById('summaryBody');
    scr.classList.add('is-on');
    const rows = Array.from({ length: 16 }, (_, i) => {
      const n = `測試玩家${i + 1}`;
      return `<tr><td>${n}</td><td>2,000</td><td>2,000</td><td class="pos">+0</td></tr>`;
    }).join('');
    body.innerHTML = `
      <div class="summary">
        <p class="lead">捲動測試：確認關閉鈕在矮視窗仍可到達。</p>
        <table>
          <thead><tr><th>玩家</th><th>買入</th><th>籌碼</th><th>淨勝</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  });
  await page.waitForSelector('#summaryScreen.is-on');
  const summary = await measureScreenReach(page, 'summaryScreen', '#btnSummaryClose');
  issues.push(...summary.issues.map((m) => `summary: ${m}`));
  if (!summary.screenScroll?.canScrollY) {
    issues.push('summary: #summaryScreen did not become vertically scrollable with tall content');
  }
  shots.push(join(ART, `poker-scroll-${vp.name}-summary.png`));
  await page.screenshot({ path: shots.at(-1) });

  await page.close();
  return {
    kind: 'scroll',
    viewport: vp.name,
    size: `${vp.w}x${vp.h}`,
    errors,
    issues,
    lobby,
    pass,
    passTall,
    summary,
    screenshots: shots,
  };
}

async function main() {
  const { server, url } = await startServer();
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || '/usr/local/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const layoutResults = [];
  for (const vp of TABLE_VIEWPORTS) {
    for (let seats = 2; seats <= 6; seats++) {
      layoutResults.push(await checkViewport(browser, url, vp, seats));
    }
  }

  const raiseResults = [];
  for (const vp of TABLE_VIEWPORTS) {
    raiseResults.push(await checkRaisePanel(browser, url, vp));
  }

  const revealResults = [];
  for (const vp of TABLE_VIEWPORTS) {
    for (let seats = 2; seats <= 6; seats++) {
      revealResults.push(await checkShowdownReveal(browser, url, vp, seats));
    }
  }

  const scrollResults = [];
  for (const vp of PHONE_SCROLL_VIEWPORTS) {
    scrollResults.push(await checkScrollScreens(browser, url, vp));
  }

  await browser.close();
  server.close();

  const failed = (rows) => rows.filter((r) => r.issues.length || r.errors.length);
  const layoutFailed = failed(layoutResults);
  const raiseFailed = failed(raiseResults);
  const revealFailed = failed(revealResults);
  const scrollFailed = failed(scrollResults);

  const summary = {
    ok:
      layoutFailed.length === 0 &&
      raiseFailed.length === 0 &&
      revealFailed.length === 0 &&
      scrollFailed.length === 0,
    layoutChecked: layoutResults.length,
    layoutFailed: layoutFailed.length,
    raiseChecked: raiseResults.length,
    raiseFailed: raiseFailed.length,
    revealChecked: revealResults.length,
    revealFailed: revealFailed.length,
    scrollChecked: scrollResults.length,
    scrollFailed: scrollFailed.length,
    layoutResults,
    raiseResults,
    revealResults,
    scrollResults,
  };

  writeFileSync(join(ART, 'poker-layout-overlap.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
