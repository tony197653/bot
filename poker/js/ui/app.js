/**
 * Hot-seat Texas Hold'em UI — classic green table.
 * Engine stays pure; this module owns DOM + pass-and-play flow.
 */

import {
  createInitialState,
  applyAction,
  viewForSeat,
  getLegalActions,
  raisePresets,
  PHASE,
  sessionSummary,
  REVEAL_MS,
  HOLD_MS_SHOWDOWN,
  HOLD_MS_FOLD_WIN,
} from '../engine/index.js';
import { cardHtml, cardBackPair, heroBackPair, fmtChips, cardFaceInner } from './cards-dom.js';
import { onTick } from './ticker.js';
import { mapSeatsClockwise, seatVisualPos } from './seating.js';
import { placeBets, placeDealer, placeTableNote } from './layout-felt.js';
import {
  playDealAnimation,
  playHeroFlip,
  playShowdownSequence,
  cancelDealFx,
  cancelWinFx,
  cancelHeroFlip,
  prefersReducedMotion,
  foldWinCenterNote,
  DEAL_FX,
  SHOWDOWN_FX,
} from './fx.js';

/**
 * Single-device: other seats who don't tap → MUCK (not coin-flip).
 * Flip to `false` to restore random show/muck for non-viewer seats.
 */
export const OTHER_HUMANS_DEFAULT_MUCK = true;

const DEFAULT_NAMES = ['宗良', '阿哲', '小芸', '志明', '小美', '老K'];

/** @type {object} */
let state = createInitialState({ timerEnabled: false, roomName: '週五牌局' });
/** Current hot-seat viewer (whose phone it is). */
let viewerSeat = 0;
/** Pass screen pending when actor changes. */
let needsPass = false;
let lastActor = null;
let raiseTo = 0;
let toastTimer = 0;
let dealAnimKey = '';
/** Hand number waiting for deal FX (plays before 換人). */
let pendingDealHand = 0;
let lastDealPlayed = 0;
let winFxKey = '';
/** @type {DOMRect | null} */
let prevDealerRect = null;
let dealFxBusy = false;
/** True while the deal FX is presenting; hero holes stay face-down. */
let dealPresenting = false;
/** After deal FX finishes, show the 換人 overlay for the actor. */
let awaitingDealThenPass = false;
/** Pass overlay is showing after deal — keep hero backs; flip on confirm. */
let passAfterDeal = false;
/** Hero 3D flip in progress after 換人 confirm. */
let heroFlipping = false;
/**
 * False from START_HAND until deal + 換人 confirm + hero flip complete.
 * Gates action buttons and the 30s timer.
 */
let handUiReady = true;
/** Last whole-second shown under reduced-motion timer. */
let lastTimerSecShown = -1;
/** When set, onTick keeps this remaining-ms on the ring (screenshot helper). */
let debugTimerFreezeMs = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let raiseHoldTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let raiseHoldRepeat = null;
/** Reveal-choice deadline (ms epoch); null when not choosing. */
let revealDeadline = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let revealTimer = null;
/** Avoid double-firing bot reveals for the same hand. */
let botsRevealedForHand = 0;
/** Auto-advance to next hand after reveal settles. */
let autoNextTimer = null;
/** Hold-period end (ms epoch) while HAND_OVER waiting for auto-next. */
let holdDeadline = null;
let raisePanelOpen = false;
/** Showdown FX in progress — freeze table rebuild / defer glow. */
let showdownFxBusy = false;
/** Choice buttons armed only after FX reaches F. */
let revealUiArmed = false;
/** Winner glow/badge visible (set at FX stage D, before choice). */
let showdownGlowOn = false;
/** Board HTML frozen during showdown to avoid dealIn replay. */
let boardFrozenKey = '';
/** Display pot amount during FX (engine contributed stays until ACK). */
let displayPotOverride = null;
/** @type {Record<number, number>|null} stack display before payout rolls in */
let displayChipsOverride = null;
/** Seats whose hole cards have been flipped by FX this hand. */
let flippedSeats = new Set();
/** Host requested pause — also mirrored in engine.state.pause */
let pausePanelBound = false;

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

function clearRaiseHold() {
  if (raiseHoldTimer != null) clearTimeout(raiseHoldTimer);
  if (raiseHoldRepeat != null) clearTimeout(raiseHoldRepeat);
  raiseHoldTimer = null;
  raiseHoldRepeat = null;
}

/** Step raise-to by ±1 BB; press-and-hold auto-repeats after ~400ms then accelerates. */
function bindRaiseStep(btn, dir) {
  if (!btn || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';
  const stepOnce = () => {
    const legal = getLegalActions(state, viewerSeat);
    if (!legal?.canAct) return;
    const min = legal.minRaiseTo;
    const max = legal.maxRaiseTo;
    const bb = state.config.bigBlind;
    raiseTo = clamp(raiseTo + dir * bb, Math.min(min, max), max);
    const range = $('#raiseRange');
    if (range) {
      range.value = String(raiseTo);
      syncRaiseUi();
    }
  };
  const onDown = (e) => {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    clearRaiseHold();
    try {
      btn.setPointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    stepOnce();
    let interval = 140;
    raiseHoldTimer = setTimeout(function tick() {
      stepOnce();
      interval = Math.max(36, Math.floor(interval * 0.82));
      raiseHoldRepeat = setTimeout(tick, interval);
    }, 400);
  };
  const onUp = () => clearRaiseHold();
  btn.addEventListener('pointerdown', onDown);
  btn.addEventListener('pointerup', onUp);
  btn.addEventListener('pointercancel', onUp);
  btn.addEventListener('lostpointercapture', onUp);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}

function syncRaiseUi() {
  const range = $('#raiseRange');
  const out = $('#raiseOut');
  if (out) out.textContent = fmtChips(raiseTo);
  if (range) {
    const min = +range.min;
    const max = +range.max;
    const pct = max > min ? ((raiseTo - min) / (max - min)) * 100 : 0;
    range.style.setProperty('--raise-pct', `${clamp(pct, 0, 100)}%`);
  }
  syncPresetPressed();
  syncRaiseBtn();
  const minus = $('#raiseMinus');
  const plus = $('#raisePlus');
  if (range && minus && plus) {
    minus.disabled = raiseTo <= +range.min;
    plus.disabled = raiseTo >= +range.max;
  }
}

function dispatch(action, env = {}) {
  try {
    state = applyAction(state, action, { now: Date.now(), ...env });
    afterState();
  } catch (e) {
    toast(e.message || String(e));
  }
}

function afterState() {
  // New hand → queue deal presentation (engine already final)
  if (
    state.handNumber > lastDealPlayed &&
    state.phase === PHASE.PREFLOP &&
    state.handNumber !== pendingDealHand
  ) {
    cancelWinFx();
    winFxKey = '';
    pendingDealHand = state.handNumber;
    botsRevealedForHand = 0;
    revealDeadline = null;
    revealUiArmed = false;
    showdownGlowOn = false;
    showdownFxBusy = false;
    displayPotOverride = null;
    displayChipsOverride = null;
    flippedSeats = new Set();
    boardFrozenKey = '';
    holdDeadline = null;
    if (revealTimer) {
      clearTimeout(revealTimer);
      revealTimer = null;
    }
    if (autoNextTimer) {
      clearTimeout(autoNextTimer);
      autoNextTimer = null;
    }
  }
  // Hand over: stop pass gate so winner FX / summary are visible
  if (state.phase === PHASE.HAND_OVER || state.phase === PHASE.SESSION_OVER) {
    needsPass = false;
    $('#passScreen')?.classList.remove('is-on');
    if (state.phase === PHASE.HAND_OVER && !showdownFxBusy) {
      scheduleAutoNextHand();
    }
  }
  // Hot-seat: when actor changes to another seated player mid-hand, show pass screen
  // (Reveal phase uses bots for other seats — no pass for 亮牌／不亮.)
  // Skip while a deal presentation is in flight (deal runs before 換人).
  if (
    state.actor != null &&
    state.actor !== viewerSeat &&
    [PHASE.PREFLOP, PHASE.FLOP, PHASE.TURN, PHASE.RIVER].includes(state.phase) &&
    !dealPresenting &&
    !awaitingDealThenPass &&
    !dealFxBusy
  ) {
    needsPass = true;
  }
  if (state.phase === PHASE.SHOWDOWN) {
    needsPass = false;
    $('#passScreen')?.classList.remove('is-on');
    beginRevealUi();
  }
  syncPausePanel();
  render();
}

function beginRevealUi() {
  if (!state.showdown) return;
  if (botsRevealedForHand !== state.handNumber) {
    botsRevealedForHand = state.handNumber;
    // Single-device: non-viewer seats default MUCK (OTHER_HUMANS_DEFAULT_MUCK)
    const pending = [...(state.showdown.pending || [])];
    for (const seat of pending) {
      if (seat === viewerSeat) continue;
      if (state.phase !== PHASE.SHOWDOWN) break;
      if (!state.showdown?.pending?.includes(seat)) continue;
      const show = OTHER_HUMANS_DEFAULT_MUCK ? false : Math.random() < 0.5;
      try {
        state = applyAction(
          state,
          { type: show ? 'SHOW' : 'MUCK', seat, mode: 'both' },
          { now: Date.now() },
        );
      } catch (_) {
        /* ignore */
      }
    }
  }
  // Countdown / REVEAL_TIMEOUT armed only after showdown FX reaches choice phase
}

/** Arm 5s show/muck window once buttons are tappable (after FX). */
function armRevealChoice() {
  revealUiArmed = true;
  if (state.phase !== PHASE.SHOWDOWN) {
    if (state.phase === PHASE.HAND_OVER) scheduleAutoNextHand();
    render();
    return;
  }
  if (revealDeadline == null && state.showdown?.pending?.length) {
    revealDeadline = Date.now() + REVEAL_MS;
    if (revealTimer) clearTimeout(revealTimer);
    revealTimer = setTimeout(() => {
      if (state.phase !== PHASE.SHOWDOWN) return;
      dispatch({ type: 'REVEAL_TIMEOUT' });
    }, REVEAL_MS + 30);
  }
  render();
}

function holdMsForState() {
  const foldWin =
    !!state.showdown?.foldWin || !!state.lastHandSummary?.foldWin;
  return foldWin ? HOLD_MS_FOLD_WIN : HOLD_MS_SHOWDOWN;
}

function scheduleAutoNextHand() {
  if (state.phase !== PHASE.HAND_OVER) return;
  if (state.pause?.active) return;
  if (showdownFxBusy) return;
  if (autoNextTimer) clearTimeout(autoNextTimer);
  const ms = holdMsForState();
  holdDeadline = Date.now() + ms;
  autoNextTimer = setTimeout(() => {
    autoNextTimer = null;
    holdDeadline = null;
    goNextHandFromHold();
  }, ms);
  render();
}

function goNextHandFromHold() {
  if (state.phase !== PHASE.HAND_OVER && !state.pause?.active) return;
  if (autoNextTimer) {
    clearTimeout(autoNextTimer);
    autoNextTimer = null;
  }
  holdDeadline = null;
  try {
    if (state.phase === PHASE.HAND_OVER) {
      dispatch({ type: 'ACK_HAND' });
    }
    if (state.pause?.requested && !state.pause?.active) {
      dispatch({ type: 'NEXT_HAND' }); // activates pause
      syncPausePanel();
      render();
      return;
    }
    if (state.pause?.active) {
      syncPausePanel();
      render();
      return;
    }
    dispatch({ type: 'NEXT_HAND' });
    viewerSeat = state.actor ?? state.room.hostSeat;
    startDealThenPass();
  } catch (e) {
    if (state.pause?.active) {
      syncPausePanel();
      render();
      return;
    }
    toast(e.message || String(e));
  }
}

/** SVG countdown ring around an avatar (pathLength=100 for easy dashoffset). */
function avWithRing(initial, { timing = false } = {}) {
  const ring =
    `<svg class="av-ring" viewBox="0 0 36 36" aria-hidden="true">` +
    `<circle class="av-ring-bg" cx="18" cy="18" r="15"/>` +
    `<circle class="av-ring-fg" cx="18" cy="18" r="15" pathLength="100" stroke-dasharray="100" stroke-dashoffset="0"/>` +
    `</svg><span class="av-ring-sec" aria-hidden="true"></span>`;
  return `<div class="av${timing ? ' is-timing' : ''}">${ring}<span>${esc(initial)}</span></div>`;
}

function view() {
  return viewForSeat(state, viewerSeat);
}

/* ─── Boot / preload ─── */
async function boot() {
  const bar = $('#bootBar');
  const pct = $('#bootPct');
  const set = (n, label) => {
    bar.style.width = `${n}%`;
    pct.textContent = `${label} ${n}%`;
  };
  set(8, '載入字型');
  try {
    if (document.fonts?.load) {
      await Promise.all([
        document.fonts.load('700 24px "Noto Serif TC"'),
        document.fonts.load('500 16px "Noto Sans TC"'),
        document.fonts.load('400 14px "Noto Sans TC"'),
      ]);
    }
  } catch (_) { /* ignore */ }
  set(40, '載入圖示');
  try {
    await Promise.all(
      ['assets/icon-192.png', 'assets/icon-180.png', 'assets/icon-512.png'].map(
        (src) =>
          new Promise((resolve) => {
            const img = new Image();
            img.onload = img.onerror = () => resolve();
            img.src = src;
          }),
      ),
    );
  } catch (_) { /* ignore */ }
  set(55, '載入介面');
  await new Promise((r) => requestAnimationFrame(() => r()));
  // Warm layout
  $('#app').classList.remove('hidden');
  setupFullscreenButton();
  setupMenu();
  set(85, '準備牌桌');
  await new Promise((r) => setTimeout(r, 180));
  set(100, '完成');
  await new Promise((r) => setTimeout(r, 220));
  $('#boot').classList.add('is-done');
  setTimeout(() => $('#boot').classList.add('hidden'), 480);
  openLobby();
}

function setupFullscreenButton() {
  const btn = $('#btnFullscreen');
  if (!btn) return;
  const doc = document;
  const el = doc.documentElement;
  const can =
    (doc.fullscreenEnabled || doc.webkitFullscreenEnabled) &&
    (el.requestFullscreen || el.webkitRequestFullscreen);
  if (!can) {
    btn.classList.add('hidden');
    return;
  }
  btn.classList.remove('hidden');
  const isFs = () => !!(doc.fullscreenElement || doc.webkitFullscreenElement);
  const sync = () => {
    const on = isFs();
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? '離開全螢幕' : '全螢幕';
  };
  btn.onclick = async () => {
    try {
      if (isFs()) {
        await (doc.exitFullscreen || doc.webkitExitFullscreen).call(doc);
      } else {
        await (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
      }
    } catch (_) {
      toast('無法進入全螢幕');
    }
    sync();
  };
  doc.addEventListener('fullscreenchange', sync);
  doc.addEventListener('webkitfullscreenchange', sync);
  sync();
}

/* ─── Lobby ─── */
function openLobby() {
  const scr = $('#lobbyScreen');
  scr.classList.remove('hidden');
  scr.classList.add('is-on');
  $('#passScreen').classList.remove('is-on');
  needsPass = false;
  const box = $('#playerRows');
  const seated = state.seats.map((p, i) => (p ? p.name : null));
  // Default fill 宗良 + friends if empty lobby
  if (!seated.some(Boolean)) {
    box.innerHTML = DEFAULT_NAMES.map(
      (n, i) => rowHtml(i, n, i < 4),
    ).join('');
  } else {
    box.innerHTML = DEFAULT_NAMES.map((n, i) =>
      rowHtml(i, seated[i] || n, !!seated[i]),
    ).join('');
  }
  $('#roomNameInput').value = state.room.name;
  $('#bbInput').value = state.config.bigBlind;
  $('#stackInput').value = state.config.startingStack;
  $('#timerToggle').checked = state.config.timerEnabled;
  bindLobby();
}

function rowHtml(i, name, on) {
  const ch = name.slice(0, 1);
  return `<div class="p-row" data-seat="${i}">
    <div class="av"><span>${esc(ch)}</span></div>
    <input type="text" maxlength="12" value="${esc(name)}" aria-label="玩家${i + 1}暱稱" ${on ? '' : 'disabled'}/>
    <button type="button" data-toggle="${i}">${on ? '移除' : '加入'}</button>
  </div>`;
}

function bindLobby() {
  const box = $('#playerRows');
  box.onclick = (e) => {
    const btn = e.target.closest('[data-toggle]');
    if (!btn) return;
    const row = btn.closest('.p-row');
    const input = row.querySelector('input');
    const on = !input.disabled;
    input.disabled = on;
    btn.textContent = on ? '加入' : '移除';
  };
  $('#bbInput').onchange = () => {
    const bb = Math.max(2, parseInt($('#bbInput').value, 10) || 20);
    const min = bb * 100;
    const cur = parseInt($('#stackInput').value, 10) || 0;
    if (cur < min) $('#stackInput').value = String(min);
  };
  $('#btnStart').onclick = () => {
    const name = $('#roomNameInput').value.trim() || '週五牌局';
    const bb = Math.max(2, parseInt($('#bbInput').value, 10) || 20);
    const stack = parseInt($('#stackInput').value, 10) || bb * 100;
    const timerOn = $('#timerToggle').checked;
    state = createInitialState({
      roomName: name,
      bigBlind: bb,
      smallBlind: Math.floor(bb / 2),
      startingStack: Math.max(stack, bb * 100),
      timerEnabled: timerOn,
    });
    try {
      state = applyAction(state, {
        type: 'CONFIG',
        bigBlind: bb,
        startingStack: Math.max(stack, bb * 100),
        timerEnabled: timerOn,
        roomName: name,
      });
    } catch (_) { /* fresh state already configured */ }

    const rows = $$('#playerRows .p-row');
    let hostSet = false;
    let count = 0;
    for (const row of rows) {
      const input = row.querySelector('input');
      if (input.disabled) continue;
      const seat = +row.dataset.seat;
      const nm = input.value.trim() || DEFAULT_NAMES[seat];
      state = applyAction(state, {
        type: 'SEAT',
        seat,
        name: nm,
        isHost: !hostSet,
      });
      hostSet = true;
      count++;
    }
    if (count < 2) {
      toast('至少需要兩位玩家');
      openLobby();
      return;
    }
    // Mark deal-before-pass before dispatch so afterState won't flash 換人
    dispatch({ type: 'START_HAND' });
    viewerSeat = state.actor ?? state.room.hostSeat;
    $('#lobbyScreen').classList.remove('is-on');
    $('#lobbyScreen').classList.add('hidden');
    startDealThenPass();
  };
}

/** Play deal FX on the open table, then show 換人 for the actor. */
function startDealThenPass() {
  awaitingDealThenPass = true;
  dealPresenting = true;
  passAfterDeal = false;
  heroFlipping = false;
  handUiReady = false;
  needsPass = false;
  $('#passScreen')?.classList.remove('is-on');
  document.getElementById('act')?.classList.add('is-deal-locked');
  pendingDealHand = state.handNumber;
  // Capture previous D before this hand's placeDealer overwrites it
  const d = $('#dealer');
  if (d && getComputedStyle(d).display !== 'none' && prevDealerRect == null) {
    // first hand: leave null so FX drops D from deck
  }
  render();
  maybePlayDealFx();
}

/* ─── Pass screen ─── */
function showPass() {
  const p = state.seats[viewerSeat];
  if (!p) return;
  needsPass = true;
  $('#heroName').textContent = '（換人中）';
  // After deal: keep large face-down hero cards (spec §8.3). Mid-hand pass: clear for privacy.
  if (passAfterDeal) {
    const hole = $('#heroHole');
    if (hole && !hole.querySelector('.card.is-back')) {
      hole.innerHTML = heroBackPair({ pending: false });
    }
    // Keep chip readout for continuity under the dim overlay
    $('#heroChips').textContent = fmtChips(p.chips);
  } else {
    $('#heroHole').innerHTML = '';
    $('#heroChips').textContent = '';
  }
  $('#passScreen').classList.remove('hidden');
  $('#passScreen').classList.add('is-on');
  $('#passName').textContent = p.name;
  $('#passHint').textContent =
    '請把裝置交給這位玩家。其他人請勿偷看手牌。';
  document.getElementById('act')?.classList.add('is-deal-locked');
}

function hidePass() {
  needsPass = false;
  dealPresenting = false;
  awaitingDealThenPass = false;
  $('#passScreen').classList.remove('is-on');
  lastActor = state.actor;
  dealAnimKey = `${state.handNumber}-${viewerSeat}`;

  if (passAfterDeal) {
    passAfterDeal = false;
    beginHeroFlipThenUnlock();
    return;
  }

  handUiReady = true;
  document.getElementById('act')?.classList.remove('is-deal-locked');
  render();
  maybePlayDealFx();
}

/** After 換人 confirm: 3D flip hero cards, then arm timer + enable actions. */
function beginHeroFlipThenUnlock() {
  heroFlipping = true;
  handUiReady = false;
  document.getElementById('act')?.classList.add('is-deal-locked');
  const hero = state.seats[viewerSeat];
  const cards = hero?.hole?.length === 2 ? hero.hole : [];
  const hole = $('#heroHole');
  playHeroFlip({
    cards,
    mountHtml: (html) => {
      if (hole) hole.innerHTML = html;
    },
    onDone: () => {
      heroFlipping = false;
      // Restore act bar, then arm deadline (spec §4.3 M→N)
      const act = document.getElementById('act');
      if (act) {
        act.getAnimations?.().forEach((a) => {
          try {
            a.cancel();
          } catch {
            /* ignore */
          }
        });
        act.classList.remove('is-deal-locked');
        act.style.opacity = '';
        act.animate(
          [
            { opacity: 0.38, transform: 'translateY(6px)' },
            { opacity: 1, transform: 'translateY(0)' },
          ],
          { duration: DEAL_FX.actRestoreMs, easing: 'ease-out' },
        );
      }
      handUiReady = true;
      if (state.config.timerEnabled) {
        dispatch({ type: 'ARM_DEADLINE' });
      }
      render();
    },
  });
}

$('#btnPassOk').onclick = () => hidePass();

/* ─── Render ─── */
function render() {
  if (
    needsPass &&
    state.phase !== PHASE.HAND_OVER &&
    state.phase !== PHASE.SESSION_OVER
  ) {
    showPass();
  }
  const v = view();
  renderTop(v);
  renderTable(v);
  renderSide(v);
  renderActions(v);
  renderHandOver(v);
}

function renderTop(v) {
  $('#roomTitle').textContent = v.room.name;
  $('#roomMeta').innerHTML =
    `<span class="meta-a"><b>盲注 ${v.config.smallBlind}／${v.config.bigBlind}</b></span>` +
    `<span class="meta-b">　第 ${v.handNumber} 手</span>`;
  const host = v.seats[v.room.hostSeat]?.name || '—';
  const meta = $('#menuMeta');
  if (meta) meta.textContent = `第 ${v.handNumber} 手 · 房號 ${v.room.code}`;
  const hostEl = $('#menuHost');
  if (hostEl) hostEl.textContent = `房主 ${host}`;
  const tbtn = $('#btnTimerCfg');
  if (tbtn) {
    tbtn.textContent = v.config.timerEnabled ? '計時：開' : '計時：關';
    tbtn.onclick = () => {
      dispatch({ type: 'SET_TIMER', enabled: !state.config.timerEnabled });
      closeMenu();
    };
  }
  const pbtn = $('#btnPauseMenu');
  if (pbtn) {
    const isHost = viewerSeat === state.room.hostSeat;
    const canPause =
      isHost &&
      !state.pause?.active &&
      state.phase !== PHASE.LOBBY &&
      state.phase !== PHASE.SESSION_OVER;
    pbtn.classList.toggle('hidden', !canPause);
    pbtn.textContent = state.pause?.requested ? '暫停（已預約）' : '暫停';
    pbtn.onclick = () => {
      requestPause();
      closeMenu();
    };
  }
}

function requestPause() {
  try {
    dispatch({ type: 'REQUEST_PAUSE', seat: state.room.hostSeat });
    toast(
      state.pause?.active
        ? '已暫停，等待全員回來'
        : '已預約暫停：這手結束後生效',
    );
  } catch (e) {
    toast(e.message || String(e));
  }
}

function syncPausePanel() {
  const scr = $('#pauseScreen');
  if (!scr) return;
  if (!state.pause?.active) {
    scr.classList.remove('is-on');
    return;
  }
  // No action timer while paused
  if (autoNextTimer) {
    clearTimeout(autoNextTimer);
    autoNextTimer = null;
  }
  holdDeadline = null;
  scr.classList.add('is-on');
  const list = $('#pauseList');
  if (!list) return;
  const rows = [];
  for (const [seatStr, ready] of Object.entries(state.pause.ready || {})) {
    const seat = +seatStr;
    const p = state.seats[seat];
    if (!p) continue;
    const status = ready ? '已回來' : '未回來';
    const btn = ready
      ? `<span class="pause-ok">✓ ${status}</span>`
      : `<button type="button" class="primary pause-ready" data-seat="${seat}">我回來了</button>`;
    rows.push(
      `<div class="pause-row" data-seat="${seat}">` +
        `<span class="pause-name">${esc(p.name)}</span>` +
        `<span class="pause-status">${btn}</span>` +
        `</div>`,
    );
  }
  list.innerHTML = rows.join('') || '<p class="lead">沒有在座玩家</p>';
  if (!pausePanelBound) {
    pausePanelBound = true;
    list.addEventListener('click', (e) => {
      const btn = e.target?.closest?.('button.pause-ready');
      if (!btn) return;
      const seat = +btn.dataset.seat;
      try {
        state = applyAction(state, { type: 'PLAYER_READY', seat }, { now: Date.now() });
        if (!state.pause?.active) {
          // All ready → deal next hand
          $('#pauseScreen')?.classList.remove('is-on');
          try {
            if (state.phase === PHASE.HAND_OVER) {
              try {
                state = applyAction(state, { type: 'ACK_HAND' }, { now: Date.now() });
              } catch (_) {
                /* already cleared */
              }
            }
            state = applyAction(state, { type: 'NEXT_HAND' }, { now: Date.now() });
            viewerSeat = state.actor ?? state.room.hostSeat;
            afterState();
            startDealThenPass();
          } catch (err2) {
            toast(err2.message || String(err2));
            render();
          }
        } else {
          syncPausePanel();
          render();
        }
      } catch (err) {
        toast(err.message || String(err));
      }
    });
  }
}

function closeMenu() {
  $('#menuPop')?.classList.add('hidden');
  $('#btnMenu')?.setAttribute('aria-expanded', 'false');
}

function setupMenu() {
  const btn = $('#btnMenu');
  const pop = $('#menuPop');
  if (!btn || !pop || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';
  btn.onclick = (e) => {
    e.stopPropagation();
    const open = pop.classList.toggle('hidden') === false;
    btn.setAttribute('aria-expanded', String(open));
  };
  document.addEventListener('click', (e) => {
    if (!pop.classList.contains('hidden') && !pop.contains(e.target) && e.target !== btn) {
      closeMenu();
    }
  });
  $('#btnEndMenu')?.addEventListener('click', () => {
    closeMenu();
    if (state.phase === PHASE.LOBBY) return;
    dispatch({ type: 'END_SESSION' });
    showSummary();
  });
}

function renderTable(v) {
  // Freeze seat/bet/hero rebuild while deal / showdown WAAPI is running
  if (dealFxBusy || heroFlipping) return;
  if (showdownFxBusy) {
    // Still allow pot/stack overrides from FX callbacks via light updates
    if (displayPotOverride != null && $('#potAmt')) {
      $('#potAmt').textContent = fmtChips(displayPotOverride);
    }
    return;
  }

  const dealingSetup = dealPresenting || awaitingDealThenPass;
  const atShowdown = v.isShowdown || v.isHandOver;
  const boardEl = $('#board');
  // Felt shows ONLY dealt community cards — no dashed placeholders.
  // Freeze board DOM during showdown/hand-over so dealIn never replays on re-render.
  const boardKey = (v.board || []).map((c) => `${c.r}${c.s}`).join('-') + `:${v.handNumber}`;
  if (!atShowdown || boardFrozenKey !== boardKey) {
    boardEl.innerHTML = (v.board || [])
      .map((c) => cardHtml(c, { anim: !atShowdown }))
      .join('');
    if (atShowdown) boardFrozenKey = boardKey;
    else boardFrozenKey = '';
  }

  const potEl = document.querySelector('.pot');
  if (dealingSetup) {
    potEl?.classList.add('is-pending');
    if (potEl) {
      potEl.style.opacity = '';
      potEl.style.visibility = '';
    }
    // Keep amount blank while pending — never show a stuck "0" chip label
    $('#potAmt').textContent = '';
  } else {
    potEl?.classList.remove('is-pending');
    if (potEl) {
      potEl.style.opacity = '';
      potEl.style.visibility = '';
    }
    // During showdown before chip FX settles, keep showing pot total (contributed).
    // After onPotZero, displayPotOverride is 0.
    $('#potAmt').textContent = fmtChips(
      displayPotOverride != null ? displayPotOverride : v.potTotal,
    );
  }
  if ($('#potSub')) $('#potSub').textContent = '';

  const seatsRoot = $('#seats');
  const betsRoot = $('#bets');
  seatsRoot.innerHTML = '';
  betsRoot.innerHTML = '';

  const occupied = [];
  for (let seat = 0; seat < 6; seat++) {
    if (v.seats[seat]) occupied.push(seat);
  }
  const { seatToPos } = mapSeatsClockwise(occupied, viewerSeat);
  const opponents = occupied.filter((s) => s !== viewerSeat);

  // Empty seats draw nothing (no 空位 circles)
  for (const seat of opponents) {
    const p = v.seats[seat];
    const pos = seatToPos.get(seat);
    if (typeof pos !== 'number') continue;
    const role = roleTag(v, seat);
    const folded = p.folded ? ' is-folded' : '';
    const actor = v.actor === seat ? ' is-actor' : '';
    // Face cards only after FX flip (or after sequence armed with a show choice)
    const willReveal =
      !!state.showdown?.revealed?.[seat] ||
      !!state.lastHandSummary?.revealed?.[seat] ||
      p.showChoice === 'auto' ||
      p.showChoice === 'both';
    const canShowFaces =
      p.hole &&
      p.hole.length === 2 &&
      !p.isSelf &&
      (flippedSeats.has(seat) || (atShowdown && revealUiArmed && willReveal));
    const revealed = !!canShowFaces;
    const backs =
      !revealed &&
      ((p.holeHidden && p.hasHole) ||
        (atShowdown && willReveal && p.hasHole) ||
        (atShowdown && p.hasHole && p.showChoice == null))
        ? cardBackPair()
        : '';
    const revealHtml = revealed
      ? `<div class="reveal-hole" data-seat="${seat}">${p.hole
          .map((c) => cardHtml(c, { hero: true }))
          .join('')}</div>`
      : '';
    const wonAmt = state.winnerPayouts?.[seat];
    // Defer WIN glow/badge until FX onGlow
    const isWin = wonAmt != null && atShowdown && showdownGlowOn;
    const showing = revealed ? ' is-showing' : '';
    const timing =
      handUiReady &&
      !!v.config.timerEnabled &&
      v.actor === seat &&
      v.deadline != null &&
      !v.isHandOver &&
      !v.isShowdown &&
      !state.pause?.active;
    // During deal intro, show pre-blind stack so chip-count can roll down
    let stackShow =
      dealingSetup && p.bet > 0 ? p.chips + p.bet : p.chips;
    if (displayChipsOverride && displayChipsOverride[seat] != null) {
      stackShow = displayChipsOverride[seat];
    } else if (atShowdown && wonAmt != null && !revealUiArmed) {
      stackShow = p.chips - wonAmt;
    }
    const el = document.createElement('div');
    el.className = `seat pos-${pos}${folded}${actor}${showing}${isWin ? ' is-winner' : ''}`;
    el.dataset.seat = String(seat);
    el.innerHTML = `
      ${revealHtml || backs}
      <div class="plate plateA${isWin ? ' is-winner' : ''}">
        ${avWithRing(p.name.slice(0, 1), { timing })}
        <div>
          <div class="nm">${esc(p.name)}${role}</div>
          <span class="ch st">${fmtChips(stackShow)}</span>
        </div>
      </div>${
        isWin ? `<div class="win-badge">WIN +${fmtChips(wonAmt)}</div>` : ''
      }`;
    seatsRoot.appendChild(el);

    if (p.bet > 0 && !v.isHandOver && !v.isShowdown) {
      const b = document.createElement('div');
      // No betPop flash during deal — use is-pending until blind lands
      b.className = dealingSetup ? 'bet is-pending' : 'bet is-in';
      b.dataset.forSeat = String(seat);
      b.dataset.pos = String(pos);
      if (pos === 0) b.dataset.ref = '1';
      const blue = p.bet <= state.config.smallBlind ? ' is-blue' : '';
      b.innerHTML = `<span class="chips${blue}"><i class="a"></i></span><span class="amt">${fmtChips(p.bet)}</span>`;
      betsRoot.appendChild(b);
    }
  }

  const dealer = $('#dealer');
  const btnPos = seatToPos.get(v.button);
  dealer.dataset.pos = btnPos === 'hero' || v.button === viewerSeat ? 'hero' : String(btnPos);
  dealer.dataset.forSeat = String(v.button);

  const hero = v.seats[viewerSeat];
  const hole = $('#heroHole');
  const heroShown =
    hero?.showChoice === 'auto' ||
    hero?.showChoice === 'both' ||
    !!state.showdown?.revealed?.[viewerSeat] ||
    !!state.lastHandSummary?.revealed?.[viewerSeat];
  const heroMucked = hero?.showChoice === 'muck';
  // Face-down large backs during deal / post-deal pass; faces only after flip
  if (dealPresenting || passAfterDeal || (needsPass && passAfterDeal)) {
    hole.innerHTML =
      hero?.hole?.length || hero?.hasHole ? heroBackPair({ pending: dealPresenting }) : '';
  } else if (needsPass && !passAfterDeal) {
    hole.innerHTML = '';
  } else if (atShowdown && heroMucked) {
    // Privacy: after 不亮, own cards stay face-down (not face-up for bystanders)
    hole.innerHTML = hero?.hasHole || hero?.hole?.length ? heroBackPair({ pending: false }) : '';
  } else if (atShowdown && hero?.hole?.length && handUiReady) {
    if (heroShown && (flippedSeats.has(viewerSeat) || revealUiArmed)) {
      hole.innerHTML = hero.hole
        .map((c) => cardHtml(c, { hero: true, anim: false }))
        .join('');
    } else {
      // Privacy default at showdown: backs until shown / FX flip
      hole.innerHTML = heroBackPair({ pending: false });
    }
  } else if (hero?.hole?.length && handUiReady) {
    hole.innerHTML = hero.hole
      .map((c) => cardHtml(c, { hero: true, anim: false }))
      .join('');
  } else if (hero?.hole?.length || hero?.hasHole) {
    hole.innerHTML = heroBackPair({ pending: false });
  } else {
    hole.innerHTML = '';
  }
  {
    const nameEl = $('#heroName');
    if (nameEl) {
      if (hero && !needsPass) {
        const role = roleTag(v, viewerSeat);
        nameEl.innerHTML = `${esc(hero.name)}（你）${role}`;
      } else if (needsPass) {
        nameEl.textContent = '（換人中）';
      } else {
        nameEl.textContent = '';
      }
    }
  }
  {
    let stackShow =
      hero && dealingSetup && hero.bet > 0 ? hero.chips + hero.bet : hero?.chips;
    const heroWonAmt = state.winnerPayouts?.[viewerSeat];
    if (displayChipsOverride && displayChipsOverride[viewerSeat] != null) {
      stackShow = displayChipsOverride[viewerSeat];
    } else if (atShowdown && heroWonAmt != null && !revealUiArmed) {
      stackShow = (hero?.chips ?? 0) - heroWonAmt;
    }
    $('#heroChips').textContent =
      hero && (!needsPass || passAfterDeal) ? fmtChips(stackShow ?? 0) : '';
  }
  const mePlate = $('#mePlate');
  const heroWon = state.winnerPayouts?.[viewerSeat];
  const heroIsWin = heroWon != null && atShowdown && showdownGlowOn;
  mePlate?.classList.toggle('is-winner', !!heroIsWin);
  const heroTiming =
    handUiReady &&
    !!v.config.timerEnabled &&
    v.actor === viewerSeat &&
    v.deadline != null &&
    !v.isHandOver &&
    !v.isShowdown &&
    !needsPass &&
    !dealPresenting;
  {
    const avHost = mePlate?.querySelector('.av') || null;
    if (avHost && mePlate) {
      const initial = hero ? hero.name.slice(0, 1) : '—';
      avHost.outerHTML = avWithRing(initial, { timing: heroTiming });
      // keep id for tests / a11y hooks
      const newAv = mePlate.querySelector('.av');
      if (newAv) newAv.id = 'heroAv';
    }
  }
  document.querySelectorAll('#meRoot > .win-badge').forEach((n) => n.remove());
  if (heroIsWin && mePlate) {
    const badge = document.createElement('div');
    badge.className = 'win-badge';
    badge.textContent = `WIN +${fmtChips(heroWon)}`;
    $('#meRoot')?.appendChild(badge);
  }

  document.querySelectorAll('.table-note').forEach((n) => n.remove());
  {
    const note = foldWinCenterNote(state);
    if (note && (v.isHandOver || v.isShowdown)) {
      const el = document.createElement('div');
      el.className = 'table-note';
      // Two-line wrap: name/amount on first line, （其他人蓋牌） on second
      const parts = note.split('（');
      el.innerHTML =
        parts.length === 2
          ? `${esc(parts[0].trim())}<br>（${esc(parts[1])}`
          : esc(note);
      document.querySelector('.table')?.appendChild(el);
    }
  }

  if (hero?.bet > 0 && !v.isHandOver && !v.isShowdown) {
    const b = document.createElement('div');
    b.className = dealingSetup ? 'bet is-pending' : 'bet is-in';
    b.dataset.forSeat = String(viewerSeat);
    b.dataset.hero = '1';
    b.dataset.pos = 'hero';
    const blue = hero.bet <= state.config.smallBlind ? ' is-blue' : '';
    b.innerHTML = `<span class="chips${blue}"><i class="a"></i></span><span class="amt">${fmtChips(hero.bet)}</span>`;
    betsRoot.appendChild(b);
  }

  requestAnimationFrame(() => {
    // Snapshot previous D before placing for next-hand arc (not first hand)
    const dBefore = $('#dealer');
    const hadPrev =
      dBefore &&
      getComputedStyle(dBefore).display !== 'none' &&
      prevDealerRect != null;

    // D first (gen.py has D static before bets); then bets clear of D
    placeDealer();
    placeBets();
    // Re-place D now that bets are parked, so D clears chips too
    placeDealer();
    placeTableNote();
    const d = $('#dealer');
    if (d && getComputedStyle(d).display !== 'none') {
      // Keep prevDealerRect as the *previous* hand's rect for FX; update after deal ends
      if (!dealingSetup) {
        prevDealerRect = d.getBoundingClientRect();
      } else if (!hadPrev && state.handNumber <= 1) {
        // First hand: leave null so D drops from deck
        prevDealerRect = null;
      }
    }
    // Keep pot CSS-centred (clear any stray inline left/top from older layouts)
    const pot = document.querySelector('.pot');
    if (pot) {
      pot.style.left = '';
      pot.style.top = '';
      pot.style.transform = '';
    }
    maybePlayWinnerFx(v);
  });
}

function finishDealPresentation(hand) {
  dealFxBusy = false;
  dealPresenting = false;
  document.documentElement.classList.remove('is-dealing');
  // Snapshot D at final seat for the *next* hand's arc
  const d = $('#dealer');
  if (d && getComputedStyle(d).display !== 'none') {
    prevDealerRect = d.getBoundingClientRect();
  }
  if (awaitingDealThenPass && hand === state.handNumber) {
    awaitingDealThenPass = false;
    passAfterDeal = true;
    needsPass = true;
    showPass();
    return;
  }
  render();
}

function maybePlayDealFx() {
  if (needsPass || dealFxBusy) return;
  if (!pendingDealHand || pendingDealHand !== state.handNumber) return;
  if (state.phase !== PHASE.PREFLOP) return;
  const hand = state.handNumber;
  const prev = prevDealerRect;
  pendingDealHand = 0;
  lastDealPlayed = hand;
  dealFxBusy = true;
  dealPresenting = true;
  handUiReady = false;
  document.getElementById('act')?.classList.add('is-deal-locked');
  requestAnimationFrame(() => {
    // Second rAF: layout settled after placeDealer/placeBets
    requestAnimationFrame(() => {
      playDealAnimation({
        state,
        viewerSeat,
        prevDealer: prev,
        onDone: () => finishDealPresentation(hand),
      });
    });
  });
}

function maybePlayWinnerFx(v) {
  if (needsPass) return;
  if (!(v.isHandOver || v.isShowdown) || !state.winners?.length) return;
  const key = `${state.handNumber}:${JSON.stringify(state.winnerPayouts || state.winners)}`;
  if (key === winFxKey) return;
  winFxKey = key;
  showdownFxBusy = true;
  revealUiArmed = false;
  showdownGlowOn = false;
  // Pre-payout stack display
  displayChipsOverride = {};
  for (const [seat, amt] of Object.entries(state.winnerPayouts || {})) {
    const p = state.seats[+seat];
    if (p) displayChipsOverride[+seat] = p.chips - amt;
  }
  displayPotOverride = v.potTotal;

  const flipSeat = async (seat, cards) => {
    flippedSeats.add(seat);
    const pos = seatVisualPos(seat, viewerSeat);
    if (pos === 'hero') {
      const mount = (html) => {
        const h = $('#heroHole');
        if (h) h.innerHTML = html;
      };
      if (prefersReducedMotion()) {
        mount(cards.map((c) => cardHtml(c, { hero: true, anim: false })).join(''));
        return;
      }
      const parts = cards.map((c, i) => {
        const red = c.s === 1 || c.s === 2 ? ' red' : ' blk';
        return (
          `<div class="card hero is-flipping" data-i="${i}">` +
          `<div class="flip">` +
          `<div class="face back" aria-hidden="true"></div>` +
          `<div class="face front${red}">${cardFaceInner(c)}</div>` +
          `</div></div>`
        );
      });
      mount(parts.join(''));
      const els = [...document.querySelectorAll('#heroHole .card.is-flipping .flip')];
      await Promise.all(
        els.map((flip, i) =>
          flip
            .animate(
              [
                { transform: 'rotateY(0deg)' },
                { offset: 0.5, transform: 'rotateY(90deg) translateY(-4px)' },
                { transform: 'rotateY(180deg)' },
              ],
              {
                delay: i * 40,
                duration: SHOWDOWN_FX.flipMs,
                easing: SHOWDOWN_FX.easeFlip,
                fill: 'forwards',
              },
            )
            .finished.catch(() => {}),
        ),
      );
      mount(cards.map((c) => cardHtml(c, { hero: true, anim: false })).join(''));
      return;
    }
    const seatEl = document.querySelector(`.seat.pos-${pos}`);
    if (!seatEl) return;
    const host = document.createElement('div');
    host.className = 'reveal-hole';
    host.dataset.seat = String(seat);
    seatEl.querySelector('.backs')?.remove();
    seatEl.querySelector('.reveal-hole')?.remove();
    seatEl.insertBefore(host, seatEl.firstChild);
    seatEl.classList.add('is-showing');
    if (prefersReducedMotion()) {
      host.innerHTML = cards.map((c) => cardHtml(c, { hero: true })).join('');
      return;
    }
    host.innerHTML = cards
      .map((c, i) => {
        const red = c.s === 1 || c.s === 2 ? ' red' : ' blk';
        return (
          `<div class="card hero is-flipping" data-i="${i}">` +
          `<div class="flip">` +
          `<div class="face back" aria-hidden="true"></div>` +
          `<div class="face front${red}">${cardFaceInner(c)}</div>` +
          `</div></div>`
        );
      })
      .join('');
    const flips = [...host.querySelectorAll('.flip')];
    await Promise.all(
      flips.map((flip, i) =>
        flip
          .animate(
            [
              { transform: 'rotateY(0deg)' },
              { offset: 0.5, transform: 'rotateY(90deg) translateY(-4px)' },
              { transform: 'rotateY(180deg)' },
            ],
            {
              delay: i * 40,
              duration: SHOWDOWN_FX.flipMs,
              easing: SHOWDOWN_FX.easeFlip,
              fill: 'forwards',
            },
          )
          .finished.catch(() => {}),
      ),
    );
    host.innerHTML = cards.map((c) => cardHtml(c, { hero: true })).join('');
  };

  playShowdownSequence({
    state,
    viewerSeat,
    flipSeat,
    onGlow: () => {
      showdownGlowOn = true;
      // Mount badges without full table rebuild (FX layer busy)
      for (const [seat, amt] of Object.entries(state.winnerPayouts || {})) {
        const pos = seatVisualPos(+seat, viewerSeat);
        if (pos === 'hero') {
          $('#mePlate')?.classList.add('is-winner');
          if (!document.querySelector('#meRoot > .win-badge')) {
            const badge = document.createElement('div');
            badge.className = 'win-badge';
            badge.textContent = `WIN +${fmtChips(+amt)}`;
            $('#meRoot')?.appendChild(badge);
          }
        } else {
          const seatEl = document.querySelector(`.seat.pos-${pos}`);
          seatEl?.classList.add('is-winner');
          seatEl?.querySelector('.plate')?.classList.add('is-winner');
          if (seatEl && !seatEl.querySelector('.win-badge')) {
            const badge = document.createElement('div');
            badge.className = 'win-badge';
            badge.textContent = `WIN +${fmtChips(+amt)}`;
            seatEl.appendChild(badge);
          }
        }
      }
    },
    onStacksFinal: (payouts) => {
      displayChipsOverride = null;
      for (const [seat] of Object.entries(payouts || {})) {
        const pos = seatVisualPos(+seat, viewerSeat);
        const el =
          pos === 'hero'
            ? $('#heroChips')
            : document.querySelector(`.seat.pos-${pos} .ch, .seat.pos-${pos} .st`);
        const p = state.seats[+seat];
        if (el && p) el.textContent = fmtChips(p.chips);
      }
    },
    onPotZero: () => {
      displayPotOverride = 0;
      if ($('#potAmt')) $('#potAmt').textContent = '0';
    },
    onReadyForChoice: () => {
      showdownFxBusy = false;
      armRevealChoice();
    },
    onDone: () => {
      showdownFxBusy = false;
    },
  });
}

/** Safe chip-rail anchors (% of .table) — inward from seats, clear of pot (~28%) / board. */
const BET_ANCHOR_PHONE = {
  0: [50, 22],
  // Inward of side nameplates, above the board band (~45%+ on phones)
  1: [64, 31],
  2: [64, 39],
  3: [36, 39],
  4: [36, 31],
  // Below board band (board ~52–60% on short phones)
  hero: [50, 72],
};
const BET_ANCHOR_DESKTOP = {
  0: [50, 22],
  // Above board band (~46–58% on desktop felt)
  1: [64, 32],
  2: [64, 42],
  3: [36, 42],
  4: [36, 32],
  hero: [50, 72],
};

/** Dealer «D» anchors — near the button seat but inward; nudged clear of plates. */
const DEALER_ANCHOR_PHONE = {
  0: [62, 16],
  1: [78, 34],
  2: [78, 54],
  3: [22, 54],
  4: [22, 34],
  hero: [58, 70],
};
const DEALER_ANCHOR_DESKTOP = {
  0: [58, 20],
  1: [76, 34],
  2: [74, 58],
  3: [26, 58],
  4: [24, 34],
  hero: [60, 74],
};

/**
 * Position each .bet on a safe rail toward the pot, then nudge away from
 * plates / board / pot / other bets if anything still collides.
 */
function layoutBets() {
  const table = document.querySelector('.table');
  const board = $('#board');
  const potEl = document.querySelector('.pot');
  if (!table) return;
  const t = table.getBoundingClientRect();
  if (t.width < 8 || t.height < 8) return;
  const desktop = window.matchMedia('(min-width: 1024px)').matches;
  const anchors = desktop ? BET_ANCHOR_DESKTOP : BET_ANCHOR_PHONE;
  const boardBox = board?.getBoundingClientRect();
  const potBox = potEl?.getBoundingClientRect();
  const plates = [...document.querySelectorAll('.seat .plate, .meinfo')].map((el) =>
    el.getBoundingClientRect(),
  );
  const holeBoxes = [...document.querySelectorAll('#heroHole .card')].map((el) =>
    el.getBoundingClientRect(),
  );
  const bets = [...document.querySelectorAll('#bets .bet')];

  /** @type {{el:HTMLElement, x:number, y:number, w:number, h:number, hero:boolean}[]} */
  const placed = [];

  for (const bet of bets) {
    const key = bet.dataset.hero === '1' ? 'hero' : bet.dataset.pos;
    const [px, py] = anchors[key] || anchors.hero;
    bet.style.left = `${px}%`;
    bet.style.top = `${py}%`;
    const br = bet.getBoundingClientRect();
    placed.push({
      el: bet,
      x: br.left,
      y: br.top,
      w: br.width,
      h: br.height,
      hero: bet.dataset.hero === '1',
    });
  }

  const pad = 8;
  const potPad = 6;
  for (let pass = 0; pass < 18; pass++) {
    for (const p of placed) {
      const box = () => ({
        left: p.x - pad,
        top: p.y - pad,
        right: p.x + p.w + pad,
        bottom: p.y + p.h + pad,
      });
      for (const pl of plates) {
        const d = separationDelta(box(), pl, 4) || overlapDelta(box(), pl);
        if (d) {
          p.x += d.dx;
          p.y += d.dy;
        }
      }
      if (!p.hero) {
        for (const hc of holeBoxes) {
          const d = overlapDelta(box(), {
            left: hc.left - 4,
            top: hc.top - 4,
            right: hc.right + 4,
            bottom: hc.bottom + 4,
          });
          if (d) {
            p.x += d.dx;
            p.y += d.dy;
          }
        }
      }
      if (boardBox) {
        const inflated = {
          left: boardBox.left - 8,
          top: boardBox.top - 8,
          right: boardBox.right + 8,
          bottom: boardBox.bottom + 8,
        };
        const d = overlapDelta(box(), inflated);
        if (d) {
          if (p.hero) {
            // Hero bets live under the board — never slide upward into the pot
            p.y += Math.max(Math.abs(d.dy), d.dy, 4);
            p.x += d.dx;
          } else {
            p.x += d.dx;
            p.y += d.dy;
          }
        }
      }
      // Clear pot: prefer vertical/horizontal slide that does not walk onto plates
      if (potBox) {
        const inflated = {
          left: potBox.left - potPad,
          top: potBox.top - potPad,
          right: potBox.right + potPad,
          bottom: potBox.bottom + potPad,
        };
        const d = overlapDelta(box(), inflated);
        if (d) {
          const pcx = (potBox.left + potBox.right) / 2;
          const pcy = (potBox.top + potBox.bottom) / 2;
          const bcx = p.x + p.w / 2;
          const bcy = p.y + p.h / 2;
          const awayX = bcx >= pcx ? 1 : -1;
          const awayY = p.hero ? 1 : bcy >= pcy ? 1 : -1;
          if (d.dx !== 0 && Math.abs(d.dx) <= Math.abs(d.dy) + 1 && !p.hero) {
            p.x += awayX * Math.abs(d.dx);
          } else {
            p.y += awayY * Math.abs(d.dy || d.dx);
            if (p.hero) p.x += awayX * Math.min(8, Math.abs(d.dx));
          }
        }
      }
      for (const q of placed) {
        if (q === p) continue;
        const d = overlapDelta(box(), {
          left: q.x - pad,
          top: q.y - pad,
          right: q.x + q.w + pad,
          bottom: q.y + q.h + pad,
        });
        if (d) {
          p.x += d.dx * 0.6;
          p.y += d.dy * 0.6;
        }
      }
      p.x = clamp(p.x, t.left + 2, t.right - p.w - 2);
      p.y = clamp(p.y, t.top + 2, t.bottom - p.h - 2);
      p.el.style.left = `${((p.x + p.w / 2 - t.left) / t.width) * 100}%`;
      p.el.style.top = `${((p.y + p.h / 2 - t.top) / t.height) * 100}%`;
      const br = p.el.getBoundingClientRect();
      p.x = br.left;
      p.y = br.top;
      p.w = br.width;
      p.h = br.height;
    }
  }

  // Final separation: plates first (priority), then pot, board, peers
  for (let fin = 0; fin < 12; fin++) {
    for (const p of placed) {
      const a0 = () => ({ left: p.x, top: p.y, right: p.x + p.w, bottom: p.y + p.h });
      for (const pl of plates) {
        const d = separationDelta(a0(), pl, 8);
        if (d) {
          p.x += d.dx;
          p.y += d.dy;
        }
      }
      if (potBox) {
        const inflated = {
          left: potBox.left - potPad,
          top: potBox.top - potPad,
          right: potBox.right + potPad,
          bottom: potBox.bottom + potPad,
        };
        const d = overlapDelta(a0(), inflated);
        if (d) {
          const pcx = (potBox.left + potBox.right) / 2;
          const pcy = (potBox.top + potBox.bottom) / 2;
          const bcx = p.x + p.w / 2;
          const bcy = p.y + p.h / 2;
          p.x += (bcx >= pcx ? 1 : -1) * Math.max(2, Math.abs(d.dx));
          p.y += (bcy >= pcy ? 1 : -1) * Math.max(2, Math.abs(d.dy));
        }
      }
      if (boardBox) {
        const inflated = {
          left: boardBox.left - 4,
          top: boardBox.top - 4,
          right: boardBox.right + 4,
          bottom: boardBox.bottom + 4,
        };
        const d = overlapDelta(a0(), inflated);
        if (d) {
          p.x += d.dx;
          p.y += d.dy;
        }
      }
      for (const q of placed) {
        if (q === p) continue;
        const d = separationDelta(
          a0(),
          { left: q.x, top: q.y, right: q.x + q.w, bottom: q.y + q.h },
          4,
        );
        if (d) {
          p.x += d.dx * 0.75;
          p.y += d.dy * 0.75;
        }
      }
      p.x = clamp(p.x, t.left + 2, t.right - p.w - 2);
      p.y = clamp(p.y, t.top + 2, t.bottom - p.h - 2);
      p.el.style.left = `${((p.x + p.w / 2 - t.left) / t.width) * 100}%`;
      p.el.style.top = `${((p.y + p.h / 2 - t.top) / t.height) * 100}%`;
      const br = p.el.getBoundingClientRect();
      p.x = br.left;
      p.y = br.top;
      p.w = br.width;
      p.h = br.height;
    }
  }
}

/**
 * Place the dealer «D» tight against the button seat's nameplate, on the
 * side facing table center. Score candidate spots around the plate's inward
 * perimeter so D never drifts toward another seat. Bet chips yield to D.
 */
function layoutDealer() {
  const table = document.querySelector('.table');
  const dealer = $('#dealer');
  if (!table || !dealer) return;
  const t = table.getBoundingClientRect();
  if (t.width < 8 || t.height < 8) return;

  const key = dealer.dataset.pos || 'hero';
  const seatId = dealer.dataset.forSeat;
  const anchorEl =
    key === 'hero'
      ? document.querySelector('.meinfo')
      : document.querySelector(`.seat[data-seat="${seatId}"] .plate`);
  if (!anchorEl) return;

  const ar = anchorEl.getBoundingClientRect();
  const ax = ar.left + ar.width / 2;
  const ay = ar.top + ar.height / 2;
  const cx = t.left + t.width / 2;
  const cy = t.top + t.height * 0.4;
  const toCx = cx - ax;
  const toCy = cy - ay;
  const toLen = Math.hypot(toCx, toCy) || 1;
  const ux = toCx / toLen;
  const uy = toCy / toLen;

  dealer.style.left = '50%';
  dealer.style.top = '50%';
  const br0 = dealer.getBoundingClientRect();
  const dw = br0.width;
  const dh = br0.height;
  const gap = 4;

  const otherPlates = [...document.querySelectorAll('.seat .plate, .meinfo')].filter(
    (el) => el !== anchorEl,
  );
  const potEl = document.querySelector('.pot');
  const boardEl = $('#board');
  const noteEl = document.querySelector('.table-note');
  const softRects = [
    potEl,
    boardEl,
    noteEl,
    ...document.querySelectorAll(
      '#board .card, #board .slot, #heroHole .card, .mini-hole .card, .seat .av, #bets .bet',
    ),
  ]
    .filter(Boolean)
    .map((el) => {
      const r = el.getBoundingClientRect();
      const isBet = el.classList?.contains('bet');
      const pad =
        el === potEl || el === noteEl ? 6 : el === boardEl ? 2 : isBet ? 4 : 1;
      return {
        left: r.left - pad,
        top: r.top - pad,
        right: r.right + pad,
        bottom: r.bottom + pad,
      };
    });
  for (const pl of otherPlates) {
    const r = pl.getBoundingClientRect();
    softRects.push({
      left: r.left - 8,
      top: r.top - 8,
      right: r.right + 8,
      bottom: r.bottom + 8,
    });
  }

  const overlaps = (a, b) => {
    const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return ox > 0 && oy > 0;
  };
  const edgeDist = (px, py, r) => {
    const dx = Math.max(r.left - px, 0, px - r.right);
    const dy = Math.max(r.top - py, 0, py - r.bottom);
    return Math.hypot(dx, dy);
  };

  // Candidates: tight ring on the plate's inward edge (not deep toward pot).
  // Depth is only gap + button radius past the plate AABB — keeps D clearly
  // on the button seat even when the pot sits just inside.
  /** @type {{x:number,y:number,score:number}[]} */
  const candidates = [];
  const edgeDepth = gap + Math.max(dw, dh) / 2;
  const rings = [edgeDepth, edgeDepth + 5];
  for (const rad of rings) {
    for (let i = 0; i < 32; i++) {
      const ang = (i / 32) * Math.PI * 2;
      const dx = Math.cos(ang);
      const dy = Math.sin(ang);
      // Inward hemisphere only (dot with table-center direction >= -0.1)
      if (dx * ux + dy * uy < -0.1) continue;
      // Distance to plate AABB edge along (dx,dy), then + rad
      const tx = dx === 0 ? Infinity : (ar.width / 2) / Math.abs(dx);
      const ty = dy === 0 ? Infinity : (ar.height / 2) / Math.abs(dy);
      const toEdge = Math.min(tx, ty);
      const x = ax + dx * (toEdge + rad);
      const y = ay + dy * (toEdge + rad);
      candidates.push({ x, y, score: 0 });
    }
  }
  // Explicit inward-edge slides (clear pot while staying on the plate lip)
  {
    const px = -uy;
    const py = ux;
    // Anchor on the inward face of the plate
    const faceX = ax + ux * (Math.min(
      ux === 0 ? Infinity : (ar.width / 2) / Math.abs(ux),
      uy === 0 ? Infinity : (ar.height / 2) / Math.abs(uy),
    ) + edgeDepth);
    const faceY = ay + uy * (Math.min(
      ux === 0 ? Infinity : (ar.width / 2) / Math.abs(ux),
      uy === 0 ? Infinity : (ar.height / 2) / Math.abs(uy),
    ) + edgeDepth);
    candidates.push({ x: faceX, y: faceY, score: 0 });
    for (const side of [-1, 1]) {
      for (const lat of [8, 14, 22, 30, 40]) {
        candidates.push({
          x: faceX + px * side * lat,
          y: faceY + py * side * lat,
          score: 0,
        });
      }
    }
  }

  // Hero plate sits below the felt — allow D into that band only for hero.
  // Opponent D must stay on the felt so it never floats in the chrome.
  const stage = document.querySelector('.stage')?.getBoundingClientRect() || t;
  const minX =
    key === 'hero' ? Math.min(t.left, stage.left) + dw / 2 + 4 : t.left + dw / 2 + 4;
  const maxX =
    key === 'hero' ? Math.max(t.right, stage.right) - dw / 2 - 4 : t.right - dw / 2 - 4;
  const minY = t.top + dh / 2 + 4;
  const maxY =
    key === 'hero'
      ? Math.max(t.bottom, ar.bottom + dh / 2 + 8) - dh / 2 - 2
      : t.bottom - dh / 2 - 2;

  // Hero hole cards sit above meinfo; for hero, don't treat them as hard blocks on
  // lateral candidates (left/right of the plate still read as "this seat's D").
  const softForHeroSide = softRects.filter((r) => {
    if (key !== 'hero') return true;
    // drop obstacles that are mostly above the plate (hole cards)
    return r.bottom > ar.top - 4;
  });

  let best = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    let x = clamp(c.x, minX, maxX);
    let y = clamp(c.y, minY, maxY);
    const box = {
      left: x - dw / 2,
      top: y - dh / 2,
      right: x + dw / 2,
      bottom: y + dh / 2,
    };
    // Must not cover own plate
    if (overlaps(box, ar)) continue;
    const soft = key === 'hero' && Math.abs(x - ax) > Math.abs(y - ay) ? softForHeroSide : softRects;
    let blocked = false;
    for (const ob of soft) {
      if (overlaps(box, ob)) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    const own = edgeDist(x, y, ar);
    if (own > 14) continue;
    // Clearly nearer to own plate than to any other (never drift toward a neighbor).
    // When glued tight to own plate (own < 8), a smaller margin still reads as "this seat".
    const otherMargin = own < 8 ? 10 : 14;
    let nearestOther = Infinity;
    let nearerOther = false;
    for (const pl of otherPlates) {
      const pr = pl.getBoundingClientRect();
      const od = edgeDist(x, y, pr);
      nearestOther = Math.min(nearestOther, od);
      if (od <= own + otherMargin) {
        nearerOther = true;
        break;
      }
    }
    if (nearerOther) continue;
    // Prefer inward + close to plate + far from neighbors
    const inward = (x - ax) * ux + (y - ay) * uy;
    const lateral = Math.abs((x - ax) * -uy + (y - ay) * ux);
    const score = own * 4 + Math.max(0, -inward) * 5 + Math.max(0, 36 - nearestOther) + lateral * 0.5;
    if (score < bestScore) {
      bestScore = score;
      best = { x, y };
    }
  }

  // Fallback: glue to the inward edge, or the side farther from other seats
  if (!best) {
    const plateAlong = (Math.abs(ux) * ar.width + Math.abs(uy) * ar.height) / 2;
    const rad = plateAlong + Math.max(dw, dh) / 2 + gap;
    const fallbacks =
      key === 'hero'
        ? [
            { x: ar.left - dw / 2 - gap, y: ay },
            { x: ar.right + dw / 2 + gap, y: ay },
            { x: ax, y: ar.top - dh / 2 - gap },
          ]
        : [
            { x: ax + ux * rad, y: ay + uy * rad },
            // Along plate edge, perpendicular to inward (both directions)
            { x: ax - uy * rad, y: ay + ux * rad },
            { x: ax + uy * rad, y: ay - ux * rad },
            { x: ax + ux * (rad * 0.7) - uy * (rad * 0.5), y: ay + uy * (rad * 0.7) + ux * (rad * 0.5) },
            { x: ax + ux * (rad * 0.7) + uy * (rad * 0.5), y: ay + uy * (rad * 0.7) - ux * (rad * 0.5) },
          ];
    let fbBest = null;
    let fbScore = Infinity;
    for (const f of fallbacks) {
      const x = clamp(f.x, minX, maxX);
      const y = clamp(f.y, minY, maxY);
      const own = edgeDist(x, y, ar);
      let nearestOther = Infinity;
      for (const pl of otherPlates) {
        nearestOther = Math.min(nearestOther, edgeDist(x, y, pl.getBoundingClientRect()));
      }
      if (nearestOther <= own + 8) continue;
      const inward = (x - ax) * ux + (y - ay) * uy;
      const score = own * 2 + Math.max(0, -inward) * 3 + Math.max(0, 30 - nearestOther);
      if (score < fbScore) {
        fbScore = score;
        fbBest = { x, y };
      }
    }
    best = fbBest || {
      x: clamp(ax + ux * rad, minX, maxX),
      y: clamp(ay + uy * rad, minY, maxY),
    };
    // Never rest on top of the button's own nameplate
    for (let k = 0; k < 8; k++) {
      const box = {
        left: best.x - dw / 2,
        top: best.y - dh / 2,
        right: best.x + dw / 2,
        bottom: best.y + dh / 2,
      };
      if (!overlaps(box, ar)) break;
      best = {
        x: clamp(best.x + ux * 6, minX, maxX),
        y: clamp(best.y + uy * 6, minY, maxY),
      };
    }
  }

  // Final: if D still grazes the pot or center note, park on the plate's
  // inward lip just clear of those AABBs — stay on the button seat edge.
  {
    const blockers = [];
    if (potEl) blockers.push({ el: potEl, pad: 4 });
    if (noteEl) blockers.push({ el: noteEl, pad: 4 });
    const lip = edgeDepth;
    const faceDist = Math.min(
      ux === 0 ? Infinity : ar.width / 2 / Math.abs(ux),
      uy === 0 ? Infinity : ar.height / 2 / Math.abs(uy),
    );
    const faceX = ax + ux * (faceDist + lip);
    const faceY = ay + uy * (faceDist + lip);
    const px = -uy;
    const py = ux;
    const touches = (x, y, rect, pad) => {
      const box = {
        left: x - dw / 2,
        top: y - dh / 2,
        right: x + dw / 2,
        bottom: y + dh / 2,
      };
      return !!overlapDelta(box, {
        left: rect.left - pad,
        top: rect.top - pad,
        right: rect.right + pad,
        bottom: rect.bottom + pad,
      });
    };
    const blocked = (x, y) =>
      blockers.some(({ el, pad }) => touches(x, y, el.getBoundingClientRect(), pad));
    if (blocked(best.x, best.y)) {
      const options = [];
      for (const { el, pad } of blockers) {
        const r = el.getBoundingClientRect();
        if (Math.abs(uy) >= Math.abs(ux)) {
          options.push(
            { x: r.left - pad - dw / 2 - 1, y: faceY },
            { x: r.right + pad + dw / 2 + 1, y: faceY },
          );
        } else {
          options.push(
            { x: faceX, y: r.top - pad - dh / 2 - 1 },
            { x: faceX, y: r.bottom + pad + dh / 2 + 1 },
          );
        }
      }
      for (const side of [-1, 1]) {
        for (const lat of [16, 24, 32, 44, 56]) {
          options.push({ x: faceX + px * side * lat, y: faceY + py * side * lat });
        }
      }
      let pick = null;
      let pickScore = Infinity;
      for (const o of options) {
        const x = clamp(o.x, minX, maxX);
        const y = clamp(o.y, minY, maxY);
        // Reject outer-rail / behind-plate spots
        if ((x - ax) * ux + (y - ay) * uy < 4) continue;
        if (blocked(x, y)) continue;
        if (
          overlaps(
            { left: x - dw / 2, top: y - dh / 2, right: x + dw / 2, bottom: y + dh / 2 },
            ar,
          )
        ) {
          continue;
        }
        const own = edgeDist(x, y, ar);
        if (own > 20) continue;
        let nearest = Infinity;
        for (const pl of otherPlates) {
          nearest = Math.min(nearest, edgeDist(x, y, pl.getBoundingClientRect()));
        }
        if (nearest <= own + 4) continue;
        // Prefer glued to own plate, far from neighbors, and away from street
        // bets (top-seat pot escape to the right crowds SB/BB chips).
        let betNear = 0;
        for (const bet of document.querySelectorAll('#bets .bet')) {
          const br = bet.getBoundingClientRect();
          const bcx = (br.left + br.right) / 2;
          const bcy = (br.top + br.bottom) / 2;
          betNear += 1 / (1 + Math.hypot(x - bcx, y - bcy));
        }
        const score =
          own * 2.5 +
          Math.abs(x - ax) * 0.8 +
          Math.abs(y - ay) * 0.3 +
          Math.max(0, 40 - nearest) * 1.5 +
          betNear * 40;
        if (score < pickScore) {
          pickScore = score;
          pick = { x, y };
        }
      }
      if (pick) best = pick;
    }
  }

  // Hard rule: if D drifted outward (proj < 0), snap to the inward lip.
  // Hero is special — inward is up into the hole cards, so park D on the
  // left/right of meinfo instead of the top lip.
  {
    if (key === 'hero') {
      // Inward from meinfo is up into hole cards — always use left/right lip
      const holeBoxes = [...document.querySelectorAll('#heroHole .card')].map((el) =>
        el.getBoundingClientRect(),
      );
      const hitsHole = (x, y) =>
        holeBoxes.some((h) =>
          overlaps(
            { left: x - dw / 2, top: y - dh / 2, right: x + dw / 2, bottom: y + dh / 2 },
            { left: h.left - 2, top: h.top - 2, right: h.right + 2, bottom: h.bottom + 2 },
          ),
        );
      const leftX = ar.left - dw / 2 - gap;
      const rightX = ar.right + dw / 2 + gap;
      const sideY = clamp(ay, minY, maxY);
      const leftOk = !hitsHole(leftX, sideY);
      const rightOk = !hitsHole(rightX, sideY);
      if (leftOk && (!rightOk || Math.abs(leftX - ax) <= Math.abs(rightX - ax))) {
        best = { x: clamp(leftX, minX, maxX), y: sideY };
      } else if (rightOk) {
        best = { x: clamp(rightX, minX, maxX), y: sideY };
      }
    } else {
      const toEdge = Math.min(
        ux === 0 ? Infinity : ar.width / 2 / Math.abs(ux),
        uy === 0 ? Infinity : ar.height / 2 / Math.abs(uy),
      );
      const lip = toEdge + Math.max(dw, dh) / 2 + 3;
      const proj = (best.x - ax) * ux + (best.y - ay) * uy;
      if (proj < Math.max(6, toEdge * 0.35)) {
        const latX = (best.x - ax) * -uy + (best.y - ay) * ux;
        const clampedLat = clamp(latX, -ar.width * 0.35, ar.width * 0.35);
        best = {
          x: clamp(ax + ux * lip - uy * clampedLat, minX, maxX),
          y: clamp(ay + uy * lip + ux * clampedLat, minY, maxY),
        };
      }
    }
  }

  dealer.style.left = `${((best.x - t.left) / t.width) * 100}%`;
  dealer.style.top = `${((best.y - t.top) / t.height) * 100}%`;

  // Street bets: snap back to rail anchors, then resolve D/pot/board/plates/peers.
  // (Heavy D-nudging previously walked chips into plate↔board dead zones.)
  const potBox = potEl?.getBoundingClientRect();
  const boardBox = boardEl?.getBoundingClientRect();
  const plateRects = [...document.querySelectorAll('.seat .plate, .meinfo')].map((el) =>
    el.getBoundingClientRect(),
  );
  const desktop = window.matchMedia('(min-width: 1024px)').matches;
  const anchors = desktop ? BET_ANCHOR_DESKTOP : BET_ANCHOR_PHONE;
  const betEls = [...document.querySelectorAll('#bets .bet')];
  const peerGap = window.innerHeight < 700 ? 4 : 6;

  /** @type {{el:HTMLElement,x:number,y:number,w:number,h:number,hero:boolean,ax:number,ay:number}[]} */
  const placed = [];
  for (const bet of betEls) {
    const key = bet.dataset.hero === '1' ? 'hero' : bet.dataset.pos;
    const [axPct, ayPct] = anchors[key] || anchors.hero;
    const ax = t.left + (axPct / 100) * t.width;
    const ay = t.top + (ayPct / 100) * t.height;
    bet.style.left = `${axPct}%`;
    bet.style.top = `${ayPct}%`;
    const br = bet.getBoundingClientRect();
    placed.push({
      el: bet,
      x: br.left,
      y: br.top,
      w: br.width,
      h: br.height,
      hero: bet.dataset.hero === '1',
      ax,
      ay,
    });
  }

  const commit = (p) => {
    p.x = clamp(p.x, t.left + 2, t.right - p.w - 2);
    p.y = clamp(p.y, t.top + 2, t.bottom - p.h - 2);
    p.el.style.left = `${((p.x + p.w / 2 - t.left) / t.width) * 100}%`;
    p.el.style.top = `${((p.y + p.h / 2 - t.top) / t.height) * 100}%`;
    const br = p.el.getBoundingClientRect();
    p.x = br.left;
    p.y = br.top;
    p.w = br.width;
    p.h = br.height;
  };

  for (let pass = 0; pass < 18; pass++) {
    const finalD = dealer.getBoundingClientRect();
    let moved = false;
    for (const p of placed) {
      const a0 = () => ({ left: p.x, top: p.y, right: p.x + p.w, bottom: p.y + p.h });
      const bump = (ob, pad, heroBoard = false) => {
        const d = separationDelta(a0(), ob, pad) || overlapDelta(a0(), ob);
        if (!d) return false;
        if (heroBoard) {
          p.y += Math.max(Math.abs(d.dy), d.dy, 3);
          p.x += d.dx;
        } else {
          p.x += d.dx;
          p.y += d.dy;
        }
        return true;
      };
      // Pad 8 clears the layout assert's near(D, bet, 2) buffer
      let hit = bump(finalD, 8);
      if (potBox) hit = bump(potBox, 6) || hit;
      if (boardBox) {
        const inflated = {
          left: boardBox.left - 4,
          top: boardBox.top - 4,
          right: boardBox.right + 4,
          bottom: boardBox.bottom + 4,
        };
        if (!p.hero) {
          const before = a0();
          if (
            before.bottom > inflated.top &&
            before.top < inflated.bottom &&
            before.right > inflated.left &&
            before.left < inflated.right
          ) {
            p.y -= Math.max(4, before.bottom - inflated.top + 4);
            hit = true;
          } else {
            hit = bump(inflated, 4) || hit;
          }
        } else {
          hit = bump(inflated, 4, true) || hit;
        }
      }
      // Pad ≥7: tall-phone layout asserts a 3px near-buffer around plates
      for (const pl of plateRects) hit = bump(pl, 8) || hit;
      for (const q of placed) {
        if (q === p) continue;
        const qb = { left: q.x, top: q.y, right: q.x + q.w, bottom: q.y + q.h };
        const d = separationDelta(a0(), qb, peerGap) || overlapDelta(a0(), qb);
        if (!d) continue;
        const pcx = p.x + p.w / 2;
        const pcy = p.y + p.h / 2;
        const qcx = q.x + q.w / 2;
        const qcy = q.y + q.h / 2;
        if (Math.hypot(pcx - qcx, pcy - qcy) < 8) {
          const dirY = p.ay <= q.ay ? -1 : 1;
          p.y += dirY * (peerGap + 2);
        } else {
          p.x += d.dx * 0.7;
          p.y += d.dy * 0.7;
        }
        hit = true;
      }
      // Re-clear D last so plate/board nudges cannot leave chips under the button
      hit = bump(finalD, 8) || hit;
      if (!hit) continue;
      moved = true;
      commit(p);
    }
    if (!moved) break;
  }
}

/** Push `a` away from `b` until edge gap >= minGap (or clear overlap). */
function separationDelta(a, b, minGap) {
  const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  const acx = (a.left + a.right) / 2;
  const acy = (a.top + a.bottom) / 2;
  const bcx = (b.left + b.right) / 2;
  const bcy = (b.top + b.bottom) / 2;
  if (ox > 0 && oy > 0) {
    if (ox < oy) {
      return { dx: (acx >= bcx ? 1 : -1) * (ox + minGap), dy: 0 };
    }
    return { dx: 0, dy: (acy >= bcy ? 1 : -1) * (oy + minGap) };
  }
  if (ox > 0) {
    const gap = Math.max(a.top - b.bottom, b.top - a.bottom);
    if (gap >= minGap) return null;
    return { dx: 0, dy: (acy >= bcy ? 1 : -1) * (minGap - gap) };
  }
  if (oy > 0) {
    const gap = Math.max(a.left - b.right, b.left - a.right);
    if (gap >= minGap) return null;
    return { dx: (acx >= bcx ? 1 : -1) * (minGap - gap), dy: 0 };
  }
  return null;
}

/** @returns {{dx:number,dy:number}|null} */
function overlapDelta(a, b) {
  const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (ox <= 0 || oy <= 0) return null;
  const acx = (a.left + a.right) / 2;
  const acy = (a.top + a.bottom) / 2;
  const bcx = (b.left + b.right) / 2;
  const bcy = (b.top + b.bottom) / 2;
  // Prefer pushing toward table center-ish (down from top seats, inward from sides)
  if (ox < oy) {
    return { dx: (acx >= bcx ? 1 : -1) * (ox + 2), dy: 0 };
  }
  return { dx: 0, dy: (acy >= bcy ? 1 : -1) * (oy + 2) };
}

function roleTag(v, seat) {
  // Mockup A: only 小盲／大盲 on nameplates (房主／莊家 live in ☰ menu)
  if (state.sbSeat === seat) return '<span class="tag sb">小盲</span>';
  if (state.bbSeat === seat) return '<span class="tag bb">大盲</span>';
  return '';
}

function renderSide(v) {
  const info = $('#sideInfo');
  if (!info) return;
  const seated = v.seats.filter(Boolean).length;
  const host = v.seats[v.room.hostSeat]?.name || '—';
  info.innerHTML = `<h2>牌局資訊</h2><dl>
    <dt>盲注</dt><dd>${v.config.smallBlind}／${v.config.bigBlind}</dd>
    <dt>起始籌碼</dt><dd>${fmtChips(v.config.startingStack)}</dd>
    <dt>在座</dt><dd>${seated} 人</dd>
    <dt>房主</dt><dd>${esc(host)}</dd></dl>`;

  const log = $('#sideLog');
  const items = v.streetLog
    .map((x) =>
      x.kind === 'street'
        ? `<li class="street">${esc(x.text)}</li>`
        : `<li>${esc(x.text)}</li>`,
    )
    .join('');
  log.innerHTML = `<h2>這一手</h2><ol>${items || '<li class="street">尚未開始</li>'}</ol>`;
}

function closeRaisePanel() {
  raisePanelOpen = false;
  const scrim = $('#raiseScrim');
  const panel = $('#raisePanel');
  if (scrim) {
    scrim.classList.remove('is-on');
    scrim.hidden = true;
  }
  if (panel) {
    panel.classList.remove('is-on');
    panel.hidden = true;
  }
  clearRaiseHold();
}

function openRaisePanel(legal) {
  const min = legal.minRaiseTo;
  const max = legal.maxRaiseTo;
  const lo = Math.min(min, max);
  const presets = raisePresets(state, viewerSeat);
  const preferred = presets.find((p) => p.preferred)?.to ?? min;
  if (!raiseTo) raiseTo = preferred;
  raiseTo = clamp(raiseTo, lo, max);

  const range = $('#raiseRange');
  range.min = String(lo);
  range.max = String(max);
  range.step = '1';
  range.value = String(raiseTo);
  range.oninput = () => {
    raiseTo = +range.value;
    syncRaiseUi();
  };
  $('#presets').innerHTML = presets
    .map(
      (p) =>
        `<button type="button" data-to="${p.to}" data-id="${p.id}" aria-pressed="${p.to === raiseTo}">` +
        `<span class="preset-lbl">${p.label}</span>` +
        `<span class="preset-amt">${fmtChips(p.to)}</span></button>`,
    )
    .join('');
  $('#presets').onclick = (e) => {
    const b = e.target.closest('button[data-to]');
    if (!b) return;
    raiseTo = clamp(+b.dataset.to, lo, max);
    range.value = String(raiseTo);
    syncRaiseUi();
  };
  bindRaiseStep($('#raiseMinus'), -1);
  bindRaiseStep($('#raisePlus'), 1);

  const callAmt = legal.callAmount || 0;
  const hint = $('#raiseHint');
  if (hint) {
    hint.textContent = legal.check
      ? `最少加到 ${fmtChips(lo)}`
      : `跟注 ${fmtChips(callAmt)} · 最少加到 ${fmtChips(lo)}`;
  }
  syncRaiseUi();

  const scrim = $('#raiseScrim');
  const panel = $('#raisePanel');
  if (scrim) {
    scrim.hidden = false;
    requestAnimationFrame(() => scrim.classList.add('is-on'));
    scrim.onclick = () => closeRaisePanel();
  }
  if (panel) {
    panel.hidden = false;
    requestAnimationFrame(() => panel.classList.add('is-on'));
  }
  raisePanelOpen = true;
  const cancel = $('#raiseCancel');
  if (cancel) cancel.onclick = () => closeRaisePanel();
  const conf = $('#raiseConfirm');
  if (conf) {
    conf.onclick = () => {
      const amt = raiseTo;
      closeRaisePanel();
      dispatch({ type: 'BET_RAISE', seat: viewerSeat, amount: amt });
      passToNextIfNeeded();
    };
  }
}

function renderActions(v) {
  const act = $('#act');
  const gated = !handUiReady || dealPresenting || heroFlipping || passAfterDeal;
  if (gated) act?.classList.add('is-deal-locked');
  else if (!needsPass) act?.classList.remove('is-deal-locked');

  const legal = v.legal;
  const myTurn =
    handUiReady &&
    !needsPass &&
    !dealPresenting &&
    !heroFlipping &&
    legal?.canAct &&
    v.actor === viewerSeat &&
    [PHASE.PREFLOP, PHASE.FLOP, PHASE.TURN, PHASE.RIVER].includes(v.phase);

  const showdownMine =
    !needsPass && v.isShowdown && state.showdown?.pending?.includes(viewerSeat);

  if (!myTurn || v.isHandOver || v.isShowdown) closeRaisePanel();

  if (v.isHandOver) {
    act.classList.remove('is-dim');
    $('#showCd')?.classList.add('hidden');
    $('#showBtns').classList.add('hidden');
    $('#showBtns').innerHTML = '';
    const isHost = viewerSeat === state.room.hostSeat;
    const holdLeft =
      holdDeadline != null
        ? Math.max(0, Math.ceil((holdDeadline - Date.now()) / 1000))
        : Math.ceil(holdMsForState() / 1000);
    const holdTotal = holdMsForState();
    const holdPct =
      holdDeadline != null
        ? Math.max(0, Math.min(100, ((holdDeadline - Date.now()) / holdTotal) * 100))
        : 100;
    $('#btns').innerHTML = `
      <button type="button" class="call btn-next-hold" id="btnNext">
        <svg class="hold-ring" viewBox="0 0 36 36" aria-hidden="true">
          <circle class="hold-ring-bg" cx="18" cy="18" r="15"/>
          <circle class="hold-ring-fg" cx="18" cy="18" r="15" pathLength="100"
            stroke-dasharray="100" stroke-dashoffset="${100 - holdPct}"/>
        </svg>
        <span class="btn-next-label">下一手</span>
        <span class="btn-next-cd" id="holdCd">${holdLeft}</span>
      </button>
      ${
        isHost
          ? `<button type="button" class="raiseb" id="btnPauseHold">暫停</button>`
          : ''
      }
      <button type="button" class="fold" id="btnEnd">結束牌局</button>
      <button type="button" class="raiseb" id="btnSummary">看戰績</button>`;
    $('#btnNext').onclick = () => {
      goNextHandFromHold();
    };
    $('#btnPauseHold')?.addEventListener('click', () => requestPause());
    $('#btnEnd').onclick = () => {
      if (autoNextTimer) {
        clearTimeout(autoNextTimer);
        autoNextTimer = null;
      }
      holdDeadline = null;
      dispatch({ type: 'END_SESSION' });
      showSummary();
    };
    $('#btnSummary').onclick = () => showSummary();
    return;
  }

  if (showdownMine && revealUiArmed) {
    act.classList.remove('is-dim');
    $('#btns').innerHTML = '';
    const left =
      revealDeadline != null
        ? Math.max(0, Math.ceil((revealDeadline - Date.now()) / 1000))
        : Math.ceil(REVEAL_MS / 1000);
    const cd = $('#showCd');
    if (cd) {
      cd.classList.remove('hidden');
      cd.textContent = `${left} 秒後自動不亮`;
    }
    $('#showBtns').classList.remove('hidden');
    $('#showBtns').innerHTML = `
      <button type="button" class="primary" id="btnShowBoth">亮牌</button>
      <button type="button" id="btnMuck">不亮</button>`;
    $('#btnMuck').onclick = () => {
      if (revealTimer) clearTimeout(revealTimer);
      revealDeadline = null;
      dispatch({ type: 'MUCK', seat: viewerSeat });
    };
    $('#btnShowBoth').onclick = () => {
      if (revealTimer) clearTimeout(revealTimer);
      revealDeadline = null;
      flippedSeats.add(viewerSeat);
      dispatch({ type: 'SHOW', seat: viewerSeat, mode: 'both' });
    };
    return;
  }

  if (v.isShowdown) {
    act.classList.remove('is-dim');
    $('#showCd')?.classList.add('hidden');
    $('#showBtns').classList.add('hidden');
    // During A–E: show disabled 下一手 placeholder; no choice yet
    if (!revealUiArmed) {
      $('#btns').innerHTML = `
        <button type="button" class="call" id="btnNext" disabled style="opacity:.45">下一手</button>`;
    } else {
      $('#btns').innerHTML = '';
    }
    return;
  }

  $('#showBtns').classList.add('hidden');
  $('#showCd')?.classList.add('hidden');

  // During deal / flip / post-deal pass: show locked Fold/Call/Raise (not 換人)
  if (!handUiReady || dealPresenting || heroFlipping || passAfterDeal) {
    act.classList.add('is-deal-locked');
    $('#btns').innerHTML = `
      <button class="fold" type="button" disabled>蓋牌</button>
      <button class="call" type="button" disabled>跟注</button>
      <button class="raiseb" type="button" disabled>加注</button>`;
    return;
  }

  if (!myTurn) {
    act.classList.add('is-dim');
    $('#showBtns').classList.add('hidden');
    $('#showBtns').innerHTML = '';
    $('#btns').innerHTML = `<button type="button" class="call" id="btnHandOff">換人</button>`;
    $('#btnHandOff').onclick = () => {
      if (state.actor != null) viewerSeat = state.actor;
      showPass();
    };
    return;
  }

  act.classList.remove('is-dim');

  const foldBtn = legal.fold
    ? `<button class="fold" type="button" id="btnFold">蓋牌<span class="key">F</span></button>`
    : `<button class="fold" type="button" disabled>蓋牌</button>`;
  let mid;
  if (legal.check) {
    mid = `<button class="call" type="button" id="btnCheck">過牌<span class="key">C</span></button>`;
  } else if (legal.call) {
    mid = `<button class="call" type="button" id="btnCall">跟注<small>${fmtChips(legal.callAmount)}</small></button>`;
  } else {
    mid = `<button class="call" type="button" disabled>—</button>`;
  }
  let raiseBtn;
  if (legal.bet || legal.raise) {
    raiseBtn = `<button class="raiseb" type="button" id="btnRaiseOpen">${legal.bet ? '下注' : '加注'}<span class="key">R</span></button>`;
  } else if (legal.allIn && !legal.call) {
    raiseBtn = `<button class="raiseb" type="button" id="btnAllIn">全下<span class="key">R</span></button>`;
  } else if (legal.allIn && legal.call && legal.callAmount === state.seats[viewerSeat].chips) {
    raiseBtn = `<button class="raiseb" type="button" id="btnAllIn">全下</button>`;
  } else {
    raiseBtn = `<button class="raiseb" type="button" disabled>加注</button>`;
  }
  $('#btns').innerHTML = foldBtn + mid + raiseBtn;

  $('#btnFold')?.addEventListener('click', () => {
    dispatch({ type: 'FOLD', seat: viewerSeat });
    passToNextIfNeeded();
  });
  $('#btnCheck')?.addEventListener('click', () => {
    dispatch({ type: 'CHECK', seat: viewerSeat });
    passToNextIfNeeded();
  });
  $('#btnCall')?.addEventListener('click', () => {
    dispatch({ type: 'CALL', seat: viewerSeat });
    passToNextIfNeeded();
  });
  $('#btnRaiseOpen')?.addEventListener('click', () => openRaisePanel(legal));
  $('#btnAllIn')?.addEventListener('click', () => {
    dispatch({ type: 'ALL_IN', seat: viewerSeat });
    passToNextIfNeeded();
  });
}

function syncRaiseBtn() {
  const out = $('#raiseOut');
  if (out) out.textContent = fmtChips(raiseTo);
  const conf = $('#raiseConfirm');
  if (conf) {
    const legal = getLegalActions(state, viewerSeat);
    const verb = legal?.bet ? '確認下注' : '確認加注到';
    conf.textContent = `${verb} ${fmtChips(raiseTo)}`;
  }
}

function syncPresetPressed() {
  for (const b of $$('#presets button')) {
    b.setAttribute('aria-pressed', String(+b.dataset.to === raiseTo));
  }
}

function passToNextIfNeeded() {
  raiseTo = 0;
  if (state.phase === PHASE.HAND_OVER || state.phase === PHASE.SHOWDOWN) {
    render();
    return;
  }
  if (
    state.actor != null &&
    state.actor !== viewerSeat &&
    [PHASE.PREFLOP, PHASE.FLOP, PHASE.TURN, PHASE.RIVER].includes(state.phase)
  ) {
    viewerSeat = state.actor;
    showPass();
    return;
  }
  render();
}

function renderHandOver() {
  /* handled in actions */
}

function showSummary() {
  const rows = sessionSummary(state);
  const scr = $('#summaryScreen');
  scr.classList.add('is-on');
  const body = rows
    .map((r) => {
      const cls = r.net > 0 ? 'pos' : r.net < 0 ? 'neg' : '';
      const net = (r.net >= 0 ? '+' : '') + fmtChips(r.net);
      return `<tr><td>${esc(r.name)}</td><td>${fmtChips(r.buyInTotal)}</td><td>${fmtChips(r.chips)}</td><td class="${cls}">${net}</td></tr>`;
    })
    .join('');
  $('#summaryBody').innerHTML = `
    <div class="summary">
      <table>
        <thead><tr><th>玩家</th><th>買入</th><th>籌碼</th><th>淨勝</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

$('#btnSummaryClose').onclick = () => {
  $('#summaryScreen').classList.remove('is-on');
  if (state.phase === PHASE.SESSION_OVER) {
    state = createInitialState({
      roomName: state.room.name,
      bigBlind: state.config.bigBlind,
      startingStack: state.config.startingStack,
      timerEnabled: state.config.timerEnabled,
    });
    openLobby();
  }
};

$('#btnLobby').onclick = () => {
  closeMenu();
  if (
    state.phase !== PHASE.LOBBY &&
    state.phase !== PHASE.HAND_OVER &&
    state.phase !== PHASE.SESSION_OVER
  ) {
    if (!confirm('確定要離開目前這手牌、回到大廳？')) return;
    state = createInitialState({
      roomName: state.room.name,
      bigBlind: state.config.bigBlind,
      startingStack: state.config.startingStack,
      timerEnabled: false,
    });
  }
  openLobby();
};

/* ─── Timer tick ─── */
onTick(() => {
  if (state.phase === PHASE.SHOWDOWN && revealDeadline != null && state.showdown?.pending?.includes(viewerSeat)) {
    const left = Math.max(0, Math.ceil((revealDeadline - Date.now()) / 1000));
    const cd = $('#showCd');
    if (cd && !cd.classList.contains('hidden')) cd.textContent = `${left} 秒後自動不亮`;
  }
  if (state.phase === PHASE.HAND_OVER && holdDeadline != null && !state.pause?.active) {
    const left = Math.max(0, Math.ceil((holdDeadline - Date.now()) / 1000));
    const holdCd = $('#holdCd');
    if (holdCd) holdCd.textContent = String(left);
    const fg = document.querySelector('#btnNext .hold-ring-fg');
    if (fg) {
      const pct = Math.max(
        0,
        Math.min(100, ((holdDeadline - Date.now()) / holdMsForState()) * 100),
      );
      fg.setAttribute('stroke-dashoffset', String(100 - pct));
    }
  }
  if (debugTimerFreezeMs != null) {
    updateActorTimerRing(debugTimerFreezeMs);
    return;
  }
  if (
    !handUiReady ||
    !state.config.timerEnabled ||
    state.deadline == null ||
    state.actor == null ||
    dealPresenting ||
    heroFlipping ||
    needsPass ||
    state.pause?.active ||
    state.phase === PHASE.SHOWDOWN ||
    state.phase === PHASE.HAND_OVER ||
    state.phase === PHASE.LOBBY
  ) {
    updateActorTimerRing(null);
    return;
  }
  const left = Math.max(0, state.deadline - Date.now());
  updateActorTimerRing(left);
  // Only the hot-seat viewer can fire their own timeout
  if (!needsPass && state.actor === viewerSeat && left <= 0) {
    const seat = state.actor;
    dispatch({ type: 'TIMEOUT', seat });
    passToNextIfNeeded();
  }
});

/**
 * Drive the thin gold→red ring around the acting seat's avatar.
 * Uses stroke-dashoffset only (GPU-friendly). Reduced-motion: 1Hz number.
 * @param {number|null} leftMs
 */
function updateActorTimerRing(leftMs) {
  const total = state.config.actionTimeoutMs || 30000;
  const actor = state.actor;
  // Clear all rings first
  document.querySelectorAll('.av.is-timing').forEach((av) => {
    av.classList.remove('is-timing', 'is-urgent');
    const fg = av.querySelector('.av-ring-fg');
    if (fg) {
      fg.style.strokeDashoffset = '0';
      fg.style.stroke = '';
    }
    const sec = av.querySelector('.av-ring-sec');
    if (sec) sec.textContent = '';
  });
  if (leftMs == null || actor == null) {
    lastTimerSecShown = -1;
    return;
  }
  const av =
    actor === viewerSeat
      ? document.querySelector('#heroAv, #mePlate .av')
      : document.querySelector(`.seat[data-seat="${actor}"] .av`);
  if (!av) return;
  av.classList.add('is-timing');
  const urgent = leftMs <= 5000;
  av.classList.toggle('is-urgent', urgent);
  const pct = Math.max(0, Math.min(1, leftMs / total));
  const fg = av.querySelector('.av-ring-fg');
  const reduce = prefersReducedMotion();
  const secLeft = Math.max(0, Math.ceil(leftMs / 1000));
  if (reduce) {
    if (secLeft === lastTimerSecShown) return;
    lastTimerSecShown = secLeft;
  }
  if (fg) {
    // pathLength=100 → offset 0 = full, 100 = empty
    fg.style.strokeDashoffset = String(100 * (1 - pct));
    // Inline stroke so urgent red wins immediately (no CSS transition lag)
    fg.style.stroke = urgent ? 'var(--warn)' : 'var(--gold)';
  }
  const secEl = av.querySelector('.av-ring-sec');
  if (secEl) secEl.textContent = String(secLeft);
}

/* ─── Keyboard (desktop) ─── */
window.addEventListener('keydown', (e) => {
  if (needsPass) return;
  if (e.target.matches('input,textarea,select')) return;
  const k = e.key.toLowerCase();
  if (k === 'f') $('#btnFold')?.click();
  if (k === 'r') $('#btnRaiseOpen')?.click() || $('#btnAllIn')?.click();
  if (k === 'c') $('#btnCheck')?.click() || $('#btnCall')?.click();
});

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), 2400);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Expose for headless e2e / layout tests
window.__poker = {
  getState: () => state,
  getViewer: () => viewerSeat,
  /** Pin the hot-seat viewer (skips pass gate) and re-render. */
  setViewer(seat) {
    viewerSeat = seat;
    needsPass = false;
    dealPresenting = false;
    awaitingDealThenPass = false;
    passAfterDeal = false;
    heroFlipping = false;
    dealFxBusy = false;
    handUiReady = true;
    cancelDealFx();
    cancelHeroFlip();
    $('#passScreen')?.classList.remove('is-on');
    document.getElementById('act')?.classList.remove('is-deal-locked');
    render();
  },
  /** Test helper: force actor timer ring to a remaining-ms value (frozen until null). */
  debugTimerRing(leftMs) {
    debugTimerFreezeMs = leftMs == null ? null : leftMs;
    updateActorTimerRing(leftMs);
  },
  get handUiReady() {
    return handUiReady;
  },
  get dealPresenting() {
    return dealPresenting;
  },
  get passAfterDeal() {
    return passAfterDeal;
  },
  prefersReducedMotion,
  /** Cancel auto-advance so layout audits can inspect showdown DOM. */
  cancelAutoNext() {
    if (autoNextTimer) {
      clearTimeout(autoNextTimer);
      autoNextTimer = null;
    }
  },
  dispatch,
  view,
  applyAction,
  createInitialState,
};

boot();
