/**
 * Multiplayer animation constants (§11) — all timings live here.
 * Milestone-1 DEAL_FX / SHOWDOWN_FX numbers are NOT changed.
 */

import { prefersReducedMotion, SHOWDOWN_FX } from './fx.js';

export const MP_FX = {
  seatInMs: 240,
  seatOutMs: 200,
  toastMs: 3000,
  bannerInMs: 320,
  bannerHoldMs: 4000,
  bannerOutMs: 240,
  hostTagOutMs: 160,
  hostTagInMs: 240,
  voidChipMs: SHOWDOWN_FX.chipFlyMs ?? 650,
  voidBoardFadeMs: 240,
  topUpDropMs: 650,
  topUpCountMs: 600,
  awayInMs: 300,
  awayOutMs: 240,
  reconnectFadeMs: 160,
  pendingDimMs: 120,
  pendingLabelAfterMs: 3000,
  pendingResendAfterMs: 8000,
  timerMs: 30000,
  timerWarnLastMs: 5000,
  skipIfLateMs: 1500,
  skipIfQueueOver: 3,
  skipIfSeqJumpOver: 1,
  easeIn: SHOWDOWN_FX.easeIn || 'cubic-bezier(.05,.7,.1,1)',
  easeOut: SHOWDOWN_FX.easeOut || 'cubic-bezier(.3,0,1,1)',
  easeChip: SHOWDOWN_FX.easeChip || 'cubic-bezier(.65,0,.35,1)',
};

/** Mutable playground overrides (ms / easing). */
export const MP_FX_LIVE = { ...MP_FX };

export function mpDuration(key) {
  if (prefersReducedMotion()) {
    if (key === 'reconnectFadeMs' || key === 'pendingDimMs') return 120;
    return 0;
  }
  return MP_FX_LIVE[key] ?? MP_FX[key] ?? 0;
}

export function setMpFx(partial) {
  Object.assign(MP_FX_LIVE, partial);
}

/**
 * Multiplayer deal total estimate: DEAL_FX without passInMs / lookPauseMs (§11.11).
 * @param {typeof import('./fx.js').DEAL_FX} dealFx
 * @param {number} playerCount
 */
export function estimateMpDealTotalMs(dealFx, playerCount) {
  const n = Math.max(2, Math.min(6, playerCount | 0));
  const stagger = dealFx.staggerByPlayers[n] ?? 130;
  // Rough upper bound matching host arm-deadline delay
  const cardPhase =
    dealFx.card0Ms +
    (2 * n - 1) * stagger +
    (dealFx.flightMax || 520) +
    dealFx.settleMs +
    dealFx.deckOutMs;
  return (
    dealFx.actDimMs +
    dealFx.deckInMs +
    dealFx.dealerMaxMs +
    dealFx.blindBbAt +
    dealFx.blindMs +
    cardPhase +
    dealFx.heroFlipMs +
    dealFx.heroFlipStaggerMs +
    dealFx.armAfterFlipMs
  );
}
