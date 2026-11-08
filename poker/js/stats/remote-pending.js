import { personalSummary, utf8Bytes } from './submission.js';
// Six entries exceeded the Rules expression cap; two-entry success awaits coordinator.
// Full queues reject new entries without evicting acknowledged or local pending.
// Serialized bytes only, not Firestore/index billing or a quota guarantee.
export const REMOTE_ENTRY_CAP = 2;
export const REMOTE_BYTE_BUDGET = 16384;
export function createRoomPendingQueue({ fs, db, roomId, startedAt = null }) {
  const ref = fs.doc(db, 'pokerRooms', roomId, 'statsPending', 'queue');
  const identity = e => JSON.stringify([e.handId, e.uid]);
  function minimal(e) {
    if (startedAt == null || e.roomId !== roomId) throw Error('disabled or wrong room');
    return { roomId, handId: e.handId, uid: e.uid, summary: personalSummary(e, startedAt) };
  }
  return {
    async list() {
      if (startedAt == null) throw Error('stats disabled');
      // Never restore cache-only or locally optimistic writes.
      const snap = await fs.getDocFromServer(ref);
      if (snap.metadata?.hasPendingWrites || snap.metadata?.fromCache) throw Error('remote pending not acknowledged');
      return snap.exists() ? snap.data().entries.map(minimal) : [];
    },
    async enqueue(entry) {
      const copy = minimal(entry);
      return fs.runTransaction(db, async tx => {
        const snap = await tx.get(ref);
        const entries = snap.exists() ? snap.data().entries : [];
        if (entries.some(e => identity(e) === identity(copy))) return 'duplicate';
        const next = { entries: [...entries, copy] };
        if (next.entries.length > REMOTE_ENTRY_CAP || utf8Bytes(next) > REMOTE_BYTE_BUDGET) return 'rejected';
        tx.set(ref, next);
        return 'added'; // exposed only after server transaction acknowledgement
      });
    },
    async dequeue(handId, uid, room) {
      if (startedAt == null || room !== roomId) throw Error('disabled or wrong room');
      // Recovery invokes this only after submission/receipt confirmation.
      return fs.runTransaction(db, async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists()) return null;
        const entries = snap.data().entries;
        const found = entries.find(e => e.handId === handId && e.uid === uid);
        if (found) tx.set(ref, { entries: entries.filter(e => e !== found) });
        return found || null;
      });
    },
  };
}
