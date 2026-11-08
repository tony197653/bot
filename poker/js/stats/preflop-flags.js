/**
 * Minimal preflop opportunity / success flags for VPIP / PFR / 3-bet (spec v1.0 §3).
 * Flags are per seat per hand and must be reset at each START_HAND.
 *
 * - Blinds / pure checks are not VPIP success.
 * - Forced all-in (never becomes actor) is excluded from denominators.
 * - Short all-in that does not reopen does not create a 3-bet opportunity.
 * - At most one 3-bet opportunity per seat per hand (sticky once set).
 */

import { PHASE, getLegalActions } from '../engine/game.js';

/**
 * @typedef {object} SeatFlags
 * @property {boolean} vpipOpp
 * @property {boolean} vpip
 * @property {boolean} pfrOpp
 * @property {boolean} pfr
 * @property {boolean} threeBetOpp
 * @property {boolean} threeBet
 */

/** @returns {SeatFlags} */
export function emptySeatFlags() {
  return {
    vpipOpp: false,
    vpip: false,
    pfrOpp: false,
    pfr: false,
    threeBetOpp: false,
    threeBet: false,
  };
}

/**
 * Mutable tracker for one hand's preflop flags.
 */
export function createPreflopFlagTracker() {
  /** @type {Record<number, SeatFlags>} */
  const bySeat = {};
  /** First complete (full) raise has occurred this preflop. */
  let firstFullRaiseSeen = false;

  function ensure(seat) {
    if (!bySeat[seat]) bySeat[seat] = emptySeatFlags();
    return bySeat[seat];
  }

  /**
   * Call with pre/post states for street actions while prev.phase === PREFLOP.
   * @param {object} prev
   * @param {object} action
   * @param {object} next
   */
  function observe(prev, action, next) {
    if (!prev || prev.phase !== PHASE.PREFLOP) return;
    const type = action?.type;
    if (
      type !== 'FOLD' &&
      type !== 'LEAVE_FOLD' &&
      type !== 'CHECK' &&
      type !== 'CALL' &&
      type !== 'BET_RAISE' &&
      type !== 'ALL_IN' &&
      type !== 'TIMEOUT'
    ) {
      return;
    }
    const seat = action.seat;
    if (!Number.isInteger(seat)) return;
    const p = prev.seats?.[seat];
    if (!p || p.folded || p.allIn) return;
    if (prev.actor !== seat) return;

    const legal = getLegalActions(prev, seat);
    if (!legal?.canAct) return;

    const f = ensure(seat);
    // Had a preflop action opportunity → PFR denominator.
    f.pfrOpp = true;

    // Voluntary put-in opportunity (call / bet / raise / shove). Check-only with
    // no way to put chips in is not vpipOpp; with chips, raise/bet/all-in exist.
    if (legal.call || legal.bet || legal.raise || legal.allIn) {
      f.vpipOpp = true;
    }

    const facingFirstRaise = firstFullRaiseSeen;
    if (facingFirstRaise && canCompleteReRaise(prev, seat, legal)) {
      f.threeBetOpp = true;
    }

    const kind = resolveActionKind(prev, action, next, seat);
    const fullRaise = isFullRaise(prev, next, seat);
    const putChips =
      (next.seats[seat]?.contributed || 0) > (prev.seats[seat]?.contributed || 0);

    if (kind === 'check' || kind === 'fold') {
      // no VPIP / PFR success
    } else if (fullRaise) {
      f.vpip = true;
      f.pfr = true;
      if (facingFirstRaise) {
        f.threeBetOpp = true;
        f.threeBet = true;
      }
      firstFullRaiseSeen = true;
    } else if (putChips) {
      // Call or short all-in (does not reopen): VPIP yes; PFR/3-bet no.
      f.vpip = true;
    }
  }

  /** @returns {Record<number, SeatFlags>} */
  function snapshot() {
    /** @type {Record<number, SeatFlags>} */
    const out = {};
    for (const [k, v] of Object.entries(bySeat)) {
      out[Number(k)] = { ...v };
    }
    return out;
  }

  function reset() {
    for (const k of Object.keys(bySeat)) delete bySeat[k];
    firstFullRaiseSeen = false;
  }

  return {
    observe,
    snapshot,
    reset,
    _debug: () => ({ bySeat: { ...bySeat }, firstFullRaiseSeen }),
  };
}

/**
 * @param {object} prev
 * @param {number} seat
 * @param {object} legal
 */
function canCompleteReRaise(prev, seat, legal) {
  // allIn remains available for calling even when a short raise did not reopen.
  if ((prev.actedBit & (1 << seat)) && prev.currentBet > prev.seats[seat].bet) return false;
  if (legal.raise) return true;
  if (!legal.allIn) return false;
  const p = prev.seats[seat];
  if (!p) return false;
  const raiseTo = p.bet + p.chips;
  const raiseSize = raiseTo - prev.currentBet;
  return raiseTo > prev.currentBet && raiseSize >= prev.lastFullRaiseSize;
}

/**
 * @param {object} prev
 * @param {object} next
 * @param {number} seat
 */
export function isFullRaise(prev, next, _seat) {
  if (!prev || !next) return false;
  if (next.currentBet <= prev.currentBet) return false;
  const raiseSize = next.currentBet - prev.currentBet;
  return raiseSize >= (prev.lastFullRaiseSize || prev.config?.bigBlind || 0);
}

/**
 * @param {object} prev
 * @param {object} action
 * @param {object} next
 * @param {number} seat
 */
function resolveActionKind(prev, action, next, seat) {
  const type = action.type;
  if (type === 'FOLD' || type === 'LEAVE_FOLD') return 'fold';
  if (type === 'CHECK') return 'check';
  if (type === 'CALL') return 'call';
  if (type === 'TIMEOUT') {
    const legal = getLegalActions(prev, seat);
    return legal.check ? 'check' : 'fold';
  }
  if (type === 'BET_RAISE' || type === 'ALL_IN') {
    if (next.currentBet > prev.currentBet) return 'raise';
    return 'call';
  }
  return 'other';
}
