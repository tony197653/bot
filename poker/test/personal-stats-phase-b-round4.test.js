import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoomPendingQueue, REMOTE_ENTRY_CAP, REMOTE_BYTE_BUDGET } from '../js/stats/remote-pending.js';
import { bindStatsWake, createStatsRoomRecovery, utf8Bytes, personalSummary } from '../js/stats/submission.js';
const entry = (uid = 'u', handId = 'h') => ({ roomId: 'r', handId, uid, summary: {
 handStartedAt: 100, wonAnyPot: true, vpipOpp: true, vpip: true, pfrOpp: true,
 pfr: false, threeBetOpp: false, threeBet: false, netDelta: -100, hole: ['As'] } });
function fixture(roomId = 'r') {
 let saved, fail = false, cache = false;
 const snap = () => ({ exists: () => !!saved, data: () => structuredClone(saved), metadata: { fromCache: cache } });
 const fs = { doc: (_, ...p) => p.join('/'), getDocFromServer: async () => snap(),
 async runTransaction(_, fn) {
   let next; const result = await fn({ get: async () => snap(), set: (_, d) => { next = d; } });
   if (fail) throw Error('permission-denied');
   if (next) saved = structuredClone(next);
   return result;
 } };
 return { make: () => createRoomPendingQueue({ fs, db: {}, roomId, startedAt: 1 }),
 fail: v => { fail = v; }, cache: v => { cache = v; } };
}
test('B4 acknowledged cross-host restore, no private fields, bounded preservation and denied ACK', async () => {
 const f = fixture(), q = f.make();
 f.fail(true); await assert.rejects(q.enqueue(entry())); assert.deepEqual(await f.make().list(), []);
 f.fail(false); await q.enqueue(entry());
 assert.equal((await f.make().list())[0].summary.hole, undefined);
 assert.equal(REMOTE_ENTRY_CAP, 2);
 for (let i = 1; i < REMOTE_ENTRY_CAP; i++) await q.enqueue(entry('u'+i));
 const before = await q.list();
 assert.equal(await q.enqueue(entry('overflow')), 'rejected');
 assert.equal((await q.list()).length, REMOTE_ENTRY_CAP);
 assert.deepEqual(await q.list(), before);
 f.cache(true); await assert.rejects(q.list(), /not acknowledged/); f.cache(false);
 await assert.rejects(q.enqueue({ ...entry(), roomId: 'other' }));
});
test('B4 room recovery retains unconfirmed and full local entries; confirmed cleanup only', async () => {
 const f = fixture(), remoteQueue = f.make(); let rows = Array.from({ length: 6 }, (_, i) => entry('u'+i)), allow = false;
 const queue = { list: async () => rows, dequeue: async () => { rows = []; } };
 const recovery = createStatsRoomRecovery({ queue, remoteQueue,
 submit: async () => { if (!allow) throw Error('denied'); return 'confirmed'; }, now: () => 100000 });
 await recovery.wake(); assert.equal(rows.length, 6); assert.equal((await remoteQueue.list()).length, REMOTE_ENTRY_CAP);
 // Fresh replacement host worker (new backoff state), same remotely acknowledged room data.
 allow = true;
 await createStatsRoomRecovery({ queue, remoteQueue: f.make(), submit: async () => 'confirmed' }).wake();
 assert.equal(rows.length, 0); assert.equal((await remoteQueue.list()).length, 0);
});
test('B4 online/foreground wake is deferred, hidden ignored, listeners removable; no polling', async () => {
 const win = new EventTarget(), doc = new EventTarget(); doc.visibilityState = 'hidden';
 let calls = 0; let release;
 const stop = bindStatsWake({ windowTarget: win, documentTarget: doc, recovery: { wake() {
 calls++; return new Promise(resolve => { release = resolve; });
 } } });
 doc.dispatchEvent(new Event('visibilitychange')); win.dispatchEvent(new Event('online'));
 assert.equal(calls, 0); await Promise.resolve(); assert.equal(calls, 1); release();
 doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange'));
 await Promise.resolve(); assert.equal(calls, 2); release(); stop();
 win.dispatchEvent(new Event('online')); await Promise.resolve(); assert.equal(calls, 2);
});
test('B4 measured remote boundary payload (serialized UTF-8, not physical storage)', async () => {
 const f = fixture(), q = f.make();
 const measured = [];
 for (let i = 0; i < 6; i++) {
 const e = entry('界'.repeat(127)+i, '手'.repeat(128));
 e.summary.netDelta = Number.MIN_SAFE_INTEGER; e.summary.handStartedAt = Number.MAX_SAFE_INTEGER;
 measured.push({ roomId: e.roomId, handId: e.handId, uid: e.uid, summary: personalSummary(e, 1) });
 assert.equal(await q.enqueue(e), i < REMOTE_ENTRY_CAP ? 'added' : 'rejected');
 }
 const bytes = utf8Bytes({ entries: measured });
 console.log('B4_REMOTE_SIX_UTF8_BYTES', bytes, 'BUDGET', REMOTE_BYTE_BUDGET);
 assert.ok(bytes <= REMOTE_BYTE_BUDGET);
 const maxRoom = measured.map(e => ({ ...e, roomId: '界'.repeat(40), summary: { ...e.summary, roomId: '界'.repeat(40) } }));
 const escaped = measured.map(e => ({ ...e, uid: '\u0001'.repeat(128), handId: '\u0001'.repeat(128), roomId: '\u0001'.repeat(40), summary: { ...e.summary, handId: '\u0001'.repeat(128), roomId: '\u0001'.repeat(40) } }));
 console.log('B4_REMOTE_MAX_ROOM_UTF8_BYTES', utf8Bytes({ entries: maxRoom }), 'CONTROL_ESCAPED_BYTES', utf8Bytes({ entries: escaped }));

 // Control-character escaping is byte-counted too; a rejected append keeps all old rows.
 assert.equal(await q.enqueue(entry('x')), 'rejected'); assert.equal((await q.list()).length, REMOTE_ENTRY_CAP);
});

test('B4 escaped payload respects two-slot cap and preserves existing unsent entries', async () => {
 const roomId = '\u0001'.repeat(40), f = fixture(roomId), q = f.make();
 let added = 0;
 for (let i = 0; i < 6; i++) {
  const e = entry('\u0001'.repeat(127)+i, '\u0001'.repeat(128)); e.roomId = roomId;
  const result = await q.enqueue(e);
  if (result === 'added') added++;
  else { assert.equal(result, 'rejected'); assert.equal((await q.list()).length, added); break; }
 }
 assert.equal(added, REMOTE_ENTRY_CAP);
});
