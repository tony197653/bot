/**
 * Side-pot calculation from per-player contributions this hand.
 * Players who folded remain eligible only for pots they helped create
 * up to the amount they put in (standard: folded players cannot win,
 * but their chips stay in the pot(s)).
 */

/**
 * @typedef {{ amount: number, eligible: number[] }} Pot
 */

/**
 * @param {{ seat: number, contributed: number, folded: boolean }[]} players
 * @returns {Pot[]}
 */
export function computePots(players) {
  const active = players.filter((p) => p.contributed > 0 || !p.folded);
  const levels = [...new Set(players.map((p) => p.contributed).filter((c) => c > 0))].sort(
    (a, b) => a - b,
  );
  if (levels.length === 0) return [{ amount: 0, eligible: players.filter((p) => !p.folded).map((p) => p.seat) }];

  /** @type {Pot[]} */
  const pots = [];
  let prev = 0;
  for (const level of levels) {
    const layer = level - prev;
    if (layer <= 0) continue;
    const contributors = players.filter((p) => p.contributed >= level);
    const amount = layer * contributors.length;
    const eligible = contributors.filter((p) => !p.folded).map((p) => p.seat).sort((a, b) => a - b);
    if (amount > 0) {
      // Merge into previous pot if same eligible set
      const last = pots[pots.length - 1];
      if (last && sameSeats(last.eligible, eligible)) {
        last.amount += amount;
      } else {
        pots.push({ amount, eligible });
      }
    }
    prev = level;
  }

  // If everyone folded except one, ensure there's at least the main pot
  if (pots.length === 0) {
    const total = players.reduce((s, p) => s + p.contributed, 0);
    const eligible = players.filter((p) => !p.folded).map((p) => p.seat);
    return [{ amount: total, eligible }];
  }
  return pots;
}

function sameSeats(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Distribute pot among winners with odd-chip rule:
 * odd chips go to the earliest winner in seat order starting left of button
 * (clockwise: next seat after button).
 *
 * @param {number} amount
 * @param {number[]} winnerSeats
 * @param {number} buttonSeat
 * @param {number} seatCount
 * @returns {Map<number, number>}
 */
export function splitPot(amount, winnerSeats, buttonSeat, seatCount) {
  /** @type {Map<number, number>} */
  const map = new Map();
  if (winnerSeats.length === 0 || amount <= 0) return map;
  if (winnerSeats.length === 1) {
    map.set(winnerSeats[0], amount);
    return map;
  }
  const ordered = orderFromButton(winnerSeats, buttonSeat, seatCount);
  const base = Math.floor(amount / ordered.length);
  let rem = amount - base * ordered.length;
  for (const s of ordered) {
    map.set(s, base + (rem > 0 ? 1 : 0));
    if (rem > 0) rem--;
  }
  return map;
}

/**
 * Seats clockwise from the seat left of the button (first to receive odd chip).
 * @param {number[]} seats
 * @param {number} buttonSeat
 * @param {number} seatCount
 */
export function orderFromButton(seats, buttonSeat, seatCount) {
  const set = new Set(seats);
  /** @type {number[]} */
  const out = [];
  for (let i = 1; i <= seatCount; i++) {
    const s = (buttonSeat + i) % seatCount;
    if (set.has(s)) out.push(s);
  }
  return out;
}
