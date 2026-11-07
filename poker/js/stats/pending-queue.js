/**
 * Persistent pending-queue interface for personal-stats hand summaries.
 * Phase A: in-memory + optional localStorage adapter. Firestore writes = Phase B.
 *
 * Dedupe key: handId + uid. Never overwrite an existing pending entry for another hand.
 */

/**
 * @typedef {object} PendingEntry
 * @property {string} handId
 * @property {string} uid
 * @property {string} roomId
 * @property {object} summary SeatHandSummary + hand meta
 * @property {number} enqueuedAt
 */

/**
 * @typedef {object} PendingQueue
 * @property {(entry: PendingEntry) => Promise<'added'|'duplicate'|'rejected'>} enqueue
 * @property {(handId: string, uid: string) => Promise<PendingEntry|null>} dequeue
 * @property {(handId: string, uid: string) => Promise<boolean>} has
 * @property {() => Promise<PendingEntry[]>} list
 * @property {() => Promise<void>} clear
 */

/** @param {PendingEntry} e */
function keyOf(e) {
  return `${e.handId}::${e.uid}`;
}

/**
 * @param {PendingEntry} e
 * @returns {string|null} error
 */
function validate(e) {
  if (!e || typeof e !== 'object') return 'invalid entry';
  if (typeof e.handId !== 'string' || !e.handId) return 'handId required';
  if (typeof e.uid !== 'string' || !e.uid) return 'uid required';
  if (typeof e.roomId !== 'string' || !e.roomId) return 'roomId required';
  if (!e.summary || typeof e.summary !== 'object') return 'summary required';
  return null;
}

/**
 * In-memory pending queue (also used as the backing store for local adapter).
 * @returns {PendingQueue & { _map: Map<string, PendingEntry> }}
 */
export function createMemoryPendingQueue() {
  /** @type {Map<string, PendingEntry>} */
  const map = new Map();

  return {
    _map: map,
    async enqueue(entry) {
      const err = validate(entry);
      if (err) return 'rejected';
      const k = keyOf(entry);
      if (map.has(k)) return 'duplicate';
      map.set(k, {
        handId: entry.handId,
        uid: entry.uid,
        roomId: entry.roomId,
        summary: Object.freeze({ ...entry.summary }),
        enqueuedAt: entry.enqueuedAt || Date.now(),
      });
      return 'added';
    },
    async dequeue(handId, uid) {
      const k = `${handId}::${uid}`;
      const v = map.get(k) || null;
      if (v) map.delete(k);
      return v;
    },
    async has(handId, uid) {
      return map.has(`${handId}::${uid}`);
    },
    async list() {
      return [...map.values()];
    },
    async clear() {
      map.clear();
    },
  };
}

/**
 * localStorage-backed queue (browser). Falls back to memory if storage unavailable.
 * Keys are namespaced per device; Phase B may replace with IndexedDB.
 *
 * @param {object} [opts]
 * @param {string} [opts.storageKey]
 * @param {Pick<Storage,'getItem'|'setItem'|'removeItem'>} [opts.storage]
 * @returns {PendingQueue}
 */
export function createLocalPendingQueue(opts = {}) {
  const storageKey = opts.storageKey || 'pokerStats.pending.v1';
  const memory = createMemoryPendingQueue();
  const storage = opts.storage || (typeof localStorage !== 'undefined' ? localStorage : null);

  function load() {
    if (!storage) return;
    try {
      const raw = storage.getItem(storageKey);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return;
      memory._map.clear();
      for (const e of arr) {
        if (validate(e)) continue;
        memory._map.set(keyOf(e), e);
      }
    } catch {
      /* ignore corrupt */
    }
  }

  function save() {
    if (!storage) return;
    try {
      storage.setItem(storageKey, JSON.stringify([...memory._map.values()]));
    } catch {
      /* quota — keep memory; Phase B surfaces sync hint */
    }
  }

  load();

  return {
    async enqueue(entry) {
      const r = await memory.enqueue(entry);
      if (r === 'added') save();
      return r;
    },
    async dequeue(handId, uid) {
      const v = await memory.dequeue(handId, uid);
      if (v) save();
      return v;
    },
    async has(handId, uid) {
      return memory.has(handId, uid);
    },
    async list() {
      return memory.list();
    },
    async clear() {
      await memory.clear();
      save();
    },
  };
}
