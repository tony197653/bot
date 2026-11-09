import { test } from 'node:test';
import assert from 'node:assert/strict';
import { personalSummary, handKey, utf8Bytes, createStatsSubmitter, createStatsRecovery } from '../js/stats/submission.js';
import { createBoundedPendingQueue, BYTE_BUDGET } from '../js/stats/bounded-queue.js';
import { createFirestoreStatsAdapter } from '../js/stats/firestore-adapter.js';
const entry = (uid = 'u', handId = 'h') => ({ roomId: 'r', handId, uid, enqueuedAt: 1,
 summary: { handStartedAt: 100, wonAnyPot: true, vpipOpp: true, vpip: true, pfrOpp: true,
 pfr: false, threeBetOpp: false, threeBet: false, netDelta: -100 } });
const storage = () => { let v = null; return { getItem: () => v, setItem: (_, next) => { v = next; } }; };
test('B minimal summary, T0 and opportunity validation, unambiguous keys', () => {
 const e = entry(); e.summary.hole = ['As'];
 assert.equal(personalSummary(e, 100).hole, undefined);
 assert.throws(() => personalSummary(e, 101));
 assert.notEqual(handKey('a','bc'), handKey('ab','c'));
 e.summary.vpipOpp = false; assert.throws(() => personalSummary(e, 1));
});
test('B partial success, durable reload, denied submission retained, receipt dedupe', async () => {
 const disk = storage(); const make = () => createBoundedPendingQueue({ storage: disk, storageKey: 'device-host' });
 let q = make(); await q.enqueue(entry('a')); await q.enqueue(entry('b'));
 const receipts = new Map(); let fail = true; let commits = 0;
 const submit = createStatsSubmitter({ startedAt: 1, adapter: {
 async readReceipt(id) { return receipts.get(id.uid); }, async commit(d) {
 if (d.uid === 'b' && fail) throw Error('permission-denied');
 commits++; receipts.set(d.uid, { uid: d.uid, handKey: d.handKey });
 assert.equal(d.increments.validHands, 1); assert.equal(d.increments.netChips, -100);
 } } });
 const worker = createStatsRecovery({ queue: q, submit, now: () => 0 });
 await worker.wake(); assert.deepEqual((await q.list()).map(e => e.uid), ['b']);
 await worker.wake(); assert.equal(commits, 1);
 fail = false; q = make(); await createStatsRecovery({ queue: q, submit }).wake();
 assert.equal((await q.list()).length, 0); assert.equal(commits, 2);
 await submit(entry('a')); assert.equal(commits, 2);
 await assert.rejects(createStatsSubmitter({ adapter: {} })(entry()));
});
test('B acknowledgement loss requires actual server receipt; denied reads fail', async () => {
 let done = false;
 const submit = createStatsSubmitter({ startedAt: 1, adapter: {
 async readReceipt(id) { return done ? { uid: id.uid, handKey: id.handKey } : null; },
 async commit() { done = true; throw Error('ack lost'); } } });
 assert.equal(await submit(entry()), 'confirmed');
 await assert.rejects(createStatsSubmitter({ startedAt: 1, adapter: {
 async readReceipt() { throw Error('permission-denied'); } } })(entry()));
});
test('B capacity and quota failure preserve unsent entries, cleanup cannot silently fail', async () => {
 const disk = storage(); const original = disk.setItem; const statuses = [];
 const q = createBoundedPendingQueue({ storage: disk, storageKey: 'host',
 budget: { entry: 8192, device: utf8Bytes([entry()]) }, onStatus: s => statuses.push(s) });
 await q.enqueue(entry()); assert.equal(await q.enqueue(entry('v')), 'rejected');
 disk.setItem = () => { throw Error('QuotaExceededError'); };
 await assert.rejects(q.dequeue('h','u','r')); assert.equal((await q.list()).length, 1);
 disk.setItem = original; await q.dequeue('h','u','r'); assert.equal((await q.list()).length, 0);
 assert.ok(statuses.includes('統計尚未完整保存，牌局不受影響'));
});
test('B/C injected SDK: four writes in one batch (summary, private agg, public agg, receipt), increments, server-only receipt read', async () => {
 const writes = []; let committed = false;
 const fs = { doc: (_, ...parts) => parts.join('/'), serverTimestamp: () => 'SERVER', increment: n => ({ increment: n }),
 getDocFromServer: async ref => { assert.match(ref,/statsReceipts/); return { exists: () => false }; },
 writeBatch: () => ({ set: (...args) => writes.push(args), commit: async () => { committed = true; } }) };
 await createStatsSubmitter({ startedAt: 1, adapter: createFirestoreStatsAdapter({ fs, db: {} }) })(entry());
 assert.equal(writes.length, 4); assert.ok(committed);
 assert.deepEqual(writes[1][1].validHands, { increment: 1 });
 assert.match(writes[2][0], /^pokerStatsPublic\//); assert.equal('lastHandKey' in writes[2][1], false);
 assert.deepEqual(writes[2][1].validHands, { increment: 1 });
 assert.deepEqual(writes[3][1], { uid: 'u', handKey: handKey('r','h') });
});
test('B actual UTF-8 boundary payload measurement', () => {
 const rows = Array.from({ length: 6 }, (_, i) => {
 const e = entry('界'.repeat(127)+i, 'h'.repeat(128)); e.roomId = 'r'.repeat(40);
 e.summary.netDelta = Number.MIN_SAFE_INTEGER; e.summary.handStartedAt = Number.MAX_SAFE_INTEGER;
 e.enqueuedAt = Number.MAX_SAFE_INTEGER; return e;
 });
 const measured = { entry: utf8Bytes(rows[0]), sixPlayers: utf8Bytes(rows),
 partialRetry: utf8Bytes({ pending: rows.slice(1), submitted: [rows[0].uid], attempts: 64, retryAt: Number.MAX_SAFE_INTEGER }),
 summary: utf8Bytes(personalSummary(rows[0], 1)) };
 console.log('PHASE_B_UTF8_BYTES', JSON.stringify(measured), 'BUDGET', JSON.stringify(BYTE_BUDGET));
 assert.ok(measured.entry < BYTE_BUDGET.entry); assert.ok(measured.sixPlayers < BYTE_BUDGET.device);
 assert.ok(utf8Bytes(rows[0]) > JSON.stringify(rows[0]).length);
});
