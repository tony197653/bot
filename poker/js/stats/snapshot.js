/**
 * Immutable per-seat hand summary at HAND_OVER (spec v1.0 §4 / §5.1 / §10 A).
 * No hole cards, no full action log. VOID hands must not be snapshotted.
 */

/**
 * @typedef {object} SeatHandSummary
 * @property {string} uid
 * @property {number} seat
 * @property {boolean} wonAnyPot
 * @property {boolean} vpipOpp
 * @property {boolean} vpip
 * @property {boolean} pfrOpp
 * @property {boolean} pfr
 * @property {boolean} threeBetOpp
 * @property {boolean} threeBet
 * @property {number} netDelta
 */

/**
 * @typedef {object} HandStatsSnapshot
 * @property {string} roomId
 * @property {string} handId
 * @property {number} handNo
 * @property {number} handStartedAt
 * @property {SeatHandSummary[]} seats
 * @property {boolean} voided
 */

/**
 * Build a frozen snapshot for dealt seats that still have a uid.
 *
 * @param {object} opts
 * @param {string} opts.roomId
 * @param {string} opts.handId
 * @param {number} opts.handNo
 * @param {number} opts.handStartedAt
 * @param {object} opts.engine HAND_OVER state
 * @param {Record<number, {uid:string, chipsBefore:number}>} opts.startBySeat
 * @param {Record<number, import('./preflop-flags.js').SeatFlags>} opts.flagsBySeat
 * @param {Record<number, number>} [opts.externalTopUps] chips granted mid-hand (subtract from net)
 * @param {boolean} [opts.voided]
 * @returns {HandStatsSnapshot|null} null when voided / missing identity
 */
export function buildHandStatsSnapshot(opts) {
  const {
    roomId,
    handId,
    handNo,
    handStartedAt,
    engine,
    startBySeat,
    flagsBySeat,
    externalTopUps = {},
    voided = false,
  } = opts;

  if (voided) return null;
  if (!roomId || !handId || !engine) return null;

  const payouts = engine.winnerPayouts || {};
  /** @type {SeatHandSummary[]} */
  const seats = [];

  for (const [seatStr, start] of Object.entries(startBySeat || {})) {
    const seat = Number(seatStr);
    const uid = start?.uid;
    if (!uid) continue;
    const p = engine.seats?.[seat];
    // Dealt participants only (had hole this hand). Sitting out / never dealt skipped.
    if (!start.dealt && !(p && (p.hasHole || start.chipsBefore != null))) {
      // start.dealt preferred; fall back to presence in startBySeat as dealt marker
    }
    if (start.dealt === false) continue;

    const flags = flagsBySeat?.[seat] || {
      vpipOpp: false,
      vpip: false,
      pfrOpp: false,
      pfr: false,
      threeBetOpp: false,
      threeBet: false,
    };

    const chipsAfter = p ? p.chips : 0;
    const topUp = Number(externalTopUps[seat]) || 0;
    const netDelta = chipsAfter - (Number(start.chipsBefore) || 0) - topUp;
    const wonAmt = Number(payouts[seat]) || 0;

    seats.push({
      uid,
      seat,
      wonAnyPot: wonAmt > 0,
      vpipOpp: !!flags.vpipOpp,
      vpip: !!flags.vpip && !!flags.vpipOpp,
      pfrOpp: !!flags.pfrOpp,
      pfr: !!flags.pfr && !!flags.pfrOpp,
      threeBetOpp: !!flags.threeBetOpp,
      threeBet: !!flags.threeBet && !!flags.threeBetOpp,
      netDelta,
    });
  }

  /** @type {HandStatsSnapshot} */
  const snap = {
    roomId,
    handId,
    handNo: Number(handNo) || 0,
    handStartedAt: Number(handStartedAt) || 0,
    seats,
    voided: false,
  };
  return Object.freeze(deepFreeze(snap));
}

/** @param {any} o */
function deepFreeze(o) {
  if (!o || typeof o !== 'object') return o;
  Object.freeze(o);
  for (const v of Object.values(o)) {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  }
  return o;
}

/**
 * Assert snapshot carries no hole cards / action log (Phase A acceptance).
 * @param {HandStatsSnapshot} snap
 * @returns {string[]} violation messages
 */
export function snapshotPrivacyViolations(snap) {
  /** @type {string[]} */
  const bad = [];
  const json = JSON.stringify(snap);
  if (/"hole"\s*:/.test(json)) bad.push('hole cards field present');
  if (/"deck"\s*:/.test(json)) bad.push('deck present');
  if (/"streetLog"\s*:/.test(json)) bad.push('streetLog present');
  if (/"log"\s*:/.test(json) && !/"handNo"/.test('')) {
    /* handNo ok */
  }
  if (json.includes('"log":')) bad.push('action log present');
  if (json.includes('"streetLog":')) bad.push('streetLog present');
  return bad;
}
