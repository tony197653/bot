import { utf8Bytes } from './submission.js';
// Provisional serialized-byte bounds, derived from the Phase B boundary fixture.
// Not a browser quota or physical-storage guarantee; no eviction or TTL.
export const BYTE_BUDGET = Object.freeze({ entry: 8192, device: 524288 });
export function createBoundedPendingQueue({ storage, storageKey, budget = BYTE_BUDGET, onStatus = () => {} }) {
  if (!storage || !storageKey) throw Error('explicit device/account storage required');
  let rows = JSON.parse(storage.getItem(storageKey) || '[]');
  if (!Array.isArray(rows)) throw Error('corrupt stats queue');
  const key = e => JSON.stringify([e.roomId, e.handId, e.uid]);
  function save(next) {
    storage.setItem(storageKey, JSON.stringify(next)); // throw on quota; keep old rows
    rows = next;
  }
  return {
    async enqueue(entry) {
      const copy = JSON.parse(JSON.stringify(entry));
      if (rows.some(e => key(e) === key(copy))) return 'duplicate';
      if (utf8Bytes(copy) > budget.entry || utf8Bytes([...rows, copy]) > budget.device) {
        onStatus('統計尚未完整保存，牌局不受影響');
        return 'rejected';
      }
      try { save([...rows, copy]); } catch (error) {
        onStatus('統計尚未完整保存，牌局不受影響', error);
        throw error;
      }
      onStatus('本機已保存');
      return 'added';
    },
    async list() { return JSON.parse(JSON.stringify(rows)); },
    async dequeue(handId, uid, roomId) {
      const found = rows.find(e => e.handId === handId && e.uid === uid && e.roomId === roomId);
      if (found) save(rows.filter(e => e !== found));
      return found || null;
    },
  };
}
