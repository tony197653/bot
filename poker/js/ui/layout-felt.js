/**
 * Bet chip + dealer D placement (mockup gen.py PLACE rules).
 * Bets ≈10px from own nameplate edge; D ≥10px from every nameplate / backs / cards.
 */

const GAP = 10;

/**
 * Inward direction from visual seat toward table centre.
 * Top: straight down. Bottom sides: ~15° up (±0.966, -0.259). Top sides: inward + slight down.
 */
export const BET_DIR = Object.freeze({
  0: [0, 1],
  1: [-0.966, 0.259],
  2: [-0.966, -0.259],
  3: [0.966, -0.259],
  4: [0.966, 0.259],
  hero: [0, -1],
});

function uni(el) {
  const r = el.getBoundingClientRect();
  let L = r.left;
  let T = r.top;
  let R = r.right;
  let B = r.bottom;
  el.querySelectorAll('*').forEach((c) => {
    const q = c.getBoundingClientRect();
    if (q.width && q.height) {
      L = Math.min(L, q.left);
      T = Math.min(T, q.top);
      R = Math.max(R, q.right);
      B = Math.max(B, q.bottom);
    }
  });
  return { L, T, R, B, w: R - L, h: B - T };
}

function gapR(a, l, t, w, h) {
  return Math.max(l - a.R, a.L - (l + w), t - a.B, a.T - (t + h));
}

function feltEllipse(tableEl) {
  const t = tableEl.getBoundingClientRect();
  // Expand past the rail so near-plate bets (~10px in) still count as on-felt.
  // gen.py used a felt ellipse that already included the near-rail band.
  const pad = Math.max(18, Math.min(t.width, t.height) * 0.04);
  return {
    cx: t.left + t.width / 2,
    cy: t.top + t.height / 2,
    rx: t.width / 2 + pad,
    ry: t.height / 2 + pad,
    table: t,
  };
}

function inFelt(F, x, y) {
  return ((x - F.cx) / F.rx) ** 2 + ((y - F.cy) / F.ry) ** 2 <= 1.08;
}

/** Plate (+ optional backs) chrome for gap measurement — exclude reveal-hole. */
function seatChrome(seatEl) {
  const plate = seatEl.querySelector('.plateA, .plate, .meinfo') || seatEl;
  const p = plate.getBoundingClientRect();
  let L = p.left;
  let T = p.top;
  let R = p.right;
  let B = p.bottom;
  seatEl.querySelectorAll('.backs').forEach((c) => {
    const q = c.getBoundingClientRect();
    if (q.width && q.height) {
      L = Math.min(L, q.left);
      T = Math.min(T, q.top);
      R = Math.max(R, q.right);
      B = Math.max(B, q.bottom);
    }
  });
  return { L, T, R, B, w: R - L, h: B - T, plate: p };
}

/**
 * Place each #bets .bet ~GAP px from its seat nameplate toward the felt.
 * Right-side seats flip to amount-then-chip ("20 ●").
 */
export function placeBets() {
  const table = document.querySelector('.table');
  const issues = [];
  /** @type {Record<string, number>} */
  const gaps = {};
  if (!table) return { ok: false, gaps, issues: ['no table'] };
  const F = feltEllipse(table);
  const C = { x: F.cx, y: F.cy };
  const dealer = document.querySelector('.dcoin, #dealer');
  const D =
    dealer &&
    getComputedStyle(dealer).display !== 'none' &&
    dealer.style.left &&
    dealer.style.left !== '50%'
      ? uni(dealer)
      : dealer && getComputedStyle(dealer).display !== 'none'
        ? uni(dealer)
        : null;

  const bets = [...document.querySelectorAll('#bets .bet')];
  // Top seat first → shared plate-centre→chip-centre distance (gen.py REF)
  bets.sort((a, b) => (b.dataset.ref ? 1 : 0) - (a.dataset.ref ? 1 : 0));
  let REF = 0;

  for (const b of bets) {
    const seatKey = b.dataset.pos || (b.dataset.hero === '1' ? 'hero' : '');
    const seatEl =
      b.dataset.hero === '1'
        ? document.querySelector('#meRoot')
        : document.querySelector(`.seat[data-seat="${b.dataset.forSeat}"]`);
    if (!seatEl) {
      issues.push(`bet missing seat ${b.dataset.forSeat}`);
      continue;
    }
    const chrome = seatChrome(seatEl);
    const p = chrome.plate;
    const px = (p.left + p.right) / 2;
    const py = (p.top + p.bottom) / 2;

    let ux;
    let uy;
    const dir = BET_DIR[seatKey] || BET_DIR[b.dataset.pos];
    if (dir) {
      [ux, uy] = dir;
    } else {
      ux = C.x - px;
      uy = C.y - py;
    }
    const n = Math.hypot(ux, uy) || 1;
    ux /= n;
    uy /= n;
    const side = Math.abs(ux) > 0.85;
    if (side && ux < 0) b.classList.add('is-rtl');
    else b.classList.remove('is-rtl');

    // Hero: just above upper-left of hole cards
    if (b.dataset.hero === '1') {
      const hole = document.querySelector('#heroHole');
      const w = b.offsetWidth;
      const h = b.offsetHeight;
      let l;
      let tp;
      if (hole && hole.children.length) {
        const hr = hole.getBoundingClientRect();
        l = hr.left - 4;
        tp = hr.top - h - GAP;
      } else {
        l = p.left;
        tp = p.top - h - GAP;
      }
      b.style.left = `${((l - F.table.left) / F.table.width) * 100}%`;
      b.style.top = `${((tp - F.table.top) / F.table.height) * 100}%`;
      b.style.transform = 'none';
      gaps.hero = GAP;
      continue;
    }

    const w = b.offsetWidth;
    const h = b.offsetHeight;
    // Side seats: chip nearest the player (measure to chip centre)
    const chipOff = !side ? w / 2 : ux < 0 ? w - 8 : 8;
    let placed = false;
    let bestLoose = null;

    // Prefer REF (gen.py) but also search from a small t so near-rail seats can sit at ~10px
    const starts = REF > 0 ? [REF, 4] : [4];
    for (const t0 of starts) {
      if (placed) break;
      for (let t = t0; t < 220; t += 0.5) {
        const cx = px + ux * t;
        const cy = py + uy * t;
        const l = cx - chipOff;
        const tp = cy - h / 2;
        const g = gapR(chrome, l, tp, w, h);
        const gd = D ? gapR(D, l, tp, w, h) : 99;
        const centerOk = inFelt(F, cx, cy);
        if (g >= GAP && g <= 14 && gd >= GAP && centerOk) {
          b.style.left = `${((l - F.table.left) / F.table.width) * 100}%`;
          b.style.top = `${((tp - F.table.top) / F.table.height) * 100}%`;
          b.style.transform = 'none';
          b.dataset.gap = String(Math.round(g));
          gaps[seatKey || b.dataset.forSeat || 'x'] = Math.round(g);
          if (b.dataset.ref) REF = t;
          placed = true;
          break;
        }
        if (
          !bestLoose &&
          g >= GAP &&
          gd >= GAP &&
          centerOk &&
          g <= 28
        ) {
          bestLoose = { l, tp, g, t };
        }
      }
    }
    if (!placed && bestLoose) {
      b.style.left = `${((bestLoose.l - F.table.left) / F.table.width) * 100}%`;
      b.style.top = `${((bestLoose.tp - F.table.top) / F.table.height) * 100}%`;
      b.style.transform = 'none';
      b.dataset.gap = String(Math.round(bestLoose.g));
      gaps[seatKey || b.dataset.forSeat || 'x'] = Math.round(bestLoose.g);
      if (b.dataset.ref) REF = bestLoose.t;
      placed = true;
    }
    if (!placed) {
      // Last resort: walk until g≥GAP with centre on felt (test may still flag >14)
      for (let t = 4; t < 280; t += 0.5) {
        const cx = px + ux * t;
        const cy = py + uy * t;
        const l = cx - chipOff;
        const tp = cy - h / 2;
        const g = gapR(chrome, l, tp, w, h);
        const gd = D ? gapR(D, l, tp, w, h) : 99;
        if (g >= GAP && gd >= GAP && inFelt(F, cx, cy)) {
          b.style.left = `${((l - F.table.left) / F.table.width) * 100}%`;
          b.style.top = `${((tp - F.table.top) / F.table.height) * 100}%`;
          b.style.transform = 'none';
          b.dataset.gap = String(Math.round(g));
          gaps[seatKey || b.dataset.forSeat || 'x'] = Math.round(g);
          if (b.dataset.ref) REF = t;
          placed = true;
          break;
        }
      }
    }
    if (!placed) {
      issues.push(`bet seat ${b.dataset.forSeat} could not place with GAP=${GAP}`);
      // Keep off-screen rather than stray at 0,0
      b.style.left = '-9999px';
      b.style.top = '-9999px';
    }
  }
  return { ok: issues.length === 0, gaps, issues };
}

/**
 * Place gold D ≥GAP from every nameplate (including own), backs, bets, pot, cards.
 * Prefers felt side of the button seat, away from that seat's bet.
 */
export function placeDealer() {
  const table = document.querySelector('.table');
  const dealer = document.getElementById('dealer');
  if (!table || !dealer || getComputedStyle(dealer).display === 'none') {
    return { ok: true, issues: [] };
  }
  const F = feltEllipse(table);
  const seatId = dealer.dataset.forSeat;
  const pos = dealer.dataset.pos || 'hero';
  const seatEl =
    pos === 'hero'
      ? document.querySelector('#meRoot')
      : document.querySelector(`.seat[data-seat="${seatId}"]`);
  if (!seatEl) return { ok: false, issues: ['no dealer seat'] };

  const plate = seatEl.querySelector('.plateA, .plate, .meinfo') || seatEl;
  const p = plate.getBoundingClientRect();
  const px = (p.left + p.right) / 2;
  const py = (p.top + p.bottom) / 2;
  const dw = dealer.offsetWidth || 20;
  const dh = dealer.offsetHeight || 20;

  // ALL nameplates + backs + cards are hard obstacles (incl. own plate).
  // Skip bets still parked at 0,0 (not yet placed).
  const obstacles = [
    ...document.querySelectorAll(
      '.seat .plateA, .seat .plate, .meinfo, .backs, .reveal-hole, .pot, #board .card, #heroHole .card',
    ),
  ]
    .map((el) => el.getBoundingClientRect())
    .concat(
      [...document.querySelectorAll('#bets .bet')]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          // Ignore unplaced / off-screen bets
          return r.width > 0 && r.left > F.table.left - 20 && r.top > F.table.top - 20;
        })
        .map((el) => el.getBoundingClientRect()),
    );

  let ux = F.cx - px;
  let uy = F.cy - py;
  const n0 = Math.hypot(ux, uy) || 1;
  ux /= n0;
  uy /= n0;

  // Minimum centre-to-centre distance that clears the plate AABB by GAP
  const minDist =
    Math.max(p.width, p.height) / 2 + Math.max(dw, dh) / 2 + GAP;

  /** @type {{x:number,y:number}[]} */
  const candidates = [];
  if (pos === 'hero') {
    // Left of hero plate on felt (mockup A), clear of hole cards
    for (const dy of [-24, -12, -4, 4, 12, 20]) {
      candidates.push({ x: p.left - GAP - dw / 2 - 2, y: py + dy });
      candidates.push({ x: p.left - GAP - dw / 2 - 16, y: py + dy });
      candidates.push({ x: p.right + GAP + dw / 2 + 2, y: py + dy });
    }
  } else {
    // Toward felt centre, then fan around the plate edge — start past plate+GAP
    for (let dist = minDist; dist < minDist + 80; dist += 1) {
      for (const ang of [0, 0.3, -0.3, 0.6, -0.6, 0.9, -0.9, 1.2, -1.2, Math.PI / 2, -Math.PI / 2]) {
        const ca = Math.cos(ang);
        const sa = Math.sin(ang);
        candidates.push({
          x: px + (ux * ca - uy * sa) * dist,
          y: py + (ux * sa + uy * ca) * dist,
        });
      }
    }
    // Explicit slides along plate edges (felt side)
    const edgePads = [GAP + dh / 2 + 1, GAP + dh / 2 + 8, GAP + dh / 2 + 16];
    for (const pad of edgePads) {
      candidates.push({ x: px, y: p.bottom + pad }); // below plate
      candidates.push({ x: px, y: p.top - pad }); // above
      candidates.push({ x: p.right + pad, y: py });
      candidates.push({ x: p.left - pad, y: py });
      candidates.push({ x: p.right + pad * 0.7, y: p.bottom + pad * 0.7 });
      candidates.push({ x: p.left - pad * 0.7, y: p.bottom + pad * 0.7 });
    }
  }

  let best = null;
  for (const c of candidates) {
    const l = c.x - dw / 2;
    const t = c.y - dh / 2;
    if (!inFelt(F, c.x, c.y)) continue;
    const box = { left: l, top: t, right: l + dw, bottom: t + dh };
    let hit = false;
    let minGap = 99;
    for (const o of obstacles) {
      const g = Math.max(o.left - box.right, box.left - o.right, o.top - box.bottom, box.top - o.bottom);
      if (g < GAP) {
        hit = true;
        break;
      }
      minGap = Math.min(minGap, g);
    }
    if (hit) continue;
    const ownDist = Math.hypot(c.x - px, c.y - py);
    // Prefer close to own plate but still ≥GAP; stay on inward side
    const inward = (c.x - px) * ux + (c.y - py) * uy;
    const score = ownDist + (inward < 0 ? 40 : 0) + (minGap < GAP + 2 ? 12 : 0);
    if (!best || score < best.score) best = { l, t, score, ownDist, minGap };
  }

  const issues = [];
  if (!best) {
    // Last resort: inward from plate edge at GAP + radius
    const cx = px + ux * minDist;
    const cy = py + uy * minDist;
    dealer.style.left = `${((cx - dw / 2 - F.table.left) / F.table.width) * 100}%`;
    dealer.style.top = `${((cy - dh / 2 - F.table.top) / F.table.height) * 100}%`;
    dealer.style.transform = 'none';
    issues.push('dealer fallback placement');
  } else {
    dealer.style.left = `${((best.l - F.table.left) / F.table.width) * 100}%`;
    dealer.style.top = `${((best.t - F.table.top) / F.table.height) * 100}%`;
    dealer.style.transform = 'none';
  }
  return { ok: issues.length === 0, issues };
}

/**
 * Place fold-win centre note under the pot, clear of revealed/hero/board cards.
 * Falls back to the action-bar strip if the felt centre is too crowded.
 */
export function placeTableNote() {
  const note = document.querySelector('.table-note');
  const table = document.querySelector('.table');
  if (!note || !table) return { ok: true, issues: [] };

  note.classList.remove('is-bar');
  note.style.left = '';
  note.style.top = '';
  note.style.transform = '';
  note.style.maxWidth = '';

  const t = table.getBoundingClientRect();
  const pot = document.querySelector('.pot');
  const potBox = pot?.getBoundingClientRect();
  const revealHoles = [...document.querySelectorAll('.reveal-hole')];

  // When opponent cards are revealed, park the note above the action bar so it
  // cannot graze side-seat hero-sized cards on a tall oval table.
  if (revealHoles.length > 0) {
    const act = document.getElementById('act');
    if (act && note.parentElement !== act) act.appendChild(note);
    note.classList.add('is-bar');
    note.style.left = '';
    note.style.top = '';
    note.style.transform = '';
    note.style.maxWidth = '';
    return { ok: true, issues: [] };
  }

  const obstacles = [
    ...document.querySelectorAll(
      '#heroHole .card, #board .card, .backs, .seat .plateA, .seat .plate, .meinfo, #dealer, .win-badge',
    ),
  ]
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0);

  const midX = t.left + t.width / 2;
  const freeW = Math.min(180, t.width * 0.42);
  note.style.maxWidth = `${freeW}px`;

  const overlapsBox = (box, pad = 8) => {
    for (const o of obstacles) {
      const ox = Math.min(box.right, o.right) - Math.max(box.left, o.left);
      const oy = Math.min(box.bottom, o.bottom) - Math.max(box.top, o.top);
      if (ox > pad && oy > pad) return true;
    }
    return false;
  };

  const potBottom = potBox ? potBox.bottom : t.top + t.height * 0.42;
  const yStarts = [potBottom + 8, potBottom + 16, potBottom + 28];

  let placed = false;
  for (const y of yStarts) {
    note.style.left = '50%';
    note.style.top = `${((y - t.top) / t.height) * 100}%`;
    note.style.transform = 'translate(-50%, 0)';
    const nb = note.getBoundingClientRect();
    const box = {
      left: midX - nb.width / 2,
      right: midX + nb.width / 2,
      top: y,
      bottom: y + nb.height,
    };
    if (!overlapsBox(box, 8)) {
      placed = true;
      break;
    }
  }

  if (!placed) {
    note.classList.add('is-bar');
    note.style.left = '';
    note.style.top = '';
    note.style.transform = '';
    note.style.maxWidth = '';
  }

  const issues = [];
  const final = note.getBoundingClientRect();
  for (const el of document.querySelectorAll('.reveal-hole .card, #heroHole .card')) {
    const r = el.getBoundingClientRect();
    const ox = Math.min(final.right, r.right) - Math.max(final.left, r.left);
    const oy = Math.min(final.bottom, r.bottom) - Math.max(final.top, r.top);
    if (ox > 0 && oy > 0) {
      issues.push('table-note still overlaps a revealed/hero card');
      break;
    }
  }
  return { ok: issues.length === 0, issues };
}

export { GAP as BET_GAP };
