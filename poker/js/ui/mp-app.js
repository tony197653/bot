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
} from '../../../lib/auth/auth.js';
import { renderAuthUi, AUTH_UI_CSS } from '../../../lib/auth/auth-ui.js';
import { FIREBASE_CONFIG, LS_PREFIX } from '../net/firebase-config.js';
import {
  createRoom,
  joinByCode,
  listenRoom,
  getLastRoom,
  shareUrl,
  formatCode,
  extendCode,
  closeRoom,
} from '../net/room.js';
import {
  ensurePlayerGrant,
  buyinAll,
  getPlayer,
  fetchLeaderboard,
  fetchNightBoard,
  selfRescueCashout,
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
import { hostShouldWarn, resetTimeTaipeiLabel } from '../net/quota.js';
import {
  renderMpLobby,
  renderCreateRoom,
  renderShareRoom,
  renderJoinCode,
} from './lobby.js';
import { renderStats } from './stats.js';
import { MP_FX, mpDuration } from './fx-mp.js';

const $ = (sel, el = document) => el.querySelector(sel);

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
let statsMode = 'total';
let statsRows = [];
let statsNight = nightKeyOf();
let leaderPreview = [];
let myHole = null;
let toastTimer = 0;

export function setSoloOpener(fn) {
  openSoloFn = fn;
}

export async function startMpApp() {
  injectAuthCss();
  ensureMpRoot();

  const params = new URLSearchParams(location.search);
  const deepRoom = params.get('room');
  const deepR = params.get('r');

  await initAuth({
    firebaseConfig: FIREBASE_CONFIG,
    mode: 'auto',
    sameDomainAuth: true,
    storageKey: 'auth.v1',
    timeoutMs: 8000,
  });

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

function paint() {
  const root = $('#mpRoot');
  if (!root) return;

  // Hide solo lobby / app when in MP shell screens
  const soloLobby = $('#lobbyScreen');
  const app = $('#app');
  const inTable = screen === 'table';

  if (screen === 'auth') {
    root.hidden = false;
    root.classList.remove('mp-root-table');
    if (soloLobby) {
      soloLobby.classList.add('hidden');
      soloLobby.classList.remove('is-on');
    }
    if (app) app.classList.add('hidden');
    renderAuthUi(root, authState, {
      brand: '週五牌局',
      onRetry: () => signIn(),
    });
    // Custom 1-a layout: brand + login button centered with table card placeholder
    if (authState.status === 'signed-out' || authState.status === 'offline') {
      root.innerHTML = `
        <div class="mp-shell mp-auth">
          <h1 class="mp-brand">週五牌局</h1>
          <div class="mp-auth-card" aria-hidden="true"><span>德州撲克</span></div>
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
    if (soloLobby) {
      soloLobby.classList.add('hidden');
      soloLobby.classList.remove('is-on');
    }
    const last = getLastRoom();
    renderMpLobby(root, {
      user: authState.user,
      player: playerDoc,
      lastRoom: last
        ? { ...last, name: room?.name, chips: playerDoc?.inPlay }
        : null,
      leaderPreview,
      offline: authState.status === 'offline',
      rescueAvailable: !!playerDoc?.tableRoomId,
      onContinue: () => last && enterRoom(last.roomId),
      onCreate: () => {
        if (playerDoc?.tableRoomId) {
          toast('先離開目前牌桌');
          return;
        }
        screen = 'create';
        paint();
      },
      onJoin: () => {
        joinDigits = '';
        joinError = '';
        joinEnded = false;
        screen = 'join';
        paint();
      },
      onStats: () => openStats(),
      onSolo: () => openSolo(),
      onSignOut: () => signOut(),
      onRescue: () => doRescue(),
      onAvatar: () => {},
    });
    return;
  }

  if (screen === 'create') {
    root.hidden = false;
    renderCreateRoom(root, {
      defaults: { name: '週五牌局', sb: 10, chips: 2000 },
      creating,
      error: createError,
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
    });
    return;
  }

  if (screen === 'join') {
    root.hidden = false;
    renderJoinCode(root, {
      digits: joinDigits,
      joining,
      error: joinError,
      ended: joinEnded,
      onBack: () => {
        screen = 'lobby';
        paint();
      },
      onChange: (d) => {
        joinDigits = d.replace(/\D/g, '').slice(0, 6);
        joinError = '';
        paint();
      },
      onJoin: () => doJoin(joinDigits),
      onLobby: () => {
        screen = 'lobby';
        paint();
      },
    });
    return;
  }

  if (screen === 'stats') {
    root.hidden = false;
    renderStats(root, {
      mode: statsMode,
      rows: statsRows,
      nightKey: statsNight,
      nights: [statsNight],
      myUid: authState.user?.uid,
      offline: authState.status === 'offline',
      onBack: () => {
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
    if (soloLobby) {
      soloLobby.classList.add('hidden');
      soloLobby.classList.remove('is-on');
    }
    if (app) app.classList.remove('hidden');
    paintTableChrome();
  }
}

async function doCreate(data) {
  const fb = getFirebase();
  const user = getUser();
  if (!fb || !user) {
    createError = '連不上網路，無法開房';
    paint();
    return;
  }
  if (data.newPlayerChips < 1000 || data.newPlayerChips > 100000 || data.newPlayerChips % 500) {
    createError = '起始籌碼要在 1,000-100,000 之間';
    paint();
    return;
  }
  creating = true;
  createError = '';
  paint();
  try {
    const res = await createRoom(fb, {
      uid: user.uid,
      name: data.name,
      sb: data.sb,
      bb: data.bb,
      newPlayerChips: data.newPlayerChips,
    });
    shareInfo = res;
    screen = 'share';
  } catch (e) {
    console.error(e);
    createError = '開房失敗，請再試一次';
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
  paint();
  try {
    const res = await Promise.race([
      joinByCode(fb, code, user.uid, expectedR),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
    ]);
    if (res.ended) {
      joinEnded = true;
    } else if (res.error) {
      joinError = res.error;
    } else if (res.roomId) {
      await enterRoom(res.roomId);
      return;
    }
  } catch (e) {
    joinError =
      e?.message === 'timeout'
        ? '連線逾時，請再試一次'
        : '找不到這個房號。請確認 6 位數字，或請房主重新分享連結。';
  }
  joining = false;
  paint();
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
  tearDownRoom();
  roomId = id;

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
      if (r.status === 'closed') {
        toast('牌桌已結束');
        leaveToLobby();
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

        if (r.hostUid === user.uid) {
          hostLoop = createHostLoop(fb, {
            roomId: id,
            uid: user.uid,
            getRoom: () => room,
            displayNameOf: () => user.displayName,
            onLocalState: () => paintTableChrome(),
            onChipMismatch: () => toast('籌碼對不上，請收桌'),
            onQuotaStop: () => toast('今天到這裡'),
          });
          hostLoop.start();
        }

        screen = 'table';
        paint();

        if (asHostSit && r.hostUid === user.uid && !r.seatUids.includes(user.uid)) {
          try {
            await buyinAll(fb, user.uid, id);
            await hostLoop?.seatPlayer(0, user.uid);
          } catch (e) {
            console.warn('host sit', e);
            toast(String(e.message || e));
          }
        }
      } else {
        // host loop ownership
        if (r.hostUid === user.uid && !hostLoop) {
          hostLoop = createHostLoop(fb, {
            roomId: id,
            uid: user.uid,
            getRoom: () => room,
            displayNameOf: () => user.displayName,
            onLocalState: () => paintTableChrome(),
          });
          hostLoop.start();
        }
        if (r.hostUid !== user.uid && hostLoop) {
          hostLoop.stop();
          hostLoop = null;
        }
        // anim diff
        const late =
          r.updatedAt?.toMillis &&
          Date.now() - r.updatedAt.toMillis() > MP_FX.skipIfLateMs;
        diffPubEvents(prevPub, r.pub || {}, {
          late,
          wasHidden: document.visibilityState === 'hidden',
        });
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
  if (!room) return;
  const user = getUser();
  const title = $('#roomTitle');
  if (title) title.textContent = room.name || '週五牌局';
  const meta = $('#roomMeta');
  if (meta) {
    const spec = room.seatUids.filter((u) => u).length;
    const watch = Math.max(0, (room.members?.length || 0) - spec);
    meta.innerHTML = `<span class="meta-a"><b>${room.config.sb}／${room.config.bb}</b></span><span class="meta-b">　房號 ${formatCode(room.code)}　觀戰 ${watch}</span>`;
  }

  // Empty seats / sit affordance via seats container overlay labels
  renderSeatOverlays();
  renderActBar();
  renderBanner();
}

function renderSeatOverlays() {
  const seatsEl = $('#seats');
  if (!seatsEl || !room) return;
  // Minimal: ensure empty-seat prompts exist as data attributes for CSS
  seatsEl.dataset.mp = '1';
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
  const between = pub.phase === 'lobby' || pub.phase === 'hand_over';

  if (mySeat < 0) {
    btns.innerHTML = `<div class="mp-spec">你正在觀戰，點任一空位就坐下<br><small>坐下時整筆帶入你的帳戶 ${(playerDoc?.bank || 0).toLocaleString('en-US')}</small></div>
      <button type="button" class="ghost" id="mpBtnLeaveLobby">回大廳</button>`;
    $('#mpBtnLeaveLobby')?.addEventListener('click', leaveToLobby);
    // Click empty seats
    bindEmptySeatClicks();
    return;
  }

  if (between && isHost && seatedCount >= 2 && (pub.phase === 'lobby' || pub.handNo === 0)) {
    btns.innerHTML = `<button type="button" class="primary" id="mpStart">開始第一手（${seatedCount}人）</button>
      <button type="button" class="ghost" id="mpLeave">離座</button>`;
    $('#mpStart')?.addEventListener('click', () => hostLoop?.startHand());
    $('#mpLeave')?.addEventListener('click', () => requestLeave());
    return;
  }

  if (between) {
    const broke = (room.stacks[mySeat] || 0) === 0;
    btns.innerHTML = `
      ${broke ? `<button type="button" class="primary" id="mpTopup">申請補 2,000</button>` : ''}
      ${isHost && pub.topUpReqs ? Object.keys(pub.topUpReqs || {}).map((s) => `<button type="button" class="primary" data-approve="${s}">核准補碼 座位${+s + 1}</button>`).join('') : ''}
      <button type="button" class="ghost" id="mpLeave">離座</button>`;
    $('#mpTopup')?.addEventListener('click', () =>
      intents?.send({ type: 'TOPUP_REQ', handNo: pub.handNo || 0, turn: pub.actionSeq || 0, seat: mySeat }),
    );
    $('#mpLeave')?.addEventListener('click', () => requestLeave());
    btns.querySelectorAll('[data-approve]').forEach((el) => {
      el.addEventListener('click', () => hostLoop?.approveTopUp(Number(el.getAttribute('data-approve'))));
    });
    return;
  }

  // In hand — if my turn, show actions
  const actor = pub.actor;
  const legal = mySeat === actor;
  const callAmt = pub.currentBet || 0;
  btns.innerHTML = `
    <button type="button" class="fold" id="mpFold" ${legal ? '' : 'disabled'}>蓋牌</button>
    <button type="button" class="call" id="mpCall" ${legal ? '' : 'disabled'}>跟注</button>
    <button type="button" class="raise" id="mpRaise" ${legal ? '' : 'disabled'}>加注</button>`;
  const send = (type, amount) => {
    btns.querySelectorAll('button').forEach((b) => {
      b.disabled = true;
      b.style.opacity = '0.5';
    });
    intents?.send(
      { type, amount, seat: mySeat, handNo: pub.handNo || 0, turn: pub.actionSeq || 0 },
      {
        onPending: () => toast('送出中…'),
        onFail: () => {
          toast('沒送到，再按一次');
          paintTableChrome();
        },
      },
    );
    if (isHost) hostLoop?.hostAction({ type, amount, seat: mySeat });
  };
  $('#mpFold')?.addEventListener('click', () => send('FOLD'));
  $('#mpCall')?.addEventListener('click', () => send('CALL'));
  $('#mpRaise')?.addEventListener('click', () => send('BET_RAISE', (pub.minRaiseTo || callAmt + (room.config.bb || 20))));
}

function bindEmptySeatClicks() {
  const table = $('.table');
  if (!table || table.dataset.mpSitBound) return;
  table.dataset.mpSitBound = '1';
  // Use 6 hit zones around table — simplified: menu item alternative + numbered buttons
  const act = $('#act');
  if (act && !$('#mpSeatPick')) {
    const wrap = document.createElement('div');
    wrap.id = 'mpSeatPick';
    wrap.className = 'mp-seat-pick';
    wrap.innerHTML = [0, 1, 2, 3, 4, 5]
      .map((i) => `<button type="button" data-seat="${i}" class="mp-seat-btn">座位 ${i + 1}</button>`)
      .join('');
    act.appendChild(wrap);
    wrap.addEventListener('click', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      const seat = Number(t.getAttribute('data-seat'));
      if (Number.isInteger(seat)) sitDown(seat);
    });
  }
}

async function sitDown(seat) {
  const fb = getFirebase();
  const user = getUser();
  if (!fb || !user || !room) return;
  if (room.seatUids[seat]) {
    toast('座位已被佔用');
    return;
  }
  if (room.seatUids.includes(user.uid)) {
    toast('你已入座，要換位請先離座');
    return;
  }
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
      handNo: pub.handNo || 0,
      turn: pub.actionSeq || 0,
    });
    if (room.hostUid === user.uid) {
      await hostLoop?.seatPlayer(seat, user.uid);
    }
  } catch (e) {
    toast(String(e.message || '入座失敗'));
  }
}

async function requestLeave() {
  const user = getUser();
  if (!room || !user) return;
  const pub = room.pub || {};
  const mySeat = room.seatUids.indexOf(user.uid);
  if (mySeat < 0) return;
  if (room.hostUid === user.uid) {
    const others = room.seatUids.filter((u) => u && u !== user.uid);
    if (!others.length) {
      toast('先收桌，或等有人入座');
      return;
    }
  }
  await intents?.send({
    type: 'LEAVE',
    seat: mySeat,
    handNo: pub.handNo || 0,
    turn: pub.actionSeq || 0,
  });
  if (room.hostUid === user.uid) {
    // Host processes on HAND_OVER via host loop; if between hands, cash out now
    if (pub.phase === 'lobby' || pub.phase === 'hand_over') {
      const order = room.seatUids.filter((u) => u && u !== user.uid);
      await hostLoop?.cashoutSeat(mySeat, user.uid, { handOffTo: order[0] });
    }
  }
}

function renderBanner() {
  const el = $('#mpBanner');
  if (!el || !room) return;
  const user = getUser();
  if (hostShouldWarn(room.hostUid === user?.uid)) {
    el.hidden = false;
    el.textContent = `寫入次數偏高，約台北 ${resetTimeTaipeiLabel()} 重置`;
    return;
  }
  if (room.pub?.voided) {
    el.hidden = false;
    el.textContent = '這一手作廢，即將重新開局';
    return;
  }
  el.hidden = true;
}

async function doRescue() {
  const fb = getFirebase();
  const user = getUser();
  if (!fb || !user || !playerDoc?.tableRoomId) return;
  try {
    const id = playerDoc.tableRoomId;
    const snap = await fb.fs.getDoc(fb.fs.doc(fb.db, 'pokerRooms', id));
    if (!snap.exists()) throw new Error('房間不存在');
    await selfRescueCashout(fb, user.uid, { id, ...snap.data() });
    playerDoc = await getPlayer(fb, user.uid);
    toast('已結帳回帳戶');
    paint();
  } catch (e) {
    toast(String(e.message || '結帳失敗（可能未滿 10 分鐘）'));
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

function openSolo() {
  tearDownRoom();
  const root = $('#mpRoot');
  if (root) root.hidden = true;
  openSoloFn({ fromMp: true });
}

function leaveToLobby() {
  tearDownRoom();
  screen = 'lobby';
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
  room = null;
  roomId = null;
  prevPub = null;
  myHole = null;
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
  closeRoom(fb, room.id).then(() => leaveToLobby());
}
