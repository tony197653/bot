// 僅 localhost demo-poker；記憶體啟用 B，不寫回正式 Rules，也不啟用 T0。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import * as fs from 'firebase/firestore';
import { handKey, personalSummary, counters } from '../js/stats/submission.js';
import { createRoomPendingQueue, REMOTE_ENTRY_CAP } from '../js/stats/remote-pending.js';
import { createFirestoreStatsAdapter } from '../js/stats/firestore-adapter.js';

const endpoint = process.env.FIRESTORE_EMULATOR_HOST;
if (!endpoint || !/^(127\.0\.0\.1|localhost):\d+$/.test(endpoint)) {
  throw Error('Set FIRESTORE_EMULATOR_HOST to a localhost emulator; project is always demo-poker');
}
const [host, port] = endpoint.split(':');
const source = readFileSync(new URL('./firestore.rules', import.meta.url), 'utf8');
const disabled = 'function statsEnabled() { return false; }';
const enabled = 'function statsEnabled() { return true; }';
assert.equal(source.split(disabled).length + source.split(enabled).length, 3, 'exactly one statsEnabled() switch (prod enabled since 2026-11-08)');
const rules = source.replace(disabled, 'function statsEnabled() { return true; }');
fs.setLogLevel('silent');
const entry = (roomId = 'r', handId = 'h') => ({ roomId, handId, uid: 'owner', summary: {
 handStartedAt: 100, wonAnyPot: true, vpipOpp: true, vpip: true, pfrOpp: true,
 pfr: false, threeBetOpp: false, threeBet: false, netDelta: -100,
} });
function payload(e = entry()) {
 const summary = personalSummary(e, 1);
 return { roomId: e.roomId, uid: e.uid, handKey: handKey(e.roomId, e.handId), summary, startedAt: 1,
 increments: Object.fromEntries(Object.entries(counters).map(([name, flag]) => [name, flag ? Number(summary[flag]) : 1]).concat([['netChips', summary.netDelta]])) };
}

test('B Rules isolation / atomicity / bounds (demo-poker only)', async t => {
 const env = await initializeTestEnvironment({ projectId: 'demo-poker', firestore: { host, port: Number(port), rules } });
 const db = uid => env.authenticatedContext(uid).firestore();
 const commit = (uid, data = payload()) => createFirestoreStatsAdapter({ fs, db: db(uid) }).commit(data);
 const seed = async (room = 'r', hostUid = 'host') => {
   await env.clearFirestore();
   await env.withSecurityRulesDisabled(c => fs.setDoc(fs.doc(c.firestore(), 'pokerRooms', room), { hostUid, members: ['host','owner','member'], status: 'playing' }));
 };
 const summaryRef = d => fs.doc(d, 'pokerStats', 'owner', 'hands', handKey('r','h'));
 const aggregateRef = d => fs.doc(d, 'pokerStats', 'owner');
 const receiptRef = d => fs.doc(d, 'pokerRooms', 'r', 'statsReceipts', handKey('r','h'), 'uids', 'owner');
 try {
  await t.test('current host atomically writes all three; only owner reads private data', async () => {
   await seed(); await assertSucceeds(commit('host'));
   for (const ref of [summaryRef, aggregateRef]) {
    await assertSucceeds(fs.getDoc(ref(db('owner'))));
    for (const uid of ['host','member','outsider']) await assertFails(fs.getDoc(ref(db(uid))));
    await assertFails(fs.getDoc(ref(env.unauthenticatedContext().firestore())));
   }
   await assertSucceeds(fs.getDoc(receiptRef(db('host'))));
   await assertSucceeds(fs.getDoc(receiptRef(db('owner'))));
   await assertFails(fs.getDoc(receiptRef(db('outsider'))));
   assert.equal((await fs.getDoc(aggregateRef(db('owner')))).data().validHands, 1);
  });
  for (const uid of ['owner','member','outsider']) await t.test(`${uid} cannot submit`, async () => {
   await seed(); await assertFails(commit(uid));
   assert.equal((await fs.getDoc(aggregateRef(db('owner')))).exists(), false);
  });
  await t.test('replaced host loses writes and receipt access', async () => {
   await seed('r', 'replacement'); await assertFails(commit('host'));
   await assertFails(fs.getDoc(receiptRef(db('host'))));
   await assertSucceeds(commit('replacement'));
  });
  await t.test('summary and receipt are create-only; replay cannot increment', async () => {
   await seed(); await commit('host'); await assertFails(commit('host'));
   await assertFails(fs.updateDoc(summaryRef(db('host')), { netDelta: 1 }));
   await assertFails(fs.deleteDoc(summaryRef(db('host'))));
   await assertFails(fs.deleteDoc(receiptRef(db('host'))));
   assert.equal((await fs.getDoc(aggregateRef(db('owner')))).data().validHands, 1);
  });
  await t.test('concurrent duplicate commit succeeds exactly once', async () => {
   await seed(); const results = await Promise.allSettled([commit('host'),commit('host')]);
   assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
   assert.equal((await fs.getDoc(aggregateRef(db('owner')))).data().validHands, 1);
  });
  await t.test('missing receipt or aggregate rejects entire batch', async () => {
   for (const omit of ['receipt','aggregate']) {
    await seed(); const d = db('host'), b = fs.writeBatch(d), p = payload();
    b.set(summaryRef(d), { ...p.summary, settledAt: fs.serverTimestamp() });
    if (omit !== 'receipt') b.set(receiptRef(d), { uid: 'owner', handKey: p.handKey });
    if (omit !== 'aggregate') b.set(aggregateRef(d), { schemaVersion: 1, startedAt: 1, lastHandKey: p.handKey, updatedAt: fs.serverTimestamp(), ...p.increments });
    await assertFails(b.commit());
    assert.equal((await fs.getDoc(summaryRef(db('owner')))).exists(), false);
   }
  });
  await t.test('forged aggregate increment rejects all writes', async () => {
   await seed(); const p = payload(); p.increments.validHands = 2; await assertFails(commit('host',p));
   assert.equal((await fs.getDoc(receiptRef(db('owner')))).exists(), false);
  });
  await t.test('standalone receipt cannot forge success', async () => {
   await seed(); await assertFails(fs.setDoc(receiptRef(db('host')), { uid: 'owner', handKey: handKey('r','h') }));
  });
  await t.test('Unicode and escaped separators have consistent JS / Rules identity', async () => {
   for (const [r,h] of [['界😀_%','手😀_%'], ['界'.repeat(40), '手'.repeat(128)]]) {
    await seed(r); await assertSucceeds(commit('host',payload(entry(r,h))));
   }
  });
  await t.test('oversized room / hand and extra private payload are denied', async () => {
   for (const change of [{ roomId: 'r'.repeat(41) }, { handId: 'h'.repeat(129) }, { hole: ['As'] }]) {
    await seed(); const p = payload(); Object.assign(p.summary, change);
    await assertFails(commit('host',p));
   }
  });
  await t.test('room pending: current host only, replacement continuation, minimal bounded payload', async () => {
   await seed();
   const q = uid => createRoomPendingQueue({ fs, db: db(uid), roomId: 'r', startedAt: 1 });
   await assertSucceeds(q('host').enqueue(entry()));
   for (const uid of ['owner','member','outsider']) {
    await assertFails(q(uid).list()); await assertFails(q(uid).enqueue(entry('r','other')));
   }
   await env.withSecurityRulesDisabled(c => fs.updateDoc(fs.doc(c.firestore(), 'pokerRooms','r'), { hostUid: 'replacement' }));
   await assertFails(q('host').list()); await assertFails(q('host').enqueue(entry('r','other')));
   assert.equal((await assertSucceeds(q('replacement').list())).length, 1);
   await assertSucceeds(commit('replacement'));
   await assertSucceeds(q('replacement').dequeue('h','owner','r'));
   assert.equal((await q('replacement').list()).length, 0);
   const ref = fs.doc(db('replacement'),'pokerRooms','r','statsPending','queue');
   const clean = { ...entry(), summary: personalSummary(entry(),1) };
   await assertFails(fs.setDoc(ref, { entries: [{ ...clean, hole: ['As'] }] }));
   await assertFails(fs.setDoc(ref, { entries: [{ ...clean, roomId: 'other' }] }));
   await assertFails(fs.setDoc(ref, { entries: Array(7).fill(clean) }));
   assert.equal(REMOTE_ENTRY_CAP, 2);
   const bounded = Array.from({ length: REMOTE_ENTRY_CAP }, (_, i) => ({ ...clean, uid: '界'.repeat(127)+i }));
   await assertSucceeds(fs.setDoc(ref, { entries: bounded }));
   await assertFails(fs.setDoc(ref, { entries: [...bounded, clean] }));
   const before = await q('replacement').list();
   assert.equal(await assertSucceeds(q('replacement').enqueue(entry('r','overflow'))), 'rejected');
   assert.deepEqual(await q('replacement').list(), before);
   await assertFails(fs.getDocs(fs.collection(db('replacement'),'pokerRooms','r','statsPending')));
   await assertFails(fs.deleteDoc(ref));
   await assertFails(fs.getDoc(summaryRef(db('replacement'))));
  });
  await t.test('success without opportunity is denied', async () => {
   await seed(); const p = payload(); p.summary.vpipOpp = false; p.increments.vpipOppHands = 0;
   await assertFails(commit('host',p));
  });
 } finally { await env.cleanup(); }
});
