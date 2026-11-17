// 管理頁規則測試（SPEC v1.2 §5.6、§7；收桌已拿掉，10:06 宗良）。只連 localhost 模擬器。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import * as fs from 'firebase/firestore';

const endpoint = process.env.FIRESTORE_EMULATOR_HOST;
if (!endpoint || !/^(localhost|127\.0\.0\.1):\d+$/.test(endpoint)) throw Error('只允許 localhost 模擬器');
const [host, port] = endpoint.split(':');
const ADMIN = { email: 'tony197653@gmail.com', email_verified: true, firebase: { sign_in_provider: 'google.com' } };
const env = await initializeTestEnvironment({ projectId: 'demo-admin', firestore: {
  host, port: Number(port), rules: readFileSync(new URL('./firestore.rules', import.meta.url), 'utf8') } });
const admin = () => env.authenticatedContext('adminUid', ADMIN).firestore();
const as = (uid, tok = {}) => env.authenticatedContext(uid, tok).firestore();
const R = 'room1';
const old = () => fs.Timestamp.fromMillis(Date.now() - 5 * 60_000);

async function seed({ seated = false } = {}) {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore(); const t = old();
    await fs.setDoc(fs.doc(db, 'pokerPlayers', 'p1'), { displayName: 'p1', photoURL: null, bank: 5000,
      inPlay: seated ? 2000 : 0, total: seated ? 7000 : 5000, tableRoomId: seated ? R : null, sessionNo: seated ? 1 : 0,
      topUps: 0, topUpChips: 0, handsPlayed: 0, lastRoomId: R, hostRoomId: null, createdAt: t, updatedAt: t });
    await fs.setDoc(fs.doc(db, 'pokerPlayers', 'host'), { displayName: 'host', photoURL: null, bank: 100,
      inPlay: 2000, total: 2100, tableRoomId: R, sessionNo: 1, topUps: 0, topUpChips: 0, handsPlayed: 0,
      lastRoomId: R, hostRoomId: R, createdAt: t, updatedAt: t });
    const seats = ['host', seated ? 'p1' : '', '', '', '', ''];
    await fs.setDoc(fs.doc(db, 'pokerRooms', R), { name: '週四桌', code: '512', hostUid: 'host', hostSince: t, createdAt: t,
      updatedAt: t, status: 'playing', rev: 3, members: ['host', 'p1'], seatUids: seats,
      stacks: seats.map((u) => (u ? 2000 : 0)), chipTotal: seats.filter(Boolean).length * 2000,
      sess: seats.map((u) => (u ? { uid: u, sessionNo: 1, buyIn: 2000, topUps: 0, topUpChips: 0, hands: 0, nightKey: '20261117', startAt: t } : null)),
      config: { sb: 10, bb: 20, newPlayerChips: 2000, actionMs: 30000, topUpAmount: 2000 },
      pub: { phase: 'hand_over', handNo: 1 }, deadlineAt: null, lastMoneyEvent: null,
      lobby: { name: '週四桌', hostName: 'host', hostPhoto: '', blinds: '10/20', seated: seats.filter(Boolean).length } });
    await fs.setDoc(fs.doc(db, 'pokerRooms', R, 'presence', 'host'), { beat: t, vis: true });
    await fs.setDoc(fs.doc(db, 'pokerStats', 'p1'), { schemaVersion: 1, validHands: 3 });
    await fs.setDoc(fs.doc(db, 'pokerStats', 'p1', 'hands', 'h1'), { roomId: R });
    await fs.setDoc(fs.doc(db, 'pokerStatsPublic', 'p1'), { schemaVersion: 1, validHands: 3 });
  });
}
const ID = () => `adj_${Date.now()}_ab12`;
function adjust(db, { delta = 2000, bank, total, id = ID(), reason = '補碼', skipPlayer, skipLedger, ledgerDelta, by = 'adminUid', extra = {} }) {
  const b = fs.writeBatch(db);
  if (!skipPlayer) b.update(fs.doc(db, 'pokerPlayers', 'p1'), { bank, total, lastAdjustId: id, updatedAt: fs.serverTimestamp(), ...extra });
  if (!skipLedger) b.set(fs.doc(db, 'pokerPlayers', 'p1', 'ledger', id), { type: 'adjust', amount: Math.abs(ledgerDelta ?? delta),
    delta: ledgerDelta ?? delta, reason, roomId: '', sessionNo: 0, bankAfter: bank, by, at: fs.serverTimestamp() });
  return b.commit();
}
const results = [];
const T = (name, fn) => test(name, async () => { try { await fn(); results.push([name, 'pass']); } catch (e) { results.push([name, 'FAIL']); throw e; } });

T('A1 管理員加 2,000（沒坐桌）成功', async () => { await seed(); await assertSucceeds(adjust(admin(), { bank: 7000, total: 7000 })); });
T('A2 管理員減 1,000 成功', async () => { await seed(); await assertSucceeds(adjust(admin(), { delta: -1000, bank: 4000, total: 4000 })); });
T('A3 在桌上加帳戶成功，桌上籌碼與 inPlay 不變', async () => {
  await seed({ seated: true });
  await assertSucceeds(adjust(admin(), { bank: 7000, total: 9000 }));
  await env.withSecurityRulesDisabled(async (c) => {
    const cdb = c.firestore();
    const p = (await fs.getDoc(fs.doc(cdb, 'pokerPlayers', 'p1'))).data();
    const r = (await fs.getDoc(fs.doc(cdb, 'pokerRooms', R))).data();
    assert.equal(p.inPlay, 2000); assert.equal(p.tableRoomId, R); assert.equal(p.total, 9000);
    assert.deepEqual(r.stacks, [2000, 2000, 0, 0, 0, 0]); assert.equal(r.chipTotal, 4000);
  });
});
T('A4 在桌上改帳戶時 total 只算 bank（漏 inPlay）被拒', async () => { await seed({ seated: true }); await assertFails(adjust(admin(), { bank: 7000, total: 7000 })); });
T('A5 在桌上改帳戶時順便改 inPlay 被拒', async () => { await seed({ seated: true }); await assertFails(adjust(admin(), { bank: 7000, total: 9000, extra: { inPlay: 0 } })); });
T('B1 非管理員 email 被拒', async () => { await seed(); await assertFails(adjust(as('x', { ...ADMIN, email: 'x@gmail.com' }), { bank: 7000, total: 7000, by: 'x' })); });
T('B2 email 未驗證被拒', async () => { await seed(); await assertFails(adjust(as('adminUid', { ...ADMIN, email_verified: false }), { bank: 7000, total: 7000 })); });
T('B3 非 Google 登入被拒', async () => { await seed(); await assertFails(adjust(as('adminUid', { ...ADMIN, firebase: { sign_in_provider: 'password' } }), { bank: 7000, total: 7000 })); });
T('B4 玩家本人自己加帳戶被拒', async () => { await seed(); await assertFails(adjust(as('p1'), { bank: 7000, total: 7000, by: 'p1' })); });
T('C1 只改帳戶不寫帳本被拒', async () => { await seed(); await assertFails(adjust(admin(), { bank: 7000, total: 7000, skipLedger: true })); });
T('C2 只寫帳本不改帳戶被拒', async () => { await seed(); await assertFails(adjust(admin(), { bank: 7000, total: 7000, skipPlayer: true })); });
T('C3 帳本 delta 與帳戶差不符被拒', async () => { await seed(); await assertFails(adjust(admin(), { bank: 7000, total: 7000, ledgerDelta: 1000 })); });
T('C4 原因空白被拒', async () => { await seed(); await assertFails(adjust(admin(), { bank: 7000, total: 7000, reason: '' })); });
T('C5 原因超過 60 字被拒', async () => { await seed(); await assertFails(adjust(admin(), { bank: 7000, total: 7000, reason: 'x'.repeat(61) })); });
T('C6 減到負數被拒', async () => { await seed(); await assertFails(adjust(admin(), { delta: -6000, bank: -1000, total: -1000 })); });
T('C7 單次超過 100,000 被拒', async () => { await seed(); await assertFails(adjust(admin(), { delta: 100001, bank: 105001, total: 105001 })); });
T('C8 帳本 id 格式不對被拒', async () => { await seed(); await assertFails(adjust(admin(), { bank: 7000, total: 7000, id: 'whatever' })); });
T('C9 adjust 帳本不能改也不能刪', async () => {
  await seed(); const id = ID(); await assertSucceeds(adjust(admin(), { bank: 7000, total: 7000, id }));
  await assertFails(fs.updateDoc(fs.doc(admin(), 'pokerPlayers', 'p1', 'ledger', id), { reason: '改' }));
  await assertFails(fs.deleteDoc(fs.doc(admin(), 'pokerPlayers', 'p1', 'ledger', id)));
});
T('C10 玩家本人不能自己改 lastAdjustId（profile 路徑）', async () => {
  await seed(); await assertFails(fs.updateDoc(fs.doc(as('p1'), 'pokerPlayers', 'p1'), { lastAdjustId: 'adj_1_aaaa', updatedAt: fs.serverTimestamp() }));
  await assertSucceeds(fs.updateDoc(fs.doc(as('p1'), 'pokerPlayers', 'p1'), { displayName: '新名', updatedAt: fs.serverTimestamp() }));
});
T('C11 新玩家建帳戶（無 lastAdjustId）仍成功、帶 lastAdjustId 被拒', async () => {
  await seed();
  const mk = (withAdj) => { const db = as('newbie'); const b = fs.writeBatch(db);
    b.set(fs.doc(db, 'pokerPlayers', 'newbie'), { displayName: 'n', photoURL: null, bank: 2000, inPlay: 0, total: 2000, tableRoomId: null,
      sessionNo: 0, topUps: 0, topUpChips: 0, handsPlayed: 0, lastRoomId: R, createdAt: fs.serverTimestamp(), updatedAt: fs.serverTimestamp(),
      ...(withAdj ? { lastAdjustId: 'adj_1_aaaa' } : {}) });
    b.set(fs.doc(db, 'pokerPlayers', 'newbie', 'ledger', R + '_0_grant'), { type: 'grant', amount: 2000, roomId: R, sessionNo: 0, bankAfter: 2000, by: 'newbie', at: fs.serverTimestamp() });
    return b.commit(); };
  await env.withSecurityRulesDisabled(async (c) => fs.updateDoc(fs.doc(c.firestore(), 'pokerRooms', R), { members: ['host', 'p1', 'newbie'] }));
  await assertFails(mk(true));
  await assertSucceeds(mk(false));
});
T('C12 非 adjust 帳本帶 reason 被拒', async () => {
  await seed();
  await env.withSecurityRulesDisabled(async (c) => fs.updateDoc(fs.doc(c.firestore(), 'pokerRooms', R), { members: ['host', 'p1', 'n2'] }));
  const db = as('n2'); const b = fs.writeBatch(db);
  b.set(fs.doc(db, 'pokerPlayers', 'n2'), { displayName: 'n', photoURL: null, bank: 2000, inPlay: 0, total: 2000, tableRoomId: null, sessionNo: 0, topUps: 0, topUpChips: 0, handsPlayed: 0, lastRoomId: R, createdAt: fs.serverTimestamp(), updatedAt: fs.serverTimestamp() });
  b.set(fs.doc(db, 'pokerPlayers', 'n2', 'ledger', R + '_0_grant'), { type: 'grant', amount: 2000, roomId: R, sessionNo: 0, bankAfter: 2000, by: 'n2', at: fs.serverTimestamp(), reason: 'x' });
  await assertFails(b.commit());
});
T('D1 管理員清除個人紀錄成功（在桌上也可）', async () => {
  await seed({ seated: true }); const db = admin();
  const hs = await assertSucceeds(fs.getDocs(fs.collection(db, 'pokerStats', 'p1', 'hands')));
  assert.equal(hs.size, 1);
  const b = fs.writeBatch(db); hs.docs.forEach((d) => b.delete(d.ref));
  b.delete(fs.doc(db, 'pokerStats', 'p1')); b.delete(fs.doc(db, 'pokerStatsPublic', 'p1'));
  await assertSucceeds(b.commit());
});
T('D2 非管理員、本人都不能刪紀錄或列別人的 hands', async () => {
  await seed();
  for (const db of [as('p1'), as('x', { ...ADMIN, email: 'x@gmail.com' })]) {
    await assertFails(fs.deleteDoc(fs.doc(db, 'pokerStats', 'p1')));
    await assertFails(fs.deleteDoc(fs.doc(db, 'pokerStatsPublic', 'p1')));
    await assertFails(fs.deleteDoc(fs.doc(db, 'pokerStats', 'p1', 'hands', 'h1')));
  }
  await assertFails(fs.getDocs(fs.collection(as('x'), 'pokerStats', 'p1', 'hands')));
});
T('D3 管理員不能刪帳本或每晚戰績', async () => {
  await seed();
  await assertFails(fs.deleteDoc(fs.doc(admin(), 'pokerPlayers', 'p1', 'nights', '20261117')));
  await assertFails(fs.deleteDoc(fs.doc(admin(), 'pokerPlayers', 'p1', 'ledger', 'x')));
  await assertFails(fs.deleteDoc(fs.doc(admin(), 'pokerPlayers', 'p1')));
});
test.after(async () => { console.log('ADMIN_RESULTS', JSON.stringify(results)); await env.cleanup(); });
