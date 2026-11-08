// Phase B seam: deliberately not connected to production host/T0.
export const utf8Bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
export const handKey = (roomId, handId) => `${roomId.length}_${roomId}${handId}`;
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
