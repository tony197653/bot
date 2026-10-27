/**
 * Map engine seats → on-screen positions.
 * Hero is always at the bottom; remaining seats go CLOCKWISE around the table
 * so button → SB → BB → UTG stay adjacent in visual order (same as engine).
 *
 * Visual pos ids (CSS .seat.pos-N), clockwise from hero:
 *   3 = bottom-left, 4 = top-left, 0 = top, 1 = top-right, 2 = bottom-right
 */

/** Full 6-max opponent ring, clockwise from just-left-of-hero. */
export const CW_OPPONENT_SLOTS = [3, 4, 0, 1, 2];

/**
 * Which visual slots to use for N opponents (evenly around the ring).
 * Always listed in clockwise order starting from the seat after hero.
 */
export function opponentSlotsForCount(oppCount) {
  const n = Math.max(0, Math.min(5, oppCount | 0));
  if (n === 0) return [];
  if (n === 1) return [0]; // face across the table
  if (n === 2) return [4, 1]; // TL, TR
  if (n === 3) return [4, 0, 1]; // TL, top, TR
  if (n === 4) return [3, 4, 1, 2]; // BL, TL, TR, BR
  return CW_OPPONENT_SLOTS.slice();
}

/**
 * Occupied engine seats in clockwise order starting at `fromSeat`
 * (fromSeat first, then +1, +2, … wrapping by table occupancy — not raw 0..5 holes).
 * @param {number[]} occupied ascending or unsorted list of filled seat indexes
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
 * @param {number[]} occupied
 * @param {number} viewerSeat
 * @returns {{ order: number[], seatToPos: Map<number, number|'hero'>, slots: number[] }}
 */
export function mapSeatsClockwise(occupied, viewerSeat) {
  const order = clockwiseFrom(occupied, viewerSeat);
  if (order[0] !== viewerSeat) {
    throw new Error('clockwiseFrom must start at viewer');
  }
  const slots = opponentSlotsForCount(order.length - 1);
  /** @type {Map<number, number|'hero'>} */
  const seatToPos = new Map();
  seatToPos.set(viewerSeat, 'hero');
  for (let i = 1; i < order.length; i++) {
    seatToPos.set(order[i], slots[i - 1]);
  }
  return { order, seatToPos, slots };
}

/**
 * Visual angle for sorting (degrees, 0 = bottom/hero, increasing clockwise).
 * @param {number|'hero'} pos
 */
export function visualAngle(pos) {
  if (pos === 'hero') return 0;
  // Map pos id → degrees clockwise from bottom
  const deg = { 3: 60, 4: 120, 0: 180, 1: 240, 2: 300 };
  return deg[pos] ?? 0;
}

/**
 * Assert helpers for tests: given button/sb/bb in engine seats, check adjacency
 * in the clockwise visual ring (hero at bottom).
 */
export function rolesAreClockwiseAdjacent(occupied, viewerSeat, button, sb, bb) {
  const { order } = mapSeatsClockwise(occupied, viewerSeat);
  const idx = (seat) => order.indexOf(seat);
  const next = (seat) => order[(idx(seat) + 1) % order.length];
  const n = order.length;
  if (n === 2) {
    // Heads-up: button === sb, bb is the other seat
    return button === sb && next(button) === bb && next(bb) === button;
  }
  return next(button) === sb && next(sb) === bb;
}
