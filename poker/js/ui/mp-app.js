/**
 * Milestone-2 shell: auth → lobby → create/join → table (§2 / §13).
 * Solo hot-seat remains available via openSolo().
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
  createRoom,
  joinByCode,
  joinByRoomId,
  listenRoom,
  listenOpenTables,
  getLastRoom,
  rememberLastRoom,
  clearLastRoom,
  shareUrl,
  formatCode,
  extendCode,
  closeRoom,
  maybeAutoCloseIdleRoom,
  isRoomOpenStatus,
  noteLobbyRoomClosed,
  deleteLobbyListing,
} from '../net/room.js';
import {
  ensurePlayerGrant,
  buyinAll,
  getPlayer,
  fetchLeaderboard,
  fetchNightBoard,
  selfRescueCashout,
  settleClosedRoomBinding,
  nightKeyOf,
  readCachedPlayer,
} from '../net/ledger.js';
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
  renderCreateRoom,
  renderShareRoom,
  renderJoinCode,
  patchOpenTables,
  showLobbyNotify,
  hideLobbyNotify,
  flashMyTableAttn,
  ensureLobbyNotify,
} from './lobby.js';
import { renderStats } from './stats.js';
import { MP_FX, mpDuration } from './fx-mp.js';
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
/** @type {ReturnType<typeof startPresence>|null} */
let presence = null;
/** @type {ReturnType<typeof createIntentSender>|null} */
let intents = null;
/** @type {(() => void)|null} */
let stopHole = null;
let lastRecvAt = Date.now();
/** @type {object|null} */
let prevPub = null;
let joinDigits = '';
let shareInfo = null;
let createError = '';
let creating = false;
let joining = false;
let joinError = '';
let joinEnded = false;
/** Persist create-form draft across re-renders (UI/UX #11). */
let createDraft = { name: '', sb: 10, chips: 2000 };
let sittingBusy = false;
let openJoinBusy = false;
let rescueBusy = false;
let approveBusy = false;
let denyBusy = false;
let leaveBusy = false;
/** Local tick for M2 #13「再申請一次」countdown. */
let topUpDenyTick = null;

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
async function silentlySettleClosedBinding() {
  const fb = getFirebase();
  const uid = getUser()?.uid;
  if (!fb || !uid) return 0;
  try {
    playerDoc = await getPlayer(fb, uid);
  } catch {
    /* keep stale */
  }
  const tid = playerDoc?.tableRoomId;
  let credited = 0;
  if (tid) {
    try {
      const snap = await fb.fs.getDoc(fb.fs.doc(fb.db, 'pokerRooms', tid));
      const closed = !snap.exists() || snap.data()?.status === 'closed';
      if (closed) {
        const inPlayBefore = Number(playerDoc?.inPlay) || 0;
        const room = snap.exists()
          ? { id: tid, ...snap.data(), status: 'closed' }
          : { id: tid, status: 'closed', seatUids: [] };
        const res = await settleClosedRoomBinding(fb, uid, room);
        if (typeof res?.amount === 'number') credited = res.amount;
        else if (res?.skipped || res?.idempotent) credited = 0;
        else credited = inPlayBefore;
        try {
          playerDoc = await getPlayer(fb, uid);
        } catch {
          if (playerDoc) {
            playerDoc = {
              ...playerDoc,
              tableRoomId: null,
              inPlay: 0,
              bank: (playerDoc.bank || 0) + credited,
              total: (playerDoc.bank || 0) + credited,
            };
          }
        }
      }
    } catch (e) {
      console.warn('silent settle closed', e);
    }
  }
  // Clear host pointer at closed/missing room
  const hid = playerDoc?.hostRoomId;
  if (hid && fb && uid) {
    try {
      const snap = await fb.fs.getDoc(fb.fs.doc(fb.db, 'pokerRooms', hid));
      if (!snap.exists() || snap.data()?.status === 'closed') {
        try {
          await fb.fs.updateDoc(fb.fs.doc(fb.db, 'pokerPlayers', uid), {
            hostRoomId: null,
            updatedAt: fb.fs.serverTimestamp(),
          });
        } catch {
          /* rules may deny */
        }
        try {
          playerDoc = await getPlayer(fb, uid);
        } catch {
          /* keep going */
        }
        if (playerDoc?.hostRoomId === hid) {
          playerDoc = { ...playerDoc, hostRoomId: null };
        }
      }
    } catch {
      /* ignore */
    }
  }
  // Closed tables never use the rescue settle card
  if (rescueReason === 'closed' || !playerDoc?.tableRoomId) {
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
  const closedId = roomId || room?.id || null;
  closeResultDismissedFor = closedId;
  hideCloseResultCard();
  clearRoomUrlParams();
  clearLastRoom();
  // Intentional exit — must NOT clear autoResumeTried (that re-enterRoom'd the table)
  autoResumeTried = true;
  await syncAfterRoomClosed();
  tearDownRoom();
  screen = 'lobby';
  const back = $('#btnBackLobby');
  if (back) back.hidden = true;
  paint();
}

async function dismissCloseResultToStats() {
  const closedId = roomId || room?.id || null;
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
function showCloseResultCard({ chips = 0, auto = false } = {}) {
  const rid = roomId || room?.id || null;
  // User already chose 回大廳／看戰績 — late closed snapshots must not re-open the card
  if (rid && closeResultDismissedFor === rid) return;
  if (screen !== 'table' && screen !== 'linking') return;
  const n = Number(chips) || 0;
  // Already showing: never let a later 0 clobber a real return; upgrade if better
  if (rid && closeResultShownFor === rid && document.getElementById('mpCloseResult')) {
    if (n > closeResultChipsShown) {
      closeResultChipsShown = n;
      const title = document.getElementById('mpCloseResultT');
      if (title) {
        title.textContent = `牌桌已收桌，你帶回 ${n.toLocaleString('en-US')} 籌碼`;
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
  const autoLine = auto
    ? '<p class="mp-close-result-d">沒人在線 30 分鐘，已自動收桌</p>'
    : '';
  el.innerHTML = `
    <div class="mp-close-result-card">
      <h2 id="mpCloseResultT">牌桌已收桌，你帶回 ${n.toLocaleString('en-US')} 籌碼</h2>
      ${autoLine}
      <button type="button" class="mp-btn-primary" id="mpCloseLobby">回大廳</button>
      <button type="button" class="mp-b2" id="mpCloseStats">看戰績</button>
    </div>`;
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
      <h2 id="mpHostAloneT">桌上只剩你，不能交給別人。要結束的話請收桌，或等有人入座</h2>
      <button type="button" class="mp-btn-primary" id="mpHostAloneClose">收桌</button>
      <button type="button" class="mp-b2" id="mpHostAloneCancel">先不要</button>
    </div>`;
  el.hidden = false;
  $('#mpHostAloneClose', el)?.addEventListener('click', () => {
    el.hidden = true;
    mpCloseRoom();
  });
  $('#mpHostAloneCancel', el)?.addEventListener('click', () => {
    el.hidden = true;
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
/** Chips amount currently shown on the close-result card (upgrade if a better value arrives). */
let closeResultChipsShown = 0;
/** Soft-leave lobby: one live refresh per closed room id (no paint loop). */
const lobbyClosedSynced = new Set();
/** Self stack captured before host pre-close cashout (dialog amount source of truth). */
let pendingCloseReturnChips = null;
/** Last known chips for this player at the current table (survives host cashout-before-close). */
let lastKnownSelfTableChips = 0;
/** @type {any[]} */
let openTables = [];
/** @type {(() => void)|null} */
let stopOpenTables = null;
/** Toast once when auto-unseated while away (附錄 L5). */
let pendingAwayUnseatToast = false;
/** Top-bar status override after auto-unseat (BD §2.1). */
let awayLobbyStatus = null;
/** Lobby idle/rescue getDoc: only on bind change or ≥30s (not every paint). */
const LOBBY_IDLE_CHECK_MS = 30_000;
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
      leaveToLobby();
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

  // takeover poll
  setInterval(() => {
    const fb = getFirebase();
    const u = getUser();
    if (!fb || !u || !room || room.hostUid === u.uid) return;
    maybeTakeover(fb, room, u.uid, lastRecvAt, (pub) => ({
      ...pub,
      phase: 'hand_over',
      voided: true,
      board: [],
      actor: null,
    }));
  }, 2000);
}

function ensureMpRoot() {
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
    root.hidden = false;
    root.classList.remove('mp-root-table');
    if (app) app.classList.add('hidden');
    silenceSoloScreens();
    ensureOpenTablesListen();
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
    const last = getLastRoom();
    // Closed tables: never show 我的牌桌 (settle is silent). Open bind only.
    const continueId =
      playerDoc?.tableRoomId && !rescueOk
        ? playerDoc.tableRoomId
        : playerDoc?.hostRoomId && !rescueOk
          ? playerDoc.hostRoomId
          : null;
    // Auto-resume after refresh only (not after intentional 回大廳／收桌結果)
    if (
      continueId &&
      playerDoc?.tableRoomId === continueId &&
      !rescueOk &&
      !autoResumeTried
    ) {
      autoResumeTried = true;
      enterRoom(continueId);
      return;
    }
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
            const fb = getFirebase();
            const tid = playerDoc?.tableRoomId || playerDoc?.hostRoomId;
            if (fb && tid) {
              const snap = await fb.fs.getDoc(
                fb.fs.doc(fb.db, 'pokerRooms', tid),
              );
              if (snap.exists()) {
                const data = snap.data();
                const didClose = await maybeAutoCloseIdleRoom(fb, {
                  id: tid,
                  ...data,
                });
                let closed = data?.status === 'closed';
                if (didClose) {
                  try {
                    const again = await fb.fs.getDoc(
                      fb.fs.doc(fb.db, 'pokerRooms', tid),
                    );
                    closed =
                      !again.exists() || again.data()?.status === 'closed';
                  } catch {
                    closed = true;
                  }
                }
                if (closed && screen === 'lobby') {
                  const before = lobbyBindKey();
                  await syncAfterRoomClosed();
                  settledChanged = before !== lobbyBindKey();
                }
              } else if (screen === 'lobby') {
                const before = lobbyBindKey();
                await syncAfterRoomClosed();
                settledChanged = before !== lobbyBindKey();
              }
            }
          } catch {
            /* ignore */
          }
          if ((changed || settledChanged) && screen === 'lobby') paint();
        })
        .finally(() => {
          lobbyIdleCheckInflight = false;
        });
    }
    const seatIdx =
      room?.seatUids
        ? room.seatUids.indexOf(authState.user?.uid)
        : last?.seat;
    const stackChips =
      seatIdx >= 0 && Array.isArray(room?.stacks)
        ? room.stacks[seatIdx]
        : null;
    const myTable =
      continueId && (playerDoc?.tableRoomId || playerDoc?.hostRoomId || rescueOk)
        ? {
            roomId: continueId,
            code: room?.code || last?.code || '',
            name: room?.name || last?.name || '牌桌',
            chips:
              stackChips != null
                ? stackChips
                : last?.chips ?? playerDoc?.inPlay,
            seat: seatIdx >= 0 ? seatIdx : last?.seat ?? null,
            seated:
              room?.lobby?.seated ??
              (room?.seatUids || []).filter(Boolean).length,
            blinds:
              room?.lobby?.blinds ||
              (room?.config
                ? `${room.config.sb}/${room.config.bb}`
                : '10/20'),
            hostName:
              room?.lobby?.hostName ||
              (room?.hostUid ? displayNameOf(room.hostUid) : '房主'),
            phase:
              room?.status === 'playing' ||
              (room?.pub?.phase &&
                room.pub.phase !== 'lobby' &&
                room.pub.phase !== 'hand_over')
                ? 'playing'
                : 'lobby',
          }
        : null;
    renderMpLobby(root, {
      user: authState.user,
      player: playerDoc,
      myTable,
      openTables: openTables.filter(
        (t) => t.id !== myTable?.roomId && isRoomOpenStatus(t.status),
      ),
      joinDigits,
      joinError,
      joining,
      leaderPreview,
      offline: authState.status === 'offline',
      rescueAvailable: rescueOk,
      rescueReason,
      rescueChips,
      onContinue: () => myTable && enterRoom(myTable.roomId),
      onCreate: () => {
        void onCreateTable();
      },
      onJoinCode: (code) => {
        joinDigits = code;
        doJoin(code);
      },
      onOpenTable: (rid) => enterOpenTable(rid),
      onStats: () => openStats(),
      onSolo: () => openSolo(),
      onSignOut: () => signOut(),
      onRescue: () => doRescue(),
      onAvatar: () => openStats(),
      onSettings: () =>
        toast('設定還在製作中，請先用⋯選單的「戰績」或「同一支手機輪流玩」'),
      lobbyStatus: awayLobbyStatus,
    });
    return;
  }

  if (screen === 'create') {
    root.hidden = false;
    root.classList.remove('mp-root-table');
    renderCreateRoom(root, {
      defaults: createDraft,
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
      onEnter: () => enterRoom(shareInfo.roomId, { asHostSit: true }),
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

function ensureOpenTablesListen() {
  if (stopOpenTables) return;
  const fb = getFirebase();
  if (!fb) return;
  stopOpenTables = listenOpenTables(
    fb,
    (rows) => {
      openTables = rows;
      if (screen !== 'lobby') return;
      const root = $('#mpRoot');
      const myId = playerDoc?.tableRoomId || playerDoc?.hostRoomId || null;
      const visible = openTables.filter(
        (t) => t.id !== myId && (t.status === 'lobby' || t.status === 'playing' || t.status === 'open'),
      );
      if (root && patchOpenTables(root, visible)) return;
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
  const root = $('#mpRoot');
  const row = root?.querySelector(`.mp-row[data-rid="${CSS.escape(roomId)}"]`);
  if (row) {
    row.setAttribute('aria-busy', 'true');
    row.disabled = true;
    const go = row.querySelector('.mp-go');
    if (go) go.textContent = '加入中…';
  }
  try {
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
    if (decision.ok && decision.reason === 'gone') {
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
      playerDoc = await getPlayer(fb, user.uid);
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
  creating = true;
  createError = '';
  paint();
  try {
    const displayName = user.displayName || '玩家';
    const tableName =
      String(data.name || '').trim() || `${displayName}的牌桌`;
    const res = await createRoom(fb, {
      uid: user.uid,
      name: tableName,
      displayName,
      photoURL: user.photoURL || null,
      sb: data.sb,
      bb: data.bb,
      newPlayerChips: data.newPlayerChips,
    });
    if (res.existing) {
      // L3: already hosting → go straight back to that table
      creating = false;
      screen = 'lobby';
      await enterRoom(res.roomId, { asHostSit: true });
      return;
    }
    shareInfo = res;
    createDraft = { name: '', sb: 10, chips: 2000 };
    // createRoom writes hostRoomId in the same txn; refresh local player doc
    try {
      playerDoc = await getPlayer(fb, user.uid);
    } catch (e) {
      console.warn('hostRoomId refresh', e);
    }
    screen = 'share';
  } catch (e) {
    console.error(e);
    createError = friendlyError(
      e,
      '牌桌沒開成功，可能是網路斷了，請再按一次',
    );
  }
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

async function enterRoom(id, { asHostSit = false } = {}) {
  const fb = getFirebase();
  const user = getUser();
  if (!fb || !user) return;
  // New/resumed table — allow a future close-result for this (or another) room
  if (closeResultDismissedFor && closeResultDismissedFor !== id) {
    lobbyClosedSynced.delete(closeResultDismissedFor);
    closeResultDismissedFor = null;
  }
  if (closeResultShownFor && closeResultShownFor !== id) {
    closeResultShownFor = null;
    closeResultChipsShown = 0;
  }

  // Soft resume after leaveToLobby keepAlive: same room still listening — just show table.
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
        lastRoomWriteAt: () => hostLoop?.lastRoomWriteAt?.() || 0,
      });
    } else {
      presence.beatNow?.();
    }
    if (!intents) intents = createIntentSender(fb, id, user.uid);
    screen = 'table';
    paint();
    return;
  }

  tearDownRoom();
  roomId = id;
  // Fresh enter of an open table resets dismiss guard
  closeResultDismissedFor = null;
  closeResultShownFor = null;
  closeResultChipsShown = 0;
  pendingCloseReturnChips = null;
  lastKnownSelfTableChips = 0;
  lobbyClosedSynced.delete(id);

  // Ensure membership: try read; on permission-denied, need code path from lastRoom / URL
  try {
    await fb.fs.getDoc(fb.fs.doc(fb.db, 'pokerRooms', id));
  } catch {
    const last = getLastRoom();
    if (last?.code) {
      const joined = await joinByCode(fb, last.code, user.uid, id);
      if (joined.ended || joined.error) {
        joinEnded = true;
        joinError = joined.error || '牌桌已結束';
        screen = 'join';
        paint();
        return;
      }
    }
  }

  stopRoom = listenRoom(
    fb,
    id,
    async (r) => {
      const first = !room;
      room = r;
      lastRecvAt = Date.now();
      // Track self stack while still seated / bound — host may cash out before status=closed
      {
        const u = getUser()?.uid;
        if (u) {
          const s = Array.isArray(r.seatUids) ? r.seatUids.indexOf(u) : -1;
          if (s >= 0) {
            lastKnownSelfTableChips = Number(r.stacks?.[s]) || 0;
          } else if (
            playerDoc?.tableRoomId === id &&
            Number(playerDoc?.inPlay) > 0
          ) {
            lastKnownSelfTableChips = Number(playerDoc.inPlay) || 0;
          }
        }
      }
      if (r.status === 'closed') {
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
          !!(r.lobby?.autoClosed || r.autoClosed) || r.closedBy === 'auto';
        // Prefer pending / settle / last-known stack (never show 0 after a real return)
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
        showCloseResultCard({ chips, auto });
        pendingCloseReturnChips = null;
        paintTableChrome();
        return;
      }

      // First visit: grant + optional host sit
      if (first) {
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
          playerDoc = await getPlayer(fb, user.uid);
        } catch (e) {
          console.warn('grant', e);
        }

        presence = startPresence(fb, id, user.uid, {
          isHost: () => room?.hostUid === user.uid,
          lastRoomWriteAt: () => hostLoop?.lastRoomWriteAt?.() || 0,
        });
        intents = createIntentSender(fb, id, user.uid);
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
          } else if (ev.type === 'topUp') {
            toast(`座位 ${ev.seat + 1} 補碼 ${fmtChips(ev.amount)}`);
          } else if (ev.type === 'seatIn') {
            toast(`${ev.player?.name || '玩家'} 入座`);
          } else if (ev.type === 'seatOut') {
            toast(`${ev.player?.name || '玩家'} 離座`);
          }
          paintTableChrome();
        });

        screen = 'table';
        paint();

        if (asHostSit && r.hostUid === user.uid && !r.seatUids.includes(user.uid)) {
          try {
            await buyinAll(fb, user.uid, id);
            await hostLoop?.seatPlayer(0, user.uid);
          } catch (e) {
            console.warn('host sit', e);
            toast(friendlyError(e, '入座失敗，請點空位再試一次'));
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
        animQ?.push(diff.events, { skip: diff.skip });
        prevPub = r.pub;
        paintTableChrome();
      }
    },
    (err) => {
      console.warn(err);
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
    if (back) back.hidden = true;
    return;
  }
  if (back) back.hidden = false;
  const user = getUser();
  const title = $('#roomTitle');
  if (title) title.textContent = room.name || '週五牌局';
  const meta = $('#roomMeta');
  if (meta) {
    const spec = room.seatUids.filter((u) => u).length;
    const watch = Math.max(0, (room.members?.length || 0) - spec);
    meta.innerHTML = `<span class="meta-a"><b>${esc(room.config.sb)}／${esc(room.config.bb)}</b></span><span class="meta-b">　房號 ${esc(formatCode(room.code))}　觀戰 ${esc(watch)}</span>`;
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
  const rem = remainingMs(room.deadlineAt, pub.hostClockAt, lastRecvAt);
  const hint = $('#turnHint');
  if (hint) {
    hint.textContent =
      rem != null && !between && pub.actor != null
        ? `${Math.ceil(rem / 1000)} 秒`
        : '';
  }

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
        <div class="av"><span>${esc(name.slice(0, 1))}</span></div>
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

  // Empty-seat hit targets on the felt (spectators only — no duplicate bottom strip)
  if (mySeat < 0) {
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
    if (heroAv) heroAv.innerHTML = `<span>${esc(name.slice(0, 1))}</span>`;
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
    if (heroName) heroName.textContent = '觀戰';
    if (heroChips) heroChips.textContent = '';
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

/** M2 #13 / §4.1 6-d: host approve+deny buttons + player deny cooldown. */
function topUpHostHtml(pub) {
  const reqs = Object.keys(pub.topUpReqs || {});
  if (!reqs.length) return '';
  return reqs
    .map(
      (s) =>
        `<button type="button" class="primary" data-approve="${s}">核准補碼 座位${+s + 1}</button>` +
        `<button type="button" class="ghost" data-deny="${s}">先不要</button>`,
    )
    .join('');
}

function topUpPlayerHtml(pub, mySeat, stacks) {
  if (mySeat < 0 || (stacks[mySeat] || 0) !== 0) return '';
  if (pub.topUpReqs?.[mySeat] || pub.topUpReqs?.[String(mySeat)]) {
    return `<button type="button" class="ghost" id="mpTopupCancel">取消申請</button>
      <span class="mp-spec">等房主核准…</span>`;
  }
  const deniedAt = Number(
    pub.topUpDenied?.[mySeat] ?? pub.topUpDenied?.[String(mySeat)] ?? 0,
  );
  if (deniedAt) {
    const left = Math.max(0, 60 - Math.floor((Date.now() - deniedAt) / 1000));
    if (left > 0) {
      if (!topUpDenyTick) {
        topUpDenyTick = setInterval(() => paintTableChrome(), 1000);
      }
      return `<div class="mp-spec">房主這次先不補。你可以 1 分鐘後再申請，或離座把籌碼結回帳戶</div>
        <button type="button" class="primary" id="mpTopup" disabled aria-disabled="true">再申請一次（${left}s）</button>
        <button type="button" class="ghost" id="mpLeave">離座</button>`;
    }
    if (topUpDenyTick) {
      clearInterval(topUpDenyTick);
      topUpDenyTick = null;
    }
    return `<div class="mp-spec">房主這次先不補。你可以再申請一次，或離座把籌碼結回帳戶</div>
      <button type="button" class="primary" id="mpTopup">再申請一次</button>
      <button type="button" class="ghost" id="mpLeave">離座</button>`;
  }
  return `<button type="button" class="primary" id="mpTopup">申請補 2,000</button>`;
}

function wireTopUpActions(btns, pub, mySeat) {
  $('#mpTopup', btns)?.addEventListener('click', () => {
    const btn = $('#mpTopup', btns);
    if (btn?.disabled) return;
    btn.disabled = true;
    btn.textContent = '申請中…';
    intents?.send(
      {
        type: 'TOPUP_REQ',
        handNo: (Number(pub.handNo) || 0) | 0,
        turn: (Number(pub.actionSeq) || 0) | 0,
        seat: mySeat,
      },
      {
        onFail: () => {
          toast('沒有送出去，可能是網路斷了。請再按一次');
          paintTableChrome();
        },
      },
    );
  });
  $('#mpTopupCancel', btns)?.addEventListener('click', () => {
    intents?.send({
      type: 'TOPUP_CANCEL',
      handNo: (Number(pub.handNo) || 0) | 0,
      turn: (Number(pub.actionSeq) || 0) | 0,
      seat: mySeat,
    });
  });
  btns.querySelectorAll('[data-approve]').forEach((el) => {
    el.addEventListener('click', async () => {
      if (approveBusy || denyBusy) return;
      approveBusy = true;
      const seat = Number(el.getAttribute('data-approve'));
      btns.querySelectorAll(`[data-approve="${seat}"],[data-deny="${seat}"]`).forEach((b) => {
        b.disabled = true;
      });
      el.textContent = '核准中…';
      try {
        await hostLoop?.approveTopUp(seat);
      } catch (e) {
        toast(friendlyError(e, '沒有送出去，可能是網路斷了。請再按一次'));
        paintTableChrome();
      } finally {
        approveBusy = false;
      }
    });
  });
  btns.querySelectorAll('[data-deny]').forEach((el) => {
    el.addEventListener('click', async () => {
      if (approveBusy || denyBusy) return;
      denyBusy = true;
      const seat = Number(el.getAttribute('data-deny'));
      btns.querySelectorAll(`[data-approve="${seat}"],[data-deny="${seat}"]`).forEach((b) => {
        b.disabled = true;
      });
      el.textContent = '處理中…';
      try {
        await hostLoop?.denyTopUp(seat);
      } catch (e) {
        toast(friendlyError(e, '沒有送出去，可能是網路斷了。請再按一次'));
        paintTableChrome();
      } finally {
        denyBusy = false;
      }
    });
  });
}

function renderActBar() {
  const act = $('#act');
  const btns = $('#btns');
  if (!act || !btns || !room) return;
  const user = getUser();
  const mySeat = room.seatUids.indexOf(user?.uid);
  const pub = room.pub || {};
  const isHost = room.hostUid === user?.uid;
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

  if (mySeat < 0) {
    // PL: soft leave via top 「‹ 大廳」only — no bottom 回大廳
    btns.innerHTML = `<div class="mp-spec">你正在觀戰，點牌桌上的空位就坐下<br><small>坐下時整筆帶入你的帳戶 ${fmtChips(playerDoc?.bank || 0)}</small></div>`;
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
        intents?.send(payload, {
          onFail: () => {
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
    $('#mpStart')?.addEventListener('click', () => hostLoop?.startHand());
    $('#mpLeave')?.addEventListener('click', () => requestLeave());
    return;
  }

  if (between && isHost && seatedCount >= 2 && pub.phase === 'hand_over') {
    const playerTop = topUpPlayerHtml(pub, mySeat, room.stacks);
    // Denied player block already includes 離座
    const hasLeaveInTop = /id="mpLeave"/.test(playerTop);
    btns.innerHTML = `<button type="button" class="primary" id="mpStart">開始下一手（${seatedCount}人）</button>
      ${hasLeaveInTop ? '' : '<button type="button" class="ghost" id="mpLeave">離座</button>'}
      ${playerTop}
      ${topUpHostHtml(pub)}`;
    $('#mpStart')?.addEventListener('click', () => hostLoop?.startHand());
    $('#mpLeave')?.addEventListener('click', () => requestLeave());
    wireTopUpActions(btns, pub, mySeat);
    return;
  }

  if (between) {
    const playerTop = topUpPlayerHtml(pub, mySeat, room.stacks);
    const hasLeaveInTop = /id="mpLeave"/.test(playerTop);
    btns.innerHTML = `
      ${playerTop}
      ${isHost ? topUpHostHtml(pub) : ''}
      ${hasLeaveInTop ? '' : '<button type="button" class="ghost" id="mpLeave">離座</button>'}`;
    $('#mpLeave')?.addEventListener('click', () => requestLeave());
    wireTopUpActions(btns, pub, mySeat);
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
    // Host applies locally; still write intent for audit / takeover handoff
    if (isHost) {
      hostLoop?.hostAction({ type, amount: payload.amount, seat: mySeat });
    }
    intents?.send(payload, {
      onPending: () => toast('送出中…'),
      onFail: () => {
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
  sittingBusy = true;
  toast('入座中…');
  try {
    if (playerDoc?.tableRoomId !== roomId) {
      await buyinAll(fb, user.uid, roomId);
      playerDoc = await getPlayer(fb, user.uid);
    }
    const pub = room.pub || {};
    await intents?.send({
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
  if (!el || !room) return;
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
    $('#mpQuotaLobby', el)?.addEventListener('click', () => leaveToLobby());
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
  await loadStats();
  paint();
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
 * Return to lobby without 離座. Spec §6.2 / EGM #7: host loop + presence
 * keep running on any visible screen so the host is never judged「失聯」by self.
 * PL: entry is top 「‹ 大廳」only (no bottom 回大廳 / menu「大廳」).
 */
function leaveToLobby() {
  const user = getUser();
  const uid = user?.uid;
  const keepAlive =
    !!roomId &&
    !!playerDoc?.tableRoomId &&
    room?.status !== 'closed' &&
    !!uid &&
    (room?.hostUid === uid || (room?.seatUids || []).includes(uid));

  // Intentional lobby visit while still bound to a table — do not auto-bounce
  autoResumeTried = true;

  if (keepAlive) {
    // Soft detach: table-only UI; keep listenRoom, presence, hostLoop
    stopHole?.();
    stopHole = null;
    intents = null;
    animQ?.clear();
    animQ = null;
    myHole = null;
    membersPanelOpen = false;
    clearMpRaiseHold();
    raiseOpen = false;
    removeMpMenuExtras();
    if (room?.hostUid === uid && !hostLoop) {
      hostLoop = createHostLoop(getFirebase(), {
        roomId,
        uid,
        getRoom: () => room,
        displayNameOf,
        onLocalState: () => paintTableChrome(),
      });
      hostLoop.start();
    }
    if (!presence && roomId && uid) {
      presence = startPresence(getFirebase(), roomId, uid, {
        isHost: () => room?.hostUid === uid,
        lastRoomWriteAt: () => hostLoop?.lastRoomWriteAt?.() || 0,
      });
    } else {
      presence?.beatNow?.();
    }
  } else {
    tearDownRoom();
    if (!playerDoc?.tableRoomId) autoResumeTried = false;
  }
  screen = 'lobby';
  const back = $('#btnBackLobby');
  if (back) back.hidden = true;
  paint();
}

function tearDownRoom() {
  stopRoom?.();
  stopRoom = null;
  stopHole?.();
  stopHole = null;
  presence?.stop();
  presence = null;
  hostLoop?.stop();
  hostLoop = null;
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
  if (topUpDenyTick) {
    clearInterval(topUpDenyTick);
    topUpDenyTick = null;
  }
  hideCloseResultCard();
  const alone = document.getElementById('mpHostAlone');
  if (alone) alone.hidden = true;
  removeMpMenuExtras();
}

function ensureMpMenu() {
  const pop = $('#menuPop');
  if (!pop || pop.dataset.mpMenu === '1') return;
  pop.dataset.mpMenu = '1';
  // Hide solo-only / duplicate exits in MP (PL: ‹ 大廳 + 收桌 cover 大廳／結束牌局)
  // 計時／暫停／全螢幕／音效：先維持現況，等 PL 通知再動
  $('#btnTimerCfg')?.classList.add('hidden');
  $('#btnPauseMenu')?.classList.add('hidden');
  $('#btnLobby')?.classList.add('hidden');
  $('#btnEndMenu')?.classList.add('hidden');

  const extras = document.createElement('div');
  extras.id = 'mpMenuExtras';
  extras.innerHTML = `
    <button type="button" id="mpBtnCopyLink" role="menuitem">複製房號連結</button>
    <button type="button" id="mpBtnExtend" role="menuitem">延長房號 24 小時</button>
    <button type="button" id="mpBtnMembers" role="menuitem">成員</button>
    <button type="button" id="mpBtnCloseRoom" role="menuitem">收桌</button>
    <div id="mpMembersPanel" class="mp-members hidden" hidden></div>`;
  pop.appendChild(extras);

  // M2: fixed top 「‹ 大廳」(soft leave, keep seat) — sole lobby exit on table
  if (!$('#btnBackLobby')?.dataset.mpWired) {
    const back = $('#btnBackLobby');
    if (back) {
      back.dataset.mpWired = '1';
      back.addEventListener('click', () => {
        if (!room) return;
        closeMpMenu();
        leaveToLobby();
      });
    }
  }
  $('#mpBtnCopyLink')?.addEventListener('click', async () => {
    closeMpMenu();
    const url = shareUrl(room.code, room.id);
    try {
      await navigator.clipboard?.writeText(url);
      toast('已複製');
    } catch {
      toast(url);
    }
  });
  $('#mpBtnExtend')?.addEventListener('click', () => {
    closeMpMenu();
    mpExtendCode();
  });
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
      uid === room.hostUid ? '房主' : seat >= 0 ? `座位 ${seat + 1}` : '觀戰';
    return `<li><b>${esc(displayNameOf(uid))}</b><span>${role}</span></li>`;
  });
  panel.innerHTML = `<h3>成員（${rows.length}）</h3><ul>${rows.join('')}</ul>`;
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
  leaveToLobby();
}

export function mpExtendCode() {
  const fb = getFirebase();
  if (!fb || !room) return;
  extendCode(fb, room.code, getUser()?.uid).then(() => toast('房號延長 24 小時'));
}

export function mpCloseRoom() {
  const fb = getFirebase();
  if (!fb || !room) return;
  if (!confirm('確定收桌？在座的人會結帳回帳戶。')) return;
  const id = room.id;
  const btn = document.getElementById('mpBtnCloseRoom');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '收桌中…';
  }
  const uid = getUser()?.uid;
  void (async () => {
    try {
      // Capture this player's return BEFORE cashout empties the seat / clears tableRoomId
      const mySeat = uid ? room.seatUids?.indexOf(uid) ?? -1 : -1;
      let chips =
        mySeat >= 0
          ? Number(room.stacks?.[mySeat]) || 0
          : playerDoc?.tableRoomId === id
            ? Number(playerDoc?.inPlay) || 0
            : 0;
      pendingCloseReturnChips = chips;
      // Host: cash out every seated stack while room still open (ledger + seat clear)
      if (uid && room.hostUid === uid && hostLoop?.cashoutSeat) {
        const seats = [...(room.seatUids || [])];
        const stacks = [...(room.stacks || [])];
        for (let i = 0; i < seats.length; i++) {
          const u = seats[i];
          if (!u) continue;
          const amt = Number(stacks[i]) || 0;
          try {
            await hostLoop.cashoutSeat(i, u);
            if (u === uid) chips = amt;
          } catch (e) {
            console.warn('close cashout seat', i, e);
          }
        }
      }
      pendingCloseReturnChips = chips;
      await closeRoom(fb, id);
      clearLastRoom();
      try {
        playerDoc = (await getPlayer(fb, uid)) || playerDoc;
      } catch {
        /* keep */
      }
      // Settle leftover bind; never replace a known return with settle's 0
      if (playerDoc?.tableRoomId === id) {
        const settled = await silentlySettleClosedBinding();
        if (settled > 0) chips = settled;
      } else {
        await silentlySettleClosedBinding();
      }
      if (closeResultDismissedFor !== id) {
        showCloseResultCard({ chips, auto: false });
      }
      pendingCloseReturnChips = null;
    } catch (e) {
      pendingCloseReturnChips = null;
      toast(friendlyError(e, '沒有送出去，可能是網路斷了。請再按一次'));
      if (btn) {
        btn.disabled = false;
        btn.textContent = '收桌';
      }
    }
  })();
}
