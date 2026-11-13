import { closeDisconnectedRoom, disconnectState, hostLivenessMs } from './host-disconnect.js';
/**
 * Create / join / extend / close rooms (§9.2 + 附錄 L3/L4/L7).
 */

import { DEFAULT_NEW_PLAYER_CHIPS } from './buyin-policy.js';
import { LS_PREFIX, isEmuMode } from './firebase-config.js';
import { recordWrite } from './quota.js';

const CODE_DIGITS = 3;
const CODE_ATTEMPTS = 10;
export const SINGLE_TABLE_CODE = '000';
const IDLE_CLOSE_MS = 30 * 60_000;
export const CREATE_TIMEOUT_MS = 15000;
export function createTimeoutMs() {
  return emuTimeout('createTimeoutMs', CREATE_TIMEOUT_MS);
}
export const HOST_ALONE_CLOSE_MS = 30 * 60_000;
function emuTimeout(name, fallback) {
  if (!isEmuMode()) return fallback;
  const value = Number(new URLSearchParams(location.search).get(name));
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
/** 閒置收桌門檻：正式站固定 30 分鐘；模擬器可用 ?staleMs= 縮短。 */
export function idleCloseMs() {
  return emuTimeout('staleMs', IDLE_CLOSE_MS);
}
export function hostAloneCloseMs() {
  return emuTimeout('aloneMs', HOST_ALONE_CLOSE_MS);
}
/** Lightweight lobby list docs (not full pokerRooms). Doc id = roomId. */
export const LOBBY_LIST_COL = 'pokerLobby';

function randomCode() {
  const n = Math.floor(Math.random() * 10 ** CODE_DIGITS);
  return String(n).padStart(CODE_DIGITS, '0');
}

function randomRoomId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = 'r';
  const buf = new Uint8Array(10);
  crypto.getRandomValues(buf);
  for (let i = 0; i < 10; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}

export function normalizeCode(code) {
  return String(code || '')
    .replace(/\D/g, '')
    .slice(0, CODE_DIGITS);
}

export function isRoomOpenStatus(status) {
  return status === 'lobby' || status === 'playing' || status === 'open';
}

/**
 * createRoom policy when hostRoomId already points at a room:
 * - resume: still active → return existing
 * - close-then-create: idle ≥30m → auto-close then create (never create while open)
 * - create: closed/missing
 */
export function hostRoomCreateDisposition(status, updatedMs, now = Date.now()) {
  if (!isRoomOpenStatus(status)) return 'create';
  if (now - (updatedMs || 0) >= IDLE_CLOSE_MS) return 'close-then-create';
  return 'resume';
}

/**
 * Build public lobby summary (附錄 L7).
 */
export function buildLobbySummary(room, { hostName, hostPhoto, seated } = {}) {
  const cfg = room?.config || {};
  const rawSeat =
    seated != null
      ? seated
      : (room?.seatUids || []).filter(Boolean).length;
  const seatN = Math.max(0, Math.min(6, Math.trunc(Number(rawSeat) || 0)));
  const photoRaw =
    hostPhoto !== undefined ? hostPhoto : room?.lobby?.hostPhoto;
  const photo =
    typeof photoRaw === 'string' && /^https:\/\//.test(photoRaw) ? photoRaw : '';
  return {
    name: String(room?.name || '週五牌局').slice(0, 20),
    hostName: String(hostName || room?.lobby?.hostName || '').slice(0, 60),
    hostPhoto: photo,
    blinds: String(`${cfg.sb ?? 10}/${cfg.bb ?? 20}`).slice(0, 15),
    seated: seatN,
  };
}

/**
 * Flat lobby-list fields (pokerLobby/{roomId}). Only these change the list UI.
 * @returns {{ name:string, code:string, blinds:string, seated:number, status:string,
 *   hostName:string, hostPhoto:string, hostUid:string }}
 */
export function buildLobbyListing(room, lobby, listStatus) {
  const L = lobby || room?.lobby || buildLobbySummary(room);
  const status =
    listStatus === 'playing' || room?.status === 'playing' ? 'playing' : 'lobby';
  return {
    name: String(L.name || room?.name || '週五牌局').slice(0, 20),
    code: String(room?.code || '').replace(/\D/g, '').slice(0, 6),
    blinds: String(L.blinds || '10/20').slice(0, 15),
    seated: Math.max(0, Math.min(6, Math.trunc(Number(L.seated) || 0))),
    status,
    hostName: String(L.hostName || '').slice(0, 60),
    hostPhoto:
      typeof L.hostPhoto === 'string' && /^https:\/\//.test(L.hostPhoto)
        ? L.hostPhoto
        : '',
    hostUid: String(room?.hostUid || ''),
  };
}

/** Fingerprint of lobby-visible fields — skip writes when unchanged. */
export function lobbyListingKey(fields) {
  if (!fields) return '';
  return [
    fields.status,
    fields.seated,
    fields.name,
    fields.code,
    fields.blinds,
    fields.hostName,
    fields.hostPhoto || '',
    fields.hostUid || '',
  ].join('|');
}

export async function upsertLobbyListing(fb, roomId, fields, { createdAt } = {}) {
  if (!fb || !roomId || !fields) return;
  const { db, fs } = fb;
  const ref = fs.doc(db, LOBBY_LIST_COL, roomId);
  const payload = {
    ...fields,
    updatedAt: fs.serverTimestamp(),
  };
  try {
    const snap = await fs.getDoc(ref);
    if (!snap.exists()) {
      await fs.setDoc(ref, {
        ...payload,
        createdAt: createdAt || fs.serverTimestamp(),
      });
    } else {
      await fs.updateDoc(ref, payload);
    }
    recordWrite();
    return true;
  } catch (e) {
    console.warn('[lobby] upsert listing', e);
    return false;
  }
}

/** Local suppress set: hide listings after we know the room closed (delete may lag). */
const closedLobbySuppress = new Set();

export function noteLobbyRoomClosed(roomId) {
  if (roomId) closedLobbySuppress.add(roomId);
}

export function isLobbyRoomSuppressed(roomId) {
  return !!roomId && closedLobbySuppress.has(roomId);
}

/** @visibleForTesting */
export function _resetLobbyClosedSuppress() {
  closedLobbySuppress.clear();
}

export async function deleteLobbyListing(fb, roomId) {
  if (!fb || !roomId) return;
  noteLobbyRoomClosed(roomId);
  const { db, fs } = fb;
  try {
    await fs.deleteDoc(fs.doc(db, LOBBY_LIST_COL, roomId));
    recordWrite();
  } catch {
    /* already gone */
  }
}

/** Stable open-table sort: createdAt asc, then id (never updatedAt). */
export function sortLobbyListings(rows) {
  return [...(rows || [])].sort((a, b) => {
    const am = a.createdAt?.toMillis?.() ?? a.createdAtMs ?? 0;
    const bm = b.createdAt?.toMillis?.() ?? b.createdAtMs ?? 0;
    if (am !== bm) return am - bm;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
}

/** 以既有大廳查詢找最早開桌；不將本機快取當作建立許可。 */
export async function findOpenTable(fb, uid) {
  const { db, fs } = fb;
  const snap = await fs.getDocs(fs.query(
    fs.collection(db, LOBBY_LIST_COL),
    fs.where('status', 'in', ['lobby', 'playing']),
    fs.orderBy('createdAt', 'asc'), fs.limit(20),
  ));
  const rows = [];
  snap.forEach(d => rows.push({ id: d.id, ...d.data() }));
  for (const table of sortLobbyListings(rows)) {
    if (await maybeAutoCloseSingleTable(fb, table.id, uid)) continue;
    return table;
  }
  return null;
}

async function joinExistingTable(fb, table, uid) {
  const result = await joinByRoomId(fb, table.id, uid);
  if (result.error || result.ended) throw new Error(result.error || '牌桌已結束');
  return { roomId: table.id, code: result.room.code, name: result.room.name,
    config: result.room.config, existing: true };
}

/** 固定房號鎖；房間可讀性在交易外判斷，回收合法性由既有規則核對。 */
export async function createSingleTable(fb, opts) {
  const existing = await findOpenTable(fb, opts.uid);
  if (existing) return joinExistingTable(fb, existing, opts.uid);
  const { db, fs } = fb;
  const codeRef = fs.doc(db, 'pokerCodes', SINGLE_TABLE_CODE);
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
    const snap = await fs.getDoc(codeRef);
    const lock = snap.exists() ? snap.data() : null;
    if (lock) {
      let room;
      try {
        room = await fs.getDoc(fs.doc(db, 'pokerRooms', lock.roomId));
      } catch (e) {
        if (!isPerm(e)) throw e;
        // 非成員無法讀取關閉／不存在的房間；交由 codeReclaimable 判定。
      }
      if (room?.exists() && isRoomOpenStatus(room.data().status)) {
        if (!await maybeAutoCloseSingleTable(fb, lock.roomId, opts.uid)) {
          return joinExistingTable(fb, { id: lock.roomId }, opts.uid);
        }
      }
    }
    try {
      return await createRoomWithLock(fb, opts, { codeRef, lock });
    } catch (e) {
      if (e?.code !== 'single-table-lock-changed') throw e;
      // SDK 重試看到新鎖時不覆寫，回讀並加入勝方。
    }
  }
  throw new Error('牌桌正在更新，請稍後再試');
}

/** T+2 原子退款；拒絕或競爭失敗由開桌流程繼續處理。 */
export async function maybeAutoCloseSingleTable(fb, roomId, uid, now = Date.now(), onStale) {
  try {
    const snap = await fb.fs.getDoc(fb.fs.doc(fb.db, 'pokerRooms', roomId));
    if (!snap.exists()) return true;
    const r = snap.data();
    if (r.status === 'closed') return true;
    const hp = await fb.fs.getDoc(fb.fs.doc(fb.db, 'pokerRooms', roomId, 'presence', r.hostUid));
    if (!disconnectState(hostLivenessMs(r, hp), now).reclaim) return false;
    const closed = await closeDisconnectedRoom({ ...fb, uid }, roomId, now);
    if (closed) { onStale?.(); await deleteLobbyListing(fb, roomId); }
    if (closed) return true;
    const latest = await fb.fs.getDoc(fb.fs.doc(fb.db, 'pokerRooms', roomId));
    return latest.exists() && latest.data().status === 'closed';
  } catch { return false; }
}

/** Lobby sweep: bounded reads; T+2 atomic cashout, restore visibility if closing fails. */
const lobbySweepState = new WeakMap();
export async function sweepStaleTable(fb, row, uid, now = Date.now(), onVisibilityChange = () => {}) {
  if (!fb || !uid || !row?.id || row.seatUids?.includes(uid)) return false;
  const checks = lobbySweepState.get(fb.db) || new Map();
  lobbySweepState.set(fb.db, checks);
  const previous = checks.get(row.id);
  if (previous?.inflight || (previous && now - previous.at < 10_000)) return false;
  const check = { at:now, inflight:true }; checks.set(row.id, check);
  try {
    const ref = fb.fs.doc(fb.db,'pokerRooms',row.id);
    const snap = await fb.fs.getDoc(ref);
    if (!snap.exists()) return false;
    const r = snap.data();
    if (r.seatUids?.includes(uid)) return false;
    if (r.status === 'closed') { noteLobbyRoomClosed(row.id); onVisibilityChange(); return true; }
    const hp = await fb.fs.getDoc(fb.fs.doc(fb.db,'pokerRooms',row.id,'presence',r.hostUid));
    const beat = hostLivenessMs(r, hp);
    const state = disconnectState(beat ?? now, now);
    const hidden = r.status === 'closed' || state.hidden;
    const was = closedLobbySuppress.has(row.id);
    if (hidden) closedLobbySuppress.add(row.id); else closedLobbySuppress.delete(row.id);
    if (hidden !== was) onVisibilityChange();
    if (state.reclaim && r.status !== 'closed' &&
        await closeDisconnectedRoom({...fb,uid},row.id,now)) await deleteLobbyListing(fb, row.id);
    return hidden;
  } catch {
    if (closedLobbySuppress.delete(row.id)) onVisibilityChange();
    return false;
  } finally { check.inflight = false; }
}

export function hostIsOnlySeated(room) {
  return !!room?.hostUid && room.seatUids?.includes(room.hostUid) &&
    !room.seatUids.some(uid => uid && uid !== room.hostUid);
}

export function hostAloneSince(room, now = Date.now()) {
  if (room?.code !== SINGLE_TABLE_CODE || !hostIsOnlySeated(room)) return null;
  if (Number.isFinite(room.pub?.hostAloneSince)) return room.pub.hostAloneSince;
  return room.pub?.handNo === 0 && !room.pub?.hostHadOtherSeats
    ? (room.createdAt?.toMillis?.() ?? now) : now;
}

async function codeIsFree(tx, fs, db, code) {
  const codeRef = fs.doc(db, 'pokerCodes', code);
  const codeSnap = await tx.get(codeRef);
  if (!codeSnap.exists()) return { free: true, codeRef };
  const c = codeSnap.data();
  const expMs = c.expiresAt?.toMillis?.() ?? 0;
  if (expMs < Date.now()) return { free: true, codeRef, reclaim: true };
  const roomSnap = await tx.get(fs.doc(db, 'pokerRooms', c.roomId));
  if (!roomSnap.exists() || roomSnap.data().status === 'closed') {
    return { free: true, codeRef, reclaim: true };
  }
  return { free: false, codeRef };
}

/**
 * @param {{ db:any, fs:any }} fb
 * @param {{ uid:string, name:string, sb:number, bb:number, newPlayerChips:number, displayName?:string, photoURL?:string|null }} opts
 * @returns {Promise<{ roomId:string, code:string, name:string, config:object, existing?:boolean }>}
 */
export async function createRoom(fb, opts) {
  return createRoomWithLock(fb, opts);
}

/** 重用房主指標檢查；交易內仍會再確認，避免並行開桌。 */
export async function findHostedOpenTable(fb, uid) {
  const { db, fs } = fb;
  const pref = fs.doc(db, 'pokerPlayers', uid);
  const pSnap = await fs.getDoc(pref);
  const existingHost = pSnap.exists() ? pSnap.data()?.hostRoomId : null;
  if (existingHost) {
    const existingRef = fs.doc(db, 'pokerRooms', existingHost);
    const er = await fs.getDoc(existingRef);
    if (er.exists()) {
      const rd = er.data();
      if (isRoomOpenStatus(rd.status)) {
        await maybeAutoCloseIdleRoom(fb, { id: existingHost, ...rd });
        const er2 = await fs.getDoc(existingRef);
        if (er2.exists() && isRoomOpenStatus(er2.data()?.status)) {
          const live = er2.data();
          rememberLastRoom(existingHost, live.code, { name: live.name });
          return {
            roomId: existingHost,
            code: live.code,
            name: live.name,
            config: live.config,
            existing: true,
          };
        }
        // closed → fall through and create a new table
      }
    }
  }
  return null;
}

async function createRoomWithLock(fb, opts, single = null) {
  const { db, fs } = fb;
  const name = (opts.name || '週五牌局').trim().slice(0, 20) || '週五牌局';
  const config = {
    sb: opts.sb,
    bb: opts.bb,
    newPlayerChips: opts.newPlayerChips ?? DEFAULT_NEW_PLAYER_CHIPS,
    actionMs: 30000,
    topUpAmount: 2000,
  };

  const pref = fs.doc(db, 'pokerPlayers', opts.uid);
  const hosted = await findHostedOpenTable(fb, opts.uid);
  if (hosted) return hosted;

  const profile = {
    displayName: String(opts.displayName || '玩家').slice(0, 60),
    photoURL: opts.photoURL && /^https:\/\//.test(opts.photoURL) ? opts.photoURL : null,
  };

  let lastErr = null;
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
    const code = single ? SINGLE_TABLE_CODE : randomCode();
    const roomId = randomRoomId();
    try {
      await fs.runTransaction(db, async (tx) => {
        let lockedCode;
        if (single) {
          // 必須是交易第一筆讀取；不在此讀取鎖所指的房間。
          const current = await tx.get(single.codeRef);
          const now = current.exists() ? current.data() : null;
          const unchanged = single.lock === null ? now === null : now !== null &&
            now.roomId === single.lock.roomId &&
            (now.expiresAt?.toMillis?.() ?? 0) === (single.lock.expiresAt?.toMillis?.() ?? 0);
          if (!unchanged) throw Object.assign(new Error('牌桌鎖已變更'), { code: 'single-table-lock-changed' });
          lockedCode = { free: true, codeRef: single.codeRef };
        }
        // Re-check hostRoomId inside txn — any still-open prior table blocks create
        const pNow = await tx.get(pref);
        if (pNow.exists()) {
          const hid = pNow.data()?.hostRoomId;
          if (hid) {
            const er = await tx.get(fs.doc(db, 'pokerRooms', hid));
            if (er.exists() && isRoomOpenStatus(er.data()?.status)) {
              const rd = er.data();
              throw Object.assign(new Error('already hosting'), {
                code: 'already-hosting',
                roomId: hid,
                roomCode: rd.code,
                roomName: rd.name,
                config: rd.config,
              });
            }
            // prior gone/closed → replace hostRoomId below
          }
        }

        const { free, codeRef, reclaim } = lockedCode || await codeIsFree(tx, fs, db, code);
        if (!free) throw Object.assign(new Error('code taken'), { code: 'taken' });

        const roomRef = fs.doc(db, 'pokerRooms', roomId);
        const codePayload = {
          roomId,
          hostUid: opts.uid,
          createdAt: fs.serverTimestamp(),
          expiresAt: fs.Timestamp.fromMillis(Date.now() + 24 * 3600e3),
        };
        if (reclaim) tx.set(codeRef, codePayload);
        else tx.set(codeRef, codePayload);

        const lobby = buildLobbySummary(
          { name, config },
          {
            hostName: profile.displayName,
            hostPhoto: profile.photoURL || '',
            seated: 0,
          },
        );

        tx.set(roomRef, {
          name,
          code,
          hostUid: opts.uid,
          hostSince: fs.serverTimestamp(),
          members: [opts.uid],
          seatUids: ['', '', '', '', '', ''],
          status: 'lobby',
          config,
          rev: 0,
          createdAt: fs.serverTimestamp(),
          updatedAt: fs.serverTimestamp(),
          pub: {
            phase: 'lobby',
            handNo: 0,
            actionSeq: 0,
            seats: [null, null, null, null, null, null],
            board: [],
            away: {},
            seatedAt: [0, 0, 0, 0, 0, 0],
            pendingSeats: [],
            topUpReqs: {},
            rejects: {},
          },
          deadlineAt: null,
          stacks: [0, 0, 0, 0, 0, 0],
          chipTotal: 0,
          sess: [null, null, null, null, null, null],
          lastMoneyEvent: null,
          lobby,
        });
        // Lightweight lobby list (listenOpenTables) — not full room pub/stacks
        tx.set(fs.doc(db, LOBBY_LIST_COL, roomId), {
          ...buildLobbyListing(
            { name, code, hostUid: opts.uid, status: 'lobby', config },
            lobby,
            'lobby',
          ),
          createdAt: fs.serverTimestamp(),
          updatedAt: fs.serverTimestamp(),
        });

        // Rules: create requires getAfter(player).hostRoomId == roomId in same txn
        if (pNow.exists()) {
          tx.update(pref, {
            hostRoomId: roomId,
            updatedAt: fs.serverTimestamp(),
          });
        } else {
          const grantId = `${roomId}_0_grant`;
          tx.set(pref, {
            displayName: profile.displayName,
            photoURL: profile.photoURL,
            bank: config.newPlayerChips,
            inPlay: 0,
            total: config.newPlayerChips,
            tableRoomId: null,
            sessionNo: 0,
            topUps: 0,
            topUpChips: 0,
            handsPlayed: 0,
            lastRoomId: roomId,
            hostRoomId: roomId,
            createdAt: fs.serverTimestamp(),
            updatedAt: fs.serverTimestamp(),
          });
          tx.set(fs.doc(db, 'pokerPlayers', opts.uid, 'ledger', grantId), {
            type: 'grant',
            amount: config.newPlayerChips,
            roomId,
            sessionNo: 0,
            seat: null,
            buyIn: null,
            topUps: null,
            topUpChips: null,
            hands: null,
            nightKey: null,
            bankAfter: config.newPlayerChips,
            by: opts.uid,
            at: fs.serverTimestamp(),
          });
        }
      });
      recordWrite();
      rememberLastRoom(roomId, code, { name });
      return { roomId, code, name, config };
    } catch (e) {
      lastErr = e;
      if (e?.code === 'already-hosting') {
        rememberLastRoom(e.roomId, e.roomCode, { name: e.roomName });
        return {
          roomId: e.roomId,
          code: e.roomCode,
          name: e.roomName,
          config: e.config,
          existing: true,
        };
      }
      if (e?.code === 'taken' || /taken|already/i.test(String(e?.message))) continue;
      throw e;
    }
  }
  throw Object.assign(lastErr || new Error('牌桌太多'), {
    code: 'too-many-tables',
    message: '現在牌桌太多，房號暫時用完了，請稍後再按一次開房',
  });
}

/**
 * Join order §9.2: code → resolve roomId → explicit arrayUnion if not member → get.
 * New client never relies on get denial; legacy open rooms still deny non-member get
 * so main 9ac534c's catch→arrayUnion path keeps working under these rules.
 * L7: 3-digit codes; if expectedRoomId mismatches current mapping → 牌桌已結束.
 */
export async function joinByCode(fb, code, uid, expectedRoomId = null) {
  const { db, fs } = fb;
  const digits = normalizeCode(code);
  if (digits.length !== CODE_DIGITS) {
    return { roomId: null, error: `請輸入 ${CODE_DIGITS} 位房號` };
  }

  const codeSnap = await fs.getDoc(fs.doc(db, 'pokerCodes', digits));
  if (!codeSnap.exists()) {
    return {
      roomId: null,
      error: '找不到這個房號。請確認數字，或請房主重新分享連結。',
    };
  }
  const c = codeSnap.data();
  const expMs = c.expiresAt?.toMillis?.() ?? 0;
  if (expMs < Date.now()) {
    return { roomId: null, ended: true, error: '牌桌已結束' };
  }
  // L7: old share link with mismatched r after code reuse
  if (expectedRoomId && c.roomId !== expectedRoomId) {
    return { roomId: null, ended: true, error: '牌桌已結束' };
  }
  const roomId = c.roomId;
  const roomRef = fs.doc(db, 'pokerRooms', roomId);

  // Probe: member / closed / already-readable lobby|playing. Ignore perm-denied (legacy open).
  let knownMember = false;
  try {
    const roomSnap = await fs.getDoc(roomRef);
    if (roomSnap.exists()) {
      const room = { id: roomId, ...roomSnap.data() };
      if (room.status === 'closed') {
        return { roomId, ended: true, error: '牌桌已結束' };
      }
      if (room.seatUids?.filter(Boolean).length >= 6 && !room.seatUids.includes(uid)) {
        return { roomId, error: '這桌已滿，請選其他牌桌' };
      }
      if (room.members?.includes(uid)) {
        rememberLastRoom(roomId, digits, { name: room.name });
        return { roomId, room };
      }
      knownMember = false;
    }
  } catch (e) {
    if (!isPerm(e)) throw e;
  }

  // Explicit join — do not depend on get being denied
  if (!knownMember) {
    try {
      await fs.updateDoc(roomRef, {
        members: fs.arrayUnion(uid),
      });
      recordWrite();
    } catch (e) {
      if (isPerm(e)) return { roomId, ended: true, error: '牌桌已結束' };
      throw e;
    }
  }

  const roomSnap = await fs.getDoc(roomRef);
  if (!roomSnap.exists() || roomSnap.data().status === 'closed') {
    return { roomId, ended: true, error: '牌桌已結束' };
  }
  rememberLastRoom(roomId, digits, { name: roomSnap.data().name });
  return { roomId, room: { id: roomId, ...roomSnap.data() } };
}

/** 加入牌桌後選擇座位；滿桌僅允許原在座玩家重連。 */
export async function joinByRoomId(fb, roomId, uid) {
  const { db, fs } = fb;
  const ref = fs.doc(db, 'pokerRooms', roomId);
  const snap = await fs.getDoc(ref);
  if (!snap.exists() || snap.data().status === 'closed') {
    return { roomId, ended: true, error: '牌桌已結束' };
  }
  const room = { id: roomId, ...snap.data() };
  if (room.seatUids?.filter(Boolean).length >= 6 && !room.seatUids.includes(uid)) {
    return { roomId, error: '這桌已滿，請選其他牌桌' };
  }
  if (!room.members?.includes(uid)) {
    try {
      await fs.updateDoc(ref, { members: fs.arrayUnion(uid) });
      recordWrite();
    } catch (e) {
      if (isPerm(e)) return { roomId, ended: true, error: '牌桌已結束' };
      throw e;
    }
  }
  rememberLastRoom(roomId, room.code, { name: room.name });
  return { roomId, room };
}

export function shareUrl(code, roomId) {
  const u = new URL(location.href);
  u.search = '';
  u.hash = '';
  if (!/\/poker\/?$/.test(u.pathname)) {
    u.pathname = u.pathname.replace(/\/?$/, '/').includes('/poker/')
      ? u.pathname
      : `${u.pathname.replace(/\/$/, '')}/poker/`;
  }
  u.searchParams.set('room', code);
  u.searchParams.set('r', roomId);
  return u.toString();
}

export async function extendCode(fb, code, hostUid) {
  const { db, fs } = fb;
  await fs.updateDoc(fs.doc(db, 'pokerCodes', normalizeCode(code)), {
    expiresAt: fs.Timestamp.fromMillis(Date.now() + 24 * 3600e3),
  });
  recordWrite();
}

export async function expireCodeNow(fb, code) {
  const { db, fs } = fb;
  await fs.updateDoc(fs.doc(db, 'pokerCodes', normalizeCode(code)), {
    expiresAt: fs.serverTimestamp(),
  });
  recordWrite();
}

export async function closeRoom(fb, roomId, { auto = false, closedRoom = null } = {}) {
  const { db, fs } = fb;
  const ref = fs.doc(db, 'pokerRooms', roomId);
  const snap = closedRoom ? { exists: () => true, data: () => closedRoom } : await fs.getDoc(ref);
  if (!snap.exists()) {
    await deleteLobbyListing(fb, roomId);
    return;
  }
  const r = snap.data();
  // Always drop lobby listing — even if room was already closed by another path
  if (r.status === 'closed' && !closedRoom) {
    await deleteLobbyListing(fb, roomId);
    return;
  }
  if (closedRoom) {
    // 整桌 batch 已原子關房；接續既有清理。
  } else if (auto) {
    await fs.updateDoc(ref, {
      status: 'closed',
      closedBy: 'auto',
      closedAt: fs.serverTimestamp(),
    });
  } else {
    await fs.updateDoc(ref, {
      status: 'closed',
      rev: r.rev + 1,
      updatedAt: fs.serverTimestamp(),
    });
  }
  recordWrite();
  await deleteLobbyListing(fb, roomId);
  if (r.code) {
    try {
      await expireCodeNow(fb, r.code);
    } catch {
      /* code may already be reclaimed */
    }
  }
  // Clear hostRoomId for former host when possible
  if (r.hostUid) {
    try {
      const pref = fs.doc(db, 'pokerPlayers', r.hostUid);
      const ps = await fs.getDoc(pref);
      if (ps.exists() && ps.data()?.hostRoomId === roomId) {
        await fs.updateDoc(pref, {
          hostRoomId: null,
          updatedAt: fs.serverTimestamp(),
        });
        recordWrite();
      }
    } catch {
      /* non-host closer can't clear another's hostRoomId; host clears on next paint */
    }
  }
}

/**
 * L4: if room idle ≥30m (updatedAt + all member presence), auto-close.
 * @returns {Promise<boolean>} true if closed
 */
export async function maybeAutoCloseIdleRoom(fb, room, now = Date.now(), staleMs = idleCloseMs(), onStale) {
  if (!room?.id || room.status === 'closed') return false;
  return maybeAutoCloseSingleTable(fb, room.id, fb.auth?.currentUser?.uid || fb.uid, now, onStale);
}

/**
 * Live list of joinable tables (附錄 L7).
 * Reads pokerLobby summaries only (stable createdAt order — not full room pubs).
 */
export function listenOpenTables(fb, onRows, onErr) {
  const { db, fs } = fb;
  const q = fs.query(
    fs.collection(db, LOBBY_LIST_COL),
    fs.where('status', 'in', ['lobby', 'playing']),
    fs.orderBy('createdAt', 'asc'),
    fs.limit(20),
  );
  return fs.onSnapshot(
    q,
    (snap) => {
      const rows = [];
      snap.forEach((d) => {
        const data = d.data() || {};
        // Defensive: never show suppressed / closed leftovers
        // Keep hidden rows in sweep input so a fresh host heartbeat can restore them.
        if (data.status === 'closed') return;
        rows.push({ id: d.id, ...data });
      });
      onRows(sortLobbyListings(rows));
    },
    (err) => onErr?.(err),
  );
}

export function listenRoom(fb, roomId, onData, onErr) {
  const { db, fs } = fb;
  return fs.onSnapshot(
    fs.doc(db, 'pokerRooms', roomId),
    (snap) => {
      if (!snap.exists()) {
        onErr?.(new Error('房間不存在'));
        return;
      }
      onData({ id: snap.id, ...snap.data() }, snap.metadata);
    },
    (err) => onErr?.(err),
  );
}

export function rememberLastRoom(roomId, code, extra = {}) {
  try {
    localStorage.setItem(
      `${LS_PREFIX}.lastRoom`,
      JSON.stringify({
        roomId,
        code,
        at: Date.now(),
        name: extra.name || '',
        seat: extra.seat ?? null,
        chips: extra.chips ?? null,
      }),
    );
  } catch {
    /* ignore */
  }
}

export function clearLastRoom() {
  try {
    localStorage.removeItem(`${LS_PREFIX}.lastRoom`);
  } catch {
    /* ignore */
  }
}

export function getLastRoom() {
  try {
    const raw = localStorage.getItem(`${LS_PREFIX}.lastRoom`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function isPerm(e) {
  return e?.code === 'permission-denied' || /permission/i.test(String(e?.message || ''));
}

/** Format code with optional middle space for 6-digit legacy; 3-digit as-is. */
export function formatCode(code) {
  const d = String(code).replace(/\D/g, '');
  if (d.length <= 3) return d.padStart(CODE_DIGITS, '0').slice(0, CODE_DIGITS);
  const six = d.padStart(6, '0').slice(0, 6);
  return `${six.slice(0, 3)} ${six.slice(3)}`;
}

export const ROOM_CONST = { CODE_DIGITS, CODE_ATTEMPTS, IDLE_CLOSE_MS };
