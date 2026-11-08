// Inject SDK/db explicitly; no imports, credentials, default DB or activation.
export function createFirestoreStatsAdapter({ fs, db, assertAuthority = () => {} }) {
  const receiptRef = id => fs.doc(db, 'pokerRooms', id.roomId, 'statsReceipts', id.handKey, 'uids', id.uid);
  return {
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
      batch.set(receiptRef(data), { uid: data.uid, handKey: data.handKey });
      assertAuthority();
      await batch.commit();
      assertAuthority();
    },
  };
}
