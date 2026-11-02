/**
 * Create / join / extend / close rooms (§9.2 + 附錄 L3/L4/L7).
 */

import { LS_PREFIX } from './firebase-config.js';
import { recordWrite } from './quota.js';

const CODE_DIGITS = 3;
const CODE_ATTEMPTS = 10;
const IDLE_CLOSE_MS = 30 * 60_000;

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
 * Build public lobby summary (附錄 L7).
 */
export function buildLobbySummary(room, { hostName, hostPhoto, seated } = {}) {
  const cfg = room?.config || {};
  const seatN =
    seated != null
      ? seated
      : (room?.seatUids || []).filter(Boolean).length;
  return {
    name: room?.name || '週五牌局',
    hostName: hostName || room?.lobby?.hostName || '',
    hostPhoto: hostPhoto !== undefined ? hostPhoto : room?.lobby?.hostPhoto ?? null,
    blinds: `${cfg.sb ?? 10}/${cfg.bb ?? 20}`,
    seated: seatN,
  };
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
  const { db, fs } = fb;
  const name = (opts.name || '週五牌局').trim().slice(0, 20) || '週五牌局';
  const config = {
    sb: opts.sb,
    bb: opts.bb,
    newPlayerChips: opts.newPlayerChips,
    actionMs: 30000,
    topUpAmount: 2000,
  };

  // L3: already hosting an open table → return it
  const pref = fs.doc(db, 'pokerPlayers', opts.uid);
  const pSnap = await fs.getDoc(pref);
  const existingHost = pSnap.exists() ? pSnap.data()?.hostRoomId : null;
  if (existingHost) {
    const er = await fs.getDoc(fs.doc(db, 'pokerRooms', existingHost));
    if (er.exists()) {
      const rd = er.data();
      const updatedMs = rd.updatedAt?.toMillis?.() || 0;
      const idle = Date.now() - updatedMs >= IDLE_CLOSE_MS;
      if (isRoomOpenStatus(rd.status) && !idle) {
        rememberLastRoom(existingHost, rd.code, { name: rd.name });
        return {
          roomId: existingHost,
          code: rd.code,
          name: rd.name,
          config: rd.config,
          existing: true,
        };
      }
    }
  }

  let lastErr = null;
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
    const code = randomCode();
    const roomId = randomRoomId();
    try {
      await fs.runTransaction(db, async (tx) => {
        // Re-check hostRoomId inside txn
        const pNow = await tx.get(pref);
        if (pNow.exists()) {
          const hid = pNow.data()?.hostRoomId;
          if (hid) {
            const er = await tx.get(fs.doc(db, 'pokerRooms', hid));
            if (er.exists()) {
              const rd = er.data();
              const updatedMs = rd.updatedAt?.toMillis?.() || 0;
              if (isRoomOpenStatus(rd.status) && Date.now() - updatedMs < IDLE_CLOSE_MS) {
                throw Object.assign(new Error('already hosting'), {
                  code: 'already-hosting',
                  roomId: hid,
                  roomCode: rd.code,
                  roomName: rd.name,
                  config: rd.config,
                });
              }
            }
          }
        }

        const { free, codeRef, reclaim } = await codeIsFree(tx, fs, db, code);
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
            hostName: opts.displayName || '',
            hostPhoto: opts.photoURL ?? null,
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

        if (pNow.exists()) {
          tx.update(pref, {
            hostRoomId: roomId,
            updatedAt: fs.serverTimestamp(),
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
  throw Object.assign(lastErr || new Error('牌桌太多，稍後再試'), {
    code: 'too-many-tables',
    message: '牌桌太多，稍後再試',
  });
}

/**
 * Join order §9.2: code → try get room → else arrayUnion members.
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

  try {
    const roomSnap = await fs.getDoc(fs.doc(db, 'pokerRooms', roomId));
    if (roomSnap.exists()) {
      const room = { id: roomId, ...roomSnap.data() };
      if (room.status === 'closed') {
        return { roomId, ended: true, error: '牌桌已結束' };
      }
      if (room.members?.includes(uid)) {
        rememberLastRoom(roomId, digits, { name: room.name });
        return { roomId, room };
      }
    }
  } catch (e) {
    if (!isPerm(e)) throw e;
  }

  try {
    await fs.updateDoc(fs.doc(db, 'pokerRooms', roomId), {
      members: fs.arrayUnion(uid),
    });
    recordWrite();
  } catch (e) {
    if (isPerm(e)) return { roomId, ended: true, error: '牌桌已結束' };
    throw e;
  }

  const roomSnap = await fs.getDoc(fs.doc(db, 'pokerRooms', roomId));
  if (!roomSnap.exists() || roomSnap.data().status === 'closed') {
    return { roomId, ended: true, error: '牌桌已結束' };
  }
  rememberLastRoom(roomId, digits, { name: roomSnap.data().name });
  return { roomId, room: { id: roomId, ...roomSnap.data() } };
}

/** Join open room by id (list row → spectator). */
export async function joinByRoomId(fb, roomId, uid) {
  const { db, fs } = fb;
  const ref = fs.doc(db, 'pokerRooms', roomId);
  const snap = await fs.getDoc(ref);
  if (!snap.exists() || snap.data().status === 'closed') {
    return { roomId, ended: true, error: '牌桌已結束' };
  }
  const room = { id: roomId, ...snap.data() };
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

export async function closeRoom(fb, roomId, { auto = false } = {}) {
  const { db, fs } = fb;
  const ref = fs.doc(db, 'pokerRooms', roomId);
  const snap = await fs.getDoc(ref);
  if (!snap.exists()) return;
  const r = snap.data();
  if (r.status === 'closed') return;
  if (auto) {
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
export async function maybeAutoCloseIdleRoom(fb, room) {
  if (!room?.id || room.status === 'closed') return false;
  const updatedMs = room.updatedAt?.toMillis?.() || 0;
  if (Date.now() - updatedMs < IDLE_CLOSE_MS) return false;
  const { db, fs } = fb;
  try {
    const pres = await fs.getDocs(
      fs.collection(db, 'pokerRooms', room.id, 'presence'),
    );
    for (const d of pres.docs) {
      const beat = d.data()?.beat?.toMillis?.() || 0;
      if (Date.now() - beat < IDLE_CLOSE_MS) return false;
    }
    await closeRoom(fb, room.id, { auto: true });
    return true;
  } catch {
    return false;
  }
}

/** Live list of joinable tables (附錄 L7). */
export function listenOpenTables(fb, onRows, onErr) {
  const { db, fs } = fb;
  const q = fs.query(
    fs.collection(db, 'pokerRooms'),
    fs.where('status', 'in', ['lobby', 'playing']),
    fs.orderBy('updatedAt', 'desc'),
    fs.limit(20),
  );
  return fs.onSnapshot(
    q,
    (snap) => {
      const cutoff = Date.now() - IDLE_CLOSE_MS;
      const rows = [];
      snap.forEach((d) => {
        const data = d.data();
        const ms = data.updatedAt?.toMillis?.() || 0;
        if (ms < cutoff) return;
        rows.push({ id: d.id, ...data });
      });
      onRows(rows);
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
      onData({ id: snap.id, ...snap.data() });
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
