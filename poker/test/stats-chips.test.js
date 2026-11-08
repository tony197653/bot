import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreStatsAdapter } from '../js/stats/firestore-adapter.js';
import { createHostStatsRuntime } from '../js/stats/host-runtime.js';

test('chips skips a missing public doc without a batch, then syncs after the first hand commit', async () => {
  const docs = new Map([['pokerPlayers/u', { bank: 100 }]]);
  const reads = []; let batches = 0;
  const fs = {
    doc: (_, ...parts) => parts.join('/'), serverTimestamp: () => 'SERVER', increment: n => n,
    getDoc: async ref => {
      reads.push(ref);
      return { exists: () => docs.has(ref), data: () => docs.get(ref) };
    },
    writeBatch: () => {
      batches++;
      const writes = [];
      return {
        set: (ref, value) => writes.push([ref, value]),
        update: (ref, value) => { assert.ok(docs.has(ref)); writes.push([ref, value]); },
        commit: async () => { for (const [ref, value] of writes) docs.set(ref, value); },
      };
    },
  };
  const adapter = createFirestoreStatsAdapter({ fs, db: {} });
  assert.equal(await adapter.writeChips({ uid: 'u', roomId: 'r', seat: 0, stack: 25 }), null);
  assert.deepEqual(reads, ['pokerPlayers/u', 'pokerStatsPublic/u']);
  assert.equal(batches, 0);
  assert.equal(docs.has('pokerStatsSeat/u'), false);
  await adapter.commit({ uid: 'u', roomId: 'r', handKey: 'r_h', startedAt: 1, summary: {}, increments: { validHands: 1 } });
  assert.equal(await adapter.writeChips({ uid: 'u', roomId: 'r', seat: 0, stack: 25 }), 125);
  assert.equal(docs.get('pokerStatsPublic/u').currentChipsTotal, 125);
  assert.deepEqual(docs.get('pokerStatsSeat/u'), { roomId: 'r', seat: 0, at: 'SERVER' });
});

test('host chips sync waits for the first stats commit and silently accepts a skipped sync', async () => {
  let publicExists = false, rows = [];
  const warnings = [], results = [];
  const runtime = createHostStatsRuntime({
    enabled: true, startedAt: 1, roomId: 'r', uid: 'host', isCurrentHost: () => true,
    windowTarget: new EventTarget(), documentTarget: new EventTarget(),
    queue: { list: async () => rows, dequeue: async () => { rows = []; } },
    remoteQueue: { list: async () => [], enqueue: async () => 'added' },
    adapter: {
      readReceipt: async () => null,
      commit: async () => { publicExists = true; },
      writeChips: async () => { const result = publicExists ? 125 : null; results.push(result); return result; },
    },
    onStatus: (status, error) => { if (error) warnings.push([status, error]); },
  });
  runtime.start();
  await runtime.recovery.wake();
  await runtime.syncChips({ seatUids: ['u'], stacks: [25] });
  assert.deepEqual(results, [null]);
  rows = [{ uid: 'u', roomId: 'r', handId: 'h', summary: {
    handStartedAt: 100, netDelta: 0, wonAnyPot: false,
    vpipOpp: true, vpip: false, pfrOpp: true, pfr: false, threeBetOpp: false, threeBet: false,
  } }];
  await runtime.syncChips({ seatUids: ['u'], stacks: [25] });
  assert.deepEqual(results, [null, 125]);
  assert.deepEqual(warnings, []);
  runtime.stop();
});
