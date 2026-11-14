import { disconnectState, closeDisconnectedRoom, DISCONNECT_COPY, hostLivenessMs, hostAliveMs } from '../net/host-disconnect.js';
/**
 * Milestone-2 shell: auth → lobby → create/join → table (§2 / §13).
 * Solo hot-seat engine kept for ?solo=1 / internal use; no lobby menu entry.
 */

import {
  initAuth,
  onUser,
  signIn,
  signOut,
  getUser,
  getFirebase,
  detectInAppBrowser,
  qaEmuSignIn,
} from '../../../lib/auth/auth.js';
import { renderAuthUi, AUTH_UI_CSS } from '../../../lib/auth/auth-ui.js';
import {
  FIREBASE_CONFIG,
  EMU_FIREBASE_CONFIG,
  EMU_PORTS,
  isEmuMode,
  LS_PREFIX,
} from '../net/firebase-config.js';
import {
  createSingleTable,
  findHostedOpenTable,
  createTimeoutMs,
  findOpenTable,
  joinByCode,
  joinByRoomId,
  listenRoom,
  listenOpenTables,
  sweepStaleTable,
  isLobbyRoomSuppressed,
  getLastRoom,
  rememberLastRoom,
  clearLastRoom,
  formatCode,
  closeRoom,
  maybeAutoCloseIdleRoom,
  maybeAutoCloseSingleTable,
  isRoomOpenStatus,
  noteLobbyRoomClosed,
  deleteLobbyListing,
} from '../net/room.js';
import {
  ensurePlayerGrant,
  buyinAmount,
  getPlayer,
  fetchLeaderboard,
  fetchNightBoard,
  selfRescueCashout,
  settleClosedRoomBinding,
  readSelfCashoutAmount,
  nightKeyOf,
  readCachedPlayer,
} from '../net/ledger.js';
import { DEFAULT_NEW_PLAYER_CHIPS, createRoomBuyinError, assertMinimumBuyin, wholeBalance, buyinOptions, buyinLabel } from '../net/buyin-policy.js';
import { createHostLoop } from '../net/host.js';
import {
  createIntentSender,
  remainingMs,
  diffPubEvents,
  createAnimQueue,
  listenHole,
} from '../net/client.js';
import { startPresence, maybeTakeover } from '../net/presence.js';
import { placeDealer, placeBets, placeShowdownReveals } from './layout-felt.js';
import {
  hostShouldWarn,
  hostMustStopNewHand,
  resetTimeTaipeiLabel,
} from '../net/quota.js';
import { decideRescue } from '../net/rescue.js';
import {
  renderMpLobby,
  patchOpenTables,
  renderCreateRoom,
  renderShareRoom,
  renderJoinCode,
  showLobbyNotify,
  hideLobbyNotify,
  flashMyTableAttn,
  ensureLobbyNotify,
} from './lobby.js';
import { renderStats } from './stats.js';
import { openPersonalStats, shouldToastClosedFallback } from './personal-stats.js';
import { STATS_ENABLED } from '../stats/host-runtime.js';
import { createFirestoreStatsAdapter } from '../stats/firestore-adapter.js';
import { MP_FX, mpDuration } from './fx-mp.js';
import { detectSoundEvents, pickSound, hurryCrossed, soundHandKey, initSound, playSound, stopSound, isSoundOn, setSoundOn } from './sound.js';
import { cardHtml, cardBackPair, heroBackPair, fmtChips, paintBoardSlots, raisePresetsMarkup, raisePanelCopy } from './cards-dom.js';
import { mapSeatsClockwise } from './seating.js';
import { prefersReducedMotion } from './fx.js';
import { parseCard } from '../engine/cards.js';
import { raisePresets } from '../engine/index.js';

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** @type {(opts?: {fromMp?:boolean}) => void} */
let openSoloFn = () => {};

/** @type {'auth'|'lobby'|'create'|'share'|'join'|'stats'|'table'|'linking'} */
let screen = 'auth';
/** @type {any} */
let authState = { status: 'loading', user: null, error: null };
/** @type {any} */
let playerDoc = null;
/** @type {any} */
let room = null;
/** @type {string|null} */
let roomId = null;
/** @type {(() => void)|null} */
let stopRoom = null;
/** @type {ReturnType<typeof createHostLoop>|null} */
let hostLoop = null;
/** Test-only: emulator pages may opt into stats via window.__qaStats; production never reads it. */
function qaStatsOpts() {
  if (!isEmuMode()) return undefined;
  const o = globalThis.window?.__qaStats;
  return o && o.enabled === true && Number.isSafeInteger(o.startedAt) ? { enabled: true, startedAt: o.startedAt } : undefined;
}
/** @type {ReturnType<typeof startPresence>|null} */
let presence = null;
/** @type {ReturnType<typeof createIntentSender>|null} */
let intents = null;
/** @type {(() => void)|null} */
let stopHole = null;
let stopHostBeat = null;
let hostBeatMs = null;
let hostRoomUpdatedMs = null;
let hostPaused = false;
let hostReturned = false;
let hostReturnedTimer = null;
let hostBeatUid = null;
function watchHostBeat(fb, id, r) {
  if (hostBeatUid === r.hostUid) return;
  stopHostBeat?.(); hostBeatUid = r.hostUid; hostBeatMs = null;
  stopHostBeat = fb.fs.onSnapshot(fb.fs.doc(fb.db,'pokerRooms',id,'presence',r.hostUid), snap => {
    if (roomId !== id || snap.metadata?.hasPendingWrites || snap.metadata?.fromCache) return;
    const next = hostLivenessMs(null, snap);
    if (Number.isFinite(next)) {
      hostLoop?.observeHostBeat?.(Math.max(next, hostRoomUpdatedMs ?? 0));
      hostBeatMs = next;
      updateHostDisconnect();
    }
  }, () => {});
}
function updateHostDisconnect() {
  if (!room) return;
  if (room.status === 'closed') {
    hostPaused = false;
    hostReturned = false;
    clearTimeout(hostReturnedTimer);
    hostReturnedTimer = null;
    const banner = $('#mpBanner');
    banner?.classList.remove('mp-banner--hd');
    if (banner && (banner.textContent === DISCONNECT_COPY.paused || banner.textContent === DISCONNECT_COPY.returned)) {
      banner.hidden = true;
      banner.textContent = '';
    }
    return;
  }
  const paused = disconnectState(hostAliveMs(hostBeatMs, hostRoomUpdatedMs)).paused;
  if (hostPaused && !paused) {
    hostReturned = true;
    clearTimeout(hostReturnedTimer);
    hostReturnedTimer = setTimeout(() => { hostReturned = false; paintTableChrome(); }, 4000);
  }
  if (paused) hostReturned = false;
  const changed = hostPaused !== paused;
  hostPaused = paused;
  if (changed) { paintTableChrome(); tickTurnHint(); }
}
let lastRecvAt = Date.now();
/** @type {object|null} */
let prevPub = null;
// Sound state is independent of animation queues and never writes room data.
let turnClockTimer = null;
let stopSoundVisibility = null;
let soundNeedsBaseline = true;
let soundSeat = -1;
let soundHand = null;
let soundConsumed = new Set();
let soundTurn = null;
let soundRem = null;
let soundWarned = false;

function resetRoomSound() {
  stopSound();
  soundNeedsBaseline = true;
  soundSeat = -1;
  soundHand = null;
  soundConsumed.clear();
  soundTurn = null;
  soundRem = null;
  soundWarned = false;
  soundClockKey = null;
}

function startRoomSound() {
  initSound();
  turnClockTick();
  const onSoundVisibility = () => {
    stopSound();
    soundNeedsBaseline = true;
    soundRem = null;
  };
  const onTurnClockVisibility = () => turnClockTick();
  document.addEventListener('visibilitychange', onSoundVisibility);
  document.addEventListener('visibilitychange', onTurnClockVisibility);
  window.addEventListener('offline', onSoundVisibility);
  window.addEventListener('online', onSoundVisibility);
  stopSoundVisibility = () => {
    document.removeEventListener('visibilitychange', onSoundVisibility);
    document.removeEventListener('visibilitychange', onTurnClockVisibility);
    window.removeEventListener('offline', onSoundVisibility);
    window.removeEventListener('online', onSoundVisibility);
  };
}

function stopTurnClock() {
  if (turnClockTimer != null) clearTimeout(turnClockTimer);
  turnClockTimer = null;
}

function scheduleTurnClock() {
  stopTurnClock();
  const pub = room?.pub;
  if (screen !== 'table' || document.hidden || !pub?.phase ||
      pub.phase === 'lobby' || pub.phase === 'hand_over' || pub.actor == null) return;
  const rem = turnRemainingMs(pub);
  if (rem > 0) turnClockTimer = setTimeout(turnClockTick, (rem % 1000 || 1000) + 15);
}

function turnClockTick() {
  tickTurnHint();
  tickRoomSound();
  scheduleTurnClock();
}

function tickRoomSound() {
  if (hostPaused || soundNeedsBaseline || screen !== 'table' || document.hidden || !room?.pub || soundSeat < 0) return;
  const pub = room.pub;
  if (pub.actor !== soundSeat || pub.actionSeq == null ||
      !['preflop', 'flop', 'turn', 'river'].includes(pub.phase)) return;
  const rem = turnRemainingMs(pub);
  if (!soundWarned && hurryCrossed(soundRem, rem, MP_FX.timerWarnLastMs)) {
    soundWarned = true;
    playSound('hurry');
  }
  soundRem = rem;
}

// Anchor the countdown at the first snapshot of each armed deadline: later snapshots of the
// same turn (presence/lobby writes) refresh lastRecvAt and must not restart the 5 s check.
let soundClockKey = null;
let soundClockAt = 0;
function turnRemainingMs(pub) {
  const key = `${soundHandKey(pub)}:${pub?.actionSeq}:${pub?.actor}:${room?.deadlineAt}:${pub?.hostClockAt}`;
  if (key !== soundClockKey) {
    soundClockKey = key;
    soundClockAt = lastRecvAt;
  }
  return remainingMs(room?.deadlineAt, pub?.hostClockAt, soundClockAt);
}

function tickTurnHint() {
  const hint = $('#turnHint');
  if (!hint) return;
  const pub = room?.pub;
  const between = !pub?.phase || pub.phase === 'lobby' || pub.phase === 'hand_over';
  const rem = !hostPaused && screen === 'table' && !between && pub.actor != null
    ? turnRemainingMs(pub) : null;
  const text = rem != null ? `${Math.ceil(rem / 1000)} 秒` : '';
  if (hint.textContent !== text) hint.textContent = text;
}

function consumeRoomSound(previous, next, seat, skip) {
  const hand = soundHandKey(next);
  const baseline = skip || soundNeedsBaseline || seat !== soundSeat;
  if (hand !== soundHand || seat !== soundSeat) soundConsumed.clear();
  soundHand = hand;
  soundSeat = seat;
  const turn = `${hand}:${next.actionSeq}:${next.actor}`;
  const newTurn = turn !== soundTurn;
  soundTurn = turn;
  if (newTurn) {
    soundWarned = false;
    soundRem = turnRemainingMs(next);
  } else if (baseline) {
    soundRem = turnRemainingMs(next);
  }
  const kinds = baseline ? [] : detectSoundEvents(previous, next, seat).filter((kind) => {
    const key = kind === 'deal' ? `deal:${next.phase}` : kind === 'turn' ? `turn:${turn}` : kind;
    if (kind === 'bet') return true;
    if (soundConsumed.has(key)) return false;
    soundConsumed.add(key);
    return true;
  });
  // Consume visible phases/results even when the snapshot is deliberately silent.
  if (baseline) {
    stopSound();
    soundConsumed.add(`deal:${next.phase}`);
    soundConsumed.add(`turn:${turn}`);
    if (Number(next.winnerPayouts?.[seat]) > 0 || next.winners?.some((pot) => pot.seats?.includes(seat))) soundConsumed.add('win');
  }
  soundNeedsBaseline = false;
  if (seat < 0) stopSound();
  else playSound(pickSound(kinds));
}

let joinDigits = '';
let shareInfo = null;
let createError = '';
let creating = false;
let createAttempt = 0;
let joining = false;
let joinError = '';
let joinEnded = false;
/** Persist create-form draft across re-renders (UI/UX #11). */
let createDraft = { name: '', sb: 10, chips: DEFAULT_NEW_PLAYER_CHIPS };
let sittingBusy = false;
let openJoinBusy = false;
let rescueBusy = false;
let leaveBusy = false;
/** Local tick for M2 #13「再申請一次」countdown. */

/** Map low-level errors to plain 發生什麼 + 怎麼做（附錄 M3）. */
function friendlyError(err, fallback) {
  const raw = String(err?.message || err?.code || err || '');
  const code = String(err?.code || '');
  if (/timeout|逾時|Deadline/i.test(raw + code)) {
    return '連線太慢，沒有加入成功。請按 Enter 再試一次';
  }
  if (/network|unavailable|Failed to fetch|offline/i.test(raw + code)) {
    return '沒有送出去，可能是網路斷了。請再按一次';
  }
  if (/permission-denied|PERMISSION_DENIED|closed|r 不符|mismatch/i.test(raw + code)) {
    return '這桌已經結束了，回大廳看看其他牌桌';
  }
  if (/not-found|NOT_FOUND|找不到|不存在/i.test(raw + code)) {
    return raw.includes('房號') ? raw : '房號不存在，請再確認';
  }
  if (/too-many|牌桌太多/i.test(raw + code)) {
    return '現在牌桌太多，房號暫時用完了，請稍後再按一次開房';
  }
  if (/未滿\s*10|10\s*分鐘/i.test(raw)) {
    return '還不能結帳：房主失聯未滿 10 分鐘，請再等一下或請房主回來';
  }
  if (/籌碼.*對不上|ledger|chip.?mismatch/i.test(raw)) {
    return '籌碼數字對不上，為了不算錯先停住。請房主收桌，大家的籌碼會照桌上數字結回帳戶';
  }
  // Strip Firebase-looking codes from otherwise OK Chinese messages
  if (/[\u4e00-\u9fff]/.test(raw) && !/permission-|firebase|INTERNAL|FAILED_PRECONDITION/i.test(raw)) {
    return raw.replace(/\s*\([^)]*\)\s*$/, '').trim() || fallback;
  }
  return fallback;
}

function clearRoomUrlParams() {
  try {
    const u = new URL(location.href);
    if (!u.searchParams.has('room') && !u.searchParams.has('r')) return;
    u.searchParams.delete('room');
    u.searchParams.delete('r');
    history.replaceState({}, '', u.pathname + (u.search || '') + u.hash);
  } catch {
    /* ignore */
  }
}

function hideCloseResultCard() {
  const el = document.getElementById('mpCloseResult');
  if (!el) return;
  el.hidden = true;
  el.setAttribute('aria-hidden', 'true');
  el.remove();
}

/**
 * Closed-table binding: silently cash out (idempotent) and clear pointers.
 * Lobby must never show「已收桌／結帳離開」for a closed table.
 * @returns {Promise<number>} chips credited this call (0 if skipped/idempotent)
 */
async function silentlySettleClosedBinding(isCurrent = () => true) {
  let settledPlayer = playerDoc;
  const fb = getFirebase();
  const uid = getUser()?.uid;
  if (!fb || !uid) return 0;
  try {
    settledPlayer = await getPlayer(fb, uid);
    if (!isCurrent()) return 0;
  } catch {
    /* keep stale */
  }
  if (!isCurrent()) return 0;
  const tid = settledPlayer?.tableRoomId;
  let credited = 0;
  if (tid) {
    try {
      const snap = await fb.fs.getDoc(fb.fs.doc(fb.db, 'pokerRooms', tid));
      if (!isCurrent()) return 0;
      const closed = !snap.exists() || snap.data()?.status === 'closed';
      if (closed) {
        const inPlayBefore = Number(settledPlayer?.inPlay) || 0;
        const room = snap.exists()
          ? { id: tid, ...snap.data(), status: 'closed' }
          : { id: tid, status: 'closed', seatUids: [] };
        const res = await settleClosedRoomBinding(fb, uid, room);
        if (!isCurrent()) return 0;
        if (typeof res?.amount === 'number') credited = res.amount;
        else if (res?.skipped || res?.idempotent) credited = 0;
        else credited = inPlayBefore;
        if (!isCurrent()) return 0;
        try {
          settledPlayer = await getPlayer(fb, uid);
          if (!isCurrent()) return 0;
        } catch {
          if (settledPlayer) {
            settledPlayer = {
              ...settledPlayer,
              tableRoomId: null,
              inPlay: 0,
              bank: (settledPlayer.bank || 0) + credited,
              total: (settledPlayer.bank || 0) + credited,
            };
          }
        }
      }
    } catch (e) {
      if (!isCurrent()) return 0;
      console.warn('silent settle closed', e);
    }
  }
  // Clear host pointer at closed/missing room
  const hid = settledPlayer?.hostRoomId;
  if (hid && fb && uid) {
    try {
      const snap = await fb.fs.getDoc(fb.fs.doc(fb.db, 'pokerRooms', hid));
      if (!isCurrent()) return 0;
      if (!snap.exists() || snap.data()?.status === 'closed') {
        try {
          await fb.fs.updateDoc(fb.fs.doc(fb.db, 'pokerPlayers', uid), {
            hostRoomId: null,
            updatedAt: fb.fs.serverTimestamp(),
          });
        } catch {
          /* rules may deny */
        }
        if (!isCurrent()) return 0;
        try {
          settledPlayer = await getPlayer(fb, uid);
          if (!isCurrent()) return 0;
        } catch {
          /* keep going */
        }
        if (settledPlayer?.hostRoomId === hid) {
          settledPlayer = { ...settledPlayer, hostRoomId: null };
        }
      }
    } catch {
      /* ignore */
    }
  }
  if (!isCurrent()) return 0;
  playerDoc = settledPlayer;
  // Closed tables never use the rescue settle card
  if (rescueReason === 'closed' || !settledPlayer?.tableRoomId) {
    rescueOk = false;
    rescueReason = null;
    rescueChips = null;
  }
  return credited;
}

/** @deprecated name kept for call sites — always silent-settles closed bindings */
async function syncAfterRoomClosed() {
  await silentlySettleClosedBinding();
}

/** Leave close-result without bouncing back into the closed table. */
async function dismissCloseResultToLobby() {
  if (closeInFlight) {
    // 0.2 秒回饋：先切大廳；收桌／結帳在背景跑完才拆 host loop
    const pending = closeInFlight;
    closeResultDismissedFor = roomId || room?.id || closeResultShownFor || null;
    hideCloseResultCard();
    clearRoomUrlParams();
    clearLastRoom();
    autoResumeTried = true;
    lobbyExitSuppressMine = true;
    screen = 'lobby';
    const back0 = $('#btnBackLobby');
    if (back0) back0.hidden = true;
    paint();
    try { await pending; } catch { return; }
    if (screen !== 'lobby') return;
  }
  const closedId = roomId || room?.id || closeResultShownFor || null;
  closeResultDismissedFor = closedId;
  hideCloseResultCard();
  clearRoomUrlParams();
  clearLastRoom();
  // Intentional exit — must NOT clear autoResumeTried (that re-enterRoom'd the table)
  autoResumeTried = true;
  tearDownRoom();
  screen = 'lobby';
  const back = $('#btnBackLobby');
  if (back) back.hidden = true;
  paint();
  // 結帳同步在背景跑，完成後若仍在大廳再刷新一次
  await syncAfterRoomClosed();
  if (screen === 'lobby') paint();
}

async function dismissCloseResultToStats() {
  if (closeInFlight) await closeInFlight.catch(() => {});
  const closedId = roomId || room?.id || closeResultShownFor || null;
  closeResultDismissedFor = closedId;
  hideCloseResultCard();
  clearRoomUrlParams();
  clearLastRoom();
  autoResumeTried = true;
  await syncAfterRoomClosed();
  tearDownRoom();
  await openStats();
}

/** M2 #5: stay on table with result card; do not auto-kick. */
function showCloseResultCard({ chips = 0, auto = false, state = 'done', retry, roomId: ridOpt, disconnected = room?.closedBy === 'host-disconnect' } = {}) {
  const rid = ridOpt || roomId || room?.id || null;
  // User already chose 回大廳／看戰績 — late closed snapshots must not re-open the card
  if (rid && closeResultDismissedFor === rid) return;
  if (screen !== 'table' && screen !== 'linking' && screen !== 'lobby' && state === 'done') return;
  const existing = document.getElementById('mpCloseResult');
  if (state === 'done' && existing?.dataset.state === 'pending' && closeInFlight) return;
  const n = Number(chips) || 0;
  const resultTitle = disconnected ? DISCONNECT_COPY.closed : `牌桌已收桌，你帶回 ${n.toLocaleString('en-US')} 籌碼`;
  // Already showing: never let a later 0 clobber a real return; upgrade if better
  if (state === 'done' && rid && closeResultShownFor === rid && existing?.dataset.state === 'done') {
    if (n > closeResultChipsShown) {
      closeResultChipsShown = n;
      const title = document.getElementById('mpCloseResultT');
      if (title) {
        title.textContent = resultTitle;
      }
    }
    return;
  }
  if (rid) closeResultShownFor = rid;
  closeResultChipsShown = n;

  let el = document.getElementById('mpCloseResult');
  if (!el) {
    el = document.createElement('div');
    el.id = 'mpCloseResult';
    el.className = 'mp-close-result';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'mpCloseResultT');
    document.body.appendChild(el);
  }
  const autoLine = auto && !disconnected
    ? '<p class="mp-close-result-d">沒人在線 30 分鐘，已自動收桌</p>'
    : '';
  el.dataset.state = state;
  el.innerHTML = `
    <div class="mp-close-result-card">
      <h2 id="mpCloseResultT">${state === 'pending' ? '結算中…' : state === 'failed' ? '結算沒有完成，請再按一次收桌' : resultTitle}</h2>
      ${autoLine}
      <button type="button" class="mp-btn-primary" id="mpCloseLobby">回大廳</button>
      <button type="button" class="mp-b2" id="mpCloseStats">看戰績</button>
    </div>`;
  if (state !== 'done') {
    $('#mpCloseLobby', el)?.remove();
    $('#mpCloseStats', el)?.remove();
    if (state === 'failed') {
      const card = el.querySelector('.mp-close-result-card');
      card.insertAdjacentHTML('beforeend', '<button type="button" class="mp-btn-primary" id="mpCloseRetry">重試</button><button type="button" class="mp-b2" id="mpCloseBack">回牌桌</button>');
      $('#mpCloseRetry', el)?.addEventListener('click', retry);
      $('#mpCloseBack', el)?.addEventListener('click', () => {
        hideCloseResultCard();
        screen = 'table';
        paint();
      });
    }
  }
  el.hidden = false;
  el.removeAttribute('aria-hidden');
  $('#mpCloseLobby', el)?.addEventListener('click', () => {
    void dismissCloseResultToLobby();
  });
  $('#mpCloseStats', el)?.addEventListener('click', () => {
    void dismissCloseResultToStats();
  });
}

/** M2 #12: host alone leave → 「收桌」/「先不要」 (not native confirm). */
function showHostAloneLeaveDialog() {
  let el = document.getElementById('mpHostAlone');
  if (!el) {
    el = document.createElement('div');
    el.id = 'mpHostAlone';
    el.className = 'mp-close-result';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'mpHostAloneT');
    document.body.appendChild(el);
  }
  el.innerHTML = `
    <div class="mp-close-result-card">
      <h2 id="mpHostAloneT">桌上只剩你，要收桌嗎？</h2>
      <button type="button" class="mp-btn-primary" id="mpHostAloneClose">收桌</button>
      <button type="button" class="mp-btn-ghost" id="mpHostAloneCancel">先不要</button>
    </div>`;
  el.hidden = false;
  $('#mpHostAloneClose', el)?.addEventListener('click', () => {
    el.hidden = true;
    doCloseRoom();
  });
  $('#mpHostAloneCancel', el)?.addEventListener('click', () => {
    el.hidden = true;
  });
}

/** Hand live = not between hands (lobby / hand_over / missing). */
function isHandInProgress(phase = room?.pub?.phase) {
  return !!phase && phase !== 'lobby' && phase !== 'hand_over';
}

/**
 * Table 「‹ 大廳」: always show confirm, including mid-hand.
 * Host confirm → 收桌 then clean lobby; guest → 離座結帳 then clean lobby.
 */
function showLeaveTableConfirm() {
  if (!room) return;
  let el = document.getElementById('mpLeaveConfirm');
  if (!el) {
    el = document.createElement('div');
    el.id = 'mpLeaveConfirm';
    el.className = 'mp-close-result';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'mpLeaveConfirmT');
    document.body.appendChild(el);
  }
  el.innerHTML = `
    <div class="mp-close-result-card">
      <h2 id="mpLeaveConfirmT">${room.hostUid === getUser()?.uid
        ? isHandInProgress()
          ? '是否離開並收桌？這一手會作廢，已下注的籌碼退回'
          : '是否離開並收桌？玩家將結帳回帳戶。'
        : '是否離開牌局？'}</h2>
      <button type="button" class="mp-btn-primary" id="mpLeaveConfirmOk">確認離開</button>
      <button type="button" class="mp-btn-ghost" id="mpLeaveConfirmCancel">取消</button>
    </div>`;
  el.hidden = false;
  $('#mpLeaveConfirmCancel', el)?.addEventListener('click', () => {
    el.hidden = true;
  });
  $('#mpLeaveConfirmOk', el)?.addEventListener('click', () => {
    const ok = $('#mpLeaveConfirmOk', el);
    const cancel = $('#mpLeaveConfirmCancel', el);
    if (ok) {
      ok.disabled = true;
      ok.textContent = '離開中…';
    }
    if (cancel) cancel.disabled = true;
    void confirmLeaveTable().finally(() => {
      el.hidden = true;
    });
  });
}
let statsMode = 'total';
let statsRows = [];
let statsNight = nightKeyOf();
let leaderPreview = [];
let myHole = null;
let toastTimer = 0;
/** @type {Record<string, string>} */
const nameCache = Object.create(null);
/** @type {ReturnType<typeof createAnimQueue>|null} */
let animQ = null;
let rescueOk = false;
/** @type {'closed'|'gone'|null} */
let rescueReason = null;
/** Settled stack to show on rescue card (not buy-in). */
let rescueChips = null;
let membersPanelOpen = false;
let raiseOpen = false;
/** Current raise-to total while the shared #raisePanel is open (MP). */
let mpRaiseTo = 0;
/** @type {string|null} single pressed preset id (amount-dupes must not multi-highlight) */
let mpRaisePresetId = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let mpRaiseHoldTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let mpRaiseHoldRepeat = null;
let autoResumeTried = false;
/** Room id whose close-result card the user already dismissed (回大廳／看戰績). */
let closeResultDismissedFor = null;
/** Room id currently showing (or shown) close-result — avoid listenRoom clobbering with 0. */
let closeResultShownFor = null;
/** No-flash: hide spectator UI until host auto-sit lands; freeze table while closing. */
let hostSitPending = false;
let closingFreeze = false;
/** Pending host close (card shows immediately; 回大廳／看戰績 wait for it). */
let closeInFlight = null;
/** Chips amount currently shown on the close-result card (upgrade if a better value arrives). */
let closeResultChipsShown = 0;
/** Soft-leave lobby: one live refresh per closed room id (no paint loop). */
const lobbyClosedSynced = new Set();
/** Self stack captured before host pre-close cashout (dialog amount source of truth). */
let pendingCloseReturnChips = null;
/** Last known chips for this player at the current table (survives host cashout-before-close). */
let lastKnownSelfTableChips = 0;
let lastKnownSelfTableChipsRoomId = null;
let lastKnownSelfSessionNo = null;
/** After voluntary ‹ 大廳 confirm: never show 我的牌桌／繼續 until unbound. */
let lobbyExitSuppressMine = false;
/** @type {any[]} */
let openTables = [];
let lobbySweepRows = [];
let lobbySweepInflight = false;
/** @type {(() => void)|null} */
let stopOpenTables = null;
/** Toast once when auto-unseated while away (附錄 L5). */
let pendingAwayUnseatToast = false;
/** Top-bar status override after auto-unseat (BD §2.1). */
let awayLobbyStatus = null;
/** Lobby idle/rescue getDoc: only on bind change or ≥30s (not every paint). */
const LOBBY_IDLE_CHECK_MS = 30_000;
let confirmedLobbyRoom = null;
let enterRoomTimeout = null;

// Reuse the existing idle-close decision, then re-read its result.
// Returns { room } when still open, or { closed, chips, auto } when gone/closed.
async function confirmContinueRoom(id) {
  const fb = getFirebase();
  if (!fb || !id) return {};
  let snap = null;
  let didClose = false;
  try {
    const ref = fb.fs.doc(fb.db, 'pokerRooms', id);
    snap = await fb.fs.getDoc(ref);
    if (snap.exists()) {
      didClose = await maybeAutoCloseIdleRoom(fb, { id, ...snap.data() });
      if (didClose) snap = await fb.fs.getDoc(ref);
    }
  } catch (e) {
    const msg = String(e?.code || e?.message || e);
    if (/permission-denied|not-found|不存在/i.test(msg)) snap = null;
    else return {};
  }
  if (snap?.exists() && isRoomOpenStatus(snap.data()?.status)) {
    return { room: { id, ...snap.data() } };
  }
  // Missing, closed, or unreadable after sweep (permission-denied): settle, no continue card.
  confirmedLobbyRoom = null;
  if (room?.id === id) room = { ...room, status: 'closed' };
  if (getLastRoom()?.roomId === id) clearLastRoom();
  const chips = await silentlySettleClosedBinding();
  const data = snap?.exists() ? snap.data() : null;
  const auto = !!(
    didClose ||
    data?.lobby?.autoClosed ||
    data?.autoClosed ||
    data?.pub?.autoClosed ||
    data?.closedBy === 'auto'
  );
  return { closed: true, chips, auto, disconnected: data?.closedBy === 'host-disconnect' };
}

function revealClosedFromLobby(id, { chips = 0, auto = false, disconnected = false } = {}) {
  if (!id || closeResultDismissedFor === id) return;
  showCloseResultCard({ chips, auto, roomId: id, disconnected });
}

async function continueMyTable(id) {
  try {
    const confirmed = await confirmContinueRoom(id);
    if (screen !== 'lobby') return;
    confirmedLobbyRoom = confirmed.room || null;
    if (confirmed.room) await enterRoom(id, { fromContinue: true });
    else {
      if (confirmed.closed) revealClosedFromLobby(id, confirmed);
      paint();
    }
  } catch {
    if (screen === 'lobby') paint();
  }
}

let lobbyIdleCheckAt = 0;
let lobbyIdleCheckKey = '';
let lobbyIdleCheckInflight = false;

function lobbyIdleCheckNeeded() {
  const key = `${playerDoc?.tableRoomId || ''}|${playerDoc?.hostRoomId || ''}`;
  if (key !== lobbyIdleCheckKey) return true;
  if (Date.now() - lobbyIdleCheckAt >= LOBBY_IDLE_CHECK_MS) return true;
  return false;
}

function looksLikeUidStub(name, uid) {
  if (!name || !uid) return !name;
  return name === uid || name === uid.slice(0, 8);
}

function displayNameOf(uid) {
  if (!uid) return '';
  if (nameCache[uid] && !looksLikeUidStub(nameCache[uid], uid)) return nameCache[uid];
  const fromPub = room?.pub?.seats?.find((s) => s && (s.id === uid || s.uid === uid));
  if (fromPub?.name && !looksLikeUidStub(fromPub.name, uid)) return fromPub.name;
  if (nameCache[uid]) return nameCache[uid];
  if (fromPub?.name) return fromPub.name;
  return '';
}

function nameOrStub(uid, ...fallbacks) {
  const candidates = [
    displayNameOf(uid),
    ...fallbacks,
    uid ? uid.slice(0, 8) : '',
  ];
  for (const c of candidates) {
    if (c && !looksLikeUidStub(c, uid)) return c;
  }
  return candidates.find((c) => !!c) || '';
}

async function cachePlayerName(uid) {
  if (!uid) return;
  if (nameCache[uid] && !looksLikeUidStub(nameCache[uid], uid)) return;
  const fb = getFirebase();
  if (!fb) return;
  try {
    const p = await getPlayer(fb, uid);
    if (p?.displayName) {
      nameCache[uid] = p.displayName;
      if (screen === 'table') paintTableChrome();
    }
  } catch {
    /* offline */
  }
}

export function setSoloOpener(fn) {
  openSoloFn = fn;
}

export async function startMpApp() {
  initSound();
  injectAuthCss();
  ensureMpRoot();

  const params = new URLSearchParams(location.search);
  const deepRoom = params.get('room');
  const deepR = params.get('r');

  const emu = isEmuMode();
  await initAuth({
    firebaseConfig: emu ? EMU_FIREBASE_CONFIG : FIREBASE_CONFIG,
    mode: 'auto',
    sameDomainAuth: !emu,
    storageKey: emu ? 'auth.emu.v1' : 'auth.v1',
    timeoutMs: 8000,
    emulator: emu
      ? {
          auth: { host: '127.0.0.1', port: EMU_PORTS.auth },
          firestore: { host: '127.0.0.1', port: EMU_PORTS.firestore },
        }
      : null,
  });

  if (emu) {
    window.__qaSignIn = async (uid, displayName) => {
      await qaEmuSignIn(uid, displayName || uid);
    };
    window.__qaRefreshRescue = async () => {
      const changed = await maybeRefreshRescue();
      if (screen === 'lobby') paint();
      let debug = null;
      try {
        const fb = getFirebase();
        const tid = playerDoc?.tableRoomId;
        if (fb && tid) {
          const snap = await fb.fs.getDoc(fb.fs.doc(fb.db, 'pokerRooms', tid));
          const d = snap.exists() ? snap.data() : null;
          let hostBeatMs = null;
          if (d?.hostUid) {
            const hp = await fb.fs.getDoc(
              fb.fs.doc(fb.db, 'pokerRooms', tid, 'presence', d.hostUid),
            );
            if (hp.exists()) hostBeatMs = hp.data()?.beat?.toMillis?.() ?? null;
          }
          debug = {
            status: d?.status || null,
            hostUid: d?.hostUid || null,
            me: getUser()?.uid || null,
            updatedAtMs: d?.updatedAt?.toMillis?.() || 0,
            hostBeatMs,
            ageRoom: d?.updatedAt ? Date.now() - d.updatedAt.toMillis() : null,
            ageHost: hostBeatMs != null ? Date.now() - hostBeatMs : null,
          };
        }
      } catch (e) {
        debug = { err: String(e?.message || e) };
      }
      return {
        changed,
        rescueOk,
        rescueReason,
        hostLoop: !!hostLoop,
        presence: !!presence,
        roomId,
        tableRoomId: playerDoc?.tableRoomId || null,
        debug,
      };
    };
    window.__qaLeaveToLobby = () => {
      // QA: confirm-leave directly (skips dialog), including mid-hand.
      void confirmLeaveTable();
    };
    window.__qaShowLeaveConfirm = () => {
      showLeaveTableConfirm();
      const el = document.getElementById('mpLeaveConfirm');
      return !!(el && !el.hidden);
    };
    window.__qaLeaveConfirmClick = (which) => {
      const id = which === 'ok' ? 'mpLeaveConfirmOk' : 'mpLeaveConfirmCancel';
      document.getElementById(id)?.click();
    };
    window.__qaIsHandInProgress = () => isHandInProgress();
    window.__qaSetPubPhase = (phase) => {
      if (room) room.pub = { ...(room.pub || {}), phase };
    };
    window.__qaShowCloseResult = (chips = 2000, auto = true) => {
      screen = 'table';
      showCloseResultCard({ chips, auto });
      return !!document.getElementById('mpCloseResult');
    };
    window.__qaCloseResultState = () => ({
      screen,
      hasCard: !!document.getElementById('mpCloseResult'),
      cardHidden: document.getElementById('mpCloseResult')?.hidden ?? null,
      autoResumeTried,
      closeResultDismissedFor,
      hostRoomId: playerDoc?.hostRoomId || null,
      tableRoomId: playerDoc?.tableRoomId || null,
      rescueOk,
      roomId,
      roomStatus: room?.status || null,
      paintCount,
      joining,
    });
    window.__qaResetPaintCount = () => {
      paintCount = 0;
      window.__qaPaintCount = 0;
    };
    window.__qaJoining = () => joining;
    window.__qaShowAwayToast = () => {
      awayLobbyStatus = '已自動離座';
      showLobbyNotify(
        '你暫離超過 30 分鐘，已自動離座，籌碼已回帳戶',
        '',
        { label: '知道了' },
        { sticky: true },
      );
      paint();
      return !!document.getElementById('mpNtc')?.classList.contains('on');
    };
    window.__qaTopStatus = () => document.getElementById('mpStl')?.textContent || '';
    window.__qaOpenMenu = () => {
      document.getElementById('mpMenuBtn')?.click();
      return [...document.querySelectorAll('#mpMenu [role="menuitem"]')].map((el) =>
        (el.textContent || '').replace(/\s+/g, ' ').trim(),
      );
    };
    window.__qaHideNotify = () => hideLobbyNotify();
    window.__qaMineSnapshot = () => {
      const mine = document.querySelector('.mp-mine');
      const my = document.querySelector('.mp-my');
      const create = document.querySelector('[data-act="create"].mp-btn-primary, .mp-btn-primary[data-act="create"]');
      return {
        hasMine: !!mine,
        kind: mine?.className || '',
        dataK: my?.getAttribute('data-k') || '',
        tag: mine?.querySelector('.mp-lbl3')?.textContent || '',
        act: mine?.querySelector('.mp-act')?.textContent?.replace(/\s+/g, ' ').trim() || '',
        hasCreate: !!create,
        height: my ? Math.round(my.getBoundingClientRect().height) : 0,
        text: (mine?.innerText || '').slice(0, 240),
      };
    };
  }

  onUser(async (ev) => {
    if (authState.user?.uid !== ev.user?.uid) {
      hostLoop?.stop();
      hostLoop = null;
    }
    authState = ev;
    if (ev.status === 'signed-in' && ev.user) {
      const fb = getFirebase();
      if (fb && !ev.fromCache) {
        try {
          playerDoc = await getPlayer(fb, ev.user.uid);
          leaderPreview = (await fetchLeaderboard(fb, 3)) || [];
        } catch {
          playerDoc = readCachedPlayer(ev.user.uid);
        }
      } else {
        playerDoc = readCachedPlayer(ev.user.uid);
      }
      // Resolve closed bindings before the first lobby paint.
      if (playerDoc?.tableRoomId || playerDoc?.hostRoomId) {
        await silentlySettleClosedBinding();
      }
      if (deepRoom && screen === 'auth') {
        await tryDeepLink(deepRoom, deepR);
        return;
      }
      if (screen === 'auth' || screen === 'linking') {
        screen = 'lobby';
      }
    } else if (
      ev.status === 'signed-out' ||
      ev.status === 'in-app-browser' ||
      ev.status === 'error' ||
      ev.status === 'loading' ||
      ev.status === 'offline'
    ) {
      if (ev.status !== 'offline' || !ev.user) screen = 'auth';
      else screen = 'lobby';
    }
    paint();
  });

  // takeover poll replaced: wait for the original host, then close at T+2.
  let disconnectClosePending = false, disconnectCloseStartedAt = 0;
  setInterval(() => {
    void sweepLobbyTables();
    updateHostDisconnect();
    const fb = getFirebase(), u = getUser();
    const dbg = globalThis.window?.__hdDebug ? (...a) => console.info('[HDDBG]', Date.now(), ...a) : null;
    dbg?.('tick', {room: !!room, status: room?.status, pending: disconnectClosePending, beat: hostBeatMs, upd: hostRoomUpdatedMs, vis: globalThis.document?.visibilityState});
    // HD1113 r4: a hung close transaction must not block retries (watchdog 8s).
    if (disconnectClosePending && Date.now() - disconnectCloseStartedAt > 8000) disconnectClosePending = false;
    if (!fb || !u || !room || room.status === 'closed' || disconnectClosePending) return;
    if (disconnectState(hostAliveMs(hostBeatMs, hostRoomUpdatedMs)).reclaim) {
      disconnectClosePending = true; disconnectCloseStartedAt = Date.now();
      const t0 = disconnectCloseStartedAt; dbg?.('close start');
      closeDisconnectedRoom({...fb,uid:u.uid},roomId).then(r => dbg?.('close done', r, Date.now()-t0)).catch(e => { dbg?.('close err', String(e?.message||e), Date.now()-t0); console.warn('[disconnect] close',e); })
        .finally(() => { if (disconnectCloseStartedAt === t0) disconnectClosePending = false; });
    }
  }, 2000);
}

/** C1: existing seat avatar → that player's Page stats overlay (avatar hit area only). */
function openOwnStats() {
  const me = getUser();
  if (me) openStatsFor(me.uid, playerDoc?.displayName || me.displayName || '玩家');
}
function bindPersonalStatsEntry() {
  if (document.body.dataset.psWired) return;
  document.body.dataset.psWired = '1';
  document.addEventListener('click', (e) => {
    const av = e.target.closest?.('#seats .av[data-ps-uid], #heroAv, .mp-lb-av[data-ps-uid], .mp-hav[data-ps-uid]');
    if (!av || (av.id !== 'heroAv' && !av.dataset.psUid)) return;
    const fb = getFirebase();
    const me = getUser();
    if (!fb || !me) return;
    if (av.classList?.contains('mp-hav') && av.dataset.psUid !== me.uid) return;
    e.stopPropagation();
    if (av.id === 'heroAv' || av.dataset.psUid === me.uid) openOwnStats();
    else openStatsFor(av.dataset.psUid, av.dataset.psName || '');
  }, true);
}
/** v1.0.5: after cash-out / leave, self re-syncs public chips total (= bank) and clears private seat map.
 * Triggered from lobby paint only when bank changed (no polling, no repaint); failures leave status pending. */
let chipsSyncKey = '';
let closedFallbackToastFor = null;
let roomGoneFor = null;
export let chipsSyncStatus = 'idle';
const CHIPS_PENDING_KEY = (uid) => `pokerStats.chipsPending.v1:${uid}`;
if (typeof window !== 'undefined') {
  // Retry a failed cash-out sync on reconnect (event-driven, no polling).
  window.addEventListener('online', () => { if (chipsSyncStatus === 'pending') { chipsSyncKey = ''; maybeSyncOwnChips(); } });
}
function maybeSyncOwnChips() {
  const fb = getFirebase(); const me = getUser();
  if (!fb || !me || !playerDoc || playerDoc.tableRoomId || !(STATS_ENABLED || qaStatsOpts())) return;
  const key = `${me.uid}:${playerDoc.bank}`;
  if (key === chipsSyncKey) return;
  chipsSyncKey = key; chipsSyncStatus = 'pending';
  try { localStorage.setItem(CHIPS_PENDING_KEY(me.uid), '1'); } catch { /* optional */ }
  void createFirestoreStatsAdapter({ fs: fb.fs, db: fb.db }).writeChips({ uid: me.uid })
    .then((total) => {
      chipsSyncStatus = total === null ? 'idle' : 'synced';
      try { localStorage.removeItem(CHIPS_PENDING_KEY(me.uid)); } catch { /* optional */ }
    })
    .catch((e) => { chipsSyncStatus = 'pending'; console.warn('[stats] chips', e?.code || e); });
}
function openStatsFor(uid, name) {
    const fromRoom = screen === 'table' ? room?.id : null;
    const fb = getFirebase();
    const me = getUser();
    if (!fb || !me || !uid) return;
    openPersonalStats({
      uid,
      name,
      myUid: me.uid,
      enabled: STATS_ENABLED || !!qaStatsOpts(),
      load: async (uid) => {
        const snap = await fb.fs.getDocFromServer(fb.fs.doc(fb.db, 'pokerStatsPublic', uid));
        return snap.exists() ? snap.data() : null;
      },
      chipsOf: (agg) => agg?.currentChipsTotal,
      syncHint: () => {
        let flag = null; try { flag = localStorage.getItem(CHIPS_PENDING_KEY(me.uid)); } catch { flag = null; }
        return chipsSyncStatus === 'pending' || (flag && chipsSyncStatus !== 'synced') ? '本裝置待送' : '';
      },
      onClose: () => {
        // Source table closed while viewing → safe lobby fallback with short note (spec §2.2).
        // PL: same table + same close event already showing its close-result card → no extra toast.
        if (!shouldToastClosedFallback({ fromRoom, roomId: room?.id || null, status: room?.status,
          gone: roomGoneFor === fromRoom, cardShownFor: closeResultShownFor,
          cardDismissedFor: closeResultDismissedFor, toastedFor: closedFallbackToastFor })) return;
        closedFallbackToastFor = fromRoom;
        {
          goLobbyClean(); toast('原牌桌已關閉，已回大廳');
        }
      },
    });
}

function ensureMpRoot() {
  bindPersonalStatsEntry();
  if ($('#mpRoot')) return;
  const el = document.createElement('div');
  el.id = 'mpRoot';
  el.className = 'mp-root';
  document.body.appendChild(el);
  const toast = document.createElement('div');
  toast.id = 'mpToast';
  toast.className = 'mp-toast';
  toast.hidden = true;
  document.body.appendChild(toast);
  const banner = document.createElement('div');
  banner.id = 'mpBanner';
  banner.className = 'mp-banner';
  banner.hidden = true;
  document.body.appendChild(banner);
}

function injectAuthCss() {
  if ($('#authUiCss')) return;
  const s = document.createElement('style');
  s.id = 'authUiCss';
  s.textContent = AUTH_UI_CSS;
  document.head.appendChild(s);
}

/** @type {number} emu/QA: lobby+shell paint invocations (detect redraw loops) */
let paintCount = 0;

function paint() {
  paintCount += 1;
  if (typeof window !== 'undefined') {
    window.__qaPaintCount = paintCount;
  }
  const root = $('#mpRoot');
  if (!root) return;

  // Hide solo lobby / app when in MP shell screens
  const soloLobby = $('#lobbyScreen');
  const app = $('#app');
  const inTable = screen === 'table';
  if (inTable || screen === 'share' || screen === 'create') dismissToast('正在確認牌桌…');
  // Table-only control — must not linger over lobby/stats after close-result
  if (!inTable) {
    const back = $('#btnBackLobby');
    if (back) back.hidden = true;
  }

  if (screen === 'auth') {
    root.hidden = false;
    root.classList.remove('mp-root-table');
    silenceSoloScreens();
    if (app) app.classList.add('hidden');
    renderAuthUi(root, authState, {
      brand: '週五牌局',
      onRetry: () => signIn(),
    });
    // Brand + felt hero image (same footprint as old dashed card) + login
    if (authState.status === 'signed-out' || authState.status === 'offline') {
      root.innerHTML = `
        <div class="mp-shell mp-auth">
          <h1 class="mp-brand">週五牌局</h1>
          <div class="mp-auth-card" aria-hidden="true">
            <img src="assets/auth-felt.svg" width="280" height="160" alt="" class="mp-auth-img">
          </div>
          ${authState.status === 'offline' ? '<p class="mp-offline">離線資料</p>' : ''}
          <button type="button" class="mp-b1" id="btnGoogle">用 Google 帳號登入</button>
        </div>`;
      $('#btnGoogle', root)?.addEventListener('click', () => signIn());
    }
    return;
  }

  if (screen === 'lobby') {
    maybeSyncOwnChips();
    root.hidden = false;
    root.classList.remove('mp-root-table');
    if (app) app.classList.add('hidden');
    silenceSoloScreens();
    ensureOpenTablesListen();
    void sweepLobbyTables();
    if (pendingAwayUnseatToast) {
      pendingAwayUnseatToast = false;
      awayLobbyStatus = '已自動離座';
      ensureLobbyNotify();
      showLobbyNotify(
        '你暫離超過 30 分鐘，已自動離座，籌碼已回帳戶',
        '',
        { label: '知道了' },
        { sticky: true },
      );
    }
    // Clear away status only when back on an open hosted/seated table (not settle)
    if (
      awayLobbyStatus &&
      !rescueOk &&
      playerDoc?.tableRoomId &&
      room?.status &&
      isRoomOpenStatus(room.status) &&
      screen === 'table'
    ) {
      awayLobbyStatus = null;
    }
    const cachedLast = getLastRoom();
    // Closed tables: never show 我的牌桌 (settle is silent). Open bind only.
    // Voluntary ‹ 大廳 exit: suppress 我的牌桌／繼續 until tableRoomId clears.
    if (lobbyExitSuppressMine && !playerDoc?.tableRoomId && !playerDoc?.hostRoomId) {
      lobbyExitSuppressMine = false;
    }
    const continueId = lobbyExitSuppressMine
      ? null
      : playerDoc?.tableRoomId && !rescueOk
        ? playerDoc.tableRoomId
        : playerDoc?.hostRoomId && !rescueOk
          ? playerDoc.hostRoomId
          : null;
    const last = cachedLast?.roomId === continueId ? cachedLast : null;
    // Stay in the lobby after load/sign-in; enter only through 我的牌桌／繼續.
    // Soft-leave live close still comes from listenRoom → silentlySettle + paint.
    // This getDoc path is only for lobby-entry / bind change / ~30s idle-close.
    if (lobbyIdleCheckNeeded() && !lobbyIdleCheckInflight) {
      lobbyIdleCheckKey = `${playerDoc?.tableRoomId || ''}|${playerDoc?.hostRoomId || ''}`;
      lobbyIdleCheckAt = Date.now();
      lobbyIdleCheckInflight = true;
      maybeRefreshRescue()
        .then(async (changed) => {
          let settledChanged = false;
          try {
            const tid = continueId;
            if (tid) {
              const before = lobbyBindKey();
              const confirmed = await confirmContinueRoom(tid);
              confirmedLobbyRoom = confirmed.room || null;
              if (confirmed.closed) revealClosedFromLobby(tid, confirmed);
              settledChanged = before !== lobbyBindKey() || !!confirmedLobbyRoom || !!confirmed.closed;
            }
          } catch {
            /* keep last confirmedLobbyRoom on a failed re-check */
          }
          if ((changed || settledChanged) && screen === 'lobby') paint();
        })
        .finally(() => {
          lobbyIdleCheckInflight = false;
        });
    }
    const liveRoom = room?.id === continueId && isRoomOpenStatus(room.status)
      ? room
      : confirmedLobbyRoom?.id === continueId ? confirmedLobbyRoom : null;
    const seatIdx =
      liveRoom?.seatUids
        ? liveRoom.seatUids.indexOf(authState.user?.uid)
        : last?.seat;
    const stackChips =
      seatIdx >= 0 && Array.isArray(liveRoom?.stacks)
        ? liveRoom.stacks[seatIdx]
        : null;
    const myTable =
      continueId && liveRoom && (playerDoc?.tableRoomId || playerDoc?.hostRoomId || rescueOk)
        ? {
            roomId: continueId,
            code: liveRoom?.code || last?.code || '',
            name: liveRoom?.name || last?.name || '—',
            chips:
              stackChips != null
                ? stackChips
                : playerDoc?.inPlay ?? last?.chips,
            seat: seatIdx >= 0 ? seatIdx : last?.seat ?? null,
            seated:
              Array.isArray(liveRoom?.seatUids)
                ? liveRoom.seatUids.filter(Boolean).length
                : liveRoom?.lobby?.seated ?? null,
            blinds:
              liveRoom?.lobby?.blinds ||
              (liveRoom?.config
                ? `${liveRoom.config.sb}/${liveRoom.config.bb}`
                : '—'),
            hostName:
              liveRoom?.lobby?.hostName ||
              (liveRoom?.hostUid ? displayNameOf(liveRoom.hostUid) : '房主'),
            phase:
              liveRoom?.status === 'playing' ||
              (liveRoom?.pub?.phase &&
                liveRoom.pub.phase !== 'lobby' &&
                liveRoom.pub.phase !== 'hand_over')
                ? 'playing'
                : 'lobby',
          }
        : null;
    renderMpLobby(root, {
      user: authState.user,
      player: playerDoc,
      myTable,
      openTables: openTables.filter(
        (t) => t.id !== myTable?.roomId && !isLobbyRoomSuppressed(t.id) && isRoomOpenStatus(t.status),
      ),
      joinDigits,
      joinError,
      joining,
      leaderPreview,
      offline: authState.status === 'offline',
      rescueAvailable: rescueOk,
      rescueReason,
      rescueChips,
      onContinue: () => myTable && continueMyTable(myTable.roomId),
      onCreate: () => {
        void onCreateTable();
      },
      onJoinCode: (code) => {
        joinDigits = code;
        doJoin(code);
      },
      onOpenTable: (rid) => enterOpenTable(rid),
      onStats: () => openStats(),
      onMyStats: () => { const u = getUser(); if (u) openStatsFor(u.uid, u.displayName || '玩家'); },
      onSignOut: () => signOut(),
      onRescue: () => doRescue(),
      onAvatar: openOwnStats,
      onSettings: () => toast('設定還在製作中，請先用⋯選單的「戰績」'),
      lobbyStatus: awayLobbyStatus,
    });
    return;
  }

  if (screen === 'create') {
    root.hidden = false;
    root.classList.remove('mp-root-table');
    renderCreateRoom(root, {
      defaults: createDraft,
      bank: playerDoc?.bank ?? null,
      creating,
      error: createError,
      onDraft: (d) => {
        createDraft = { ...createDraft, ...d };
      },
      onCancel: () => {
        screen = 'lobby';
        paint();
      },
      onSubmit: (data) => doCreate(data),
    });
    return;
  }

  if (screen === 'share' && shareInfo) {
    root.hidden = false;
    root.classList.remove('mp-root-table');
    renderShareRoom(root, {
      ...shareInfo,
      onShare: async (url) => {
        if (navigator.share) {
          try {
            await navigator.share({ title: shareInfo.name, url });
            return;
          } catch {
            /* fallthrough */
          }
        }
        await navigator.clipboard?.writeText(url);
        toast('已複製');
      },
      onCopy: async (url) => {
        await navigator.clipboard?.writeText(url);
        toast('已複製');
      },
      onEnter: () => {
        paintEnterShell(shareInfo?.name);
        void enterRoom(shareInfo.roomId, { asHostSit: true });
      },
      onLobby: () => {
        clearRoomUrlParams();
        screen = 'lobby';
        paint();
      },
    });
    return;
  }

  if (screen === 'join') {
    root.hidden = false;
    root.classList.remove('mp-root-table');
    renderJoinCode(root, {
      digits: joinDigits,
      joining,
      error: joinError,
      ended: joinEnded,
      onBack: () => {
        clearRoomUrlParams();
        screen = 'lobby';
        paint();
      },
      onChange: (d) => {
        joinDigits = d.replace(/\D/g, '').slice(0, 3);
        joinError = '';
        paint();
      },
      onJoin: () => doJoin(joinDigits),
      onLobby: () => {
        clearRoomUrlParams();
        joinEnded = false;
        joinError = '';
        joinDigits = '';
        screen = 'lobby';
        paint();
      },
    });
    return;
  }

  if (screen === 'stats') {
    root.hidden = false;
    root.classList.remove('mp-root-table');
    if (app) app.classList.add('hidden');
    silenceSoloScreens();
    renderStats(root, {
      mode: statsMode,
      rows: statsRows,
      nightKey: statsNight,
      nights: [statsNight],
      myUid: authState.user?.uid,
      offline: authState.status === 'offline',
      onBack: () => {
        // From 看戰績 after close-result: stay in lobby, never auto-resume table
        autoResumeTried = true;
        screen = 'lobby';
        paint();
      },
      onMode: async (m) => {
        statsMode = m;
        await loadStats();
        paint();
      },
      onNight: async (k) => {
        statsNight = k;
        await loadStats();
        paint();
      },
    });
    return;
  }

  if (screen === 'table') {
    root.hidden = true;
    root.classList.add('mp-root-table');
    silenceSoloScreens();
    if (app) app.classList.remove('hidden');
    ensureMpMenu();
    paintTableChrome();
  }
}

/** 0.2 秒回饋：點「進入牌桌」立刻畫空牌桌＋自己的位子，讀取在背景完成（不畫空位／觀戰）。 */
function paintEnterShell(name) {
  room = null;
  screen = 'table';
  paint();
  const user = getUser();
  const me = nameOrStub(user?.uid, user?.displayName, '你');
  const set = (sel, fn) => {
    const el = $(sel);
    if (el) fn(el);
  };
  set('#btnBackLobby', (el) => (el.hidden = false));
  set('#roomTitle', (el) => (el.textContent = name || '—'));
  set('#roomMeta', (el) => (el.innerHTML = ''));
  set('#seats', (el) => el.querySelectorAll('.mp-empty-seat, .seat:not(.hero)').forEach((n) => n.remove()));
  set('#bets', (el) => (el.innerHTML = ''));
  set('#board', (el) => (el.innerHTML = ''));
  set('#heroHole', (el) => (el.innerHTML = ''));
  set('#heroName', (el) => (el.textContent = me));
  set('#heroChips', (el) => (el.textContent = (playerDoc?.inPlay ?? getLastRoom()?.chips) != null ? fmtChips(playerDoc?.inPlay ?? getLastRoom()?.chips) : '—'));
  set('#heroAv', (el) => (el.innerHTML = `<span>${esc(me.slice(0, 1))}</span>`));
  set('#btns', (el) => (el.innerHTML = ''));
}

async function sweepLobbyTables() {
  const fb = getFirebase();
  const user = getUser();
  if (screen !== 'lobby' || !fb || !user || lobbySweepInflight) return;
  lobbySweepInflight = true;
  try {
    for (const row of lobbySweepRows) {
      if (screen !== 'lobby' || getUser()?.uid !== user.uid) break;
      if (row.id === playerDoc?.tableRoomId) continue;
      await sweepStaleTable(fb, row, user.uid, Date.now(), () => {
        if (screen === 'lobby') paint();
      });
    }
  } finally {
    lobbySweepInflight = false;
  }
}

function ensureOpenTablesListen() {
  if (stopOpenTables) return;
  const fb = getFirebase();
  if (!fb) return;
  stopOpenTables = listenOpenTables(
    fb,
    (rows) => {
      const hadTable = openTables.length > 0;
      lobbySweepRows = rows;
      openTables = rows.slice(0, 1);
      void sweepLobbyTables();
      if (screen !== 'lobby') return;
      // 一般快照只更新清單，保留手機 pointerdown 到 click 之間的頭像節點。
      const root = $('#mpRoot');
      const mine = lobbyExitSuppressMine ? null : playerDoc?.tableRoomId || playerDoc?.hostRoomId;
      const listed = openTables.filter(t => t.id !== mine && !isLobbyRoomSuppressed(t.id) && isRoomOpenStatus(t.status));
      if (hadTable === (openTables.length > 0) && root && patchOpenTables(root, listed)) return;
      // 單桌出現／消失時，開桌入口也必須同步更新。
      paint();
    },
    (err) => console.warn('open tables', err),
  );
}

async function enterOpenTable(roomId) {
  const fb = getFirebase();
  const user = getUser();
  if (!fb || !user || !roomId || openJoinBusy) return;
  openJoinBusy = true;
  toast('正在確認牌桌…');
  const root = $('#mpRoot');
  const row = root?.querySelector(`.mp-row[data-rid="${CSS.escape(roomId)}"]`);
  if (row) {
    row.setAttribute('aria-busy', 'true');
    row.disabled = true;
    const go = row.querySelector('.mp-go');
    if (go) go.textContent = '加入中…';
  }
  try {
    await silentlySettleClosedBinding();
    playerDoc = await getPlayer(fb, user.uid);
    if (await maybeAutoCloseSingleTable(fb, roomId, user.uid)) {
      openTables = openTables.filter((t) => t.id !== roomId);
      // Release the join guard in finally before create's lookup may join a new table.
      return onCreateTable();
    }
    const res = await joinByRoomId(fb, roomId, user.uid);
    if (res.ended || res.error) {
      // M2 #2: just-closed from open list — drop stale pokerLobby row
      if (res.ended) {
        noteLobbyRoomClosed(roomId);
        try {
          await deleteLobbyListing(fb, roomId);
        } catch {
          /* ignore */
        }
        openTables = openTables.filter((t) => t.id !== roomId);
      }
      toast(
        res.ended
          ? '這桌剛收桌了，換一桌或開新牌桌'
          : friendlyError(res.error, '無法加入這桌，請再試一次或換一桌'),
      );
      if (screen === 'lobby') paint();
      return;
    }
    if (playerDoc?.tableRoomId !== roomId) {
      assertMinimumBuyin(playerDoc?.bank ?? res.room.config.newPlayerChips, res.room.config.bb);
    }
    await enterRoom(roomId);
  } catch (e) {
    toast(friendlyError(e, '無法加入這桌，請檢查網路後再試一次'));
    if (screen === 'lobby') paint();
  } finally {
    openJoinBusy = false;
  }
}

function lobbyBindKey() {
  return [
    playerDoc?.tableRoomId || '',
    playerDoc?.hostRoomId || '',
    playerDoc?.inPlay ?? '',
    playerDoc?.bank ?? '',
    playerDoc?.total ?? '',
    rescueOk ? '1' : '0',
    rescueReason || '',
  ].join('|');
}

async function maybeRefreshRescue() {
  const fb = getFirebase();
  const uid = getUser()?.uid;
  const tid = playerDoc?.tableRoomId;
  if (!fb || !uid || !tid) {
    const prev = rescueOk;
    rescueOk = false;
    rescueReason = null;
    rescueChips = null;
    return prev !== rescueOk;
  }
  try {
    const snap = await fb.fs.getDoc(fb.fs.doc(fb.db, 'pokerRooms', tid));
    const prev = rescueOk;
    const before = lobbyBindKey();
    // Closed / missing: silent settle — never show「結帳離開」for closed tables
    if (!snap.exists() || snap.data()?.status === 'closed') {
      await silentlySettleClosedBinding();
      return before !== lobbyBindKey() || prev !== rescueOk;
    }
    const d = snap.data();
    const seat = Array.isArray(d.seatUids) ? d.seatUids.indexOf(uid) : -1;
    const stackAmt =
      seat >= 0 && Array.isArray(d.stacks) ? Number(d.stacks[seat]) || 0 : null;
    const settled =
      stackAmt != null ? stackAmt : Number(playerDoc?.inPlay) || 0;

    let hostBeatMs = null;
    if (d.hostUid) {
      try {
        const hp = await fb.fs.getDoc(
          fb.fs.doc(fb.db, 'pokerRooms', tid, 'presence', d.hostUid),
        );
        if (hp.exists()) hostBeatMs = hp.data()?.beat?.toMillis?.() ?? null;
      } catch {
        hostBeatMs = null;
      }
    }

    const decision = decideRescue({
      uid,
      room: {
        status: d.status,
        hostUid: d.hostUid,
        updatedAtMs: d.updatedAt?.toMillis?.() || 0,
      },
      hostBeatMs,
    });

    // reason === 'closed' should be unreachable (handled above); keep gone-only card
    if (!hostPaused && decision.ok && decision.reason === 'gone') {
      rescueOk = true;
      rescueReason = 'gone';
      rescueChips = settled;
    } else {
      rescueOk = false;
      rescueReason = null;
      rescueChips = null;
    }
    return prev !== rescueOk;
  } catch {
    return false;
  }
}

/**
 * L3 / stuck hostRoomId: if pointer is closed/missing, clear and open create;
 * if still open, resume that table.
 */
async function onCreateTable() {
  const fb = getFirebase();
  const user = getUser();
  toast('正在確認牌桌…');
  if (!fb || !user) return;
  try {
    const existing = await findOpenTable(fb, user.uid);
    if (existing) {
      await enterOpenTable(existing.id);
      return;
    }
  } catch (e) {
    toast(friendlyError(e, '無法確認牌桌，請再試一次'));
    return;
  }
  const hid = playerDoc?.hostRoomId;
  if (hid && fb && user) {
    try {
      const snap = await fb.fs.getDoc(fb.fs.doc(fb.db, 'pokerRooms', hid));
      if (snap.exists() && isRoomOpenStatus(snap.data()?.status)) {
        enterRoom(hid, { asHostSit: true });
        return;
      }
      // closed or missing → clear stuck pointer, then open create form
      await fb.fs.updateDoc(fb.fs.doc(fb.db, 'pokerPlayers', user.uid), {
        hostRoomId: null,
        updatedAt: fb.fs.serverTimestamp(),
      });
      playerDoc = { ...playerDoc, hostRoomId: null };
    } catch (e) {
      console.warn('hostRoomId reclaim', e);
    }
  }
  if (playerDoc?.tableRoomId && !rescueOk) {
    const last = getLastRoom();
    const nm = last?.name || '牌桌';
    showLobbyNotify(
      `先離開「${nm}」`,
      '你正坐在這桌，離座結帳後才能開新牌桌。',
      {
        label: '回到這一桌',
        run: () => {
          const tid = playerDoc?.tableRoomId;
          if (tid) enterRoom(tid);
        },
      },
    );
    flashMyTableAttn($('#mpRoot'));
    return;
  }
  screen = 'create';
  paint();
}

async function doCreate(data) {
  const fb = getFirebase();
  const user = getUser();
  createDraft = {
    name: data.name || createDraft.name,
    sb: data.sb,
    chips: data.newPlayerChips,
  };
  if (!fb || !user) {
    createError = '連不上網路，請檢查連線後再按「開房」';
    paint();
    return;
  }
  if (data.newPlayerChips < 1000 || data.newPlayerChips > 100000 || data.newPlayerChips % 500) {
    createError = '起始籌碼要在 1,000–100,000 之間，且是 500 的倍數；請改完再按「開房」';
    paint();
    return;
  }
  if (creating) return;
  const attempt = ++createAttempt;
  const isCurrent = () => attempt === createAttempt;
  const timeout = setTimeout(() => {
    if (!isCurrent()) return;
    ++createAttempt;
    creating = false;
    createError = '牌桌沒開成功，請再按一次';
    paint();
  }, createTimeoutMs());
  creating = true;
  createError = '';
  paint();
  try {
    const displayName = user.displayName || '玩家';
    const tableName =
      String(data.name || '').trim() || `${displayName}的牌桌`;
    await silentlySettleClosedBinding(isCurrent);
    if (!isCurrent()) return;
    const freshPlayer = await getPlayer(fb, user.uid);
    if (!isCurrent()) return;
    playerDoc = freshPlayer;
    let res = playerDoc?.hostRoomId ? await findHostedOpenTable(fb, user.uid) : null;
    if (!isCurrent()) return;
    const buyinError = createRoomBuyinError(data.newPlayerChips, data.sb, data.bb, playerDoc?.bank ?? null);
    if (!res && buyinError) {
      createError = buyinError;
      creating = false;
      paint();
      return;
    }
    if (!res) res = await createSingleTable(fb, {
      uid: user.uid,
      name: tableName,
      displayName,
      photoURL: user.photoURL || null,
      sb: data.sb,
      bb: data.bb,
      newPlayerChips: data.newPlayerChips,
    });
    if (!isCurrent()) return;
    if (res.existing) {
      // L3: already hosting → go straight back to that table
      const existingPlayer = await getPlayer(fb, user.uid);
      if (!isCurrent()) return;
      playerDoc = existingPlayer;
      creating = false;
      screen = 'lobby';
      if (playerDoc?.tableRoomId !== res.roomId) {
        try { assertMinimumBuyin(playerDoc?.bank ?? res.config.newPlayerChips, res.config.bb); }
        catch (e) { toast(e.message); paint(); return; }
      }
      clearTimeout(timeout);
      await enterRoom(res.roomId);
      return;
    }
    shareInfo = res;
    createDraft = { name: '', sb: 10, chips: DEFAULT_NEW_PLAYER_CHIPS };
    // createRoom atomically writes this pointer; no read is needed before sharing.
    playerDoc = { ...playerDoc, hostRoomId: res.roomId };
    screen = 'share';
  } catch (e) {
    if (!isCurrent()) return;
    console.error(e);
    createError = friendlyError(
      e,
      '牌桌沒開成功，可能是網路斷了，請再按一次',
    );
  } finally {
    clearTimeout(timeout);
  }
  if (!isCurrent()) return;
  creating = false;
  paint();
}

async function doJoin(code, expectedR = null) {
  const fb = getFirebase();
  const user = getUser();
  if (!fb || !user) return;
  joining = true;
  joinError = '';
  joinEnded = false;
  joinDigits = String(code || '').replace(/\D/g, '').slice(0, 3);
  paint();
  try {
    const res = await Promise.race([
      joinByCode(fb, code, user.uid, expectedR),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
    ]);
    if (res.ended || res.error) {
      // M2 #3: keep digits for select-all overwrite
      const digits = joinDigits;
      if (res.ended || /permission-denied|closed|結束/i.test(String(res.error || ''))) {
        joinError = '這桌已經結束了，回大廳看看其他牌桌';
        joinEnded = true;
      } else if (res.error && /找不到|不存在/.test(res.error)) {
        joinError = `房號 ${digits} 不存在，請再確認`;
        joinEnded = false;
      } else {
        joinError = friendlyError(res.error, '這桌已經結束了，回大廳看看其他牌桌');
        joinEnded = !!res.ended;
      }
    } else if (res.roomId) {
      joinDigits = '';
      joinError = '';
      await enterRoom(res.roomId);
      return;
    }
  } catch (e) {
    joinError =
      e?.message === 'timeout'
        ? '連線太慢，沒有加入成功。請按 Enter 再試一次'
        : friendlyError(e, `房號 ${joinDigits} 不存在，請再確認`);
  } finally {
    // Success path used to return before clearing — lobby 房號 stuck on「加入中…」
    joining = false;
  }
  if (screen !== 'table') paint();
}

async function tryDeepLink(code, r) {
  screen = 'linking';
  const root = $('#mpRoot');
  if (root) {
    root.hidden = false;
    root.innerHTML = `<div class="mp-shell"><div class="auth-spin"></div><p>正在進入牌桌…</p></div>`;
  }
  await doJoin(code, r);
  if (screen !== 'table') {
    if (joinEnded) screen = 'join';
    else if (!roomId) screen = 'lobby';
    paint();
  }
}

async function enterRoom(id, { asHostSit = false, retryJoin = true, fromContinue = false } = {}) {
  const fb = getFirebase();
  const user = getUser();
  if (!fb || !user) return;
  closingFreeze = false;
  hostSitPending = false;
  // New/resumed table — allow a future close-result for this (or another) room
  if (closeResultDismissedFor && closeResultDismissedFor !== id) {
    lobbyClosedSynced.delete(closeResultDismissedFor);
    closeResultDismissedFor = null;
  }
  if (closeResultShownFor && closeResultShownFor !== id) {
    closeResultShownFor = null;
    closeResultChipsShown = 0;
  }

  // Re-enter same open room while listenRoom still active (e.g. crash recovery race).
  if (
    roomId === id &&
    room &&
    stopRoom &&
    room.status !== 'closed' &&
    (room.hostUid === user.uid || (room.seatUids || []).includes(user.uid))
  ) {
    if (!animQ) {
      animQ = createAnimQueue(async (ev) => {
        if (prefersReducedMotion() && ev.type !== 'snap' && ev.type !== 'hostChange') {
          paintTableChrome();
          return;
        }
        paintTableChrome();
      });
    }
    if (room.hostUid === user.uid && !hostLoop) {
      hostLoop = createHostLoop(fb, {
        onHostAloneClose: () => startHostClose({ showResultCard: true, auto: true }),
        getCurrentUid: () => getUser()?.uid,
        stats: qaStatsOpts(),
        roomId: id,
        uid: user.uid,
        getRoom: () => room,
        displayNameOf,
        onLocalState: () => paintTableChrome(),
      });
      hostLoop.start();
    }
    if (!presence) {
      presence = startPresence(fb, id, user.uid, {
        isHost: () => room?.hostUid === user.uid,
        getRoom: () => room,
        lastRoomWriteAt: () => hostLoop?.lastRoomWriteAt?.() || 0,
      });
    } else {
      presence.beatNow?.();
    }
    if (!intents) intents = createIntentSender(fb, id, user.uid, () => screen === 'table' && roomId === id);
    screen = 'table';
    paint();
    return;
  }

  tearDownRoom();
  roomId = id;
  startRoomSound();
  // Preserve a dismissed result for this same room.
  closeResultShownFor = null;
  closeResultChipsShown = 0;
  pendingCloseReturnChips = null;
  lastKnownSelfTableChips = 0;
  lastKnownSelfTableChipsRoomId = null;
  lastKnownSelfSessionNo = null;
  lobbyClosedSynced.delete(id);

  const last = getLastRoom();
  paintEnterShell(last?.roomId === id ? last.name : null);
  enterRoomTimeout = setTimeout(() => {
    if (roomId === id && screen === 'table' && !room) goLobbyClean();
  }, 3000);

  // Members subscribe directly; only denied subscriptions need the code join path.
  stopRoom = listenRoom(
    fb,
    id,
    async (r, metadata) => {
      if (roomId !== id) return;
      clearTimeout(enterRoomTimeout);
      const first = !room;
      const previousSelfSeat = room?.seatUids?.indexOf(user.uid) ?? -1;
      const wasBusted = previousSelfSeat >= 0 && (room.stacks?.[previousSelfSeat] === 0 ||
        room.pub?.seats?.[previousSelfSeat]?.chips === 0);
      room = r;
      if (!metadata?.hasPendingWrites && !metadata?.fromCache) {
        hostRoomUpdatedMs = r.updatedAt?.toMillis?.() ?? hostRoomUpdatedMs;
        const live = Math.max(hostBeatMs ?? 0, hostRoomUpdatedMs ?? 0);
        if (live) hostLoop?.observeHostBeat?.(live);
      }
      watchHostBeat(fb, id, r);
      updateHostDisconnect();
      const ownZeroCashout = r.lastMoneyEvent?.type === 'cashout' &&
        r.lastMoneyEvent.uid === user.uid && r.lastMoneyEvent.amount === 0;
      if (previousSelfSeat >= 0 && (wasBusted || ownZeroCashout) &&
          r.status !== 'closed' && !r.seatUids.includes(user.uid)) {
        // 輸光離座＝自願離開：不顯示「我的牌桌／回到牌桌」，並重讀帳戶避免顯示舊的桌上籌碼
        lobbyExitSuppressMine = true;
        goLobbyClean();
        toast('籌碼輸光了，已離座回大廳');
        try { void getPlayer(fb, user.uid).then((p) => { if (p) { playerDoc = p; if (screen === 'lobby') paint(); } }).catch(() => {}); } catch { /* 測試沙盒 */ }
        return;
      }
      lastRecvAt = Date.now();
      if (first) {
        consumeRoomSound(null, r.pub || {}, r.seatUids.indexOf(user.uid), true);
      }
      // Track self stack while still seated / bound — host may cash out before status=closed
      {
        const u = getUser()?.uid;
        if (u) {
          const s = Array.isArray(r.seatUids) ? r.seatUids.indexOf(u) : -1;
          if (s >= 0) {
            lastKnownSelfTableChips = Number(r.stacks?.[s]) || 0;
            lastKnownSelfTableChipsRoomId = id;
            lastKnownSelfSessionNo = r.sess?.[s]?.sessionNo ?? null;
          } else if (
            lastKnownSelfTableChipsRoomId !== id &&
            playerDoc?.tableRoomId === id &&
            Number(playerDoc?.inPlay) > 0
          ) {
            lastKnownSelfTableChips = Number(playerDoc.inPlay) || 0;
          }
        }
      }
      if (r.status === 'closed') {
        resetRoomSound();
        // M2 #5: result card — do not auto-kick to lobby
        clearLastRoom();
        // Soft-leave / already dismissed: settle + one lobby live refresh (no loop)
        if (closeResultDismissedFor === id || screen !== 'table') {
          void (async () => {
            const before = lobbyBindKey();
            await silentlySettleClosedBinding();
            if (screen !== 'lobby') return;
            const changed = before !== lobbyBindKey();
            if (changed || !lobbyClosedSynced.has(id)) {
              lobbyClosedSynced.add(id);
              paint();
            }
          })();
          return;
        }
        const auto =
          !!(r.lobby?.autoClosed || r.autoClosed || r.pub?.autoClosed) || r.closedBy === 'auto';
        const cashoutSessionNo = lastKnownSelfSessionNo ?? playerDoc?.sessionNo;
        const cashoutAmount = await readSelfCashoutAmount(
          fb, user.uid, id, cashoutSessionNo,
        );
        // Ledger is authoritative; retain pending / settle / last-known as fallback.
        let chips =
          pendingCloseReturnChips != null
            ? Number(pendingCloseReturnChips) || 0
            : 0;
        try {
          playerDoc = (await getPlayer(getFirebase(), getUser()?.uid)) || playerDoc;
        } catch {
          /* keep */
        }
        if (playerDoc?.tableRoomId === id) {
          const settled = await silentlySettleClosedBinding();
          if (settled > 0) chips = settled;
        } else {
          await silentlySettleClosedBinding();
        }
        if (!(chips > 0) && lastKnownSelfTableChips > 0) {
          chips = lastKnownSelfTableChips;
        }
        if (cashoutAmount > 0) chips = cashoutAmount;
        showCloseResultCard({ chips, auto });
        pendingCloseReturnChips = null;
        paintTableChrome();
        return;
      }

      if (!r.seatUids.includes(user.uid) && r.seatUids.filter(Boolean).length >= 6) {
        goLobbyClean();
        toast('這桌已滿，請選其他牌桌');
        return;
      }
      // First visit: grant + optional host sit
      if (first) {
        hostSitPending = asHostSit && r.hostUid === user.uid && !r.seatUids.includes(user.uid);
        paintTableChrome();
        try {
          const g = await ensurePlayerGrant(
            fb,
            user.uid,
            id,
            r.config.newPlayerChips,
            user,
          );
          if (g.created) {
            toast(`第一次來，送你 ${r.config.newPlayerChips.toLocaleString('en-US')} 籌碼`);
          }
          playerDoc = { uid: user.uid, ...g.player };
        } catch (e) {
          console.warn('grant', e);
        }
        // 進桌途中已離開（回大廳）：不要再把畫面切回牌桌、不要啟動這桌的連線
        if (roomId !== id) return;

        presence = startPresence(fb, id, user.uid, {
          isHost: () => room?.hostUid === user.uid,
          getRoom: () => room,
          lastRoomWriteAt: () => hostLoop?.lastRoomWriteAt?.() || 0,
        });
        intents = createIntentSender(fb, id, user.uid, () => screen === 'table' && roomId === id);
        stopHole = listenHole(fb, id, user.uid, (h) => {
          myHole = h;
          paintTableChrome();
        });

        // Cache names for seated + members
        for (const u of r.seatUids) if (u) cachePlayerName(u);
        for (const u of r.members || []) if (u) cachePlayerName(u);
        // Seed from pub seats (skip uid stubs)
        for (const s of r.pub?.seats || []) {
          if (s?.id && s.name && !looksLikeUidStub(s.name, s.id)) nameCache[s.id] = s.name;
        }
        if (user.displayName) nameCache[user.uid] = user.displayName;
        {
          const seatIdx = r.seatUids.indexOf(user.uid);
          rememberLastRoom(id, r.code, {
            name: r.name,
            seat: seatIdx >= 0 ? seatIdx : null,
            chips:
              seatIdx >= 0
                ? r.stacks?.[seatIdx] ?? playerDoc?.inPlay
                : playerDoc?.inPlay,
          });
        }

        if (r.hostUid === user.uid) {
          hostLoop = createHostLoop(fb, {
        onHostAloneClose: () => startHostClose({ showResultCard: true, auto: true }),
        getCurrentUid: () => getUser()?.uid,
        stats: qaStatsOpts(),
            roomId: id,
            uid: user.uid,
            getRoom: () => room,
            displayNameOf,
            onLocalState: () => paintTableChrome(),
            onChipMismatch: () =>
              toast(
                '籌碼數字對不上，為了不算錯先停住。請房主收桌，大家的籌碼會照桌上數字結回帳戶',
              ),
            onQuotaStop: () => {
              paintTableChrome();
            },
          });
          hostLoop.start();
        }

        animQ = createAnimQueue(async (ev) => {
          if (prefersReducedMotion() && ev.type !== 'snap' && ev.type !== 'hostChange') {
            paintTableChrome();
            return;
          }
          if (ev.type === 'hostChange') {
            const who = displayNameOf(ev.to);
            toast(
              ev.voided
                ? `房主斷線，由 ${who} 接手；這一手作廢`
                : `${displayNameOf(ev.from)} 離座，由 ${who} 當房主`,
            );

          } else if (ev.type === 'seatIn') {
            toast(`${ev.player?.name || '玩家'} 入座`);
          } else if (ev.type === 'seatOut') {
            toast(`${ev.player?.name || '玩家'} 離座`);
          }
          paintTableChrome();
        });

        const needHostSit =
          asHostSit && r.hostUid === user.uid && !r.seatUids.includes(user.uid);
        hostSitPending = needHostSit;
        screen = 'table';
        paint();

        if (needHostSit) {
          try {
            assertMinimumBuyin(wholeBalance(playerDoc, id), r.config.bb);
            const buyin = await buyinAmount(fb, user.uid, id, r.config.bb,
              playerDoc?.tableRoomId === id ? playerDoc.inPlay : buyinOptions(playerDoc, r.config).amount);
            playerDoc = { uid: user.uid, ...buyin.player };
            await hostLoop?.seatPlayer(0, user.uid);
          } catch (e) {
            console.warn('host sit', e);
            toast(friendlyError(e, '入座失敗，請點空位再試一次'));
          } finally {
            hostSitPending = false;
            paintTableChrome();
          }
        }
        // L3: ensure hostRoomId points at this table (replace only if prior gone/closed/null)
        if (r.hostUid === user.uid) {
          try {
            const p = await getPlayer(fb, user.uid);
            if (p && p.hostRoomId !== id) {
              let canClaim = !p.hostRoomId;
              if (p.hostRoomId) {
                const old = await fb.fs.getDoc(
                  fb.fs.doc(fb.db, 'pokerRooms', p.hostRoomId),
                );
                canClaim = !old.exists() || old.data()?.status === 'closed';
              }
              if (canClaim) {
                await fb.fs.updateDoc(fb.fs.doc(fb.db, 'pokerPlayers', user.uid), {
                  hostRoomId: id,
                  updatedAt: fb.fs.serverTimestamp(),
                });
              }
            }
            playerDoc = await getPlayer(fb, user.uid);
          } catch {
            /* ignore */
          }
        }
      } else {
        // host loop ownership
        if (r.hostUid === user.uid && !hostLoop) {
          hostLoop = createHostLoop(fb, {
        onHostAloneClose: () => startHostClose({ showResultCard: true, auto: true }),
        getCurrentUid: () => getUser()?.uid,
        stats: qaStatsOpts(),
            roomId: id,
            uid: user.uid,
            getRoom: () => room,
            displayNameOf,
            onLocalState: () => paintTableChrome(),
          });
          hostLoop.start();
        }
        if (r.hostUid !== user.uid && hostLoop) {
          hostLoop.stop();
          hostLoop = null;
        }
        for (const u of r.seatUids) if (u) cachePlayerName(u);
        for (const s of r.pub?.seats || []) {
          if (s?.id && s.name) nameCache[s.id] = s.name;
        }
        // Keep lastRoom.seat current once seated (QA round-3 E)
        {
          const seatIdx = r.seatUids.indexOf(user.uid);
          if (seatIdx >= 0) {
            rememberLastRoom(id, r.code, {
              name: r.name,
              seat: seatIdx,
              chips: r.stacks?.[seatIdx] ?? playerDoc?.inPlay,
            });
          }
        }
        // anim diff → queue (QA #13)
        const late =
          r.updatedAt?.toMillis &&
          Date.now() - r.updatedAt.toMillis() > MP_FX.skipIfLateMs;
        const diff = diffPubEvents(prevPub, r.pub || {}, {
          late,
          wasHidden: document.visibilityState === 'hidden',
        });
        consumeRoomSound(prevPub, r.pub || {}, r.seatUids.indexOf(user.uid), diff.skip || (r.pub?.actionSeq ?? 0) < (prevPub?.actionSeq ?? 0));
        animQ?.push(diff.events, { skip: diff.skip });
        prevPub = r.pub;
        paintTableChrome();
      }
    },
    async (err) => {
      if (roomId !== id) return;
      if (retryJoin && err?.code === 'permission-denied') {
        const last = getLastRoom();
        if (last?.code) {
          try {
            const joined = await joinByCode(fb, last.code, user.uid, id);
            if (roomId !== id) return;
            if (!joined.ended && !joined.error) {
              await enterRoom(id, { asHostSit, retryJoin: false, fromContinue });
              return;
            }
            joinError = joined.error || '牌桌已結束';
          } catch (e) {
            console.warn('join membership', e);
          }
        }
      }
      if (roomId !== id) return;
      console.warn(err);
      roomGoneFor = id;
      // Stats overlay open over this table: let its close run the lobby fallback (no card possible).
      if (document.getElementById('psHost')) return;
      clearTimeout(enterRoomTimeout);
      if (fromContinue) {
        goLobbyClean();
        return;
      }
      joinEnded = true;
      screen = 'join';
      paint();
    },
  );
}

function paintTableChrome() {
  // Host loop keeps running in lobby (§6.2) — skip DOM work off-table
  const back = $('#btnBackLobby');
  if (!room || screen !== 'table') {
    if (back) back.hidden = screen !== 'table';
    return;
  }
  // 收桌中：保留最後一格正常牌桌，結果卡蓋在上面
  if (closingFreeze) return;
  if (back) back.hidden = false;
  const user = getUser();
  const title = $('#roomTitle');
  if (title) title.textContent = room.name || '週五牌局';
  const meta = $('#roomMeta');
  if (meta) {
    const selfSeat = room.seatUids.indexOf(user?.uid);
    const buyin = buyinLabel(playerDoc, roomId, selfSeat >= 0 ? room.sess?.[selfSeat] : null, room.config);
    meta.innerHTML = `<span class="meta-a"><b>${esc(room.config.sb)}／${esc(room.config.bb)}</b>　${esc(buyin)}</span><span class="meta-b">　房號 ${esc(formatCode(room.code))}</span>`;
  }

  // Empty seats / sit affordance via seats container overlay labels
  renderSeatOverlays();
  renderActBar();
  renderBanner();
}

function renderSeatOverlays() {
  const seatsEl = $('#seats');
  const betsEl = $('#bets');
  const boardEl = $('#board');
  const potAmt = $('#potAmt');
  const heroHole = $('#heroHole');
  const heroName = $('#heroName');
  const heroChips = $('#heroChips');
  const heroAv = $('#heroAv');
  const dealer = $('#dealer');
  const turnTitle = $('#turnTitle');
  if (!seatsEl || !room) return;
  seatsEl.dataset.mp = '1';

  const user = getUser();
  const pub = room.pub || {};
  const mySeat = room.seatUids.indexOf(user?.uid);
  const between = pub.phase === 'lobby' || pub.phase === 'hand_over' || !pub.phase;

  // Board + pot — five fixed slots from hand start (no recenter on turn/river)
  const boardCards = pub.board || [];
  const boardActive =
    boardCards.length > 0 ||
    (!between && (Number(pub.handNo) || 0) > 0) ||
    pub.phase === 'showdown';
  paintBoardSlots(boardEl, boardCards, { anim: false, active: boardActive });
  if (potAmt) potAmt.textContent = fmtChips(pub.potTotal || 0);

  // Timer / turn hint
  if (turnTitle) {
    if (between) {
      turnTitle.textContent =
        pub.phase === 'hand_over' ? `第 ${pub.handNo || 0} 手結束` : '準備中';
    } else if (pub.actor == null) {
      turnTitle.textContent = pub.phase || '—';
    } else if (pub.actor === mySeat) {
      turnTitle.textContent = '輪到你';
    } else {
      const nm =
        displayNameOf(room.seatUids[pub.actor]) ||
        pub.seats?.[pub.actor]?.name ||
        `座位 ${pub.actor + 1}`;
      turnTitle.textContent = `等待 ${nm}`;
    }
  }
  turnClockTick();

  // Occupied seats for layout
  const occupied = [];
  for (let i = 0; i < 6; i++) if (room.seatUids[i]) occupied.push(i);
  const viewer = mySeat >= 0 ? mySeat : occupied[0] ?? 0;
  /** @type {Map<number, number|'hero'>} */
  let seatToPos = new Map();
  if (occupied.length && occupied.includes(viewer)) {
    ({ seatToPos } = mapSeatsClockwise(occupied, viewer));
  } else {
    for (let i = 0; i < 6; i++) seatToPos.set(i, SLOT_FALLBACK(i, 0));
  }

  seatsEl.innerHTML = '';
  if (betsEl) betsEl.innerHTML = '';

  for (const seat of occupied) {
    if (seat === mySeat) continue; // hero uses #meRoot
    const uid = room.seatUids[seat];
    const ps = pub.seats?.[seat];
    const name = nameOrStub(uid, ps?.name, `座位 ${seat + 1}`);
    const chips = between
      ? room.stacks[seat] || 0
      : (ps?.chips ?? room.stacks[seat] ?? 0);
    const bet = between ? 0 : ps?.bet || 0;
    const folded = !!ps?.folded;
    const isActor = pub.actor === seat && !between;
    const pos = seatToPos.get(seat);
    if (typeof pos !== 'number') continue;
    const away = !!(pub.away?.[seat] || pub.away?.[String(seat)]);
    const pending = (pub.pendingSeats || []).some((x) => x.seat === seat);
    const el = document.createElement('div');
    el.className = `seat pos-${pos}${folded ? ' is-folded' : ''}${isActor ? ' is-actor' : ''}${away ? ' is-away' : ''}`;
    el.dataset.seat = String(seat);
    const backs =
      !between && ps?.hasHole && !ps?.hole ? cardBackPair() : '';
    const reveal =
      ps?.hole?.length === 2
        ? `<div class="reveal-hole" data-seat="${seat}">${ps.hole.map((c) => cardHtml(c, { hero: true })).join('')}</div>`
        : '';
    const stateTag = folded
      ? '<i class="mp-seat-state" aria-label="已蓋牌">已蓋牌</i>'
      : away
        ? '<i class="mp-seat-state is-away-tag" aria-label="暫離">暫離</i>'
        : '';
    el.innerHTML = `
      ${reveal || backs}
      <div class="plate plateA">
        <div class="av" data-ps-uid="${esc(room.seatUids[seat] || '')}" data-ps-name="${esc(name)}"><span>${esc(name.slice(0, 1))}</span></div>
        <div>
          <div class="nm">${esc(name)}${seat === room.seatUids.indexOf(room.hostUid) ? '<i class="mp-host-tag">房主</i>' : ''}${pending ? '<i class="mp-host-tag">排隊</i>' : ''}${stateTag}</div>
          <span class="ch st">${fmtChips(chips)}</span>
        </div>
      </div>`;
    seatsEl.appendChild(el);
    if (bet > 0 && betsEl && !between) {
      const b = document.createElement('div');
      b.className = 'bet is-in';
      b.dataset.forSeat = String(seat);
      b.dataset.pos = String(pos);
      b.innerHTML = `<span class="chips"><i class="a"></i></span><span class="amt">${fmtChips(bet)}</span>`;
      betsEl.appendChild(b);
    }
  }

  // Empty-seat hit targets on the felt (unseated players only)
  if (mySeat < 0 && !hostSitPending) {
    for (let i = 0; i < 6; i++) {
      if (room.seatUids[i]) continue;
      const pos = SLOT_FALLBACK(i, viewer);
      if (pos === 'hero') continue;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `seat pos-${pos} mp-empty-seat`;
      el.dataset.seat = String(i);
      el.setAttribute('aria-label', `坐到座位 ${i + 1}`);
      el.innerHTML = `<div class="plate plateA mp-empty-plate"><span>空位 ${i + 1}</span></div>`;
      el.addEventListener('click', () => sitDown(i));
      seatsEl.appendChild(el);
    }
  }

  renderSidePanels(pub, mySeat);

  // Dealer button
  if (dealer && Number.isInteger(pub.button)) {
    const btnPos = seatToPos.get(pub.button);
    dealer.dataset.pos =
      btnPos === 'hero' || pub.button === mySeat ? 'hero' : String(btnPos ?? 0);
    dealer.dataset.forSeat = String(pub.button);
    dealer.hidden = between && pub.handNo === 0;
  }

  // Hero plate + hole
  if (mySeat >= 0) {
    const uid = user.uid;
    const ps = pub.seats?.[mySeat];
    const name = nameOrStub(uid, user.displayName, '你');
    const chips = between
      ? room.stacks[mySeat] || 0
      : (ps?.chips ?? room.stacks[mySeat] ?? 0);
    if (heroName) heroName.textContent = name;
    if (heroChips) heroChips.textContent = fmtChips(chips);
    if (heroAv) { heroAv.innerHTML = `<span>${esc(name.slice(0, 1))}</span>`; heroAv.dataset.psUid = room.seatUids[mySeat] || ''; heroAv.dataset.psName = name; }
    if (heroHole) {
      const keys = myHole?.cards;
      if (!between && keys?.length === 2) {
        let cards = [];
        try {
          cards = keys.map((k) => parseCard(k));
        } catch {
          cards = [];
        }
        heroHole.innerHTML = cards.length
          ? cards.map((c) => cardHtml(c, { hero: true })).join('')
          : heroBackPair({ pending: false });
      } else if (!between && (ps?.hasHole || myHole)) {
        heroHole.innerHTML = heroBackPair({ pending: false });
      } else {
        heroHole.innerHTML = '';
      }
    }
  } else {
    if (hostSitPending) {
      // 入座中：先畫自己的位子（名字＋帳戶籌碼），寫入在背景完成
      const name = nameOrStub(user.uid, user.displayName, '你');
      if (heroName) heroName.textContent = name;
      if (heroChips) heroChips.textContent = fmtChips(Number(playerDoc?.bank) || 0);
      if (heroAv) heroAv.innerHTML = `<span>${esc(name.slice(0, 1))}</span>`;
    } else {
      if (heroName) heroName.textContent = '請選位子';
      if (heroChips) heroChips.textContent = '';
    }
    if (heroHole) heroHole.innerHTML = '';
  }

  // Menu meta
  const menuMeta = $('#menuMeta');
  const menuHost = $('#menuHost');
  if (menuMeta) {
    menuMeta.textContent = `第 ${pub.handNo || 0} 手 · 房號 ${formatCode(room.code)}`;
  }
  if (menuHost) {
    menuHost.textContent = `房主 ${displayNameOf(room.hostUid)}`;
  }

  // Place D / bets after DOM seats+board settle (CSS default is table centre → covers board)
  requestAnimationFrame(() => {
    placeDealer();
    placeBets();
    placeDealer();
    placeShowdownReveals();
  });
}

function SLOT_FALLBACK(seat, viewer) {
  const rel = (seat - viewer + 6) % 6;
  return { 0: 'hero', 1: 3, 2: 4, 3: 0, 4: 1, 5: 2 }[rel] ?? 0;
}

async function startHandFromButton(event) {
  const button = event.currentTarget;
  if (button.disabled) return;
  button.disabled = true;
  try {
    if (!await hostLoop?.startHand()) toast('沒有送出去，可能是網路斷了。請再按一次');
  } catch (e) {
    toast(friendlyError(e, '沒有送出去，可能是網路斷了。請再按一次'));
  } finally {
    button.disabled = false;
    paintTableChrome();
  }
}

function renderActBar() {
  const act = $('#act');
  const btns = $('#btns');
  if (!act || !btns || !room) return;
  const user = getUser();
  const mySeat = room.seatUids.indexOf(user?.uid);
  const pub = room.pub || {};
  const isHost = room.hostUid === user?.uid;
  if (hostPaused) { btns.innerHTML = '<div class="mp-spec">等待房主回來</div>'; lockMpRaisePanel(); return; }
  const seatedCount = room.seatUids.filter(Boolean).length;
  const between = pub.phase === 'lobby' || pub.phase === 'hand_over' || !pub.phase;

  // No bottom seat-pick strip (empty seats are on the felt only)
  $('#mpSeatPick')?.remove();

  // Lock raise as soon as this seat is not the actor (or hand left betting)
  if (
    between ||
    pub.phase === 'showdown' ||
    mySeat < 0 ||
    mySeat !== pub.actor
  ) {
    lockMpRaisePanel();
  }

  if (mySeat < 0 && hostSitPending) {
    btns.innerHTML = '';
    return;
  }
  if (mySeat < 0) {
    // PL: soft leave via top 「‹ 大廳」only — no bottom 回大廳
    btns.innerHTML = `<div class="mp-spec">請選位子，點牌桌上的空位入座<br><small>${esc(buyinLabel(playerDoc, roomId, null, room.config))}；最低 ${fmtChips(50 * room.config.bb)}（50 大盲）</small></div>`;
    return;
  }

  // Showdown: 亮牌 / 不亮 (spec §5-c); host auto-mucks after 5s
  if (pub.phase === 'showdown') {
    const pending = pub.showdown?.pending || [];
    const myPending = pending.includes(mySeat);
    if (myPending) {
      btns.innerHTML = `
        <button type="button" class="primary" id="mpShow">亮牌</button>
        <button type="button" class="ghost" id="mpMuck">不亮</button>`;
      const sendReveal = (type) => {
        btns.querySelectorAll('button').forEach((b) => {
          b.disabled = true;
          b.classList.add('is-pending');
        });
        const payload = {
          type,
          seat: mySeat,
          handNo: (Number(pub.handNo) || 0) | 0,
          turn: (Number(pub.actionSeq) || 0) | 0,
        };
        const sentRoomId = roomId;
        intents?.send(payload, {
          onFail: () => {
            if (screen !== 'table' || roomId !== sentRoomId) return;
            toast('沒送到，再按一次');
            paintTableChrome();
          },
        });
        if (isHost) hostLoop?.hostAction({ type, seat: mySeat, mode: 'both' });
      };
      $('#mpShow')?.addEventListener('click', () => sendReveal('SHOW'));
      $('#mpMuck')?.addEventListener('click', () => sendReveal('MUCK'));
    } else {
      btns.innerHTML = `<div class="mp-spec">等待其他人選擇亮牌…</div>`;
    }
    return;
  }

  if (
    between &&
    isHost &&
    seatedCount >= 2 &&
    (pub.phase === 'lobby' || !pub.handNo)
  ) {
    btns.innerHTML = `<button type="button" class="primary" id="mpStart">開始第一手（${seatedCount}人）</button>
      <button type="button" class="ghost" id="mpLeave">離座</button>`;
    $('#mpStart')?.addEventListener('click', startHandFromButton);
    $('#mpLeave')?.addEventListener('click', () => requestLeave());
    return;
  }

  if (between && isHost && seatedCount >= 2 && pub.phase === 'hand_over') {
    btns.innerHTML = `<button type="button" class="primary" id="mpStart">開始下一手（${seatedCount}人）</button>
      <button type="button" class="ghost" id="mpLeave">離座</button>`;
    $('#mpStart')?.addEventListener('click', startHandFromButton);
    $('#mpLeave')?.addEventListener('click', () => requestLeave());
    return;
  }

  if (between) {
    btns.innerHTML = '<button type="button" class="ghost" id="mpLeave">離座</button>';
    $('#mpLeave')?.addEventListener('click', () => requestLeave());
    return;
  }

  // In hand
  const actor = pub.actor;
  const legal = mySeat === actor;
  const myBet = pub.seats?.[mySeat]?.bet || 0;
  const toCall = Math.max(0, (pub.currentBet || 0) - myBet);
  const canCheck = toCall === 0;
  const minRaise = pub.minRaiseTo || (pub.currentBet || 0) + (room.config.bb || 20);
  const dis = legal ? '' : 'disabled';
  btns.innerHTML = `
    <button type="button" class="fold" id="mpFold" ${dis}>蓋牌</button>
    ${canCheck
      ? `<button type="button" class="call" id="mpCheck" ${dis}>過牌</button>`
      : `<button type="button" class="call" id="mpCall" ${dis}>跟注 ${fmtChips(toCall)}</button>`}
    <button type="button" class="raise" id="mpRaise" ${dis}>加注</button>`;
  const send = (type, amount) => {
    btns.querySelectorAll('button').forEach((b) => {
      b.disabled = true;
      b.classList.add('is-pending');
    });
    const payload = {
      type,
      seat: mySeat,
      handNo: (Number(pub.handNo) || 0) | 0,
      turn: (Number(pub.actionSeq) || 0) | 0,
    };
    if (amount != null) payload.amount = Math.floor(Number(amount));
    const sentRoomId = roomId;
    // Host applies locally; still write intent for audit / takeover handoff
    if (isHost) {
      hostLoop?.hostAction({ type, amount: payload.amount, seat: mySeat });
    }
    intents?.send(payload, {
      onPending: () => {
        if (screen === 'table' && roomId === sentRoomId) toast('送出中…');
      },
      onFail: () => {
        if (screen !== 'table' || roomId !== sentRoomId) return;
        if (!isHost) {
          toast('沒送到，再按一次');
          paintTableChrome();
        }
      },
    });
  };
  $('#mpFold')?.addEventListener('click', () => send('FOLD'));
  $('#mpCheck')?.addEventListener('click', () => send('CHECK'));
  $('#mpCall')?.addEventListener('click', () => send('CALL'));
  $('#mpRaise')?.addEventListener('click', () => {
    if (!legal) return;
    openMpRaise(minRaise, send);
  });
}

function clearMpRaiseHold() {
  if (mpRaiseHoldTimer != null) clearTimeout(mpRaiseHoldTimer);
  if (mpRaiseHoldRepeat != null) clearTimeout(mpRaiseHoldRepeat);
  mpRaiseHoldTimer = null;
  mpRaiseHoldRepeat = null;
}

function clampMpRaise(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Approved #20 raise quick-picks: reuse engine raisePresets.
 * Host prefers live engine; guests (and host fallback) shim from pub —
 * all inputs are already public (phase / currentBet / pot / seat stacks).
 */
function mpRaisePresets(seat, minRaiseTo, maxRaiseTo) {
  const eng = hostLoop?.getEngine?.();
  if (eng && Number.isInteger(seat) && seat >= 0) {
    try {
      const fromEng = raisePresets(eng, seat);
      if (fromEng?.length) return fromEng;
    } catch {
      /* fall through to pub shim */
    }
  }
  const pub = room?.pub || {};
  const bb = room?.config?.bb || pub.config?.bigBlind || 20;
  const seats = (pub.seats || []).map((p, i) =>
    p
      ? {
          seat: p.seat ?? i,
          chips: p.chips || 0,
          bet: p.bet || 0,
          contributed: p.contributed || 0,
          folded: !!p.folded,
          allIn: !!p.allIn,
          sittingOut: !!p.sittingOut,
          hasHole: !!p.hasHole,
        }
      : null,
  );
  const shim = {
    actor: seat,
    phase: pub.phase,
    currentBet: pub.currentBet || 0,
    minRaiseTo: pub.minRaiseTo || minRaiseTo,
    actedBit: 0,
    config: { bigBlind: bb },
    seats,
  };
  // Ensure actor seat exists with stack bounds matching the open panel
  if (seats[seat]) {
    const stack = seats[seat].chips + seats[seat].bet;
    if (stack < maxRaiseTo) seats[seat].chips = Math.max(0, maxRaiseTo - seats[seat].bet);
  }
  return raisePresets(shim, seat);
}

function mpRaiseIsBet() {
  const pub = room?.pub || {};
  return (pub.currentBet || 0) === 0;
}

function syncMpRaiseUi(range) {
  const out = $('#raiseOut');
  if (out) out.textContent = fmtChips(mpRaiseTo);
  if (range) {
    const min = +range.min;
    const max = +range.max;
    const pct = max > min ? ((mpRaiseTo - min) / (max - min)) * 100 : 0;
    range.style.setProperty('--raise-pct', `${clampMpRaise(pct, 0, 100)}%`);
  }
  if (mpRaisePresetId) {
    const safeId =
      typeof CSS !== 'undefined' && CSS.escape
        ? CSS.escape(mpRaisePresetId)
        : mpRaisePresetId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const btn = document.querySelector(`#presets button[data-id="${safeId}"]`);
    if (btn && +btn.dataset.to !== mpRaiseTo) mpRaisePresetId = null;
  }
  for (const b of document.querySelectorAll('#presets button')) {
    b.setAttribute('aria-pressed', String(b.dataset.id === mpRaisePresetId));
  }
  const minus = $('#raiseMinus');
  const plus = $('#raisePlus');
  if (range && minus && plus) {
    minus.disabled = mpRaiseTo <= +range.min;
    plus.disabled = mpRaiseTo >= +range.max;
  }
  const copy = raisePanelCopy(mpRaiseIsBet(), mpRaiseTo);
  const verbEl = $('#raiseVerb');
  if (verbEl) verbEl.textContent = copy.verb;
  const title = $('#raiseTitle');
  if (title) title.setAttribute('aria-label', copy.title);
  const panel = $('#raisePanel');
  if (panel) panel.setAttribute('aria-label', copy.verb);
  const conf = $('#raiseConfirm');
  if (conf) conf.textContent = copy.confirm;
}

function mpRaiseBounds() {
  const range = $('#raiseRange');
  const bb = room?.config?.bb || room?.pub?.config?.bigBlind || 20;
  return { lo: +(range?.min || 0), hi: +(range?.max || 0), bb };
}

/** Step raise-to by ±1 BB; press-and-hold auto-repeats (same as solo #20). */
function bindMpRaiseStep(btn, dir) {
  if (!btn || btn.dataset.mpBound === '1') return;
  btn.dataset.mpBound = '1';
  btn.onclick = null;
  const stepOnce = () => {
    const range = $('#raiseRange');
    if (!range || !raiseOpen) return;
    const { lo, hi, bb } = mpRaiseBounds();
    mpRaiseTo = clampMpRaise(mpRaiseTo + dir * bb, lo, hi);
    range.value = String(mpRaiseTo);
    syncMpRaiseUi(range);
  };
  const onDown = (e) => {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    clearMpRaiseHold();
    try {
      btn.setPointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    stepOnce();
    let interval = 140;
    mpRaiseHoldTimer = setTimeout(function tick() {
      stepOnce();
      interval = Math.max(36, Math.floor(interval * 0.82));
      mpRaiseHoldRepeat = setTimeout(tick, interval);
    }, 400);
  };
  const onUp = () => clearMpRaiseHold();
  btn.addEventListener('pointerdown', onDown);
  btn.addEventListener('pointerup', onUp);
  btn.addEventListener('pointercancel', onUp);
  btn.addEventListener('lostpointercapture', onUp);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}

/** Close MP raise immediately when the turn leaves this seat (stale confirm). */
function lockMpRaisePanel() {
  if (!raiseOpen) return;
  clearMpRaiseHold();
  mpRaisePresetId = null;
  raiseOpen = false;
  const panel = $('#raisePanel');
  const scrim = $('#raiseScrim');
  if (panel) {
    panel.classList.remove('is-on');
    panel.hidden = true;
    panel.inert = true;
    panel.setAttribute('aria-hidden', 'true');
  }
  if (scrim) {
    scrim.classList.remove('is-on');
    scrim.hidden = true;
    scrim.inert = true;
  }
}

function openMpRaise(minRaiseTo, send) {
  // Betting core restored from e44c13f openMpRaise (known-good on preview):
  // unlock panel FIRST, confirm reads range.value. UI (presets / hold / wording)
  // is layered on top — see 56b2833 which moved unlock after fallible work.
  const panel = $('#raisePanel');
  const scrim = $('#raiseScrim');
  const range = $('#raiseRange');
  if (!panel || !range || !room) {
    send('BET_RAISE', minRaiseTo);
    return;
  }

  // --- e44c13f unlock order (must run before presets/engine work) ---
  panel.hidden = false;
  panel.inert = false;
  panel.removeAttribute('aria-hidden');
  if (scrim) {
    scrim.hidden = false;
    scrim.inert = false;
  }
  raiseOpen = true;
  requestAnimationFrame(() => {
    panel.classList.add('is-on');
    scrim?.classList.add('is-on');
  });

  const mySeat = room.seatUids.indexOf(getUser()?.uid);
  const pub = room.pub || {};
  const ps = pub.seats?.[mySeat];
  const maxTo = (ps?.chips || 0) + (ps?.bet || 0);
  const lo = Math.min(minRaiseTo, maxTo);
  const hi = Math.max(lo, maxTo);

  let presets = [];
  try {
    presets = mpRaisePresets(mySeat, lo, hi) || [];
  } catch {
    presets = [];
  }
  const preferred = presets.find((p) => p.preferred);
  mpRaiseTo = clampMpRaise(preferred?.to ?? lo, lo, hi);
  mpRaisePresetId = preferred?.id ?? null;

  range.min = String(lo);
  range.max = String(hi);
  range.step = '1';
  range.value = String(mpRaiseTo);
  range.oninput = () => {
    mpRaiseTo = +range.value;
    syncMpRaiseUi(range);
  };

  const presetsEl = $('#presets');
  if (presetsEl) {
    presetsEl.innerHTML = raisePresetsMarkup(presets, mpRaisePresetId);
    presetsEl.onclick = (e) => {
      const b = e.target.closest('button[data-to]');
      if (!b) return;
      mpRaisePresetId = b.dataset.id || null;
      mpRaiseTo = clampMpRaise(+b.dataset.to, lo, hi);
      range.value = String(mpRaiseTo);
      syncMpRaiseUi(range);
    };
  }

  bindMpRaiseStep($('#raiseMinus'), -1);
  bindMpRaiseStep($('#raisePlus'), 1);

  const callAmt = Math.max(0, (pub.currentBet || 0) - (ps?.bet || 0));
  const hint = $('#raiseHint');
  if (hint) {
    const minHint = raisePanelCopy(mpRaiseIsBet(), lo).minHint;
    hint.textContent =
      callAmt <= 0
        ? minHint
        : `跟注 ${fmtChips(callAmt)} · ${minHint}`;
  }
  try {
    syncMpRaiseUi(range);
  } catch {
    /* keep panel usable even if chrome sync fails */
  }

  const close = () => {
    clearMpRaiseHold();
    mpRaisePresetId = null;
    panel.classList.remove('is-on');
    scrim?.classList.remove('is-on');
    panel.hidden = true;
    panel.inert = true;
    panel.setAttribute('aria-hidden', 'true');
    if (scrim) {
      scrim.hidden = true;
      scrim.inert = true;
    }
    raiseOpen = false;
  };
  if (scrim) {
    scrim.onclick = () => {
      close();
      paintTableChrome();
    };
  }
  $('#raiseCancel').onclick = () => {
    close();
    paintTableChrome();
  };
  // e44c13f: amount from the live range, not a stale mirror variable
  $('#raiseConfirm').onclick = () => {
    const amt = Number(range.value);
    mpRaiseTo = amt;
    close();
    send('BET_RAISE', amt);
  };
}

function pickBuyinAmount(options) {
  const el = document.createElement('div');
  el.id = 'mpBuyinPicker';
  el.className = 'mp-close-result';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'mpBuyinTitle');
  el.innerHTML = `<div class="mp-close-result-card">
    <h2 id="mpBuyinTitle">攜入籌碼</h2>
    <input aria-label="攜入籌碼" type="number" inputmode="numeric" min="${options.min}" max="${options.max}" step="${options.step}" value="${options.amount}">
    <input aria-label="調整攜入籌碼" type="range" min="${options.min}" max="${options.max}" step="${options.step}" value="${options.amount}">
    <button type="button" class="mp-btn-ghost" data-cancel>取消</button>
    <button type="button" class="mp-btn-primary" data-confirm>入座</button>
  </div>`;
  document.body.appendChild(el);
  const number = el.querySelector('input[type="number"]');
  const slider = el.querySelector('input[type="range"]');
  number.addEventListener('input', () => { slider.value = number.value; });
  slider.addEventListener('input', () => { number.value = slider.value; });
  return new Promise(resolve => {
    el.querySelector('[data-cancel]').addEventListener('click', () => { el.remove(); resolve(null); });
    el.querySelector('[data-confirm]').addEventListener('click', () => {
      const amount = Number(number.value);
      if (!Number.isSafeInteger(amount) || amount < options.min || amount > options.max ||
          (amount - options.min) % options.step !== 0) {
        number.reportValidity();
        return;
      }
      toast('入座中…');
      el.remove();
      resolve(amount);
    });
  });
}

async function sitDown(seat) {
  const fb = getFirebase();
  const user = getUser();
  if (!fb || !user || !room || sittingBusy) return;
  if (room.seatUids[seat]) {
    toast('這個座位剛被佔走了，請選其他空位');
    return;
  }
  if (room.seatUids.includes(user.uid)) {
    toast('你已入座，要換位請先離座');
    return;
  }
  try {
    assertMinimumBuyin(wholeBalance(playerDoc, roomId), room.config.bb);
  } catch (e) {
    toast(e.message);
    return;
  }
  sittingBusy = true;
  try {
    const targetRoomId = roomId;
    const amount = playerDoc?.tableRoomId === roomId ? playerDoc.inPlay
      : await pickBuyinAmount(buyinOptions(playerDoc, room.config));
    if (amount == null || !room || roomId !== targetRoomId) return;
    toast('入座中…');
    if (room.hostUid !== user.uid) {
      try {
        const hp = await fb.fs.getDoc(
          fb.fs.doc(fb.db, 'pokerRooms', roomId, 'presence', room.hostUid),
        );
        const hostBeatMs = hp.exists() ? hp.data()?.beat?.toMillis?.() ?? 0 : 0;
        const updatedAtMs = room.updatedAt?.toMillis?.() || 0;
        const age = Date.now() - (hostAliveMs(hostBeatMs, updatedAtMs) ?? 0);
        if (age > 30_000) {
          const minutes = Math.max(1, Math.ceil((30 * 60_000 - age) / 60_000));
          toast(`房主已離線，暫時無法入座；牌桌約 ${minutes} 分鐘後會自動關閉，之後就能開新牌桌`);
          return;
        }
      } catch {
        // Presence read failures retain the existing sit flow.
      }
    }
    if (playerDoc?.tableRoomId !== roomId) {
      await buyinAmount(fb, user.uid, roomId, room.config.bb, amount);
      playerDoc = await getPlayer(fb, user.uid);
    }
    if (!intents) throw new Error('連線準備中，請再點一次空位');
    const pub = room.pub || {};
    await intents.send({
      type: 'SIT',
      seat,
      handNo: (Number(pub.handNo) || 0) | 0,
      turn: (Number(pub.actionSeq) || 0) | 0,
    });
    if (room.hostUid === user.uid) {
      await hostLoop?.seatPlayer(seat, user.uid);
    }
  } catch (e) {
    toast(friendlyError(e, '入座失敗，請再點一次空位'));
  } finally {
    sittingBusy = false;
  }
}

async function requestLeave() {
  const user = getUser();
  if (!room || !user || leaveBusy) return;
  const pub = room.pub || {};
  const mySeat = room.seatUids.indexOf(user.uid);
  if (mySeat < 0) return;
  if (room.hostUid === user.uid) {
    const others = room.seatUids.filter((u) => u && u !== user.uid);
    if (!others.length) {
      // M2 #12: 「收桌」／「先不要」
      showHostAloneLeaveDialog();
      return;
    }
  }
  leaveBusy = true;
  try {
    await intents?.send({
      type: 'LEAVE',
      seat: mySeat,
      handNo: (Number(pub.handNo) || 0) | 0,
      turn: (Number(pub.actionSeq) || 0) | 0,
    });
    if (room.hostUid === user.uid) {
      // Host processes on HAND_OVER via host loop; if between hands, cash out now
      if (pub.phase === 'lobby' || pub.phase === 'hand_over') {
        const order = room.seatUids.filter((u) => u && u !== user.uid);
        await hostLoop?.cashoutSeat(mySeat, user.uid, { handOffTo: order[0] });
      }
    }
  } catch (e) {
    toast(friendlyError(e, '沒有送出去，可能是網路斷了。請再按一次'));
  } finally {
    leaveBusy = false;
  }
}

function renderBanner() {
  const el = $('#mpBanner');
  if (!el) return;
  el.classList.toggle('mp-banner--hd', !!room && (hostPaused || hostReturned));
  if (!room) return;
  if (hostPaused || hostReturned) { el.hidden = false; el.textContent = hostPaused ? DISCONNECT_COPY.paused : DISCONNECT_COPY.returned; return; }
  const user = getUser();
  const isHost = room.hostUid === user?.uid;
  const mySeat = user ? room.seatUids.indexOf(user.uid) : -1;
  const stop =
    !!room.pub?.quotaStop ||
    (isHost && hostMustStopNewHand(true));
  const warn = !stop && hostShouldWarn(isHost);
  if (stop) {
    // M2 #10 / §2 @ 8,000: exits — 收桌／離座／回大廳
    el.hidden = false;
    const msg = `今天的免費用量快用完了，這手打完先停。台北時間 ${resetTimeTaipeiLabel()} 後可以再開`;
    const actions = isHost
      ? `<button type="button" class="mp-banner-act" id="mpQuotaClose">收桌</button>`
      : `${mySeat >= 0 ? '<button type="button" class="mp-banner-act" id="mpQuotaLeave">離座</button>' : ''}<button type="button" class="mp-banner-act" id="mpQuotaLobby">回大廳</button>`;
    el.innerHTML = `<span class="mp-banner-msg">${esc(msg)}</span><span class="mp-banner-acts">${actions}</span>`;
    $('#mpQuotaClose', el)?.addEventListener('click', () => mpCloseRoom());
    $('#mpQuotaLeave', el)?.addEventListener('click', () => requestLeave());
    $('#mpQuotaLobby', el)?.addEventListener('click', () => showLeaveTableConfirm());
    return;
  }
  if (warn) {
    el.hidden = false;
    el.textContent = `今天的免費用量快用完了。台北時間 ${resetTimeTaipeiLabel()} 後重置；快到 8,000 時會停開新手牌。`;
    return;
  }
  if (room.pub?.voided) {
    el.hidden = false;
    el.textContent = '這一手作廢，即將重新開局';
    return;
  }
  el.hidden = true;
  el.textContent = '';
}

function renderSidePanels(pub, mySeat) {
  const info = $('#sideInfo');
  if (info && room) {
    const seated = room.seatUids.filter(Boolean).length;
    const hostName = nameOrStub(room.hostUid) || '—';
    info.innerHTML = `<h2>牌局資訊</h2><dl>
      <dt>盲注</dt><dd>${room.config.sb}／${room.config.bb}</dd>
      <dt>手數</dt><dd>第 ${pub.handNo || 0} 手</dd>
      <dt>在座</dt><dd>${seated} 人</dd>
      <dt>房主</dt><dd>${esc(hostName)}</dd>
      <dt>階段</dt><dd>${esc(phaseZh(pub.phase))}</dd>
    </dl>`;
  }
  const log = $('#sideLog');
  if (log) {
    const items = (pub.log || [])
      .map((x) =>
        x.kind === 'street'
          ? `<li class="street">${esc(x.text)}</li>`
          : `<li>${esc(x.text || '')}</li>`,
      )
      .join('');
    log.innerHTML = `<h2>這一手</h2><ol>${items || '<li class="street">尚未開始</li>'}</ol>`;
  }
  void mySeat;
}

function phaseZh(phase) {
  const m = {
    lobby: '大廳',
    preflop: '翻前',
    flop: '翻牌',
    turn: '轉牌',
    river: '河牌',
    showdown: '攤牌',
    hand_over: '手結束',
  };
  return m[phase] || phase || '—';
}

async function doRescue() {
  const fb = getFirebase();
  const user = getUser();
  if (!fb || !user || !playerDoc?.tableRoomId || rescueBusy) return;
  rescueBusy = true;
  try {
    const id = playerDoc.tableRoomId;
    const snap = await fb.fs.getDoc(fb.fs.doc(fb.db, 'pokerRooms', id));
    if (!snap.exists()) throw new Error('這桌已經結束了，回大廳看看其他牌桌');
    await selfRescueCashout(fb, user.uid, { id, ...snap.data() });
    playerDoc = await getPlayer(fb, user.uid);
    toast('已結帳回帳戶');
    paint();
  } catch (e) {
    // M2 #8: keep card; plain retry copy
    toast('結帳沒成功，籌碼還在桌上不會不見。請再按一次');
    const card = document.querySelector('.mp-my[data-act="rescue"]');
    if (card) {
      card.removeAttribute('aria-busy');
      const act = card.querySelector('.mp-act');
      if (act) act.textContent = '結帳離開（請再按一次）';
    }
  } finally {
    rescueBusy = false;
  }
}

async function openStats() {
  screen = 'stats';
  paint();
  await loadStats();
  if (screen === 'stats') paint();
}

async function loadStats() {
  const fb = getFirebase();
  if (!fb) {
    statsRows = [];
    return;
  }
  try {
    if (statsMode === 'total') statsRows = await fetchLeaderboard(fb, 50);
    else statsRows = await fetchNightBoard(fb, statsNight, 50);
  } catch {
    statsRows = [];
  }
}

function clearSoloInert() {
  document.querySelectorAll('.screen, #lobbyScreen').forEach((el) => {
    el.inert = false;
    el.removeAttribute('aria-hidden');
  });
}

function silenceSoloScreens() {
  document.querySelectorAll('.screen, #lobbyScreen').forEach((el) => {
    el.inert = true;
    el.setAttribute('aria-hidden', 'true');
    el.classList.remove('is-on');
    el.classList.add('hidden');
  });
  // Raise panel lives outside #app — keep closed panels out of tab order.
  // Never clobber an in-flight open (is-on / raiseOpen): that re-inert's the
  // panel and makes 確認下注 clicks fall through to the scrim.
  const raise = $('#raisePanel');
  const scrim = $('#raiseScrim');
  if (raise && !raise.classList.contains('is-on') && !raiseOpen) {
    raise.inert = true;
    raise.setAttribute('aria-hidden', 'true');
    raise.hidden = true;
  }
  if (scrim && !scrim.classList.contains('is-on') && !raiseOpen) {
    scrim.inert = true;
    scrim.hidden = true;
  }
}

function openSolo() {
  tearDownRoom();
  const back = $('#btnBackLobby');
  if (back) back.hidden = true;
  const root = $('#mpRoot');
  if (root) root.hidden = true;
  clearSoloInert();
  // MP paint() hides #app; solo table lives inside #app — must show it again
  const app = $('#app');
  if (app) app.classList.remove('hidden');
  const lobby = $('#lobbyScreen');
  if (lobby) {
    lobby.classList.remove('hidden');
    lobby.inert = false;
    lobby.removeAttribute('aria-hidden');
  }
  openSoloFn({ fromMp: true });
}

/**
 * Land on lobby after a full exit (or when already unbound).
 * Soft-detach removed (owner 2026-11): ‹ 大廳 confirms leave/close instead.
 */
function goLobbyClean() {
  autoResumeTried = true;
  tearDownRoom();
  hideCloseResultCard();
  const leaveDlg = document.getElementById('mpLeaveConfirm');
  if (leaveDlg) leaveDlg.hidden = true;
  screen = 'lobby';
  const back = $('#btnBackLobby');
  if (back) back.hidden = true;
  paint();
}

/** @deprecated name kept for stats/exports — hard lobby only (no soft-detach). */
function leaveToLobby() {
  goLobbyClean();
}

function showSettlementNotice(id, message, done = false) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    el.className = 'mp-close-result';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    document.body.appendChild(el);
  }
  el.replaceChildren();
  const card = document.createElement('div');
  card.className = 'mp-close-result-card';
  const title = document.createElement('h2');
  // Break only at a full-width comma so a lone char never wraps alone (same words; textContent unchanged).
  const parts = String(message).split(/(?<=，)/);
  if (parts.length > 1) {
    for (const part of parts) {
      const span = document.createElement('span');
      span.style.display = 'inline-block';
      span.textContent = part;
      title.appendChild(span);
    }
  } else title.textContent = message;
  card.appendChild(title);
  if (done) {
    const button = document.createElement('button');
    button.className = 'mp-btn-primary';
    button.textContent = '知道了';
    button.addEventListener('click', () => el.remove());
    card.appendChild(button);
  }
  el.appendChild(card);
  el.hidden = false;
}

let stopLeaveSettlement = null;

/** Watch deferred host cashout after a mid-hand guest exit, for at most 3 minutes. */
function watchLeaveSettlement(fb, uid, leavingRoomId, hostWasPaused = false) {
  stopLeaveSettlement?.();
  const bankBefore = Number(playerDoc?.bank) || 0;
  const sessionNo = playerDoc?.sessionNo;
  showSettlementNotice('mpLeaveSettle', hostWasPaused ? '結算中…籌碼最晚 1 分鐘內回到帳戶' : '結算中…這手已蓋牌，打完會把剩下的籌碼結帳');
  let stopped = false;
  let timer;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(expiry);
    if (stopLeaveSettlement === stop) stopLeaveSettlement = null;
  };
  const expiry = setTimeout(stop, 3 * 60 * 1000);
  stopLeaveSettlement = stop;
  async function check() {
    if (stopped) return;
    if (getUser()?.uid !== uid) return stop();
    try {
      const player = await getPlayer(fb, uid);
      if (stopped || getUser()?.uid !== uid) return stop();
      if (player?.tableRoomId && player.tableRoomId !== leavingRoomId) return stop();
      let settled = !!player && !player.tableRoomId;
      if (!settled) {
        const snap = await fb.fs.getDoc(fb.fs.doc(fb.db, 'pokerRooms', leavingRoomId));
        if (stopped || getUser()?.uid !== uid) return stop();
        if (!snap.exists() || snap.data()?.status === 'closed') {
          await silentlySettleClosedBinding();
          settled = true;
        }
      }
      if (settled) {
        const refreshed = await getPlayer(fb, uid);
        if (stopped || getUser()?.uid !== uid) return stop();
        if (!refreshed || refreshed.tableRoomId) {
          if (!stopped) timer = setTimeout(check, 2000);
          return;
        }
        let amount = (Number(refreshed.bank) || 0) - bankBefore;
        if (sessionNo != null) {
          const ledger = await fb.fs.getDoc(fb.fs.doc(fb.db, 'pokerPlayers', uid,
            'ledger', `${leavingRoomId}_${sessionNo}_cashout`));
          if (ledger.exists()) amount = Number(ledger.data().amount);
        }
        if (stopped || getUser()?.uid !== uid) return stop();
        showSettlementNotice('mpLeaveSettle', `已結算，你帶回 ${amount.toLocaleString('en-US')} 籌碼`, true);
        playerDoc = refreshed || playerDoc;
        stop();
        if (screen === 'lobby') paint();
        return;
      }
    } catch {
      /* Retry transient read failures within the bounded window. */
    }
    if (!stopped) timer = setTimeout(check, 2000);
  }
  timer = setTimeout(check, 2000);
}

/**
 * Confirmed ‹ 大廳: host closes table; guest leaves, with cashout between hands.
 * Then clean lobby — no 我的牌桌 card.
 */
async function confirmLeaveTable() {
  const fb = getFirebase();
  const uid = getUser()?.uid;
  if (!fb || !room || !uid) {
    goLobbyClean();
    return;
  }
  lobbyExitSuppressMine = true;
  autoResumeTried = true;
  const isHost = room.hostUid === uid;
  try {
    if (isHost) {
      // Mid-hand: 結算中 → result card. Between hands: unchanged (clean lobby).
      const hostMidHand = isHandInProgress();
      // performHostCloseRoom starts synchronously inside this click handler.
      const pending = startHostClose({ showResultCard: hostMidHand });
      if (!hostMidHand) void dismissCloseResultToLobby();
      await pending;
      return;
    }
    // Spectator: just leave the room shell
    const mySeat = room.seatUids.indexOf(uid);
    if (mySeat < 0) {
      goLobbyClean();
      return;
    }
    // Same path as 離座: LEAVE intent (mid-hand folds first; host cashout between hands)
    const midHand = isHandInProgress();
    const leavingRoomId = roomId;
    const hostWasPaused = hostPaused;
    await requestLeave();
    if (midHand) {
      goLobbyClean();
      watchLeaveSettlement(fb, uid, leavingRoomId, hostWasPaused);
      return;
    }
    // Wait until chips settled / bind cleared (host processes LEAVE)
    for (let i = 0; i < 80; i++) {
      try {
        playerDoc = (await getPlayer(fb, uid)) || playerDoc;
      } catch {
        /* keep */
      }
      if (!playerDoc?.tableRoomId) break;
      const stillSeated = Array.isArray(room?.seatUids) && room.seatUids.includes(uid);
      if (!stillSeated && !playerDoc?.tableRoomId) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    // Defensive settle if room closed while leaving
    if (playerDoc?.tableRoomId) {
      try {
        await silentlySettleClosedBinding();
        playerDoc = (await getPlayer(fb, uid)) || playerDoc;
      } catch {
        /* keep */
      }
    }
    goLobbyClean();
  } catch (e) {
    if (isHost) return; // startHostClose already rendered the retry card.
    lobbyExitSuppressMine = false;
    toast(friendlyError(e, '沒有送出去，可能是網路斷了。請再按一次'));
  }
}

function tearDownRoom() {
  lastKnownSelfTableChipsRoomId = null;
  lastKnownSelfSessionNo = null;
  stopHostBeat?.(); stopHostBeat = null; hostBeatUid = null; hostBeatMs = null; hostRoomUpdatedMs = null; hostPaused = false; hostReturned = false; clearTimeout(hostReturnedTimer);
  hostReturnedTimer = null;
  const banner = $('#mpBanner');
  banner?.classList.remove('mp-banner--hd');
  if (banner && (banner.textContent === DISCONNECT_COPY.paused || banner.textContent === DISCONNECT_COPY.returned)) {
    banner.hidden = true;
    banner.textContent = '';
  }
  stopTurnClock();
  stopSoundVisibility?.();
  stopSoundVisibility = null;
  resetRoomSound();
  closingFreeze = false;
  clearTimeout(enterRoomTimeout);
  confirmedLobbyRoom = null;
  hostSitPending = false;
  stopRoom?.();
  stopRoom = null;
  stopHole?.();
  stopHole = null;
  presence?.stop();
  presence = null;
  hostLoop?.stop();
  hostLoop = null;
  intents?.clearResend();
  intents = null;
  animQ?.clear();
  animQ = null;
  room = null;
  roomId = null;
  prevPub = null;
  myHole = null;
  membersPanelOpen = false;
  clearMpRaiseHold();
  raiseOpen = false;
  document.getElementById('mpBuyinPicker')?.querySelector('[data-cancel]')?.click();
  hideCloseResultCard();
  const alone = document.getElementById('mpHostAlone');
  if (alone) alone.hidden = true;
  removeMpMenuExtras();
}

function ensureMpMenu() {
  const pop = $('#menuPop');
  if (!pop || pop.dataset.mpMenu === '1') return;
  pop.dataset.mpMenu = '1';
  const mute = $('#btnMute');
  if (mute) {
    const paintSoundToggle = () => {
      mute.textContent = isSoundOn() ? '音效：開' : '音效：關';
      mute.setAttribute('aria-pressed', String(isSoundOn()));
    };
    paintSoundToggle();
    mute.onclick = () => {
      if (screen !== 'table' || !roomId) return;
      setSoundOn(!isSoundOn());
      paintSoundToggle();
    };
  }
  // Hide solo-only / duplicate exits in MP (PL: ‹ 大廳 + 收桌 cover 大廳／結束牌局)
  // 計時／暫停沿用既有行為；保留全螢幕及音效入口
  $('#btnTimerCfg')?.classList.add('hidden');
  $('#btnPauseMenu')?.classList.add('hidden');
  $('#btnLobby')?.classList.add('hidden');
  $('#btnEndMenu')?.classList.add('hidden');

  const extras = document.createElement('div');
  extras.id = 'mpMenuExtras';
  extras.innerHTML = `
    <button type="button" id="mpBtnMembers" role="menuitem">成員</button>
    <button type="button" id="mpBtnCloseRoom" role="menuitem">收桌</button>
    <div id="mpMembersPanel" class="mp-members hidden" hidden></div>`;
  pop.appendChild(extras);

  // M2: fixed top 「‹ 大廳」→ confirm leave/close (no soft-detach)
  if (!$('#btnBackLobby')?.dataset.mpWired) {
    const back = $('#btnBackLobby');
    if (back) {
      back.dataset.mpWired = '1';
      back.addEventListener('click', () => {
        if (!room) {
          goLobbyClean();
          return;
        }
        closeMpMenu();
        showLeaveTableConfirm();
      });
    }
  }
  $('#mpBtnCloseRoom')?.addEventListener('click', () => {
    closeMpMenu();
    if (room?.hostUid !== getUser()?.uid) {
      toast('只有房主可以收桌');
      return;
    }
    mpCloseRoom();
  });
  $('#mpBtnMembers')?.addEventListener('click', () => {
    membersPanelOpen = !membersPanelOpen;
    renderMembersPanel();
  });
}

function removeMpMenuExtras() {
  $('#mpMenuExtras')?.remove();
  const mute = $('#btnMute');
  if (mute) mute.onclick = null;
  const pop = $('#menuPop');
  if (pop) delete pop.dataset.mpMenu;
  $('#btnTimerCfg')?.classList.remove('hidden');
  $('#btnLobby')?.classList.remove('hidden');
  $('#btnEndMenu')?.classList.remove('hidden');
}

function closeMpMenu() {
  $('#menuPop')?.classList.add('hidden');
  $('#btnMenu')?.setAttribute('aria-expanded', 'false');
}

function renderMembersPanel() {
  const panel = $('#mpMembersPanel');
  if (!panel || !room) return;
  if (!membersPanelOpen) {
    panel.hidden = true;
    panel.classList.add('hidden');
    return;
  }
  panel.hidden = false;
  panel.classList.remove('hidden');
  const rows = (room.members || []).map((uid) => {
    const seat = room.seatUids.indexOf(uid);
    const role =
      uid === room.hostUid ? '房主' : seat >= 0 ? `座位 ${seat + 1}` : '尚未入座';
    return `<li><b>${esc(displayNameOf(uid))}</b><span>${role}</span></li>`;
  });
  panel.innerHTML = `<h3>成員（${rows.length}）</h3><ul>${rows.join('')}</ul>`;
}

function dismissToast(text) {
  const el = $('#mpToast');
  if (!el || el.textContent !== text) return;
  clearTimeout(toastTimer);
  toastTimer = 0;
  el.hidden = true;
}

function toast(msg) {
  const el = $('#mpToast');
  if (!el) return;
  el.hidden = false;
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, mpDuration('toastMs') || 3000);
}

/** Expose for menu hooks */
export function mpLeaveToLobby() {
  showLeaveTableConfirm();
}

/**
 * Host 收桌 core (cashout all → closeRoom → settle). Shared by menu 收桌 and ‹ 大廳.
 * @param {{ showResultCard?: boolean }} opt showResultCard=false → caller goes clean lobby
 * @returns {Promise<number>} chips returned for this host
 */
async function performHostCloseRoom(opts = {}) {
  closingFreeze = true;
  const closingLoop = hostLoop;
  try {
    return await performHostCloseRoomInner(opts);
  } finally {
    closingLoop?.stop();
  }
}

function startHostClose(opts = {}) {
  if (closeInFlight) return closeInFlight;
  closeResultDismissedFor = null;
  showCloseResultCard({ state: 'pending' });
  closeInFlight = performHostCloseRoom(opts);
  const pending = closeInFlight;
  void pending.then((chips) => {
    closeInFlight = null;
    if (opts.showResultCard !== false) showCloseResultCard({ chips, auto: !!opts.auto });
    else if (screen === 'lobby') goLobbyClean();
  }, () => {
    closeInFlight = null;
    closingFreeze = false;
    pendingCloseReturnChips = null;
    closeResultDismissedFor = null;
    showCloseResultCard({ state: 'failed', retry: () => startHostClose(opts) });
    const btn = document.getElementById('mpBtnCloseRoom');
    if (btn) {
      btn.disabled = false;
      btn.textContent = '收桌';
    }
  });
  return pending;
}

async function performHostCloseRoomInner(opts = {}) {
  const { showResultCard = true } = opts;
  const fb = getFirebase();
  const uid = getUser()?.uid;
  if (!fb || !room || !uid) return 0;
  const closingLoop = hostLoop;
  const id = room.id;
  const mySeat = room.seatUids?.indexOf(uid) ?? -1;
  let chips = opts.returnedChips ?? (
    mySeat >= 0
      ? Number(room.stacks?.[mySeat]) || 0
      : playerDoc?.tableRoomId === id
        ? Number(playerDoc?.inPlay) || 0
        : 0);
  pendingCloseReturnChips = chips;
  if (room.hostUid === uid && closingLoop?.cashoutSeat) {
    const payoutRoom = await closingLoop.prepareClose();
    const ownSeat = payoutRoom.seatUids.indexOf(uid);
    if (ownSeat >= 0) {
      chips = Number(payoutRoom.stacks[ownSeat]) || 0;
      opts.returnedChips = chips;
    }
    let closedRoom = null;
    try {
      closedRoom = await closingLoop.closeAll(payoutRoom);
    } catch (e) {
      if (e?.code !== 'permission-denied') throw e;
      console.warn('[host] closeAll permission-denied; fallback to per-seat cashout', e);
      for (let i = 0; i < payoutRoom.seatUids.length; i++) {
        const u = payoutRoom.seatUids[i];
        if (!u) continue;
        if (!await closingLoop.cashoutSeat(i, u, { room: payoutRoom })) {
          throw new Error('結算尚未同步，請重試收桌');
        }
      }
    }
    await closeRoom(fb, id, closedRoom ? { closedRoom } : {});
  } else {
    await closeRoom(fb, id);
  }
  pendingCloseReturnChips = chips;
  clearLastRoom();
  try {
    playerDoc = (await getPlayer(fb, uid)) || playerDoc;
  } catch {
    /* keep */
  }
  if (playerDoc?.tableRoomId === id) {
    const settled = await silentlySettleClosedBinding();
    if (settled > 0) chips = settled;
  } else {
    await silentlySettleClosedBinding();
  }
  if (showResultCard && closeResultDismissedFor !== id) {
    showCloseResultCard({ chips, auto: !!opts.auto });
  } else if (!showResultCard) {
    closeResultDismissedFor = id;
  }
  pendingCloseReturnChips = null;
  return chips;
}

/** Styled confirm for 收桌 (same component as 「是否離開牌局？」); replaces the browser-native dialog. */
function showCloseRoomConfirm(onOk) {
  let el = document.getElementById('mpCloseConfirm');
  if (!el) {
    el = document.createElement('div');
    el.id = 'mpCloseConfirm';
    el.className = 'mp-close-result';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'mpCloseConfirmT');
    document.body.appendChild(el);
  }
  el.innerHTML = `
    <div class="mp-close-result-card">
      <h2 id="mpCloseConfirmT">${isHandInProgress()
        ? '確定收桌？這一手會作廢，已下注的籌碼退回，所有人照桌上籌碼結帳回帳戶。'
        : '確定收桌？玩家將結帳回帳戶。'}</h2>
      <button type="button" class="mp-btn-primary" id="mpCloseConfirmOk">確認收桌</button>
      <button type="button" class="mp-btn-ghost" id="mpCloseConfirmCancel">取消</button>
    </div>`;
  el.hidden = false;
  $('#mpCloseConfirmCancel', el)?.addEventListener('click', () => {
    el.hidden = true;
  });
  $('#mpCloseConfirmOk', el)?.addEventListener('click', () => {
    el.hidden = true;
    onOk();
  });
}

export function mpCloseRoom() {
  const fb = getFirebase();
  if (!fb || !room) return;
  showCloseRoomConfirm(() => doCloseRoom());
}

function doCloseRoom() {
  const fb = getFirebase();
  if (!fb || !room) return;
  closingFreeze = true;
  const btn = document.getElementById('mpBtnCloseRoom');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '收桌中…';
  }
  void startHostClose({ showResultCard: true });
}
