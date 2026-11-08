// Inject SDK/db explicitly; no imports, credentials, default DB or activation.
export function createFirestoreStatsAdapter({ fs, db, assertAuthority = () => {} }) {
  const receiptRef = id => fs.doc(db, 'pokerRooms', id.roomId, 'statsReceipts', id.handKey, 'uids', id.uid);
  return {
    /** Public current-chips TOTAL (bank + seat stack at HAND_OVER). Separate write; never blocks game. */
    async writeChips({ uid, roomId = null, seat = null, stack = 0 }) {
      assertAuthority();
      const p = await fs.getDoc(fs.doc(db, 'pokerPlayers', uid));
      const bank = p.exists() ? p.data().bank : null;
      if (!Number.isInteger(bank) || !Number.isInteger(stack)) return false;
      assertAuthority();
      const batch = fs.writeBatch(db);
      batch.set(fs.doc(db, 'pokerStatsSeat', uid), { roomId, seat, at: fs.serverTimestamp() });
      batch.update(fs.doc(db, 'pokerStatsPublic', uid), { currentChipsTotal: bank + (roomId ? stack : 0), chipsAt: fs.serverTimestamp() });
      await batch.commit();
      return bank + (roomId ? stack : 0);
    },
    async readReceipt(id) {
      assertAuthority();
      const snap = await fs.getDocFromServer(receiptRef(id));
      assertAuthority();
      return snap.exists() ? snap.data() : null;
    },
    async commit(data) {
      const batch = fs.writeBatch(db);
      const aggregate = { schemaVersion: 1, startedAt: data.startedAt,
        lastHandKey: data.handKey, updatedAt: fs.serverTimestamp() };
      for (const [name, value] of Object.entries(data.increments)) aggregate[name] = fs.increment(value);
      batch.set(fs.doc(db, 'pokerStats', data.uid, 'hands', data.handKey),
        { ...data.summary, settledAt: fs.serverTimestamp() });
      batch.set(fs.doc(db, 'pokerStats', data.uid), aggregate, { merge: true });
      const { lastHandKey, ...publicAggregate } = aggregate; // Page projection only
      batch.set(fs.doc(db, 'pokerStatsPublic', data.uid), publicAggregate, { merge: true });
      batch.set(receiptRef(data), { uid: data.uid, handKey: data.handKey });
      assertAuthority();
      await batch.commit();
      assertAuthority();
    },
  };
}
