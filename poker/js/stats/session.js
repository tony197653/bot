/**
 * Per-room host-side stats session: handId lifecycle, flags, HAND_OVER snapshot,
 * and non-blocking enqueue onto the independent stats write chain.
 */

import { PHASE } from '../engine/game.js';
import { generateHandId, handIdFromPub } from './hand-id.js';
import { createPreflopFlagTracker } from './preflop-flags.js';
import { buildHandStatsSnapshot } from './snapshot.js';

/**
 * @param {object} opts
 * @param {string} opts.roomId
 * @param {import('./write-chain.js').createStatsWriteChain extends Function ? any : any} [opts.writeChain]
 * @param {(msg: string, err?: any) => void} [opts.onError]
 */
export function createStatsSession(opts) {
  const roomId = opts.roomId;
  const writeChain = opts.writeChain || null;
  const onError = opts.onError || ((m, e) => console.warn('[stats]', m, e));

  const flags = createPreflopFlagTracker();
  /** @type {string|null} */
  let handId = null;
  /** @type {number} */
  let handStartedAt = 0;
  /** @type {Record<number, {uid:string, chipsBefore:number, dealt:boolean}>} */
  let startBySeat = {};
  /** @type {Record<number, number>} */
  let externalTopUps = {};
  let voided = false;
  /** @type {import('./snapshot.js').HandStatsSnapshot|null} */
  let lastSnapshot = null;

  function restoreFromPub(pub) {
    const id = handIdFromPub(pub);
    if (id) handId = id;
  }

  /**
   * Call immediately BEFORE applyAction(START_HAND) with pre-blind chip stacks.
   * @param {object} engine
   * @param {string[]} seatUids length 6
   * @param {string} [existingHandId] rare resume path — prefer generate
   */
  function onHandStarting(engine, seatUids, existingHandId) {
    flags.reset();
    voided = false;
    lastSnapshot = null;
    externalTopUps = {};
    startBySeat = {};
    handStartedAt = Date.now();
    handId = existingHandId || generateHandId();
    for (let i = 0; i < 6; i++) {
      const p = engine?.seats?.[i];
      const uid = seatUids?.[i] || p?.id || null;
      if (!p || !uid) continue;
      startBySeat[i] = {
        uid,
        chipsBefore: p.chips,
        dealt: false,
      };
    }
    return handId;
  }

  /** After START_HAND succeeds — mark dealt seats (hasHole). */
  function onHandStarted(engine) {
    if (!handId) handId = generateHandId();
    if (engine && !engine.handId) engine.handId = handId;
    else if (engine && engine.handId && engine.handId !== handId) {
      // Engine already stamped (startHand); prefer engine as source of truth.
      handId = engine.handId;
    }
    for (let i = 0; i < 6; i++) {
      const p = engine?.seats?.[i];
      if (!p?.hasHole) continue;
      const uid = p.id;
      if (!startBySeat[i]) {
        startBySeat[i] = {
          uid,
          chipsBefore: p.chips + (p.bet || 0) + (p.contributed || 0), // rough if missed pre-blind
          dealt: true,
        };
      } else {
        startBySeat[i].dealt = true;
        if (!startBySeat[i].uid) startBySeat[i].uid = uid;
      }
    }
  }

  function onAction(prev, action, next) {
    try {
      flags.observe(prev, action, next);
    } catch (e) {
      onError('flag observe', e);
    }
  }

  function onTopUp(seat, amount) {
    externalTopUps[seat] = (externalTopUps[seat] || 0) + (Number(amount) || 0);
  }

  function onVoid() {
    voided = true;
  }

  /**
   * At HAND_OVER: freeze snapshot and fire-and-forget enqueue.
   * Must not throw into game flow.
   * @param {object} engine
   */
  function onHandOver(engine) {
    try {
      if (voided) return null;
      if (engine?.phase !== PHASE.HAND_OVER) return null;
      // Detect void via pub / last log without trusting only local flag
      const lastStreet = engine.streetLog?.[engine.streetLog.length - 1];
      if (lastStreet?.text === '本手作廢') {
        voided = true;
        return null;
      }
      const snap = buildHandStatsSnapshot({
        roomId,
        handId: handId || engine.handId,
        handNo: engine.handNumber,
        handStartedAt,
        engine,
        startBySeat,
        flagsBySeat: flags.snapshot(),
        externalTopUps,
        voided: false,
      });
      if (!snap) return null;
      lastSnapshot = snap;
      writeChain?.enqueueSnapshot(snap);
      return snap;
    } catch (e) {
      onError('hand over snapshot', e);
      return null;
    }
  }

  return {
    restoreFromPub,
    onHandStarting,
    onHandStarted,
    onAction,
    onTopUp,
    onVoid,
    onHandOver,
    getHandId: () => handId,
    getLastSnapshot: () => lastSnapshot,
    getFlags: () => flags.snapshot(),
  };
}
