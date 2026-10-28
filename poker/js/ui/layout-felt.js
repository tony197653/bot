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

  // When opponent cards are revealed, park the note in a fixed strip above #act
  // (above 下一手), narrow + clear of hero plate AND every revealed card.
  if (revealHoles.length > 0) {
    const tableEl = document.querySelector('.table');
    if (tableEl && note.parentElement !== tableEl) tableEl.appendChild(note);
    note.classList.add('is-bar');
    note.style.left = '';
    note.style.top = '';
    note.style.transform = '';
    note.style.maxWidth = '150px';
    const blockers = [
      ...document.querySelectorAll(
        '#meRoot .meinfo, #heroHole .card, #meRoot .win-badge, .reveal-hole, .reveal-hole .card',
      ),
    ].map((el) => el.getBoundingClientRect());
    const hits = (nb, pad = 8) => {
      for (const o of blockers) {
        const ox = Math.min(nb.right, o.right) - Math.max(nb.left, o.left);
        const oy = Math.min(nb.bottom, o.bottom) - Math.max(nb.top, o.top);
        if (ox > pad && oy > pad) return true;
      }
      return false;
    };
    // Prefer just above the action bar; only rise if something collides
    let bottom = parseFloat(getComputedStyle(note).bottom) || 88;
    note.style.bottom = `${bottom}px`;
    for (let i = 0; i < 16; i++) {
      if (!hits(note.getBoundingClientRect(), 8)) break;
      bottom += 12;
      note.style.bottom = `${bottom}px`;
    }
    // If still colliding after rising (crowded mid-felt), shrink further
    if (hits(note.getBoundingClientRect(), 8)) {
      note.style.maxWidth = '120px';
      for (let i = 0; i < 10; i++) {
        if (!hits(note.getBoundingClientRect(), 8)) break;
        bottom += 10;
        note.style.bottom = `${bottom}px`;
      }
    }
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

function overlapsPad(a, b, pad = 0) {
  const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return ox > pad && oy > pad;
}

function seatPosClass(seatEl) {
  const m = [...seatEl.classList].find((c) => /^pos-\d$/.test(c));
  return m ? Number(m.slice(4)) : 0;
}

/**
 * Park opponent reveal-holes (+ WIN badges) fully inside the viewport,
 * clear of the board / pot / plates / peers by ≥6px.
 * Side seats: inward of the nameplate (toward table centre) with a vertical
 * offset away from the board band. WIN sits above or below the card pair —
 * never on the cards. Does not change bet-chip placement.
 */
export function placeShowdownReveals() {
  const stage = document.querySelector('.stage');
  const table = document.querySelector('.table');
  if (!stage || !table) return { ok: false, issues: ['no stage'] };

  const holes = [...document.querySelectorAll('.seat[data-seat] .reveal-hole')];
  if (!holes.length) return { ok: true, issues: [] };

  const view = {
    left: 0,
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
  };
  const pad = 4;
  const gap = 6;

  /** @type {{ hole: HTMLElement, seat: HTMLElement, pos: number, w: number, h: number, left: number, top: number, badge: HTMLElement|null }[]} */
  const items = [];

  for (const hole of holes) {
    const seat = hole.closest('.seat');
    if (!seat) continue;
    const plate = seat.querySelector('.plateA, .plate');
    if (!plate) continue;
    hole.style.left = '0';
    hole.style.top = '0';
    hole.style.right = 'auto';
    hole.style.bottom = 'auto';
    hole.style.transform = 'none';
    hole.style.margin = '0';
    hole.style.position = 'absolute';

    const pb = plate.getBoundingClientRect();
    const hb = hole.getBoundingClientRect();
    const w = Math.max(hb.width, 1);
    const h = Math.max(hb.height, 1);
    const pos = seatPosClass(seat);

    // Prefer: centred on the plate, nudged slightly toward table centre,
    // vertically away from the board band (above for upper seats, below for lower).
    // 80%-scale cards then fit inside the viewport without rail-edge clipping.
    const midX = (pb.left + pb.right) / 2;
    // Nudge toward table centre so 80% cards sit on the felt, not the screen gutter
    const inward =
      pos === 1 || pos === 2 ? -18 : pos === 3 || pos === 4 ? 18 : 0;
    let left = midX - w / 2 + inward;
    let top;
    if (pos === 2 || pos === 3) {
      top = pb.bottom + gap + 2;
    } else {
      // pos 0 / 1 / 4 — above the plate
      top = pb.top - gap - h;
    }

    const badge = seat.querySelector(':scope > .win-badge');
    items.push({ hole, seat, pos, w, h, left, top, badge });
  }

  const clampItem = (it) => {
    it.left = Math.min(
      Math.max(it.left, view.left + pad),
      view.right - pad - it.w,
    );
    it.top = Math.min(
      Math.max(it.top, view.top + pad),
      view.bottom - pad - it.h,
    );
  };

  const boardCards = [...document.querySelectorAll('#board .card')]
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0);
  let boardBand = null;
  if (boardCards.length) {
    boardBand = {
      left: Math.min(...boardCards.map((r) => r.left)),
      right: Math.max(...boardCards.map((r) => r.right)),
      top: Math.min(...boardCards.map((r) => r.top)),
      bottom: Math.max(...boardCards.map((r) => r.bottom)),
    };
  }

  const enforceBoardBand = (it) => {
    if (!boardBand) return;
    if (it.pos === 2 || it.pos === 3) {
      it.top = Math.max(it.top, boardBand.bottom + gap);
    } else if (it.pos === 0 || it.pos === 1 || it.pos === 4) {
      it.top = Math.min(it.top, boardBand.top - gap - it.h);
    }
  };

  for (const it of items) {
    clampItem(it);
    enforceBoardBand(it);
    clampItem(it);
  }

  const staticObstacles = () => {
    const list = [];
    for (const el of document.querySelectorAll(
      '#board .card, .pot, #heroHole .card, #meRoot > .win-badge, .meinfo',
    )) {
      if (getComputedStyle(el).display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      list.push({ r, el });
    }
    for (const el of document.querySelectorAll('.seat .plateA, .seat .plate')) {
      const r = el.getBoundingClientRect();
      if (r.width < 1) continue;
      list.push({ r, el });
    }
    return list;
  };

  for (let iter = 0; iter < 56; iter++) {
    let moved = false;
    const staticObs = staticObstacles();
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const box = {
        left: it.left,
        right: it.left + it.w,
        top: it.top,
        bottom: it.top + it.h,
      };
      let dx = 0;
      let dy = 0;

      const pushFrom = (obs) => {
        // Require ≥gap clear — treat pad as soft separation target
        if (!overlapsPad(box, obs, gap)) return;
        const cx = (box.left + box.right) / 2;
        const cy = (box.top + box.bottom) / 2;
        const ox = (obs.left + obs.right) / 2;
        const oy = (obs.top + obs.bottom) / 2;
        let vx = cx - ox;
        let vy = cy - oy;
        // Prefer vertical escape away from the board
        if (it.pos === 2 || it.pos === 3) vy += 1.4;
        if (it.pos === 1 || it.pos === 4 || it.pos === 0) vy -= 1.4;
        const n = Math.hypot(vx, vy) || 1;
        dx += (vx / n) * 5;
        dy += (vy / n) * 5;
      };

      for (const { r, el } of staticObs) {
        const ownPlate = el.closest?.('.seat') === it.seat;
        if (ownPlate) {
          if (overlapsPad(box, r, gap - 0.5)) {
            if (it.pos === 2 || it.pos === 3) {
              dy += Math.max(4, r.bottom + gap - box.top);
            } else {
              dy -= Math.max(4, box.bottom + gap - r.top);
            }
          }
          continue;
        }
        pushFrom(r);
      }

      for (let j = 0; j < items.length; j++) {
        if (i === j) continue;
        const o = items[j];
        const ob = {
          left: o.left,
          right: o.left + o.w,
          top: o.top,
          bottom: o.top + o.h,
        };
        if (!overlapsPad(box, ob, gap)) continue;
        // Peer resolve: prefer horizontal split for top-band seats
        const cx = (box.left + box.right) / 2;
        const ox = (ob.left + ob.right) / 2;
        const cy = (box.top + box.bottom) / 2;
        const oy = (ob.top + ob.bottom) / 2;
        let vx = cx - ox;
        let vy = cy - oy;
        if (Math.abs(vx) < 0.1 && Math.abs(vy) < 0.1) vx = it.pos <= o.pos ? -1 : 1;
        if (
          (it.pos === 0 || it.pos === 1 || it.pos === 4) &&
          (o.pos === 0 || o.pos === 1 || o.pos === 4)
        ) {
          vx *= 1.6;
          vy *= 0.4;
        }
        const n = Math.hypot(vx, vy) || 1;
        dx += (vx / n) * 6;
        dy += (vy / n) * 6;
      }

      if (Math.abs(dx) > 0.4 || Math.abs(dy) > 0.4) {
        it.left += dx;
        it.top += dy;
        clampItem(it);
        enforceBoardBand(it);
        clampItem(it);
        moved = true;
      }
    }
    if (!moved) break;
  }

  // Final own-plate snap: lower seats must sit fully below plate + gap
  for (const it of items) {
    const plate = it.seat.querySelector('.plateA, .plate');
    if (!plate) continue;
    const pb = plate.getBoundingClientRect();
    if (it.pos === 2 || it.pos === 3) {
      it.top = Math.max(it.top, pb.bottom + gap);
    } else if (it.pos === 0) {
      it.top = Math.min(it.top, pb.top - gap - it.h);
    }
    clampItem(it);
    enforceBoardBand(it);
    clampItem(it);
  }

  // Commit + park WIN badge above (preferred) or below the card pair — never on it
  for (const it of items) {
    const sb = it.seat.getBoundingClientRect();
    it.hole.style.position = 'absolute';
    it.hole.style.left = `${it.left - sb.left}px`;
    it.hole.style.top = `${it.top - sb.top}px`;
    it.hole.style.right = 'auto';
    it.hole.style.bottom = 'auto';
    it.hole.style.transform = 'none';
    it.hole.style.margin = '0';
    it.hole.style.zIndex = '5';

    if (!it.badge) continue;
    const badgeH = it.badge.offsetHeight || 22;
    const badgeW = it.badge.offsetWidth || 72;
    const plate = it.seat.querySelector('.plateA, .plate');
    const pb = plate?.getBoundingClientRect();

    const hits = (l, t, obs) => {
      if (!obs) return false;
      const r = l + badgeW;
      const b = t + badgeH;
      return (
        Math.min(r, obs.right) - Math.max(l, obs.left) > 0 &&
        Math.min(b, obs.bottom) - Math.max(t, obs.top) > 0
      );
    };
    const holeBox = {
      left: it.left,
      right: it.left + it.w,
      top: it.top,
      bottom: it.top + it.h,
    };

    // Candidates ordered away from the nameplate:
    // lower seats (cards below plate) → badge below cards first;
    // upper seats (cards above plate) → badge above cards first.
    const above = {
      left: it.left + it.w / 2 - badgeW / 2,
      top: it.top - badgeH - gap,
    };
    const below = {
      left: it.left + it.w / 2 - badgeW / 2,
      top: it.top + it.h + gap,
    };
    const candidates =
      it.pos === 2 || it.pos === 3 ? [below, above] : [above, below];
    let chosen = null;
    for (const c of candidates) {
      c.left = Math.min(
        Math.max(c.left, view.left + pad),
        view.right - pad - badgeW,
      );
      c.top = Math.min(
        Math.max(c.top, view.top + pad),
        view.bottom - pad - badgeH,
      );
      if (hits(c.left, c.top, holeBox)) continue;
      if (pb && hits(c.left, c.top, pb)) continue;
      if (boardBand && hits(c.left, c.top, boardBand)) continue;
      let peerHit = false;
      for (const o of items) {
        if (o === it) continue;
        if (
          hits(c.left, c.top, {
            left: o.left,
            right: o.left + o.w,
            top: o.top,
            bottom: o.top + o.h,
          })
        ) {
          peerHit = true;
          break;
        }
      }
      if (peerHit) continue;
      chosen = c;
      break;
    }
    if (!chosen) {
      // Fallback: above, clamped — still keep clear of the card AABB vertically
      chosen = {
        left: Math.min(
          Math.max(it.left + it.w / 2 - badgeW / 2, view.left + pad),
          view.right - pad - badgeW,
        ),
        top: Math.max(view.top + pad, it.top - badgeH - 4),
      };
      if (chosen.top + badgeH > it.top) {
        chosen.top = Math.min(it.top + it.h + 4, view.bottom - pad - badgeH);
      }
    }

    it.badge.style.position = 'absolute';
    it.badge.style.left = `${chosen.left - sb.left + badgeW / 2}px`;
    it.badge.style.top = `${chosen.top - sb.top}px`;
    it.badge.style.bottom = 'auto';
    it.badge.style.right = 'auto';
    it.badge.style.transform = 'translateX(-50%)';
    it.badge.style.zIndex = '6';
  }

  // Second pass: clear of rotated card AABBs (hole flex box understates height)
  for (const it of items) {
    if (!it.badge) continue;
    const sb = it.seat.getBoundingClientRect();
    const cards = [...it.hole.querySelectorAll('.card')].map((c) =>
      c.getBoundingClientRect(),
    );
    if (!cards.length) continue;
    const cardBand = {
      left: Math.min(...cards.map((r) => r.left)),
      right: Math.max(...cards.map((r) => r.right)),
      top: Math.min(...cards.map((r) => r.top)),
      bottom: Math.max(...cards.map((r) => r.bottom)),
    };
    const bb = it.badge.getBoundingClientRect();
    if (bb.width < 1) continue;
    const covers =
      Math.min(bb.right, cardBand.right) - Math.max(bb.left, cardBand.left) > 0 &&
      Math.min(bb.bottom, cardBand.bottom) - Math.max(bb.top, cardBand.top) > 0;
    const badgeH = bb.height || 22;
    const badgeW = bb.width || 72;
    let top;
    let left = (cardBand.left + cardBand.right) / 2 - badgeW / 2;
    const above = cardBand.top - badgeH - gap;
    const below = cardBand.bottom + gap;
    left = Math.min(Math.max(left, view.left + pad), view.right - pad - badgeW);
    const plate = it.seat.querySelector('.plateA, .plate');
    const pb = plate?.getBoundingClientRect();
    const clearOfPlate = (t) => {
      if (!pb) return true;
      return !(
        Math.min(t + badgeH, pb.bottom) - Math.max(t, pb.top) > 0 &&
        Math.min(left + badgeW, pb.right) - Math.max(left, pb.left) > 0
      );
    };
    const clearOfCards = (t) =>
      !(
        Math.min(t + badgeH, cardBand.bottom) - Math.max(t, cardBand.top) > 0 &&
        Math.min(left + badgeW, cardBand.right) - Math.max(left, cardBand.left) > 0
      );
    const gapToCards = (t) => {
      const oy = Math.min(t + badgeH, cardBand.bottom) - Math.max(t, cardBand.top);
      const ox =
        Math.min(left + badgeW, cardBand.right) - Math.max(left, cardBand.left);
      if (ox > 0 && oy > 0) return -Math.min(ox, oy);
      if (ox > 0) return Math.max(t - cardBand.bottom, cardBand.top - (t + badgeH));
      return 99;
    };
    // Already clear of cards (≥gap) + plate?
    if (
      !covers &&
      clearOfPlate(bb.top) &&
      clearOfCards(bb.top) &&
      gapToCards(bb.top) >= gap
    ) {
      continue;
    }
    // Prefer the side away from the plate
    const preferBelow = it.pos === 2 || it.pos === 3;
    const order = preferBelow ? [below, above] : [above, below];
    top = order[0];
    for (const cand of order) {
      const t = Math.min(Math.max(cand, view.top + pad), view.bottom - pad - badgeH);
      if (clearOfCards(t) && clearOfPlate(t) && gapToCards(t) >= gap - 0.5) {
        top = t;
        break;
      }
      top = t;
    }
    it.badge.style.left = `${left - sb.left + badgeW / 2}px`;
    it.badge.style.top = `${top - sb.top}px`;
  }

  return { ok: true, issues: [] };
}

export { GAP as BET_GAP };
