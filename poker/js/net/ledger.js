/**
 * Chip cashier: grant / buyin / topup / cashout / self-rescue (§6.10).
 * Ledger ids are fixed → idempotent (permission-denied + exists = success).
 */

import { LS_PREFIX } from './firebase-config.js';
import { deleteLobbyListing } from './room.js';

/**
 * Taipei night key: day rolls at 06:00 (§6.10.4).
 * @param {Date|number} [when]
 */
export function nightKeyOf(when = Date.now()) {
  const d = new Date(when);
  // Shift back 6h so 00:00–05:59 count as previous calendar day
  const shifted = new Date(d.getTime() - 6 * 3600e3);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(shifted);
  const y = parts.find((p) => p.type === 'year').value;
  const m = parts.find((p) => p.type === 'month').value;
  const day = parts.find((p) => p.type === 'day').value;
  return `${y}${m}${day}`;
}

function isDenied(e) {
  const c = e?.code || '';
  return c === 'permission-denied' || /permission/i.test(String(e?.message || ''));
}

/**
 * @param {{ db: any, fs: any }} fb
 * @param {string} uid
 * @param {string} roomId
 * @param {number} n newPlayerChips
 * @param {{ displayName: string, photoURL: string|null }} profile
 */
export async function ensurePlayerGrant(fb, uid, roomId, n, profile) {
  const { db, fs } = fb;
  const pref = fs.doc(db, 'pokerPlayers', uid);
  const snap = await fs.getDoc(pref);
  if (snap.exists()) return { created: false, player: snap.data() };

  const id = `${roomId}_0_grant`;
  const batch = fs.writeBatch(db);
  batch.set(pref, {
    displayName: profile.displayName.slice(0, 60),
    photoURL: profile.photoURL,
    bank: n,
    inPlay: 0,
    total: n,
    tableRoomId: null,
    sessionNo: 0,
    topUps: 0,
    topUpChips: 0,
    handsPlayed: 0,
    lastRoomId: roomId,
    hostRoomId: null,
    createdAt: fs.serverTimestamp(),
    updatedAt: fs.serverTimestamp(),
  });
  batch.set(fs.doc(db, 'pokerPlayers', uid, 'ledger', id), {
    type: 'grant',
    amount: n,
    roomId,
    sessionNo: 0,
    seat: null,
    buyIn: null,
    topUps: null,
    topUpChips: null,
    hands: null,
    nightKey: null,
    bankAfter: n,
    by: uid,
    at: fs.serverTimestamp(),
  });
  try {
    await batch.commit();
  } catch (e) {
    if (!isDenied(e)) throw e;
    const again = await fs.getDoc(pref);
    if (again.exists()) return { created: false, player: again.data() };
    throw e;
  }
  cachePlayer(uid, { bank: n, inPlay: 0, total: n, tableRoomId: null });
  return { created: true, player: { bank: n, inPlay: 0, total: n, tableRoomId: null, sessionNo: 0 } };
}

/**
 * Whole-bank buy-in (§6.10 scheme ①).
 */
export async function buyinAll(fb, uid, roomId) {
  const { db, fs } = fb;
  const pref = fs.doc(db, 'pokerPlayers', uid);
  const snap = await fs.getDoc(pref);
  if (!snap.exists()) throw new Error('還沒有帳戶');
  const p = snap.data();
  if (p.tableRoomId === roomId) {
    return { skipped: true, amount: p.inPlay, sessionNo: p.sessionNo };
  }
  if (p.tableRoomId != null) throw new Error('你還在別桌，請先結帳離開');

  const no = p.sessionNo + 1;
  const amount = p.bank;
  const id = `${roomId}_${no}_buyin`;
  const batch = fs.writeBatch(db);
  batch.update(pref, {
    bank: 0,
    inPlay: amount,
    tableRoomId: roomId,
    sessionNo: no,
    lastRoomId: roomId,
    updatedAt: fs.serverTimestamp(),
  });
  batch.set(fs.doc(db, 'pokerPlayers', uid, 'ledger', id), {
    type: 'buyin',
    amount,
    roomId,
    sessionNo: no,
    seat: null,
    buyIn: null,
    topUps: null,
    topUpChips: null,
    hands: null,
    nightKey: null,
    bankAfter: 0,
    by: uid,
    at: fs.serverTimestamp(),
  });
  try {
    await batch.commit();
  } catch (e) {
    if (!isDenied(e)) throw e;
    const led = await fs.getDoc(fs.doc(db, 'pokerPlayers', uid, 'ledger', id));
    if (led.exists()) {
      const again = (await fs.getDoc(pref)).data();
      return { skipped: false, amount: again.inPlay, sessionNo: again.sessionNo, idempotent: true };
    }
    throw e;
  }
  cachePlayer(uid, { bank: 0, inPlay: amount, total: p.total, tableRoomId: roomId, sessionNo: no, lastRoomId: roomId });
  return { skipped: false, amount, sessionNo: no };
}

/**
 * Host (or self) cashout batch: room seat clear + ledger + player + night.
 * Caller supplies room mutation fields already computed.
 */
export async function hostCashoutBatch(fb, {
  hostUid,
  roomId,
  seat,
  uid,
  roomPatch,
  sessRow,
  amount,
  playerName,
}) {
  const { db, fs } = fb;
  const id = `${roomId}_${sessRow.sessionNo}_cashout`;
  const pref = fs.doc(db, 'pokerPlayers', uid);
  const pSnap = await fs.getDoc(pref);
  const p = pSnap.data();
  // Already self-rescued → only clear seat (caller should skip account writes)
  if (!p?.tableRoomId) {
    return { alreadyCashed: true, id };
  }

  const batch = fs.writeBatch(db);
  batch.update(fs.doc(db, 'pokerRooms', roomId), {
    ...roomPatch,
    updatedAt: fs.serverTimestamp(),
  });
  batch.set(fs.doc(db, 'pokerPlayers', uid, 'ledger', id), {
    type: 'cashout',
    amount,
    roomId,
    sessionNo: sessRow.sessionNo,
    seat,
    buyIn: sessRow.buyIn,
    topUps: sessRow.topUps,
    topUpChips: sessRow.topUpChips,
    hands: sessRow.hands,
    nightKey: sessRow.nightKey,
    bankAfter: p.bank + amount,
    by: hostUid,
    at: fs.serverTimestamp(),
  });
  batch.update(pref, {
    bank: p.bank + amount,
    inPlay: 0,
    total: p.bank + amount,
    tableRoomId: null,
    topUps: p.topUps + sessRow.topUps,
    topUpChips: p.topUpChips + sessRow.topUpChips,
    handsPlayed: p.handsPlayed + sessRow.hands,
    updatedAt: fs.serverTimestamp(),
  });
  const nref = fs.doc(db, 'pokerPlayers', uid, 'nights', sessRow.nightKey);
  const nSnap = await fs.getDoc(nref);
  const base = nSnap.exists()
    ? nSnap.data()
    : { buyIn: 0, cashOut: 0, topUps: 0, hands: 0, lastEntry: '' };
  batch.set(nref, {
    nightKey: sessRow.nightKey,
    uid,
    name: (playerName || '玩家').slice(0, 60),
    buyIn: base.buyIn + sessRow.buyIn + sessRow.topUpChips,
    cashOut: base.cashOut + amount,
    net: base.cashOut + amount - (base.buyIn + sessRow.buyIn + sessRow.topUpChips),
    topUps: base.topUps + sessRow.topUps,
    hands: base.hands + sessRow.hands,
    lastEntry: id,
    updatedAt: fs.serverTimestamp(),
  });
  try {
    await batch.commit();
  } catch (e) {
    if (!isDenied(e)) throw e;
    const led = await fs.getDoc(fs.doc(db, 'pokerPlayers', uid, 'ledger', id));
    if (led.exists()) return { alreadyCashed: false, id, idempotent: true };
    throw e;
  }
  return { alreadyCashed: false, id };
}

/** 整桌結算：prepareClose 的房間快照＋平行帳戶／晚間紀錄讀取＋單次原子寫入。 */
export async function hostCloseAllBatch(fb, { hostUid, roomId, room, displayNameOf }) {
  if (room.status === 'closed') return { skipped: true };
  if (room.hostUid !== hostUid || !['lobby', 'hand_over'].includes(room.pub?.phase)) {
    throw new Error('結算尚未同步，請重試收桌');
  }
  const { db, fs } = fb;
  const rows = await Promise.all(room.seatUids.map(async (uid, seat) => {
    if (!uid) return null;
    const sessRow = room.sess[seat];
    if (!sessRow) throw new Error('座位帳資料缺失');
    const pref = fs.doc(db, 'pokerPlayers', uid);
    const nref = fs.doc(db, 'pokerPlayers', uid, 'nights', sessRow.nightKey);
    const [pSnap, nSnap] = await Promise.all([fs.getDoc(pref), fs.getDoc(nref)]);
    const p = pSnap.data();
    if (!p) throw new Error('玩家帳戶缺失');
    if (p.tableRoomId == null) return null;
    if (p.tableRoomId !== roomId || p.sessionNo !== sessRow.sessionNo) {
      throw new Error('玩家帳戶與座位帳不同步');
    }
    return { uid, seat, sessRow, pref, nref, nSnap, p };
  }));
  const batch = fs.writeBatch(db);
  const roomPatch = {
    status: 'closed', rev: room.rev + 1, updatedAt: fs.serverTimestamp(),
    seatUids: ['', '', '', '', '', ''], stacks: [0, 0, 0, 0, 0, 0],
    chipTotal: 0, sess: [null, null, null, null, null, null],
    deadlineAt: null, lastMoneyEvent: { type: 'closeAll' },
  };
  batch.update(fs.doc(db, 'pokerRooms', roomId), roomPatch);
  for (const row of rows) {
    if (!row) continue;
    const { uid, seat, sessRow, pref, nref, nSnap, p } = row;
    const id = `${roomId}_${sessRow.sessionNo}_cashout`;
    const amount = room.stacks[seat];
    const playerName = displayNameOf?.(uid);
    batch.set(fs.doc(db, 'pokerPlayers', uid, 'ledger', id), {
      type: 'cashout',
      amount,
      roomId,
      sessionNo: sessRow.sessionNo,
      seat,
      buyIn: sessRow.buyIn,
      topUps: sessRow.topUps,
      topUpChips: sessRow.topUpChips,
      hands: sessRow.hands,
      nightKey: sessRow.nightKey,
      bankAfter: p.bank + amount,
      by: hostUid,
      at: fs.serverTimestamp(),
    });
    batch.update(pref, {
      bank: p.bank + amount,
      inPlay: 0,
      total: p.bank + amount,
      tableRoomId: null,
      topUps: p.topUps + sessRow.topUps,
      topUpChips: p.topUpChips + sessRow.topUpChips,
      handsPlayed: p.handsPlayed + sessRow.hands,
      updatedAt: fs.serverTimestamp(),
    });
    const base = nSnap.exists()
      ? nSnap.data()
      : { buyIn: 0, cashOut: 0, topUps: 0, hands: 0, lastEntry: '' };
    batch.set(nref, {
      nightKey: sessRow.nightKey,
      uid,
      name: (playerName || '玩家').slice(0, 60),
      buyIn: base.buyIn + sessRow.buyIn + sessRow.topUpChips,
      cashOut: base.cashOut + amount,
      net: base.cashOut + amount - (base.buyIn + sessRow.buyIn + sessRow.topUpChips),
      topUps: base.topUps + sessRow.topUps,
      hands: base.hands + sessRow.hands,
      lastEntry: id,
      updatedAt: fs.serverTimestamp(),
    });
  }
  await batch.commit();
  return { skipped: false, room: { ...room, ...roomPatch } };
}

/**
 * After a room is closed (or missing): move this player's table chips back to
 * bank. Idempotent via fixed ledger id — safe to call from close dialog, 回大廳,
 * and lobby paint. Never double-credits.
 *
 * @returns {Promise<{ ok: boolean, amount?: number, skipped?: boolean, idempotent?: boolean }>}
 */
export async function settleClosedRoomBinding(fb, uid, roomOrId) {
  const roomId =
    typeof roomOrId === 'string'
      ? roomOrId
      : roomOrId?.id || roomOrId?.roomId || null;
  if (!fb || !uid || !roomId) return { ok: true, skipped: true };

  const { db, fs } = fb;
  let room = typeof roomOrId === 'object' && roomOrId ? { ...roomOrId } : null;
  if (!room || !Array.isArray(room.seatUids)) {
    const snap = await fs.getDoc(fs.doc(db, 'pokerRooms', roomId));
    if (snap.exists()) room = { id: roomId, ...snap.data() };
    else room = { id: roomId, roomId, status: 'closed', seatUids: [] };
  } else {
    room = { ...room, id: room.id || roomId, roomId };
  }
  // Only for closed / missing rooms — open-table host-gone still uses explicit rescue UI
  if (room.status && room.status !== 'closed') {
    return { ok: true, skipped: true };
  }
  room.status = 'closed';
  // Defensive: any settle-on-closed path must drop the lobby list entry
  await deleteLobbyListing(fb, roomId);
  return selfRescueCashout(fb, uid, room);
}

/**
 * Self-rescue cashout when host gone ≥10m or room closed (§6.10).
 */
export async function selfRescueCashout(fb, uid, room) {
  const { db, fs } = fb;
  const seat = room.seatUids.indexOf(uid);
  if (seat < 0) {
    return cancelBuyin(fb, uid, room);
  }
  const sessRow = room.sess[seat];
  const amount = room.stacks[seat];
  const id = `${room.id || room.roomId}_${sessRow.sessionNo}_cashout`;
  const roomId = room.id || room.roomId;
  const pref = fs.doc(db, 'pokerPlayers', uid);
  const p = (await fs.getDoc(pref)).data();
  if (!p?.tableRoomId) return { ok: true, skipped: true };

  const batch = fs.writeBatch(db);
  batch.set(fs.doc(db, 'pokerPlayers', uid, 'ledger', id), {
    type: 'cashout',
    amount,
    roomId,
    sessionNo: sessRow.sessionNo,
    seat,
    buyIn: sessRow.buyIn,
    topUps: sessRow.topUps,
    topUpChips: sessRow.topUpChips,
    hands: sessRow.hands,
    nightKey: sessRow.nightKey,
    bankAfter: p.bank + amount,
    by: uid,
    at: fs.serverTimestamp(),
  });
  const playerPatch = {
    bank: p.bank + amount,
    inPlay: 0,
    total: p.bank + amount,
    tableRoomId: null,
    topUps: p.topUps + sessRow.topUps,
    topUpChips: p.topUpChips + sessRow.topUpChips,
    handsPlayed: p.handsPlayed + sessRow.hands,
    updatedAt: fs.serverTimestamp(),
  };
  // 附錄 L3：只有房間已 closed 才清 hostRoomId；房仍開著時保留，避免房主兑現後又能再開一桌
  if (p.hostRoomId === roomId && room.status === 'closed') {
    playerPatch.hostRoomId = null;
  }
  batch.update(pref, playerPatch);
  const nref = fs.doc(db, 'pokerPlayers', uid, 'nights', sessRow.nightKey);
  const nSnap = await fs.getDoc(nref);
  const base = nSnap.exists()
    ? nSnap.data()
    : { buyIn: 0, cashOut: 0, topUps: 0, hands: 0, lastEntry: '' };
  batch.set(nref, {
    nightKey: sessRow.nightKey,
    uid,
    name: (p.displayName || '玩家').slice(0, 60),
    buyIn: base.buyIn + sessRow.buyIn + sessRow.topUpChips,
    cashOut: base.cashOut + amount,
    net: base.cashOut + amount - (base.buyIn + sessRow.buyIn + sessRow.topUpChips),
    topUps: base.topUps + sessRow.topUps,
    hands: base.hands + sessRow.hands,
    lastEntry: id,
    updatedAt: fs.serverTimestamp(),
  });
  try {
    await batch.commit();
  } catch (e) {
    if (!isDenied(e)) throw e;
    const led = await fs.getDoc(fs.doc(db, 'pokerPlayers', uid, 'ledger', id));
    if (led.exists()) return { ok: true, idempotent: true };
    throw e;
  }
  return { ok: true, amount };
}

async function cancelBuyin(fb, uid, room) {
  const { db, fs } = fb;
  const roomId = room.id || room.roomId;
  const pref = fs.doc(db, 'pokerPlayers', uid);
  const p = (await fs.getDoc(pref)).data();
  if (!p || p.tableRoomId !== roomId) return { ok: true, skipped: true };
  const id = `${roomId}_${p.sessionNo}_cashout`;
  const amount = p.inPlay;
  const nk = nightKeyOf();
  const batch = fs.writeBatch(db);
  batch.set(fs.doc(db, 'pokerPlayers', uid, 'ledger', id), {
    type: 'cashout',
    amount,
    roomId,
    sessionNo: p.sessionNo,
    seat: null,
    buyIn: amount,
    topUps: 0,
    topUpChips: 0,
    hands: 0,
    nightKey: nk,
    bankAfter: p.bank + amount,
    by: uid,
    at: fs.serverTimestamp(),
  });
  batch.update(pref, {
    bank: p.bank + amount,
    inPlay: 0,
    total: p.bank + amount,
    tableRoomId: null,
    updatedAt: fs.serverTimestamp(),
  });
  const nref = fs.doc(db, 'pokerPlayers', uid, 'nights', nk);
  const nSnap = await fs.getDoc(nref);
  const base = nSnap.exists()
    ? nSnap.data()
    : { buyIn: 0, cashOut: 0, topUps: 0, hands: 0, lastEntry: '' };
  batch.set(nref, {
    nightKey: nk,
    uid,
    name: (p.displayName || '玩家').slice(0, 60),
    buyIn: base.buyIn + amount,
    cashOut: base.cashOut + amount,
    net: base.cashOut + amount - (base.buyIn + amount),
    topUps: base.topUps,
    hands: base.hands,
    lastEntry: id,
    updatedAt: fs.serverTimestamp(),
  });
  try {
    await batch.commit();
  } catch (e) {
    if (!isDenied(e)) throw e;
    return { ok: true, idempotent: true };
  }
  return { ok: true, amount, cancelledBuyin: true };
}

export async function fetchLeaderboard(fb, limit = 50) {
  const { db, fs } = fb;
  const q = fs.query(
    fs.collection(db, 'pokerPlayers'),
    fs.orderBy('total', 'desc'),
    fs.limit(limit),
  );
  const snap = await fs.getDocs(q);
  return snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
}

export async function fetchNightBoard(fb, nightKey, limit = 50) {
  const { db, fs } = fb;
  const q = fs.query(
    fs.collectionGroup(db, 'nights'),
    fs.where('nightKey', '==', nightKey),
    fs.limit(limit),
  );
  const snap = await fs.getDocs(q);
  return snap.docs.map((d) => d.data()).sort((a, b) => b.net - a.net);
}

export async function getPlayer(fb, uid) {
  const { db, fs } = fb;
  const snap = await fs.getDoc(fs.doc(db, 'pokerPlayers', uid));
  if (!snap.exists()) return null;
  const data = { uid, ...snap.data() };
  cachePlayer(uid, data);
  return data;
}

function cachePlayer(uid, data) {
  try {
    localStorage.setItem(
      `${LS_PREFIX}.player.${uid}`,
      JSON.stringify({ ...data, at: Date.now() }),
    );
  } catch {
    /* ignore */
  }
}

export function readCachedPlayer(uid) {
  try {
    const raw = localStorage.getItem(`${LS_PREFIX}.player.${uid}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
