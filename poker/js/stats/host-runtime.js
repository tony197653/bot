import { createBoundedPendingQueue } from './bounded-queue.js';
import { createRoomPendingQueue } from './remote-pending.js';
import { createFirestoreStatsAdapter } from './firestore-adapter.js';
import { bindStatsWake, createStatsRoomRecovery, createStatsSubmitter } from './submission.js';

// Release activation is deliberately absent. Tests inject an explicit period/adapters.
export const STATS_ENABLED = false;
export const STATS_T0 = null;
export function createHostStatsRuntime({ fs, db, roomId, uid, isCurrentHost,
  enabled = STATS_ENABLED, startedAt = STATS_T0, storage,
  queue: injectedQueue, remoteQueue: injectedRemote, adapter: injectedAdapter,
  windowTarget = globalThis.window, documentTarget = globalThis.document,
  onStatus = (status, error) => { if (error) console.warn('[stats]', status, error); },
}) {
  let active = false, disposed = false, unbind = null, flight = null;
  const allowed = () => active && isCurrentHost();
  const check = () => { if (!allowed()) throw Error('stats host authority revoked'); };
  // Check both sides of each async boundary: a stale ACK must never trigger cleanup.
  const guard = target => Object.fromEntries(Object.entries(target).filter(([, v]) => typeof v === 'function').map(([key, fn]) => [key, async (...args) => {
    check(); const result = await fn(...args); check(); return result;
  }]));
  let queue = null, worker = null;
  if (enabled && Number.isSafeInteger(startedAt) && startedAt > 0) {
    queue = injectedQueue || createBoundedPendingQueue({ storage: storage || globalThis.localStorage,
      storageKey: `pokerStats.pending.v1:${JSON.stringify([uid, roomId])}`, onStatus });
    const remoteQueue = guard(injectedRemote || createRoomPendingQueue({ fs, db, roomId, startedAt, assertAuthority: check }));
    const adapter = guard(injectedAdapter || createFirestoreStatsAdapter({ fs, db, assertAuthority: check }));
    worker = createStatsRoomRecovery({ queue: guard(queue), remoteQueue,
      submit: guard({ submit: createStatsSubmitter({ adapter, startedAt }) }).submit, onStatus });
  }
  const recovery = { wake() {
    if (!worker || !allowed()) return Promise.resolve();
    if (!flight) flight = worker.wake().finally(() => { flight = null; });
    return flight;
  } };
  return { queue, recovery,
    start() {
      if (disposed || active || !worker || !isCurrentHost()) return;
      active = true;
      unbind = bindStatsWake({ recovery, windowTarget, documentTarget, onError: e => onStatus('pending', e) });
      void recovery.wake();
    },
    stop() { disposed = true; active = false; unbind?.(); unbind = null; },
  };
}
