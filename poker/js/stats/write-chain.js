/**
 * Independent stats write chain — NEVER chained into host.js writeChain,
 * NEVER awaited by betting / next-hand game flow (spec v1.0 §5.1 / §10 A).
 *
 * Phase A: serialize local pending-queue ops only. Firestore upload = Phase B.
 */

/**
 * @param {object} [opts]
 * @param {import('./pending-queue.js').PendingQueue} opts.queue
 * @param {(err: any) => void} [opts.onError]
 */
export function createStatsWriteChain(opts = {}) {
  const queue = opts.queue;
  const onError = opts.onError || ((e) => console.warn('[stats] write', e));

  let chain = Promise.resolve();
  let pendingCount = 0;

  /**
   * Enqueue work on the stats chain. Returns a promise for tests / UI hints,
   * but callers in game flow MUST NOT await it.
   * @param {() => Promise<any>} fn
   */
  function run(fn) {
    pendingCount += 1;
    const p = chain.then(() => fn()).catch(onError);
    // Keep chain alive after errors so later hands still flush.
    chain = p.then(
      () => {
        pendingCount -= 1;
      },
      () => {
        pendingCount -= 1;
      },
    );
    return p;
  }

  /**
   * Fire-and-forget: persist one hand's per-seat summaries into the pending queue.
   * @param {import('./snapshot.js').HandStatsSnapshot} snapshot
   */
  function enqueueSnapshot(snapshot) {
    if (!snapshot || snapshot.voided || !queue) return;
    // Intentionally not returned to game flow.
    run(async () => {
      const at = Date.now();
      for (const seat of snapshot.seats || []) {
        await queue.enqueue({
          handId: snapshot.handId,
          uid: seat.uid,
          roomId: snapshot.roomId,
          summary: {
            handNo: snapshot.handNo,
            handStartedAt: snapshot.handStartedAt,
            ...seat,
          },
          enqueuedAt: at,
        });
      }
    });
  }

  /**
   * Simulate a stats failure without touching the game. Used by self-tests.
   * @param {Error|string} err
   */
  function injectFailure(err) {
    run(async () => {
      throw typeof err === 'string' ? new Error(err) : err;
    });
  }

  function whenIdle() {
    return chain;
  }

  function getPendingCount() {
    return pendingCount;
  }

  return {
    run,
    enqueueSnapshot,
    injectFailure,
    whenIdle,
    getPendingCount,
  };
}
