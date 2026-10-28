/**
 * Best-5-of-7 Texas Hold'em hand evaluator.
 * Categories (high → low):
 * 8 同花大順/同花順, 7 四條, 6 葫蘆, 5 同花, 4 順子, 3 三條, 2 兩對, 1 一對, 0 高牌
 * Rank vector is lexicographically comparable (higher wins).
 */

import { asCard } from './cards.js';

export const CATEGORY = {
  HIGH: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  TRIPS: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  QUADS: 7,
  STRAIGHT_FLUSH: 8,
};

export const CATEGORY_ZH = [
  '高牌',
  '一對',
  '兩對',
  '三條',
  '順子',
  '同花',
  '葫蘆',
  '四條',
  '同花順',
];

/** Royal flush is 同花大順 (A-high straight flush); reported via category + high. */
export function categoryZh(rank) {
  if (rank[0] === CATEGORY.STRAIGHT_FLUSH && rank[1] === 14) return '同花大順';
  return CATEGORY_ZH[rank[0]];
}

/**
 * @param {(import('./cards.js').Card|string)[]} cards 5–7 cards
 * @returns {number[]} comparable rank vector
 */
export function evaluate(cards) {
  return bestFiveOf(cards).rank;
}

/**
 * Best 5-card subset among 5–7 cards (for correctness / tests; UI may ignore cards).
 * @param {(import('./cards.js').Card|string)[]} cards
 * @returns {{ rank: number[], cards: import('./cards.js').Card[] }}
 */
export function bestFiveOf(cards) {
  const cs = cards.map(asCard);
  if (cs.length < 5 || cs.length > 7) {
    throw new Error('需要 5 到 7 張牌');
  }
  let bestRank = null;
  /** @type {import('./cards.js').Card[]|null} */
  let bestCards = null;
  for (const five of combinations(cs, 5)) {
    const r = rankFive(five);
    if (!bestRank || compareRanks(r, bestRank) > 0) {
      bestRank = r;
      bestCards = five;
    }
  }
  return { rank: bestRank, cards: bestCards };
}

/**
 * Best five from hole + board.
 * @param {(import('./cards.js').Card|string)[]} hole
 * @param {(import('./cards.js').Card|string)[]} board
 * @returns {{ rank: number[], cards: import('./cards.js').Card[] }|null}
 */
export function bestFive(hole, board) {
  const all = [...hole, ...board].map(asCard);
  if (all.length < 5) return null;
  return bestFiveOf(all);
}

/**
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} >0 if a better, <0 if b better, 0 tie
 */
export function compareRanks(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * Evaluate hole + board; returns null if fewer than 5 total.
 * @param {(import('./cards.js').Card|string)[]} hole
 * @param {(import('./cards.js').Card|string)[]} board
 */
export function evaluateHand(hole, board) {
  const all = [...hole, ...board].map(asCard);
  if (all.length < 5) return null;
  return evaluate(all);
}

/** @param {import('./cards.js').Card[]} five */
function rankFive(five) {
  const ranks = five.map((c) => c.r).sort((a, b) => b - a);
  const suits = five.map((c) => c.s);
  const flush = suits.every((s) => s === suits[0]);
  const straightHigh = straightHighOf(ranks);

  if (flush && straightHigh) {
    return [CATEGORY.STRAIGHT_FLUSH, straightHigh];
  }

  const counts = countRanks(ranks);
  // counts: [[rank, count], ...] sorted by count desc, then rank desc
  const c0 = counts[0];
  const c1 = counts[1];

  if (c0[1] === 4) {
    const kicker = counts.find((x) => x[0] !== c0[0])[0];
    return [CATEGORY.QUADS, c0[0], kicker];
  }
  if (c0[1] === 3 && c1[1] === 2) {
    return [CATEGORY.FULL_HOUSE, c0[0], c1[0]];
  }
  if (flush) {
    return [CATEGORY.FLUSH, ...ranks];
  }
  if (straightHigh) {
    return [CATEGORY.STRAIGHT, straightHigh];
  }
  if (c0[1] === 3) {
    const kickers = counts.filter((x) => x[0] !== c0[0]).map((x) => x[0]);
    return [CATEGORY.TRIPS, c0[0], ...kickers];
  }
  if (c0[1] === 2 && c1[1] === 2) {
    const highPair = Math.max(c0[0], c1[0]);
    const lowPair = Math.min(c0[0], c1[0]);
    const kicker = counts.find((x) => x[1] === 1)[0];
    return [CATEGORY.TWO_PAIR, highPair, lowPair, kicker];
  }
  if (c0[1] === 2) {
    const kickers = counts.filter((x) => x[0] !== c0[0]).map((x) => x[0]);
    return [CATEGORY.PAIR, c0[0], ...kickers];
  }
  return [CATEGORY.HIGH, ...ranks];
}

/** @param {number[]} ranksDesc */
function straightHighOf(ranksDesc) {
  const uniq = [...new Set(ranksDesc)].sort((a, b) => b - a);
  for (let i = 0; i <= uniq.length - 5; i++) {
    let ok = true;
    for (let j = 0; j < 4; j++) {
      if (uniq[i + j] - 1 !== uniq[i + j + 1]) {
        ok = false;
        break;
      }
    }
    if (ok) return uniq[i];
  }
  // Wheel A-2-3-4-5 → high = 5
  const set = new Set(uniq);
  if (set.has(14) && set.has(5) && set.has(4) && set.has(3) && set.has(2)) return 5;
  return 0;
}

function countRanks(ranks) {
  /** @type {Map<number, number>} */
  const m = new Map();
  for (const r of ranks) m.set(r, (m.get(r) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
}

/**
 * @template T
 * @param {T[]} arr
 * @param {number} k
 * @returns {T[][]}
 */
function combinations(arr, k) {
  /** @type {T[][]} */
  const out = [];
  const n = arr.length;
  const idx = Array.from({ length: k }, (_, i) => i);
  for (;;) {
    out.push(idx.map((i) => arr[i]));
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) break;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
  return out;
}
