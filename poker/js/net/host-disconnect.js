// Liveness uses the host's own presence beat (server timestamp); room.updatedAt only when no beat exists.
// Never use the time a client received a snapshot.
export const DISCONNECT_COPY = Object.freeze({
  paused: '房主連線中斷，等待回來', returned: '房主已回來',
  closed: '原牌桌已關閉，籌碼已回到帳戶',
});
export const HOST_PAUSE_MS = 45_000;
export const HOST_CLOSE_MS = 120_000;
export function hostLivenessMs(room, presenceSnapOrBeat) {
  const beat = typeof presenceSnapOrBeat === 'number' ? presenceSnapOrBeat
    : presenceSnapOrBeat?.exists?.() ? presenceSnapOrBeat.data().beat?.toMillis?.()
    : presenceSnapOrBeat?.toMillis?.();
  return hostAliveMs(beat, room?.updatedAt?.toMillis?.());
}
/** Host beat wins; room.updatedAt is only a fallback when no host beat exists (guests write the room too). */
export function hostAliveMs(beatMs, roomUpdatedMs) {
  if (Number.isFinite(beatMs) && beatMs > 0) return beatMs;
  return Number.isFinite(roomUpdatedMs) && roomUpdatedMs > 0 ? roomUpdatedMs : null;
}
export function disconnectState(livenessMs, now = Date.now()) {
  const age = Number.isFinite(livenessMs) ? Math.max(0, now - livenessMs) : 0;
  return { paused: age >= HOST_PAUSE_MS, hidden: age >= HOST_CLOSE_MS, reclaim: age >= HOST_CLOSE_MS };
}
export function resumeDeadline(deadline, from, now) {
  return deadline == null ? null : deadline + Math.max(0, now - from);
}
export function refundAtSeat(room, seat) {
  if (['lobby', 'hand_over'].includes(room.pub?.phase)) return room.stacks[seat];
  const p = room.pub?.seats?.[seat];
  if (!p || !Number.isSafeInteger(p.chips) || !Number.isSafeInteger(p.contributed)) throw Error('缺少退款證據');
  return p.chips + p.contributed;
}
export async function closeDisconnectedRoom(fb, roomId, now = Date.now()) {
  try {
    return await closeDisconnectedRoomTx(fb, roomId, now);
  } catch (e) {
    // Lost a close race: the winner already refunded everyone. Signed-in users may read closed rooms.
    const snap = await fb.fs.getDoc(fb.fs.doc(fb.db, 'pokerRooms', roomId)).catch(() => null);
    if (snap?.exists?.() && snap.data().status === 'closed') return false;
    throw e;
  }
}
async function closeDisconnectedRoomTx(fb, roomId, now) {
  const { db, fs } = fb;
  return fs.runTransaction(db, async tx => {
    const ref = fs.doc(db, 'pokerRooms', roomId);
    const snap = await tx.get(ref);
    if (!snap.exists()) return false;
    const r = snap.data();
    if (r.status === 'closed') return false;
    const hp = await tx.get(fs.doc(db, 'pokerRooms', roomId, 'presence', r.hostUid));
    const beat = hostLivenessMs(r, hp);
    if (!Number.isFinite(beat) || !disconnectState(beat, now).reclaim) return false;
    const rows = [];
    for (let i = 0; i < r.seatUids.length; i++) {
      const uid = r.seatUids[i];
      if (!uid) continue;
      const pRef = fs.doc(db, 'pokerPlayers', uid);
      const p = (await tx.get(pRef)).data();
      if (!p || p.tableRoomId !== roomId || p.sessionNo !== r.sess[i].sessionNo) throw Error('退款帳戶不一致');
      rows.push({i,uid,pRef,p,amount:refundAtSeat(r,i),s:r.sess[i]});
    }
    const by = fb.auth?.currentUser?.uid || fb.uid;
    if (rows.length && !by) throw Error('缺少登入身分');
    for (const {i,uid,pRef,p,amount,s} of rows) {
      tx.update(pRef, {bank:p.bank+amount, total:p.bank+amount, inPlay:0, tableRoomId:null,
        topUps:p.topUps+s.topUps, topUpChips:p.topUpChips+s.topUpChips,
        handsPlayed:p.handsPlayed+s.hands, updatedAt:fs.serverTimestamp()});
      tx.set(fs.doc(db,'pokerPlayers',uid,'ledger',`${roomId}_${s.sessionNo}_cashout`), {
        type:'cashout',amount,roomId,sessionNo:s.sessionNo,seat:i,buyIn:s.buyIn,
        topUps:s.topUps,topUpChips:s.topUpChips,hands:s.hands,nightKey:s.nightKey,
        bankAfter:p.bank+amount,by,at:fs.serverTimestamp(),
      });
    }
    tx.update(ref, {status:'closed',closedBy:'host-disconnect',closedAt:fs.serverTimestamp(),
      rev:r.rev+1,updatedAt:fs.serverTimestamp(),seatUids:Array(6).fill(''),
      stacks:Array(6).fill(0),chipTotal:0,sess:Array(6).fill(null),deadlineAt:null,
      lastMoneyEvent:{type:'hostDisconnectClose'}});
    return true;
  });
}
