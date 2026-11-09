// 只連 PM 指定的本機 emulator；不啟動服務、不部署。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import * as fs from 'firebase/firestore';
import { createInitialState, applyAction, getLegalActions } from '../js/engine/game.js';
import { publicState } from '../js/engine/view.js';
import { mulberry32 } from '../js/engine/shuffle.js';
import { hostCloseAllBatch, hostCashoutBatch, ensurePlayerGrant, buyinAll } from '../js/net/ledger.js';

const endpoint = process.env.FIRESTORE_EMULATOR_HOST;
if (!endpoint || !/^(127\.0\.0\.1|localhost):\d+$/.test(endpoint)) {
  throw Error('必須設定本機 FIRESTORE_EMULATOR_HOST');
}
const [host, port] = endpoint.split(':');
const rules = readFileSync(new URL('./firestore.rules', import.meta.url), 'utf8');
fs.setLogLevel('silent');
const between = phase => ['lobby', 'hand_over'].includes(phase);
const chips = state => state.seats.map(p => p?.chips ?? 0);
const uids = ['host', 'friend', 'third', 'fourth', 'fifth', 'sixth'];

test('stacks：真 engine 每步房主寫入與帳務相容', async t => {
  const env = await initializeTestEnvironment({
    projectId: process.env.RULES_PROJECT || 'demo-fix1109',
    firestore: { host, port: Number(port), rules },
  });
  const db = uid => env.authenticatedContext(uid).firestore();
  const hostDb = db('host');
  const roomId = 'stacks-sim';
  const ref = fs.doc(hostDb, 'pokerRooms', roomId);
  let state, room, actionSeq, lastHandsBump, voided;
  const snap = async () => { room = (await fs.getDoc(ref)).data(); return room; };
  const seed = async (amounts = [2000, 2000], seedNumber = 42) => {
    await env.clearFirestore();
    state = createInitialState({ multiplayer: true, timerEnabled: false });
    amounts.forEach((amount, seat) => {
      state = applyAction(state, { type: 'SEAT', seat, id: uids[seat], name: uids[seat], chips: amount });
    });
    actionSeq = 0; lastHandsBump = 0; voided = false;
    const now = fs.Timestamp.now();
    room = {
      name: '牌桌', code: '930', hostUid: 'host', hostSince: now,
      members: uids, status: 'lobby', rev: 2, createdAt: now, updatedAt: now,
      config: { sb: 10, bb: 20, newPlayerChips: 2000, actionMs: 30000, topUpAmount: 2000 },
      pub: publicState(state), seatUids: uids.map((uid, i) => i < amounts.length ? uid : ''),
      stacks: chips(state), chipTotal: amounts.reduce((a, b) => a + b, 0),
      sess: uids.map((uid, i) => i < amounts.length ? {
        uid, sessionNo: 1, buyIn: amounts[i], topUps: 0, topUpChips: 0, hands: 0,
        nightKey: '20261109', startAt: now,
      } : null), deadlineAt: null,
      lastMoneyEvent: { uid: 'friend', id: `${roomId}_1_buyin`, seat: 1, type: 'buyin', amount: amounts[1] },
      lobby: { name: '牌桌', hostName: '房主', hostPhoto: '', blinds: '10/20', seated: amounts.length },
    };
    await env.withSecurityRulesDisabled(async c => {
      const d = c.firestore();
      await fs.setDoc(fs.doc(d, 'pokerRooms', roomId), room);
      for (let i = 0; i < amounts.length; i++) await fs.setDoc(fs.doc(d, 'pokerPlayers', uids[i]), {
        displayName: uids[i], photoURL: null, bank: 0, inPlay: amounts[i], total: amounts[i], tableRoomId: roomId,
        sessionNo: 1, topUps: 0, topUpChips: 0, handsPlayed: 0, lastRoomId: roomId,
        hostRoomId: i === 0 ? roomId : null, createdAt: now, updatedAt: now,
      });
    });
    return { now: 1000000, randUnit: mulberry32(seedNumber) };
  };
  // 與 queueWrite 相同：進行中保留 stacks，between 時同步 engine；房間已存成 hand_over 後每手只加一次 hands。
  const publish = async (extra = {}) => {
    await snap();
    if (state.phase === 'hand_over' && state.handNumber > lastHandsBump &&
        room.pub.phase === 'hand_over' && room.pub.handNo === state.handNumber) {
      const sess = room.sess.map((p, i) => p && room.seatUids[i] === p.uid
        ? { ...p, hands: p.hands + 1 } : p);
      const handsPatch = { rev: room.rev + 1, updatedAt: fs.serverTimestamp(), sess };
      // 手數寫入不能夾帶挪籌碼；總額守恆也必須拒絕。
      const moved = [...room.stacks]; moved[0]--; moved[1]++;
      await assertFails(fs.updateDoc(ref, { ...handsPatch, stacks: moved }));
      await assertSucceeds(fs.updateDoc(ref, handsPatch));
      lastHandsBump = state.handNumber;
      await snap();
    }
    const pub = publicState(state, { actionSeq: ++actionSeq });
    if (voided) pub.voided = true;
    const patch = {
      rev: room.rev + 1, updatedAt: fs.serverTimestamp(), pub, deadlineAt: state.deadline,
      stacks: between(state.phase) ? chips(state) : room.stacks, chipTotal: room.chipTotal,
      sess: room.sess, seatUids: room.seatUids, status: between(state.phase) ? 'lobby' : 'playing',
      lobby: room.lobby, ...extra,
    };
    assert.equal(patch.stacks.reduce((a, b) => a + b, 0), patch.chipTotal);
    await assertSucceeds(fs.updateDoc(ref, patch));
    await snap();
  };
  const step = async (action, engineEnv) => {
    state = applyAction(state, action, engineEnv);
    if (action.type === 'VOID_HAND') voided = true;
    if (['START_HAND', 'ACK_HAND'].includes(action.type)) voided = false;
    await publish();
  };
  const finish = async (engineEnv, policy = () => null) => {
    for (let n = 0; n < 100 && state.phase !== 'hand_over'; n++) {
      if (state.phase === 'showdown') {
        assert.ok(state.showdown.pending.length);
        await step({ type: 'MUCK', seat: state.showdown.pending[0] }, engineEnv);
      } else {
        assert.notEqual(state.actor, null);
        const legal = getLegalActions(state, state.actor);
        const action = policy(state, legal, n) || { type: legal.check ? 'CHECK' : 'CALL' };
        await step({ seat: state.actor, ...action }, engineEnv);
      }
    }
    assert.equal(state.phase, 'hand_over');
    assert.deepEqual(room.stacks, chips(state));
  };
  try {
    await t.test('六人桌 check/call、bet/raise、showdown、多手連續', async () => {
      const e = await seed([2000, 2000, 2000, 2000, 2000, 2000]);
      for (let hand = 0; hand < 3; hand++) {
        await step({ type: 'START_HAND' }, e);
        await finish(e, (_s, _l, n) => n === 0 ? { type: 'BET_RAISE', amount: 60 }
          : n === 1 ? { type: 'BET_RAISE', amount: 120 } : null);
        assert.ok(state.winners.length);
        // 結算那筆不動 sess；房間存成 hand_over 後下一筆才 hands+1（host.js 開下一手前會等這筆）
        assert.equal(room.sess[0].hands, hand);
        await publish();
        assert.deepEqual(room.sess.filter(Boolean).map(p => p.hands), Array(6).fill(hand + 1));
        // ACK 清除 contributed，但 stacks 不變，仍可重送 hand_over。
        await step({ type: 'ACK_HAND' }, e);
        assert.deepEqual(room.sess.filter(Boolean).map(p => p.hands), Array(6).fill(hand + 1));
      }
      await step({ type: 'START_HAND' }, e);
      assert.equal(room.pub.handNo, 4);
      assert.equal(room.pub.phase, 'preflop');
    });
    await t.test('多人 fold 與 foldWin', async () => {
      const e = await seed([2000, 2000, 2000]);
      await step({ type: 'START_HAND' }, e);
      await finish(e, () => ({ type: 'FOLD' }));
      assert.equal(state.lastHandSummary.foldWin, true);
    });
    await t.test('all-in 與多層 side pot', async () => {
      const e = await seed([80, 200, 2000], 77);
      await step({ type: 'START_HAND' }, e);
      await finish(e, (_s, l) => ({ type: l.allIn ? 'ALL_IN' : l.check ? 'CHECK' : 'CALL' }));
      assert.ok(state.winners.length >= 2, '必須實際產生邊池');
    });
    await t.test('固定種子實際 split pot 平手', async () => {
      // engine 的 mulberry32(59) 讓此兩人桌實際平手，不改手牌、pub 或派彩。
      const e = await seed([2000, 2000], 59);
      await step({ type: 'START_HAND' }, e);
      await finish(e);
      assert.ok(state.winners.some(w => w.seats.length > 1));
    });
    await t.test('中途離桌 leftHand 正常結算', async () => {
      const e = await seed([2000, 2000, 2000]);
      await step({ type: 'START_HAND' }, e);
      await step({ type: 'LEAVE_FOLD', seat: 1 }, e);
      assert.equal(state.seats[1].leftHand, true);
      await finish(e);
      assert.equal(room.stacks[1], 2000 - state.seats[1].contributed);
    });
    for (const leave of [false, true]) await t.test(`牌局中作廢、closeAll（中離=${leave}）`, async () => {
      const e = await seed([2000, 2000, 2000, 2000]);
      await step({ type: 'START_HAND' }, e);
      if (leave) await step({ type: 'LEAVE_FOLD', seat: 2 }, e);
      else await step({ type: 'CALL', seat: state.actor }, e);
      await step({ type: 'VOID_HAND', stacks: room.stacks }, e);
      assert.ok(state.seats.filter(Boolean).every(p => p.contributed === 0));
      if (leave) assert.equal(room.stacks[2], 1980);
      await assertSucceeds(hostCloseAllBatch({ fs, db: hostDb }, {
        hostUid: 'host', roomId, room, displayNameOf: uid => uid,
      }));
      assert.equal((await snap()).status, 'closed');
    });
    await t.test('合法接手保留存檔點、接手後重開', async () => {
      const e = await seed();
      await step({ type: 'START_HAND' }, e);
      await env.withSecurityRulesDisabled(c => fs.updateDoc(fs.doc(c.firestore(), 'pokerRooms', roomId), {
        updatedAt: fs.Timestamp.fromMillis(Date.now() - 60000),
      }));
      await assertSucceeds(fs.updateDoc(fs.doc(db('friend'), 'pokerRooms', roomId), {
        rev: room.rev + 1, updatedAt: fs.serverTimestamp(), hostUid: 'friend', hostSince: fs.serverTimestamp(),
        pub: { ...room.pub, phase: 'hand_over', voided: true, board: [], actor: null },
        deadlineAt: null, stacks: room.stacks,
      }));
      // 接手實作保留 stacks；新 host 以存檔點重建 engine。
      await snap();
      state = applyAction(state, { type: 'VOID_HAND', stacks: room.stacks }, e);
      state = applyAction(state, { type: 'START_HAND' }, e);
      await assertSucceeds(fs.updateDoc(fs.doc(db('friend'), 'pokerRooms', roomId), {
        rev: room.rev + 1, updatedAt: fs.serverTimestamp(), pub: publicState(state), stacks: room.stacks,
      }));
    });
    await t.test('手間 buyin、topup、cashout 後繼續下一手', async () => {
      const e = await seed([2000, 2000, 0]);
      await step({ type: 'START_HAND' }, e);
      await finish(e);
      // 補碼：照 approveTopUp 的原子 room + ledger 寫入，帳戶不變。
      const seat = 2, uid = uids[seat], row = room.sess[seat], amount = 2000;
      const id = `${roomId}_${row.sessionNo}_topup1`;
      state = applyAction(state, { type: 'TOP_UP', seat, amount }, e);
      const batch = fs.writeBatch(hostDb);
      const sess = room.sess.map((p, i) => i === seat ? { ...p, topUps: 1, topUpChips: amount } : p);
      batch.update(ref, { rev: room.rev + 1, updatedAt: fs.serverTimestamp(), stacks: chips(state),
        chipTotal: room.chipTotal + amount, sess, pub: publicState(state),
        lastMoneyEvent: { uid, id, seat, type: 'topup', amount } });
      batch.set(fs.doc(hostDb, 'pokerPlayers', uid, 'ledger', id), {
        type: 'topup', amount, roomId, sessionNo: row.sessionNo, seat, buyIn: null, topUps: 1,
        topUpChips: null, hands: null, nightKey: null, bankAfter: null, by: 'host', at: fs.serverTimestamp(),
      });
      await assertSucceeds(batch.commit()); await snap();
      // 新人真的領取贈送並買入，再由房主依帳本入座。
      const newUid = uids[3], fb = { fs, db: db(newUid) };
      await assertSucceeds(ensurePlayerGrant(fb, newUid, roomId, 2000, { displayName: newUid, photoURL: null }));
      await assertSucceeds(buyinAll(fb, newUid, roomId, 20));
      const player = (await fs.getDoc(fs.doc(hostDb, 'pokerPlayers', newUid))).data();
      state = applyAction(state, { type: 'SEAT', seat: 3, id: newUid, name: newUid, chips: player.inPlay }, e);
      const seatUids = [...room.seatUids]; seatUids[3] = newUid;
      const buySess = [...room.sess]; buySess[3] = { uid: newUid, sessionNo: player.sessionNo,
        buyIn: 2000, topUps: 0, topUpChips: 0, hands: 0, nightKey: '20261109', startAt: fs.Timestamp.now() };
      await assertSucceeds(fs.updateDoc(ref, { rev: room.rev + 1, updatedAt: fs.serverTimestamp(),
        pub: publicState(state), stacks: chips(state), chipTotal: room.chipTotal + 2000, sess: buySess, seatUids,
        lastMoneyEvent: { uid: newUid, id: `${roomId}_${player.sessionNo}_buyin`, seat: 3, type: 'buyin', amount: 2000 } }));
      await snap();
      // 真 cashout helper 寫帳本、帳戶與夜間紀錄。
      const cashSeat = 1, cashUid = uids[cashSeat], cashRow = room.sess[cashSeat], cashAmount = room.stacks[cashSeat];
      state = applyAction(state, { type: 'UNSEAT', seat: cashSeat }, e);
      const cashUids = [...room.seatUids]; cashUids[cashSeat] = '';
      const cashSess = [...room.sess]; cashSess[cashSeat] = null;
      await assertSucceeds(hostCashoutBatch({ fs, db: hostDb }, {
        hostUid: 'host', roomId, seat: cashSeat, uid: cashUid, sessRow: cashRow, amount: cashAmount, playerName: cashUid,
        roomPatch: { rev: room.rev + 1, pub: publicState(state), stacks: chips(state),
          chipTotal: room.chipTotal - cashAmount, seatUids: cashUids, sess: cashSess,
          lastMoneyEvent: { uid: cashUid, id: `${roomId}_${cashRow.sessionNo}_cashout`, seat: cashSeat, type: 'cashout', amount: cashAmount } },
      }));
      await snap();
      await step({ type: 'START_HAND' }, e);
      await finish(e);
    });
  } finally { await env.cleanup(); }
});
