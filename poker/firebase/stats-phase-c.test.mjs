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
assert.equal(source.split(disabled).length, 2, 'production B must remain disabled');
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

test('C Rules public aggregate read matrix (demo-poker only)', async t => {
 const env = await initializeTestEnvironment({ projectId: 'demo-poker', firestore: { host, port: Number(port), rules } });
 const db = (uid, provider = 'google.com') => env.authenticatedContext(uid, { firebase: { sign_in_provider: provider } }).firestore();
 const commit = (uid, data = payload()) => createFirestoreStatsAdapter({ fs, db: db(uid) }).commit(data);
 const pubRef = d => fs.doc(d, 'pokerStatsPublic', 'owner');
 const seed = async () => {
   await env.clearFirestore();
   await env.withSecurityRulesDisabled(async c => {
     const f = c.firestore();
     await fs.setDoc(fs.doc(f, 'pokerRooms', 'r'), { hostUid: 'host', members: ['host','owner','member'], status: 'playing', seatUids: ['host','owner',null,null,null,null], stacks: [1000, 1500, 0, 0, 0, 0] });
     for (const u of ['host','owner','member']) await fs.setDoc(fs.doc(f, 'pokerPlayers', u), { bank: 300 });
   });
 };
 try {
  await t.test('legit host commit writes public projection without private fields', async () => {
   await seed(); await assertSucceeds(commit('host'));
   const d = (await fs.getDoc(pubRef(db('owner')))).data();
   assert.equal(d.validHands, 1); assert.equal('lastHandKey' in d, false);
  });
  await t.test('registered player reads other public aggregate', async () => {
   await assertSucceeds(fs.getDoc(pubRef(db('reader'))));
   await assertSucceeds(fs.getDoc(pubRef(db('owner'))));
  });
  await t.test('unauthenticated denied; anonymous / no own pokerPlayers allowed (v1.0.4 signedIn)', async () => {
   await assertFails(fs.getDoc(pubRef(env.unauthenticatedContext().firestore())));
   await assertSucceeds(fs.getDoc(pubRef(db('reader', 'anonymous'))));
   await assertSucceeds(fs.getDoc(pubRef(db('stranger'))));
   await assertFails(fs.getDocs(fs.collection(db('reader'), 'pokerStatsPublic')));
  });
  await t.test('other player private data still denied', async () => {
   await assertFails(fs.getDoc(fs.doc(db('reader'), 'pokerStats', 'owner')));
   await assertFails(fs.getDoc(fs.doc(db('reader'), 'pokerStats', 'owner', 'hands', handKey('r','h'))));
   await assertFails(fs.getDocs(fs.collection(db('reader'), 'pokerStats', 'owner', 'hands')));
   await assertFails(fs.getDoc(fs.doc(db('reader'), 'pokerRooms', 'r', 'statsPending', 'queue')));
  });
  await t.test('arbitrary public writes denied', async () => {
   for (const uid of ['owner','reader','host']) {
    await assertFails(fs.setDoc(pubRef(db(uid)), { validHands: 999 }, { merge: true }));
    await assertFails(fs.deleteDoc(pubRef(db(uid))));
   }
   const hd = db('host'); const b = fs.writeBatch(hd);
   b.set(pubRef(hd), { schemaVersion: 1, startedAt: 1, validHands: 50, updatedAt: fs.serverTimestamp() }, { merge: true });
   await assertFails(b.commit());
  });
  await t.test('chips total: host writes bank+stack; forged / non-host / wrong seat denied', async () => {
   const chips = (uid, total, seat = 1, room = 'r') => fs.updateDoc(pubRef(db(uid)), { currentChipsTotal: total, chipsAt: fs.serverTimestamp(), chipsRoomId: room, chipsSeat: seat });
   await assertFails(chips('host', 9999));
   await assertFails(chips('owner', 1800));
   await assertFails(chips('reader', 1800));
   await assertFails(chips('host', 1300, 0));
   await assertSucceeds(createFirestoreStatsAdapter({ fs, db: db('host') }).writeChips({ uid: 'owner', roomId: 'r', seat: 1, stack: 1500 }));
   assert.equal((await fs.getDoc(pubRef(db('reader', 'anonymous')))).data().currentChipsTotal, 1800);
   await assertFails(fs.updateDoc(pubRef(db('host')), { currentChipsTotal: 1800, validHands: 9, chipsAt: fs.serverTimestamp(), chipsRoomId: 'r', chipsSeat: 1 }));
  });
  await t.test('legit host resubmit of new hand ok; duplicate rejected', async () => {
   await assertSucceeds(commit('host', payload(entry('r', 'h2'))));
   assert.equal((await fs.getDoc(pubRef(db('reader')))).data().validHands, 2);
   await assertFails(commit('host', payload(entry('r', 'h2'))));
   assert.equal((await fs.getDoc(pubRef(db('reader')))).data().validHands, 2);
  });
 } finally { await env.cleanup(); }
});
