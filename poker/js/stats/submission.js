// Phase B seam: deliberately not connected to production host/T0.
export const utf8Bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
// Escape the separator itself; no JS/Rules Unicode length dependency.
const keyPart = value => value.replaceAll('%', '%25').replaceAll('_', '%5F');
export const handKey = (roomId, handId) => `${keyPart(roomId)}_${keyPart(handId)}`;
export const counters = {
  validHands: null, wonHands: 'wonAnyPot', vpipOppHands: 'vpipOpp', vpipHands: 'vpip',
  pfrOppHands: 'pfrOpp', pfrHands: 'pfr', threeBetOppHands: 'threeBetOpp', threeBetHands: 'threeBet',
};
export function personalSummary(entry, startedAt) {
  const s = entry.summary;
  if (!Number.isSafeInteger(startedAt) || startedAt < 1 || !Number.isSafeInteger(s.handStartedAt)
      || s.handStartedAt < startedAt || !Number.isSafeInteger(s.netDelta)) throw Error('invalid stats period/value');
  if (!/^[^/]{1,40}$/u.test(entry.roomId) || !/^[^/]{1,128}$/u.test(entry.handId)
      || !/^[^/]{1,128}$/u.test(entry.uid)) throw Error('invalid stats identity');
  const d = { roomId: entry.roomId, handId: entry.handId, schemaVersion: 1, handStartedAt: s.handStartedAt };
  for (const field of Object.values(counters).filter(Boolean)) {
    if (typeof s[field] !== 'boolean') throw Error('invalid flag');
    d[field] = s[field];
  }
  for (const [success, opp] of [['vpip', 'vpipOpp'], ['pfr', 'pfrOpp'], ['threeBet', 'threeBetOpp']]) {
    if (d[success] && !d[opp]) throw Error('success without opportunity');
  }
  return { ...d, netDelta: s.netDelta };
}
// Adapter must provide server-only receipt reads and an atomic create-only
// summary + increment aggregate + create-only receipt commit. Never read private
// summaries/aggregates as host. A permission-denied response is never success.
export function createStatsSubmitter({ adapter, startedAt = null }) {
  return async entry => {
    if (startedAt == null) throw Error('stats disabled');
    const summary = personalSummary(entry, startedAt);
    const key = handKey(entry.roomId, entry.handId);
    const identity = { roomId: entry.roomId, uid: entry.uid, handKey: key };
    const confirmed = receipt => receipt?.uid === entry.uid && receipt?.handKey === key;
    if (confirmed(await adapter.readReceipt(identity))) return 'confirmed';
    try {
      await adapter.commit({ ...identity, summary, startedAt,
        increments: Object.fromEntries(Object.entries(counters).map(([name, flag]) => [name, flag ? Number(summary[flag]) : 1]).concat([['netChips', summary.netDelta]])),
      });
      return 'confirmed';
    } catch (error) {
      if (confirmed(await adapter.readReceipt(identity))) return 'confirmed';
      throw error;
    }
  };
}
// Explicit wake only: no idle polling, at most six uid submissions per wake.
// Caller may wake on foreground/online after backoff; errors retain all unsent data.
export function createStatsRecovery({ queue, submit, now = Date.now, onStatus = () => {} }) {
  let chain = Promise.resolve();
  let retryAt = 0;
  let failures = 0;
  return {
    wake() {
      chain = chain.then(async () => {
        if (now() < retryAt) return;
        const entries = (await queue.list()).slice(0, 6);
        for (const entry of entries) {
          try {
            if (await submit(entry) !== 'confirmed') throw Error('unconfirmed submission');
            await queue.dequeue(entry.handId, entry.uid, entry.roomId);
            failures = 0;
            onStatus('submitted');
          } catch (error) {
            retryAt = now() + Math.min(60000, 1000 * 2 ** Math.min(++failures, 6));
            onStatus('pending', error);
            break;
          }
        }
      }).catch(error => onStatus('pending', error));
      return chain;
    },
  };
}

// Opt-in Phase B composition; never installed in the production host/T0.
export function createStatsRoomRecovery({ queue, remoteQueue, submit, onStatus = () => {}, now = Date.now }) {
  const local = createStatsRecovery({ queue, submit, onStatus, now });
  const remote = createStatsRecovery({ queue: remoteQueue, submit, onStatus, now });
  let chain = Promise.resolve();
  return { wake() {
    chain = chain.then(async () => {
      for (const entry of (await queue.list()).slice(0, 6)) {
        try {
          const result = await remoteQueue.enqueue(entry);
          if (result === 'rejected') onStatus('統計尚未完整保存，牌局不受影響');
          else onStatus('remotely-confirmed');
        } catch (error) { onStatus('pending', error); }
      }
      await remote.wake();
      await local.wake();
    }).catch(error => onStatus('pending', error));
    return chain;
  } };
}

export function bindStatsWake({ recovery, windowTarget = globalThis.window, documentTarget = globalThis.document, onError = () => {} }) {
  const wake = () => { Promise.resolve().then(() => recovery.wake()).catch(onError); };
  const foreground = () => { if (documentTarget.visibilityState === 'visible') wake(); };
  windowTarget.addEventListener('online', wake);
  documentTarget.addEventListener('visibilitychange', foreground);
  return () => {
    windowTarget.removeEventListener('online', wake);
    documentTarget.removeEventListener('visibilitychange', foreground);
  };
}
