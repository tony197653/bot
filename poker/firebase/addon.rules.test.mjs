// ADDON-SPEC：自助加碼規則實測（只連本機 emulator）。6 人滿桌、一手打完的大型 pub 下寫 addon，確認不超過 1000 運算式。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import * as fs from 'firebase/firestore';
import { createInitialState, applyAction, getLegalActions } from '../js/engine/game.js';
import { publicState } from '../js/engine/view.js';
import { mulberry32 } from '../js/engine/shuffle.js';
import { hostAddonBatch } from '../js/net/ledger.js';

const endpoint = process.env.FIRESTORE_EMULATOR_HOST;
if (!endpoint || !/^(127\.0\.0\.1|localhost):\d+$/.test(endpoint)) throw Error('必須設定本機 FIRESTORE_EMULATOR_HOST');
const [host, port] = endpoint.split(':');
const rules = readFileSync(new URL('./firestore.rules', import.meta.url), 'utf8');
fs.setLogLevel('silent');
const uids = ['host', 'p1', 'p2', 'p3', 'p4', 'p5'];

test('addon：6 人滿桌 hand_over 大型 pub 下的加碼規則', async t => {
  const env = await initializeTestEnvironment({ projectId: 'demo-addon', firestore: { host, port: Number(port), rules } });
  t.after(() => env.cleanup());
  await env.clearFirestore();
  const db = uid => env.authenticatedContext(uid).firestore();
  const roomId = 'addonroom';
  let state = createInitialState({ multiplayer: true, timerEnabled: false });
  uids.forEach((id, seat) => { state = applyAction(state, { type: 'SEAT', seat, id, name: id, chips: 2000 }); });
  const envOpt = { now: 1000000, randUnit: mulberry32(7) };
  state = applyAction(state, { type: 'START_HAND' }, envOpt);
  let guard = 0;
  while (state.phase !== 'hand_over' && guard++ < 200) {
    if (state.phase === 'showdown') { state = applyAction(state, { type: 'SHOW', seat: state.showdown.pending[0] }, envOpt); continue; }
    const seat = state.actor; const legal = getLegalActions(state, seat);
    state = applyAction(state, { type: legal.check ? 'CHECK' : 'CALL', seat }, envOpt);
  }
  assert.equal(state.phase, 'hand_over');
  const pub = publicState(state);
  const now = fs.Timestamp.now();
  const stacks = state.seats.map(p => p.chips);
  const room = {
    name: '牌桌', code: '931', hostUid: 'host', hostSince: now, members: uids, status: 'open', rev: 5,
    createdAt: now, updatedAt: now,
    config: { sb: 10, bb: 20, newPlayerChips: 2000, actionMs: 30000, topUpAmount: 2000 },
    pub, seatUids: [...uids], stacks, chipTotal: stacks.reduce((a, b) => a + b, 0),
    sess: uids.map(uid => ({ uid, sessionNo: 1, buyIn: 2000, topUps: 0, topUpChips: 0, hands: 1, nightKey: '20261117', startAt: now })),
    deadlineAt: null, lastMoneyEvent: { uid: 'p5', id: `${roomId}_1_buyin`, seat: 5, type: 'buyin', amount: 2000 },
    lobby: { name: '牌桌', hostName: '房主', hostPhoto: '', blinds: '10/20', seated: 6 },
  };
  await env.withSecurityRulesDisabled(async c => {
    const d = c.firestore();
    await fs.setDoc(fs.doc(d, 'pokerRooms', roomId), room);
    for (const [i, uid] of uids.entries()) await fs.setDoc(fs.doc(d, 'pokerPlayers', uid), {
      displayName: uid, photoURL: null, bank: 8000, inPlay: stacks[i], total: 8000 + stacks[i],
      tableRoomId: roomId, sessionNo: 1, topUps: 0, topUpChips: 0, handsPlayed: 0, lastRoomId: roomId,
      hostRoomId: i === 0 ? roomId : null, createdAt: now, updatedAt: now,
    });
  });
  console.log('pub bytes', JSON.stringify(pub).length);
  // 本人排隊兩筆；別人不能幫他排；房主不能塞金額
  const q = uid => fs.doc(db(uid), 'pokerRooms', roomId, 'addons', uid);
  await assertSucceeds(fs.setDoc(q('p1'), { items: [{ id: 'a1', amount: 1000 }], seq: 1, at: fs.serverTimestamp() }));
  await assertSucceeds(fs.setDoc(q('p1'), { items: [{ id: 'a1', amount: 1000 }, { id: 'a2', amount: 500 }], seq: 2, at: fs.serverTimestamp() }));
  await assertFails(fs.setDoc(fs.doc(db('p2'), 'pokerRooms', roomId, 'addons', 'p1'), { items: [], seq: 3, at: fs.serverTimestamp() }));
  await assertFails(fs.updateDoc(fs.doc(db('host'), 'pokerRooms', roomId, 'addons', 'p1'), { items: [{ id: 'x', amount: 1 }] }));
  // 房主批次：6 人滿桌大型 pub 下要成功（1000 運算式上限）
  const hfb = { db: db('host'), fs };
  const res = await hostAddonBatch(hfb, { hostUid: 'host', roomId, playerUid: 'p1' });
  assert.equal(res.amount, 1500);
  const after = (await fs.getDoc(fs.doc(db('host'), 'pokerRooms', roomId))).data();
  assert.equal(after.stacks[1], stacks[1] + 1500);
  assert.equal(after.sess[1].topUps, 2);
  const p1 = (await fs.getDoc(fs.doc(db('p1'), 'pokerPlayers', 'p1'))).data();
  assert.equal(p1.bank, 6500); assert.equal(p1.total, 8000 + stacks[1]);
  // 帳本不能覆寫
  await assertFails(fs.setDoc(fs.doc(db('host'), 'pokerPlayers', 'p1', 'ledger', `${roomId}_1_addon_a1`), { type: 'addon', amount: 1 }));
  // 帳戶不足：全部不上、不扣錢
  await assertSucceeds(fs.setDoc(q('p5'), { items: [{ id: 'b1', amount: 20 }], seq: 1, at: fs.serverTimestamp() }));
  // 排隊時有足額帳戶，處理前才下降，符合已核准的帳戶不足情境。
  await env.withSecurityRulesDisabled(c => fs.updateDoc(fs.doc(c.firestore(), 'pokerPlayers', 'p5'), {
    bank: 10, total: 10 + stacks[5],
  }));
  const r5 = await hostAddonBatch(hfb, { hostUid: 'host', roomId, playerUid: 'p5' });
  assert.equal(r5.rejected, true);
  // 非房主直接改房間加碼被拒
  const cur = (await fs.getDoc(fs.doc(db('host'), 'pokerRooms', roomId))).data();
  const bad = { stacks: cur.stacks.map((v, i) => i === 2 ? v + 100 : v), chipTotal: cur.chipTotal + 100, rev: cur.rev + 1,
    updatedAt: fs.serverTimestamp(), lastMoneyEvent: { type: 'addon', seat: 2, uid: 'p2', amount: 100, ids: ['z'] },
    sess: cur.sess.map((s, i) => i === 2 ? { ...s, topUps: s.topUps + 1, topUpChips: s.topUpChips + 100 } : s) };
  await assertFails(fs.updateDoc(fs.doc(db('p2'), 'pokerRooms', roomId), bad));
  // 手中（非兩手之間）房主加碼被拒
  await env.withSecurityRulesDisabled(c => fs.updateDoc(fs.doc(c.firestore(), 'pokerRooms', roomId), { 'pub.phase': 'flop' }));
  await assertSucceeds(fs.setDoc(q('p3'), { items: [{ id: 'c1', amount: 100 }], seq: 1, at: fs.serverTimestamp() }));
  await assert.rejects(hostAddonBatch(hfb, { hostUid: 'host', roomId, playerUid: 'p3' }));
});
