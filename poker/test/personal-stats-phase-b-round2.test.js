import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handKey, personalSummary, utf8Bytes } from '../js/stats/submission.js';
import { createBoundedPendingQueue } from '../js/stats/bounded-queue.js';
const entry = handId => ({ roomId: 'r', uid: 'u', handId, summary: { handStartedAt: 1, wonAnyPot: false, vpipOpp: false, vpip: false, pfrOpp: false, pfr: false, threeBetOpp: false, threeBet: false, netDelta: 0 } });
const storage = () => { let value; return { getItem: () => value, setItem: (_, next) => { value = next; } }; };
test('B keys preserve Unicode and escape separator without collisions', () => {
 const pairs = [['a_', 'b'],['a','_b'],['a%5F','b'],['😀','界'],['界','😀'],['ab','c'],['a','bc']];
 assert.equal(new Set(pairs.map(p => handKey(...p))).size, pairs.length);
 assert.equal(handKey('😀','界'), '😀_界');
 const e = entry('😀'.repeat(128)); e.roomId = '界'.repeat(40); personalSummary(e,1);
 e.handId += '😀'; assert.throws(() => personalSummary(e,1));
});
test('B multiple queue instances retain other tab enqueue and cleanup', async () => {
 const disk = storage(); const a = createBoundedPendingQueue({ storage: disk, storageKey: 'device' });
 const b = createBoundedPendingQueue({ storage: disk, storageKey: 'device' });
 await Promise.all([a.enqueue(entry('a')), b.enqueue(entry('b'))]);
 assert.equal((await a.list()).length,2);
 await a.dequeue('a','u','r'); await b.enqueue(entry('c'));
 assert.deepEqual((await a.list()).map(e => e.handId), ['b','c']);
});
test('B mutations reload inside shared Web Lock', async () => {
 let chain = Promise.resolve(), calls = 0;
 const locks = { request(name, fn) { assert.equal(name,'poker-stats:device'); calls++; const result = chain.then(fn); chain = result.catch(() => {}); return result; } };
 const disk = storage(); const make = () => createBoundedPendingQueue({ storage: disk, storageKey: 'device', locks });
 const a = make(), b = make();
 await Promise.all([a.enqueue(entry('a')),b.enqueue(entry('b')),a.enqueue(entry('c'))]);
 await Promise.all([a.dequeue('a','u','r'),b.enqueue(entry('d'))]);
 assert.deepEqual((await a.list()).map(e => e.handId), ['b','c','d']); assert.equal(calls,6);
});
test('B exact UTF-8 entry bound rejects excess while retaining pending', async () => {
 const e = entry('界'); const q = createBoundedPendingQueue({ storage: storage(), storageKey: 'device', budget: { entry: utf8Bytes(e), device: 4096 } });
 assert.equal(await q.enqueue(e),'added'); assert.equal(await q.enqueue(entry('界界')),'rejected');
 assert.equal((await q.list()).length,1);
});
test('B quota rejection releases injected and native locks for subsequent queue operations', async () => {
 for (const [name, locks] of [
  ['injected', { request: (_, fn) => Promise.resolve().then(fn) }],
  ['native', navigator.locks],
 ]) {
  const disk = storage(); const save = disk.setItem;
  const q = createBoundedPendingQueue({ storage: disk, storageKey: `quota-release-${name}`, locks });
  await q.enqueue(entry('retained'));
  disk.setItem = () => { throw Error('QuotaExceededError'); };
  await assert.rejects(q.dequeue('retained', 'u', 'r'), /QuotaExceededError/);
  assert.deepEqual((await q.list()).map(e => e.handId), ['retained']);
  disk.setItem = save;
  await q.dequeue('retained', 'u', 'r');
  assert.deepEqual(await q.list(), []);
 }
});
