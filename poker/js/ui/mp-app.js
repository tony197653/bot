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
  listenRoom,
  getLastRoom,
  rememberLastRoom,
  clearLastRoom,
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
import { styledConfirm } from './confirm-dialog.js';
import { MP_FX, mpDuration } from './fx-mp.js';
import { cardHtml, cardBackPair, heroBackPair, fmtChips } from './cards-dom.js';
import { mapSeatsClockwise } from './seating.js';
import { prefersReducedMotion } from './fx.js';
import { parseCard } from '../engine/cards.js';

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
let autoResumeTried = false;

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
    const last = getLastRoom();
    // Auto-resume open table after host refresh (QA round-2)
    if (
      last?.roomId &&
      playerDoc?.tableRoomId === last.roomId &&
      !rescueOk &&
      !autoResumeTried
    ) {
      autoResumeTried = true;
      enterRoom(last.roomId);
      return;
    }
    // Refresh rescue eligibility (host gone ≥10m) without blocking paint
    maybeRefreshRescue().then((changed) => {
      if (changed && screen === 'lobby') paint();
    });
    // Enrich seat labels for continue card
    const seatIdx =
      last && room?.seatUids
        ? room.seatUids.indexOf(authState.user?.uid)
        : last?.seat;
    renderMpLobby(root, {
      user: authState.user,
      player: playerDoc,
      lastRoom: last
        ? {
            ...last,
            name: room?.name || last.name,
            chips: playerDoc?.inPlay,
            seat: seatIdx >= 0 ? seatIdx : last.seat,
          }
        : null,
      leaderPreview,
      offline: authState.status === 'offline',
      rescueAvailable: rescueOk,
      rescueReason,
      rescueChips,
      onContinue: () => last && enterRoom(last.roomId),
      onCreate: () => {
        if (playerDoc?.tableRoomId && !rescueOk) {
          toast('先回到牌桌或等房主失聯後結帳');
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
    silenceSoloScreens();
    if (app) app.classList.remove('hidden');
    ensureMpMenu();
    paintTableChrome();
  }
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
    if (!snap.exists()) {
      const prev = rescueOk;
      rescueOk = true;
      rescueReason = 'gone';
      rescueChips = playerDoc?.inPlay ?? 0;
      return prev !== rescueOk;
    }
    const d = snap.data();
    const updatedMs = d.updatedAt?.toMillis?.() || 0;
    const seat = Array.isArray(d.seatUids) ? d.seatUids.indexOf(uid) : -1;
    const stackAmt =
      seat >= 0 && Array.isArray(d.stacks) ? Number(d.stacks[seat]) || 0 : null;
    const settled =
      stackAmt != null ? stackAmt : Number(playerDoc?.inPlay) || 0;
    const prev = rescueOk;
    if (d.status === 'closed') {
      rescueOk = true;
      rescueReason = 'closed';
      rescueChips = settled;
    } else if (Date.now() - updatedMs >= 10 * 60_000) {
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
        clearLastRoom();
        autoResumeTried = false;
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
            onChipMismatch: () => toast('籌碼對不上，請收桌'),
            onQuotaStop: () => toast('今天到這裡'),
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

  // Board + pot
  if (boardEl) {
    boardEl.innerHTML = (pub.board || [])
      .map((c) => cardHtml(c, { anim: false }))
      .join('');
  }
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
    el.innerHTML = `
      ${reveal || backs}
      <div class="plate plateA">
        <div class="av"><span>${esc(name.slice(0, 1))}</span></div>
        <div>
          <div class="nm">${esc(name)}${seat === room.seatUids.indexOf(room.hostUid) ? '<i class="mp-host-tag">房主</i>' : ''}${pending ? '<i class="mp-host-tag">排隊</i>' : ''}</div>
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
}

function SLOT_FALLBACK(seat, viewer) {
  const rel = (seat - viewer + 6) % 6;
  return { 0: 'hero', 1: 3, 2: 4, 3: 0, 4: 1, 5: 2 }[rel] ?? 0;
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

  if (mySeat < 0) {
    btns.innerHTML = `<div class="mp-spec">你正在觀戰，點牌桌上的空位就坐下<br><small>坐下時整筆帶入你的帳戶 ${fmtChips(playerDoc?.bank || 0)}</small></div>
      <button type="button" class="ghost" id="mpBtnLeaveLobby">回大廳</button>`;
    $('#mpBtnLeaveLobby')?.addEventListener('click', leaveToLobby);
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
    btns.innerHTML = `<button type="button" class="primary" id="mpStart">開始下一手（${seatedCount}人）</button>
      <button type="button" class="ghost" id="mpLeave">離座</button>
      ${(room.stacks[mySeat] || 0) === 0 ? `<button type="button" class="primary" id="mpTopup">申請補 2,000</button>` : ''}
      ${Object.keys(pub.topUpReqs || {})
        .map((s) => `<button type="button" class="primary" data-approve="${s}">核准補碼 座位${+s + 1}</button>`)
        .join('')}`;
    $('#mpStart')?.addEventListener('click', () => hostLoop?.startHand());
    $('#mpLeave')?.addEventListener('click', () => requestLeave());
    $('#mpTopup')?.addEventListener('click', () =>
      intents?.send({
        type: 'TOPUP_REQ',
        handNo: (Number(pub.handNo) || 0) | 0,
        turn: (Number(pub.actionSeq) || 0) | 0,
        seat: mySeat,
      }),
    );
    btns.querySelectorAll('[data-approve]').forEach((el) => {
      el.addEventListener('click', () => hostLoop?.approveTopUp(Number(el.getAttribute('data-approve'))));
    });
    return;
  }

  if (between) {
    const broke = (room.stacks[mySeat] || 0) === 0;
    btns.innerHTML = `
      ${broke ? `<button type="button" class="primary" id="mpTopup">申請補 2,000</button>` : ''}
      ${isHost && pub.topUpReqs ? Object.keys(pub.topUpReqs || {}).map((s) => `<button type="button" class="primary" data-approve="${s}">核准補碼 座位${+s + 1}</button>`).join('') : ''}
      <button type="button" class="ghost" id="mpLeave">離座</button>`;
    $('#mpTopup')?.addEventListener('click', () =>
      intents?.send({
        type: 'TOPUP_REQ',
        handNo: (Number(pub.handNo) || 0) | 0,
        turn: (Number(pub.actionSeq) || 0) | 0,
        seat: mySeat,
      }),
    );
    $('#mpLeave')?.addEventListener('click', () => requestLeave());
    btns.querySelectorAll('[data-approve]').forEach((el) => {
      el.addEventListener('click', () => hostLoop?.approveTopUp(Number(el.getAttribute('data-approve'))));
    });
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

function openMpRaise(minRaiseTo, send) {
  const panel = $('#raisePanel');
  const scrim = $('#raiseScrim');
  const range = $('#raiseRange');
  const out = $('#raiseOut');
  if (!panel || !range || !room) {
    send('BET_RAISE', minRaiseTo);
    return;
  }
  const mySeat = room.seatUids.indexOf(getUser()?.uid);
  const ps = room.pub?.seats?.[mySeat];
  const maxTo = (ps?.chips || 0) + (ps?.bet || 0);
  const minTo = Math.min(minRaiseTo, maxTo);
  range.min = String(minTo);
  range.max = String(Math.max(minTo, maxTo));
  range.value = String(minTo);
  range.step = String(room.config.bb || 20);
  if (out) out.textContent = fmtChips(minTo);
  const sync = () => {
    if (out) out.textContent = fmtChips(Number(range.value));
  };
  range.oninput = sync;
  panel.hidden = false;
  panel.inert = false;
  panel.removeAttribute('aria-hidden');
  if (scrim) {
    scrim.hidden = false;
    scrim.inert = false;
  }
  requestAnimationFrame(() => {
    panel.classList.add('is-on');
    scrim?.classList.add('is-on');
  });
  raiseOpen = true;
  const close = () => {
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
  $('#raiseCancel').onclick = () => {
    close();
    paintTableChrome();
  };
  $('#raiseConfirm').onclick = () => {
    const amt = Number(range.value);
    close();
    send('BET_RAISE', amt);
  };
  $('#raiseMinus').onclick = () => {
    range.value = String(Math.max(minTo, Number(range.value) - (room.config.bb || 20)));
    sync();
  };
  $('#raisePlus').onclick = () => {
    range.value = String(Math.min(maxTo, Number(range.value) + (room.config.bb || 20)));
    sync();
  };
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
      handNo: (Number(pub.handNo) || 0) | 0,
      turn: (Number(pub.actionSeq) || 0) | 0,
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
  // Raise panel lives outside #app — keep closed panels out of tab order
  const raise = $('#raisePanel');
  const scrim = $('#raiseScrim');
  if (raise && !raise.classList.contains('is-on')) {
    raise.inert = true;
    raise.setAttribute('aria-hidden', 'true');
    raise.hidden = true;
  }
  if (scrim && !scrim.classList.contains('is-on')) {
    scrim.inert = true;
    scrim.hidden = true;
  }
}

function openSolo() {
  tearDownRoom();
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

function leaveToLobby() {
  tearDownRoom();
  // Allow auto-resume only when still seated at an open table
  if (!playerDoc?.tableRoomId) autoResumeTried = false;
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
  animQ?.clear();
  animQ = null;
  room = null;
  roomId = null;
  prevPub = null;
  myHole = null;
  membersPanelOpen = false;
  removeMpMenuExtras();
}

function ensureMpMenu() {
  const pop = $('#menuPop');
  if (!pop || pop.dataset.mpMenu === '1') return;
  pop.dataset.mpMenu = '1';
  // Hide solo-only items in MP
  $('#btnTimerCfg')?.classList.add('hidden');
  $('#btnPauseMenu')?.classList.add('hidden');
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

  $('#btnLobby')?.addEventListener(
    'click',
    (e) => {
      if (!room) return;
      e.stopImmediatePropagation();
      closeMpMenu();
      leaveToLobby();
    },
    true,
  );
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

export async function mpCloseRoom() {
  if (!getFirebase() || !room) return;
  const ok = await styledConfirm({ title: '確定收桌？玩家將結帳回帳戶。', okText: '確認收桌' });
  const fb = getFirebase();
  if (!ok || !fb || !room) return;
  const id = room.id;
  closeRoom(fb, id)
    .then(() => {
      clearLastRoom();
      autoResumeTried = false;
      leaveToLobby();
    })
    .catch((e) => toast(String(e.message || '收桌失敗')));
}
