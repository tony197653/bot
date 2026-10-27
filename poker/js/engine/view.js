/**
 * Derive a per-seat public view: own hole cards visible; others hidden
 * until revealed at showdown (or auto-shown as winners).
 */

import { cloneJson, cloneCards, cardKey } from './cards.js';
import { getLegalActions, raisePresets, totalPot, streetBetsTotal, sessionSummary, PHASE } from './game.js';
import { categoryZh } from './hand.js';

/**
 * @param {object} state full authoritative state
 * @param {number|null} viewerSeat seat index, or null for omniscient (host debug)
 */
export function viewForSeat(state, viewerSeat) {
  const s = cloneJson(state);
  const seats = s.seats.map((p, i) => {
    if (!p) return null;
    const isSelf = viewerSeat != null && i === viewerSeat;
    const revealed = s.showdown?.revealed?.[i];
    /** @type {object|null} */
    let holeView = null;
    if (isSelf && p.hole) {
      holeView = cloneCards(p.hole);
    } else if (revealed) {
      holeView = cloneCards(revealed.cards);
    } else if (
      viewerSeat == null &&
      p.hole &&
      (s.phase === PHASE.SHOWDOWN || s.phase === PHASE.HAND_OVER)
    ) {
      holeView = cloneCards(p.hole);
    }

    return {
      seat: p.seat,
      id: p.id,
      name: p.name,
      chips: p.chips,
      buyInTotal: p.buyInTotal,
      sittingOut: p.sittingOut,
      bet: p.bet,
      contributed: p.contributed,
      folded: p.folded,
      allIn: p.allIn,
      lastAction: p.lastAction,
      showChoice: p.showChoice,
      hasHole: p.hasHole,
      hole: holeView,
      holeHidden: p.hasHole && !holeView,
      isSelf,
    };
  });

  const legal = viewerSeat != null ? getLegalActions(s, viewerSeat) : null;
  const presets = viewerSeat != null ? raisePresets(s, viewerSeat) : [];

  return {
    version: s.version,
    config: s.config,
    room: s.room,
    handNumber: s.handNumber,
    button: s.button,
    phase: s.phase,
    board: cloneCards(s.board),
    boardKeys: s.board.map(cardKey),
    currentBet: s.currentBet,
    minRaiseTo: s.minRaiseTo,
    actor: s.actor,
    deadline: s.deadline,
    pots: s.pots,
    potTotal: totalPot(s),
    streetBets: streetBetsTotal(s),
    log: s.log,
    streetLog: s.streetLog,
    winners: s.winners,
    showdown: s.showdown
      ? {
          pending: s.showdown.pending,
          revealed: s.showdown.revealed,
          myPending:
            viewerSeat != null && s.showdown.pending.includes(viewerSeat),
          ranksZh: s.showdown.ranks
            ? Object.fromEntries(
                Object.entries(s.showdown.ranks).map(([k, r]) => [k, categoryZh(r)]),
              )
            : {},
        }
      : null,
    seats,
    viewerSeat,
    legal,
    presets,
    summary: sessionSummary(s),
    isLobby: s.phase === PHASE.LOBBY,
    isHandOver: s.phase === PHASE.HAND_OVER,
    isShowdown: s.phase === PHASE.SHOWDOWN,
    isSessionOver: s.phase === PHASE.SESSION_OVER,
  };
}

/**
 * JSON round-trip helper for tests / Firebase sync.
 * @param {object} state
 */
export function serializeState(state) {
  return JSON.stringify(state);
}

/**
 * @param {string} json
 */
export function deserializeState(json) {
  return JSON.parse(json);
}
