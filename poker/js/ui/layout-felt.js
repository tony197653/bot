/**
 * Bet chip + dealer D placement (ported from mockup gen.py PLACE rules).
 * GAP ≈ 10px from own nameplate; D stays on felt, clear of bets/pot/cards.
 */

const GAP = 10;

/**
 * Inward direction from a visual seat toward table centre.
 * Top: straight down. Side lowers: ~15° up toward centre.
 */
export const BET_DIR = Object.freeze({
  0: [0, 1],
  1: [-0.85, 0.53],
  2: [-0.966, -0.259],
  3: [0.966, -0.259],
  4: [0.85, 0.53],
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
  // Felt inset ≈ 13px of rail (matches mockup .felt{inset:13px})
  const inset = Math.min(t.width, t.height) * 0.036;
  return {
    cx: t.left + t.width / 2,
    cy: t.top + t.height / 2,
    rx: t.width / 2 - inset,
    ry: t.height / 2 - inset,
    table: t,
  };
}

function inFelt(F, x, y) {
  return ((x - F.cx) / F.rx) ** 2 + ((y - F.cy) / F.ry) ** 2 <= 1;
}

/**
 * Place each #bets .bet ~GAP px from its seat plate, toward the felt.
 * Right-side seats flip to amount-then-chip ("20 ●").
 * @returns {{ok:boolean, gaps: Record<string,number>, issues:string[]}}
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
  const D = dealer && getComputedStyle(dealer).display !== 'none' ? uni(dealer) : null;

  const bets = [...document.querySelectorAll('#bets .bet')];
  // Top seat first → its plate→chip distance becomes the shared reference (gen.py)
  bets.sort((a, b) => (b.dataset.ref ? 1 : 0) - (a.dataset.ref ? 1 : 0));
  let REF = 0;

  for (const b of bets) {
    const seatKey = b.dataset.pos || (b.dataset.hero === '1' ? 'hero' : '');
    const seatEl =
      b.dataset.hero === '1'
        ? document.querySelector('.heroA, #meRoot')
        : document.querySelector(`.seat[data-seat="${b.dataset.forSeat}"]`);
    if (!seatEl) {
      issues.push(`bet missing seat ${b.dataset.forSeat}`);
      continue;
    }
    const sBox = uni(seatEl);
    const plate =
      seatEl.querySelector('.plateA, .plate, .meinfo') || seatEl;
    const p = plate.getBoundingClientRect();
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
    const side = Math.abs(ux) > 0.9;
    if (side && ux < 0) b.classList.add('is-rtl');
    else b.classList.remove('is-rtl');

    // Hero: just above upper-left of hole cards when present
    if (b.dataset.hero === '1') {
      const hole = document.querySelector('#heroHole');
      if (hole && hole.children.length) {
        const hr = hole.getBoundingClientRect();
        const w = b.offsetWidth;
        const h = b.offsetHeight;
        const l = hr.left - 4;
        const tp = hr.top - h - GAP;
        b.style.left = `${((l - F.table.left) / F.table.width) * 100}%`;
        b.style.top = `${((tp - F.table.top) / F.table.height) * 100}%`;
        b.style.transform = 'none';
        gaps.hero = GAP;
        continue;
      }
    }

    const w = b.offsetWidth;
    const h = b.offsetHeight;
    const chipOff = !side ? w / 2 : ux < 0 ? w - 8 : 8;
    let placed = false;
    for (let t = REF || GAP; t < 420; t += 0.5) {
      const cx = px + ux * t;
      const cy = py + uy * t;
      const l = cx - chipOff;
      const tp = cy - h / 2;
      const g = gapR(sBox, l, tp, w, h);
      const gd = D ? gapR(D, l, tp, w, h) : 99;
      if (
        g >= GAP &&
        gd >= GAP &&
        inFelt(F, l, tp) &&
        inFelt(F, l + w, tp) &&
        inFelt(F, l, tp + h) &&
        inFelt(F, l + w, tp + h)
      ) {
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
    if (!placed) issues.push(`bet seat ${b.dataset.forSeat} could not place with GAP=${GAP}`);
  }
  return { ok: issues.length === 0, gaps, issues };
}

/**
 * Place gold D coin near the button seat, on the felt, away from that seat's bet.
 * Prefers the side of the nameplate opposite the bet direction.
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
      ? document.querySelector('#meRoot, .heroA')
      : document.querySelector(`.seat[data-seat="${seatId}"]`);
  if (!seatEl) return { ok: false, issues: ['no dealer seat'] };

  const plate = seatEl.querySelector('.plateA, .plate, .meinfo') || seatEl;
  const p = plate.getBoundingClientRect();
  const px = (p.left + p.right) / 2;
  const py = (p.top + p.bottom) / 2;
  const bet = document.querySelector(`#bets .bet[data-for-seat="${seatId}"], #bets .bet[data-hero="1"]`);
  // Prefer direction toward centre, then nudge away from bet
  let ux = F.cx - px;
  let uy = F.cy - py;
  const n0 = Math.hypot(ux, uy) || 1;
  ux /= n0;
  uy /= n0;
  // If bet exists along that ray, bias perpendicular
  const dw = dealer.offsetWidth || 20;
  const dh = dealer.offsetHeight || 20;
  const obstacles = [
    ...document.querySelectorAll(
      '.seat .plateA, .seat .plate, .meinfo, #bets .bet, .pot, #board .card, #heroHole .card, .seat .reveal-hole .card',
    ),
  ].map((el) => el.getBoundingClientRect());

  let best = null;
  for (let dist = GAP + 4; dist < 80; dist += 1) {
    for (const ang of [0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2, Math.PI / 2, -Math.PI / 2]) {
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const vx = ux * ca - uy * sa;
      const vy = ux * sa + uy * ca;
      const cx = px + vx * dist;
      const cy = py + vy * dist;
      const l = cx - dw / 2;
      const t = cy - dh / 2;
      if (!inFelt(F, l, t) || !inFelt(F, l + dw, t + dh)) continue;
      const box = { left: l, top: t, right: l + dw, bottom: t + dh };
      let minGap = 99;
      let hit = false;
      for (const o of obstacles) {
        const g = Math.max(o.left - box.right, box.left - o.right, o.top - box.bottom, box.top - o.bottom);
        if (g < GAP) {
          hit = true;
          break;
        }
        minGap = Math.min(minGap, g);
      }
      if (hit) continue;
      // Prefer closer to own plate
      const ownDist = Math.hypot(cx - px, cy - py);
      const score = ownDist - minGap * 0.1;
      if (!best || score < best.score) {
        best = { l, t, score, ownDist };
      }
    }
    if (best && best.ownDist < 36) break;
  }
  const issues = [];
  if (!best) {
    // Fallback: inward from plate centre
    const cx = px + ux * (GAP + 14);
    const cy = py + uy * (GAP + 14);
    dealer.style.left = `${(((cx - dw / 2) - F.table.left) / F.table.width) * 100}%`;
    dealer.style.top = `${(((cy - dh / 2) - F.table.top) / F.table.height) * 100}%`;
    dealer.style.transform = 'none';
    issues.push('dealer fallback placement');
  } else {
    dealer.style.left = `${((best.l - F.table.left) / F.table.width) * 100}%`;
    dealer.style.top = `${((best.t - F.table.top) / F.table.height) * 100}%`;
    dealer.style.transform = 'none';
  }
  return { ok: issues.length === 0, issues };
}

export { GAP as BET_GAP };
