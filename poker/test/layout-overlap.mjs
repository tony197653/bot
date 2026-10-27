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

  const seatOf = (t) => {
    const el = t.el;
    const seatEl = el.closest?.('.seat[data-seat]');
    if (seatEl) return seatEl.dataset.seat;
    if (el.closest?.('#meRoot, .meinfo, #heroHole')) return 'hero';
    return null;
  };
  const kind = (name) => name.replace(/\[\d+\]/, '');
  for (let i = 0; i < targets.length; i++) {
    for (let j = i + 1; j < targets.length; j++) {
      const a = targets[i];
      const b = targets[j];
      const ka = kind(a.name);
      const kb = kind(b.name);
      // Mockup A: card backs tuck into the nameplate; hole/reveal pairs fan-overlap
      if (
        (ka === 'plate' && kb === 'backs') ||
        (ka === 'backs' && kb === 'plate')
      ) {
        if (seatOf(a) != null && seatOf(a) === seatOf(b)) continue;
      }
      if (ka === 'heroHole' && kb === 'heroHole') continue;
      if (ka === 'reveal' && kb === 'reveal' && seatOf(a) === seatOf(b)) continue;
      // Hero hole cards may tuck slightly into own nameplate (mockup A)
      if (
        ({plate:1,heroHole:1}[ka] && {plate:1,heroHole:1}[kb]) &&
        seatOf(a) != null &&
        seatOf(a) === seatOf(b)
      ) {
        continue;
      }
      // Revealed cards must NOT cover the owner's nameplate
      if ((ka === 'plate' && kb === 'reveal') || (ka === 'reveal' && kb === 'plate')) {
        if (seatOf(a) != null && seatOf(a) === seatOf(b) && overlaps(a.b, b.b)) {
          issues.push(`${a.name} overlaps ${b.name} (reveal must sit above nameplate)`);
          continue;
        }
      }
      // D must stay clear of EVERY nameplate (including the button's own) — no skip
      if ((ka === 'dealer' && kb === 'plate') || (ka === 'plate' && kb === 'dealer')) {
        const g = edgeGap(a.b, b.b);
        if (g < 10) {
          issues.push(`dealer vs ${ka === 'plate' ? a.name : b.name} gap ${g.toFixed(1)}px (want ≥10)`);
        }
        continue;
      }
      if (overlaps(a.b, b.b)) {
        issues.push(`${a.name} overlaps ${b.name}`);
      }
    }
  }

  // Bet → own seat chrome (plate + backs) gap 6–14px; nearest plate must be the owner
  for (const bet of bets) {
    const seatId = bet.dataset.forSeat;
    const isHero = bet.dataset.hero === '1';
    const seatEl = isHero
      ? document.querySelector('#meRoot')
      : seatId != null
        ? document.querySelector(`.seat[data-seat="${seatId}"]`)
        : null;
    if (!seatEl) {
      issues.push(`bet missing own seat (seat=${seatId || 'hero'})`);
      continue;
    }
    const plateEl = seatEl.querySelector('.plate, .plateA, .meinfo') || seatEl;
    const ownPlate = box(plateEl);
    // Chrome = plate + backs (not reveal-hole). Hero bets sit above hole cards (mockup A).
    let L = ownPlate.left,
      T = ownPlate.top,
      R = ownPlate.right,
      B = ownPlate.bottom;
    seatEl.querySelectorAll('.backs').forEach((c) => {
      const q = c.getBoundingClientRect();
      if (q.width && q.height) {
        L = Math.min(L, q.left);
        T = Math.min(T, q.top);
        R = Math.max(R, q.right);
        B = Math.max(B, q.bottom);
      }
    });
    const holeEl = isHero ? document.querySelector('#heroHole') : null;
    const holeBox =
      holeEl && holeEl.children.length
        ? (() => {
            const r = holeEl.getBoundingClientRect();
            return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
          })()
        : null;
    const betBox = box(bet);
    // Off-screen unplaced bets
    if (betBox.left < -500 || betBox.top < -500) {
      issues.push(`bet seat ${seatId ?? 'hero'} unplaced (off-screen)`);
      continue;
    }
    const target = holeBox || { left: L, top: T, right: R, bottom: B };
    const g = edgeGap(betBox, target);
    const gap = Math.round(g * 10) / 10;
    const hi = isHero ? 20 : 14;
    if (gap < 6 || gap > hi) {
      issues.push(
        `bet seat ${seatId ?? 'hero'} ${holeBox ? 'hole' : 'plate'} gap ${gap}px (want 6–${hi})`,
      );
    }
    // Nearest nameplate must be the owner's (non-hero). Hero bets sit above hole cards
    // toward felt centre, so they can be nearer an opponent plate than meinfo.
    if (!isHero) {
      const rectDist = (a, b) => {
        const dx = Math.max(a.left - b.right, b.left - a.right, 0);
        const dy = Math.max(a.top - b.bottom, b.top - a.bottom, 0);
        return Math.hypot(dx, dy);
      };
      let nearest = { seat: null, dist: Infinity };
      for (const pl of plates) {
        const pd = rectDist(betBox, box(pl));
        const sid =
          pl.closest?.('.seat[data-seat]')?.dataset?.seat ??
          (pl.classList?.contains('meinfo') || pl.closest?.('#meRoot') ? 'hero' : null);
        if (pd < nearest.dist) nearest = { seat: sid, dist: pd };
      }
      const ownerKey = String(seatId);
      if (nearest.seat != null && nearest.seat !== ownerKey) {
        issues.push(
          `bet seat ${ownerKey} nearest plate is seat ${nearest.seat} (dist ${nearest.dist.toFixed(1)}), not owner`,
        );
      }
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

  // Dealer placement — ≥10px clear of EVERY nameplate (incl. own) + backs / bets / pot / cards
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
        : document.querySelector(
            `.seat[data-seat="${buttonSeat}"] .plate, .seat[data-seat="${buttonSeat}"] .plateA`,
          );
    if (!dealerPlateEl) {
      issues.push('missing dealer nameplate for button seat');
    } else {
      const ownGap = edgeGap(dBox, box(dealerPlateEl));
      if (ownGap < 10) {
        issues.push(`dealer overlaps/too close to OWN nameplate (gap=${ownGap.toFixed(1)}, want ≥10)`);
      }
      // Also clear of stack/name text box inside the plate
      const textEl =
        dealerPlateEl.querySelector?.('.nm, .ch, .st, b, strong') || dealerPlateEl;
      const textGap = edgeGap(dBox, box(textEl));
      if (textGap < 10) {
        issues.push(`dealer too close to nameplate text (gap=${textGap.toFixed(1)}, want ≥10)`);
      }
      const ownDist = distToPlate(box(dealerPlateEl));
      plates.forEach((el, j) => {
        if (el === dealerPlateEl) return;
        const od = distToPlate(box(el));
        if (od <= ownDist + 1) {
          issues.push(
            `dealer nearer to plate[${j}] (${od.toFixed(1)}) than button plate (${ownDist.toFixed(1)})`,
          );
        }
        const g = edgeGap(dBox, box(el));
        if (g < 10) {
          issues.push(`dealer too close to plate[${j}] (gap=${g.toFixed(1)}, want ≥10)`);
        }
      });
      if (ownDist > 48) issues.push(`dealer too far from button plate (edgeDist=${ownDist.toFixed(1)})`);
    }
    for (const bk of backs) {
      const g = edgeGap(dBox, box(bk));
      if (g < 10) issues.push(`dealer too close to card backs (gap=${g.toFixed(1)})`);
    }
    const minObstacleGap = 10;
    for (const bet of bets) {
      const bb = box(bet);
      if (bb.left < -500) continue;
      const g = edgeGap(dBox, bb);
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
      if (overlaps(dBox, box(c)) || edgeGap(dBox, box(c)) < 10) {
        issues.push('dealer too close to hero hole card');
      }
    }
    for (const c of revealCards) {
      if (overlaps(dBox, box(c)) || edgeGap(dBox, box(c)) < 10) {
        issues.push('dealer too close to revealed card');
      }
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

/** Fold-win showdown; force every pending seat to SHOW (hero-sized reveals). */
async function forceAllSeatsRevealed(page) {
  return page.evaluate(() => {
    const api = window.__poker;
    if (!api) return { ok: false, error: 'no __poker' };
    const origRandom = Math.random;
    // Bots in beginRevealUi: Math.random() < 0.5 → SHOW when 0
    Math.random = () => 0;

    const street = new Set(['preflop', 'flop', 'turn', 'river']);
    let raised = false;
    let steps = 0;
    while (steps++ < 160) {
      const st = api.getState();
      if (st.phase === 'showdown') break;
      if (st.phase === 'hand_over') {
        // Auto-next may have fired — start another hand
        try {
          api.dispatch({ type: 'ACK_HAND' });
          api.dispatch({ type: 'NEXT_HAND' });
          raised = false;
          continue;
        } catch (e) {
          Math.random = origRandom;
          return { ok: false, error: 'hand_over: ' + (e.message || e) };
        }
      }
      if (!street.has(st.phase) || st.actor == null) break;
      const actor = st.actor;
      const live = st.seats.filter((p) => p && !p.folded && !p.sittingOut);
      if (live.length <= 1) break;
      // Open a bet so others can fold (fold only legal when facing a bet)
      if (!raised) {
        try {
          const bb = st.config.bigBlind;
          const p = st.seats[actor];
          const minTo = Math.max(st.minRaiseTo || bb * 2, (st.currentBet || 0) + bb);
          const to = Math.min(minTo, p.bet + p.chips);
          api.dispatch({ type: 'BET_RAISE', seat: actor, amount: to });
          raised = true;
          continue;
        } catch (_) {
          /* actor cannot raise — fall through */
        }
      }
      try {
        api.dispatch({ type: 'FOLD', seat: actor });
      } catch {
        try {
          api.dispatch({ type: 'CHECK', seat: actor });
        } catch {
          try {
            api.dispatch({ type: 'CALL', seat: actor });
          } catch (e) {
            Math.random = origRandom;
            return { ok: false, error: String(e.message || e) };
          }
        }
      }
    }

    let st = api.getState();
    if (st.phase !== 'showdown') {
      Math.random = origRandom;
      return { ok: false, error: `stuck in ${st.phase}` };
    }

    api.cancelAutoNext?.();

    // SHOW any remaining pending (viewer + anyone bots skipped)
    const viewer = api.getViewer();
    const pending = [...(st.showdown?.pending || [])];
    for (const seat of pending) {
      if (!api.getState().showdown?.pending?.includes(seat)) continue;
      try {
        api.dispatch({ type: 'SHOW', seat, mode: 'both' });
      } catch (e) {
        Math.random = origRandom;
        return { ok: false, error: String(e.message || e) };
      }
    }
    // If hand_over already, re-SHOW is N/A — but we need DOM reveals.
    // beginRevealUi bots already SHOW'd others while Math.random=0.
    api.setViewer(viewer);
    // Re-render by pinning viewer
    api.setViewer(viewer);

    st = api.getState();
    Math.random = origRandom;

    // Prevent auto next from clearing holes during audit: noop if already over
    const revealedDom = document.querySelectorAll('.reveal-hole .card').length;
    const occ = st.seats.map((p, i) => (p ? i : null)).filter((x) => x != null);
    return {
      ok: true,
      phase: st.phase,
      occupied: occ.length,
      pendingLeft: st.showdown?.pending?.length ?? 0,
      revealedDom,
      foldWin: !!(st.showdown?.foldWin || st.lastHandSummary?.foldWin),
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
    const plate = seatEl.querySelector('.plate, .plateA');
    if (!hole) {
      issues.push(`reveal cards do not fit at seat ${seat} (no reveal-hole)`);
      continue;
    }
    if (!seatEl.classList.contains('is-showing')) {
      issues.push(`seat ${seat} revealed but missing .is-showing (nameplate may be dimmed)`);
    }
    const plateOp = plate ? parseFloat(getComputedStyle(plate).opacity) : 1;
    if (plateOp < 0.9) {
      issues.push(`seat ${seat} nameplate dimmed while showing (opacity=${plateOp})`);
    }
    const cards = [...hole.querySelectorAll('.card')];
    if (cards.length < 2) {
      issues.push(`reveal cards do not fit at seat ${seat} (expected 2 cards)`);
    }
    const holeBox = box(hole);
    if (plate) {
      const pb = box(plate);
      // Reveals must sit above the nameplate (bottom of cards ≤ top of plate + 2px)
      if (holeBox.bottom > pb.top + 2) {
        issues.push(
          `seat ${seat} reveal covers nameplate (reveal.bottom=${holeBox.bottom.toFixed(1)} plate.top=${pb.top.toFixed(1)})`,
        );
      }
      for (const card of cards) {
        if (overlaps(box(card), pb)) {
          issues.push(`seat ${seat} reveal card overlaps nameplate`);
        }
      }
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
        if (out) {
          issues.push(
            `reveal cards do not fit at seat ${seat} viewport=${window.innerWidth}x${window.innerHeight} (clipped outside stage)`,
          );
        }
      }
    }
  }

  // WIN badge must not cover hero hole cards
  const winBadge = document.querySelector('#meRoot > .win-badge, .me .win-badge');
  if (winBadge && heroRef) {
    const wb = box(winBadge);
    for (const c of document.querySelectorAll('#heroHole .card')) {
      if (overlaps(wb, box(c))) {
        issues.push('WIN badge overlaps hero hole cards');
      }
    }
  }

  // Centre fold-win note must not cover any revealed / hero cards
  const noteEl = document.querySelector('.table-note');
  if (noteEl && getComputedStyle(noteEl).display !== 'none') {
    const nb = box(noteEl);
    for (const c of document.querySelectorAll('.reveal-hole .card, #heroHole .card')) {
      if (overlaps(nb, box(c))) {
        issues.push(
          `table-note overlaps revealed/hero card (viewport=${window.innerWidth}x${window.innerHeight} seats=${seatCount})`,
        );
        break;
      }
    }
    for (const hole of document.querySelectorAll('.reveal-hole')) {
      if (overlaps(nb, box(hole))) {
        issues.push(
          `table-note overlaps reveal-hole (viewport=${window.innerWidth}x${window.innerHeight} seats=${seatCount})`,
        );
        break;
      }
    }
  }

  // No timer ring on the hero nameplate (idle ⊖ sat on the gold border)
  const timerEl = document.querySelector('#mePlate .timer, .meinfo .timer');
  if (timerEl) {
    const cs = getComputedStyle(timerEl);
    const visible =
      !timerEl.hasAttribute('hidden') &&
      cs.display !== 'none' &&
      cs.visibility !== 'hidden' &&
      parseFloat(cs.opacity || '1') > 0.05;
    if (visible) issues.push('hero nameplate must not show a timer ring');
  }

  // No stray chips at table top-left (unplaced bets / FX)
  const tableEl = document.querySelector('.table');
  if (tableEl) {
    const tb = box(tableEl);
    for (const el of document.querySelectorAll('#bets .bet, .fx-chip-fly')) {
      const b = box(el);
      if (b.w < 1 || b.h < 1) continue;
      if (b.left < tb.left + 8 && b.top < tb.top + 8) {
        issues.push('stray chip near table top-left');
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

  const seatOfEl = (el) => {
    const seatEl = el?.closest?.('.seat[data-seat]');
    if (seatEl) return seatEl.dataset.seat;
    if (el?.closest?.('#meRoot, .meinfo, #heroHole')) return 'hero';
    return null;
  };
  const kind = (name) => name.replace(/\[\d+\]/, '');
  // Rebuild with elements for seat checks
  const tagged = [];
  const add = (name, el) => {
    if (!el || getComputedStyle(el).display === 'none') return;
    tagged.push({ name, el, b: box(el) });
  };
  [...document.querySelectorAll('.seat .plate, .seat .plateA, .meinfo')].forEach((el, i) => add(`plate[${i}]`, el));
  [...document.querySelectorAll('.backs')].forEach((el, i) => add(`backs[${i}]`, el));
  [...document.querySelectorAll('#bets .bet')].forEach((el, i) => add(`bet[${i}]`, el));
  add('dealer', document.getElementById('dealer'));
  add('pot', document.querySelector('.pot'));
  [...document.querySelectorAll('#board .card')].forEach((el, i) => add(`board[${i}]`, el));
  [...document.querySelectorAll('#heroHole .card')].forEach((el, i) => add(`hero[${i}]`, el));
  add('act', document.getElementById('act'));
  add('note', document.querySelector('.table-note'));
  revealCards.forEach((el, i) => add(`reveal[${i}]`, el));

  for (let i = 0; i < tagged.length; i++) {
    for (let j = i + 1; j < tagged.length; j++) {
      const a = tagged[i];
      const b = tagged[j];
      const ka = kind(a.name);
      const kb = kind(b.name);
      if ((ka === 'plate' && kb === 'backs') || (ka === 'backs' && kb === 'plate')) {
        if (seatOfEl(a.el) != null && seatOfEl(a.el) === seatOfEl(b.el)) continue;
      }
      if (ka === 'hero' && kb === 'hero') continue;
      if (ka === 'reveal' && kb === 'reveal' && seatOfEl(a.el) === seatOfEl(b.el)) continue;
      // Note must never overlap reveals / hero cards / board (plates OK if note is in the bar)
      if (
        (ka === 'note' || kb === 'note') &&
        ({ reveal: 1, hero: 1, board: 1 }[ka] || { reveal: 1, hero: 1, board: 1 }[kb])
      ) {
        if (overlaps(a.b, b.b)) {
          issues.push(`showdown: ${a.name} overlaps ${b.name}`);
        }
        continue;
      }
      if ((ka === 'note' && kb === 'plate') || (ka === 'plate' && kb === 'note')) {
        const noteNode = ka === 'note' ? a.el : b.el;
        // Bar note sits in #act; ignore plate AABB collisions there
        if (noteNode?.classList?.contains('is-bar') || noteNode?.closest?.('#act')) continue;
      }
      // Hero hole may tuck into own plate; reveals must NOT cover plates
      if (
        ({ plate: 1, hero: 1 }[ka] && { plate: 1, hero: 1 }[kb]) &&
        seatOfEl(a.el) != null &&
        seatOfEl(a.el) === seatOfEl(b.el)
      ) {
        continue;
      }
      if ((ka === 'dealer' && kb === 'plate') || (ka === 'plate' && kb === 'dealer')) {
        const ox = Math.min(a.b.right, b.b.right) - Math.max(a.b.left, b.b.left);
        const oy = Math.min(a.b.bottom, b.b.bottom) - Math.max(a.b.top, b.b.top);
        let gap;
        if (ox > 0 && oy > 0) gap = -Math.min(ox, oy);
        else if (ox > 0) gap = Math.max(a.b.top - b.b.bottom, b.b.top - a.b.bottom);
        else if (oy > 0) gap = Math.max(a.b.left - b.b.right, b.b.left - a.b.right);
        else gap = 99;
        if (gap < 10) {
          issues.push(`showdown: dealer vs plate gap ${gap.toFixed(1)} (want ≥10)`);
        }
        continue;
      }
      if (overlaps(a.b, b.b)) {
        issues.push(`showdown: ${a.name} overlaps ${b.name}`);
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
  await page.evaluate(() => window.__poker?.cancelAutoNext?.());
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
    const sheet = scr?.querySelector('.sheet');
    scr.classList.add('is-on');
    const rows = Array.from({ length: 24 }, (_, i) => {
      const n = `測試玩家${i + 1}`;
      return `<tr><td>${n}</td><td>2,000</td><td>2,000</td><td class="pos">+0</td></tr>`;
    }).join('');
    body.innerHTML = `
      <div class="summary">
        <p class="lead">捲動測試：確認關閉鈕在矮視窗仍可到達。</p>
        <div id="scrollTestPadSum" style="height:80vh;color:transparent">.</div>
        <table>
          <thead><tr><th>玩家</th><th>買入</th><th>籌碼</th><th>淨勝</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    void sheet;
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
