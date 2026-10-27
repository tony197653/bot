/**
 * Map engine seats → on-screen positions.
 * Six visual slots are FIXED around the table. The viewer is always at
 * bottom-center; every other engine seat maps by relative index
 * `(seat - viewer + 6) % 6` so adding a player fills an empty slot without
 * reshuffling the others. Clockwise order (and SB/BB adjacency) is preserved.
 *
 * Visual pos ids (CSS .seat.pos-N), clockwise from hero (bottom-center):
 *   3 = bottom-left, 4 = top-left, 0 = top, 1 = top-right, 2 = bottom-right
 */

/** Opponent ring slots in clockwise order starting just left of hero. */
export const CW_OPPONENT_SLOTS = [3, 4, 0, 1, 2];

/**
 * Relative offset 1..5 → visual pos id.
 * rel 0 is the viewer (hero / bottom-center).
 */
export const SLOT_BY_REL = Object.freeze({
  1: 3,
  2: 4,
  3: 0,
  4: 1,
  5: 2,
});

/**
 * @deprecated Prefer fixed relative mapping; kept for tests that list CW slots.
 * With fixed seats, N opponents use the first N clockwise slots.
 */
export function opponentSlotsForCount(oppCount) {
  const n = Math.max(0, Math.min(5, oppCount | 0));
  return CW_OPPONENT_SLOTS.slice(0, n);
}

/**
 * Occupied engine seats in clockwise order starting at `fromSeat`.
 * @param {number[]} occupied
 * @param {number} fromSeat
 * @returns {number[]}
 */
export function clockwiseFrom(occupied, fromSeat) {
  const occ = [...new Set(occupied)].sort((a, b) => a - b);
  if (!occ.length) return [];
  const start = occ.indexOf(fromSeat);
  if (start < 0) throw new Error('fromSeat not occupied: ' + fromSeat);
  const out = [];
  for (let i = 0; i < occ.length; i++) {
    out.push(occ[(start + i) % occ.length]);
  }
  return out;
}

/**
 * Visual slot for an engine seat when `viewerSeat` sits at bottom-center.
 * @param {number} seat
 * @param {number} viewerSeat
 * @returns {number|'hero'}
 */
export function seatVisualPos(seat, viewerSeat) {
  const rel = (seat - viewerSeat + 6) % 6;
  if (rel === 0) return 'hero';
  return SLOT_BY_REL[rel];
}

/**
 * Deal order: two rounds of hole cards, clockwise starting at SB.
 * @param {number[]} occupied
 * @param {number} sbSeat
 * @returns {number[]} length = occupied.length * 2
 */
export function dealOrderFromSb(occupied, sbSeat) {
  const round = clockwiseFrom(occupied, sbSeat);
  return [...round, ...round];
}

/**
 * @param {number[]} occupied
 * @param {number} viewerSeat
 * @returns {{
 *   order: number[],
 *   seatToPos: Map<number, number|'hero'>,
 *   emptySlots: number[],
 *   slots: number[],
 * }}
 */
export function mapSeatsClockwise(occupied, viewerSeat) {
  const order = clockwiseFrom(occupied, viewerSeat);
  if (order[0] !== viewerSeat) {
    throw new Error('clockwiseFrom must start at viewer');
  }
  /** @type {Map<number, number|'hero'>} */
  const seatToPos = new Map();
  const used = new Set();
  for (let seat = 0; seat < 6; seat++) {
    if (!occupied.includes(seat)) continue;
    const pos = seatVisualPos(seat, viewerSeat);
    seatToPos.set(seat, pos);
    if (pos !== 'hero') used.add(pos);
  }
  const emptySlots = CW_OPPONENT_SLOTS.filter((p) => !used.has(p));
  const slots = order.slice(1).map((s) => seatToPos.get(s));
  return { order, seatToPos, emptySlots, slots };
}

/**
 * Visual angle for sorting (degrees, 0 = bottom/hero, increasing clockwise).
 * @param {number|'hero'} pos
 */
export function visualAngle(pos) {
  if (pos === 'hero') return 0;
  const deg = { 3: 60, 4: 120, 0: 180, 1: 240, 2: 300 };
  return deg[pos] ?? 0;
}

/**
 * Assert helpers: button/sb/bb adjacent in the clockwise visual ring.
 */
export function rolesAreClockwiseAdjacent(occupied, viewerSeat, button, sb, bb) {
  const { order } = mapSeatsClockwise(occupied, viewerSeat);
  const idx = (seat) => order.indexOf(seat);
  const next = (seat) => order[(idx(seat) + 1) % order.length];
  const n = order.length;
  if (n === 2) {
    return button === sb && next(button) === bb && next(bb) === button;
  }
  return next(button) === sb && next(sb) === bb;
}
