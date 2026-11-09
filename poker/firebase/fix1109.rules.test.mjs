// 僅連 PM 明確指定的本機 emulator；不替換正式 Rules、不啟用任何功能。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import * as fs from 'firebase/firestore';
import { hostCloseAllBatch, hostCashoutBatch, buyinAmount, buyinAll, ensurePlayerGrant, settleClosedRoomBinding } from '../js/net/ledger.js';
import { createSingleTable, closeRoom } from '../js/net/room.js';
import { createHostLoop } from '../js/net/host.js';

const endpoint = process.env.FIRESTORE_EMULATOR_HOST;
if (!endpoint || !/^(127\.0\.0\.1|localhost):\d+$/.test(endpoint)) {
  throw Error('必須設定本機 FIRESTORE_EMULATOR_HOST；projectId 使用 RULES_PROJECT 或 demo-fix1109');
}
const [host, port] = endpoint.split(':');
const rules = readFileSync(new URL('./firestore.rules', import.meta.url), 'utf8');
fs.setLogLevel('silent');

test('fix1109：零手數收桌／第三人入座／禁止房主任意移錢', async t => {
  const previousDocument = globalThis.document;
  globalThis.document = { visibilityState: 'visible' };
  const env = await initializeTestEnvironment({ projectId: process.env.RULES_PROJECT || 'demo-fix1109', firestore: { host, port: Number(port), rules } });
  const db = uid => env.authenticatedContext(uid).firestore();
  const roomId = 'r930';
  const roomRef = d => fs.doc(d, 'pokerRooms', roomId);
  const seed = async () => {
    await env.clearFirestore();
    const now = fs.Timestamp.now();
    const room = { name: '牌桌', code: '930', hostUid: 'host', hostSince: now,
      members: ['host', 'friend', 'third'], status: 'lobby', rev: 2, createdAt: now, updatedAt: now,
      config: { sb: 10, bb: 20, newPlayerChips: 2000, actionMs: 30000, topUpAmount: 2000 },
      pub: { phase: 'lobby', handNo: 0, actionSeq: 2, seats: Array(6).fill(null), board: [], away: {}, seatedAt: [1, 2, 0, 0, 0, 0], pendingSeats: [], topUpReqs: {}, rejects: {} },
      seatUids: ['host', 'friend', '', '', '', ''], stacks: [2000, 2000, 0, 0, 0, 0], chipTotal: 4000,
      sess: ['host', 'friend', null, null, null, null].map(uid => uid ? {
        uid, sessionNo: 1, buyIn: 2000, topUps: 0, topUpChips: 0, hands: 0, nightKey: '20261109', startAt: now,
      } : null), deadlineAt: null,
      lastMoneyEvent: { uid: 'friend', id: `${roomId}_1_buyin`, seat: 1, type: 'buyin', amount: 2000 },
      lobby: { name: '牌桌', hostName: '房主', hostPhoto: '', blinds: '10/20', seated: 2 },
    };
    await env.withSecurityRulesDisabled(async c => {
      const d = c.firestore();
      await fs.setDoc(roomRef(d), room);
      for (const uid of ['host', 'friend']) {
        await fs.setDoc(fs.doc(d, 'pokerPlayers', uid), {
          displayName: uid, photoURL: null, bank: 0, inPlay: 2000, total: 2000, tableRoomId: roomId,
          sessionNo: 1, topUps: 0, topUpChips: 0, handsPlayed: 0, lastRoomId: roomId,
          hostRoomId: uid === 'host' ? roomId : null, createdAt: now, updatedAt: now,
        });
      }
    });
    return room;
  };
  const seedBuyer = async () => {
    await seed();
    await env.withSecurityRulesDisabled(async c => {
      const d = c.firestore(), now = fs.Timestamp.now();
      await fs.setDoc(fs.doc(d, 'pokerPlayers', 'third'), {
        displayName: 'third', photoURL: null, bank: 8765, inPlay: 0, total: 8765,
        tableRoomId: null, sessionNo: 0, topUps: 0, topUpChips: 0, handsPlayed: 0,
        lastRoomId: roomId, hostRoomId: null, createdAt: now, updatedAt: now,
      });
    });
  };
  const rawBuyin = async (amount, bank = 8765 - amount, by = 'third') => {
    const d = db(by), b = fs.writeBatch(d);
    b.update(fs.doc(d, 'pokerPlayers', 'third'), { bank, inPlay: amount, tableRoomId: roomId,
      sessionNo: 1, lastRoomId: roomId, updatedAt: fs.serverTimestamp() });
    b.set(fs.doc(d, 'pokerPlayers', 'third', 'ledger', `${roomId}_1_buyin`), {
      type: 'buyin', amount, roomId, sessionNo: 1, bankAfter: bank, by, at: fs.serverTimestamp(),
    });
    return b.commit();
  };
  try {
    await t.test('自選買入 2000，保留 6765 且 total 不變', async () => {
      await seedBuyer();
      await assertSucceeds(buyinAmount({ fs, db: db('third') }, 'third', roomId, 20, 2000));
      const p = (await fs.getDoc(fs.doc(db('third'), 'pokerPlayers', 'third'))).data();
      assert.equal(p.bank, 6765); assert.equal(p.inPlay, 2000); assert.equal(p.total, 8765);
    });
    for (const [name, amount, bank, by] of [
      ['低於 50BB', 999, 7766, 'third'], ['超過 bank', 8766, -1, 'third'],
      ['未扣足 bank', 2000, 8765, 'third'], ['他人代寫買入', 2000, 6765, 'host'],
    ]) await t.test(name + '拒絕', async () => { await seedBuyer(); await assertFails(rawBuyin(amount, bank, by)); });
    await t.test('補碼 ledger 與房間改寫均拒絕', async () => {
      const r = await seed(), d = db('host');
      await assertFails(fs.setDoc(fs.doc(d,'pokerPlayers','friend','ledger',`${roomId}_1_topup1`), {
        type:'topup',amount:2000,roomId,sessionNo:1,seat:1,topUps:1,by:'host',at:fs.serverTimestamp(),
      }));
      await assertFails(fs.updateDoc(roomRef(d), { rev:r.rev+1,updatedAt:fs.serverTimestamp(),
        stacks:[2000,4000,0,0,0,0],chipTotal:6000,
        lastMoneyEvent:{uid:'friend',id:`${roomId}_1_topup1`,seat:1,type:'topup',amount:2000} }));
      // 舊版可核准的完整補碼批次：輸光席＋房間＋帳本，現在必須拒絕。
      await env.withSecurityRulesDisabled(c => fs.updateDoc(roomRef(c.firestore()), {stacks:[4000,0,0,0,0,0]}));
      const batch = fs.writeBatch(d), id = `${roomId}_1_topup1`;
      batch.update(roomRef(d), {rev:r.rev+1,updatedAt:fs.serverTimestamp(),
        stacks:[4000,2000,0,0,0,0],chipTotal:6000,
        sess:[r.sess[0],{...r.sess[1],topUps:1,topUpChips:2000},null,null,null,null],
        lastMoneyEvent:{uid:'friend',id,seat:1,type:'topup',amount:2000}});
      batch.set(fs.doc(d,'pokerPlayers','friend','ledger',id), {
        type:'topup',amount:2000,roomId,sessionNo:1,seat:1,buyIn:null,topUps:1,
        topUpChips:null,hands:null,nightKey:null,bankAfter:null,by:'host',at:fs.serverTimestamp(),
      });
      await assertFails(batch.commit());
    });
    await t.test('房主將輸光 0-stack 席結帳，bank 保持餘額且桌上總額不變', async () => {
      const r = await seed();
      r.stacks = [4000,0,0,0,0,0]; r.pub.phase = 'hand_over';
      await env.withSecurityRulesDisabled(async c => {
        const f = c.firestore();
        await fs.updateDoc(roomRef(f), { stacks:r.stacks,pub:r.pub });
        await fs.updateDoc(fs.doc(f,'pokerPlayers','friend'), {bank:765,total:2765});
      });
      await assertSucceeds(hostCashoutBatch({fs,db:db('host')}, {
        hostUid:'host',roomId,seat:1,uid:'friend',sessRow:r.sess[1],amount:0,playerName:'friend',
        roomPatch:{ rev:r.rev+1,seatUids:['host','','','','',''],stacks:r.stacks,chipTotal:4000,
          sess:[r.sess[0],null,null,null,null,null],pub:r.pub,
          lastMoneyEvent:{uid:'friend',id:`${roomId}_1_cashout`,seat:1,type:'cashout',amount:0} },
      }));
      let p, ct;
      await env.withSecurityRulesDisabled(async c => {
        const f = c.firestore();
        p = (await fs.getDoc(fs.doc(f,'pokerPlayers','friend'))).data();
        ct = (await fs.getDoc(roomRef(f))).data().chipTotal;
      });
      assert.equal(p.bank,765); assert.equal(p.inPlay,0); assert.equal(p.total,765);
      assert.equal(ct,4000);
    });
    await t.test('房主離線獨坐：非房主懶惰收桌回收 000，本人稍後結算守恆且不重複', async () => {
      const original = await seed();
      const stale = fs.Timestamp.fromMillis(Date.now() - 31 * 60_000);
      await env.withSecurityRulesDisabled(async c => {
        const d = c.firestore();
        await fs.updateDoc(roomRef(d), {
          code: '000', members: ['host'], updatedAt: stale,
          seatUids: ['host', '', '', '', '', ''], stacks: [2000, 0, 0, 0, 0, 0],
          chipTotal: 2000, sess: [original.sess[0], null, null, null, null, null],
        });
        await fs.setDoc(fs.doc(d, 'pokerRooms', roomId, 'presence', 'host'), { beat: stale, vis: false });
        await fs.setDoc(fs.doc(d, 'pokerCodes', '000'), {
          roomId, hostUid: 'host', createdAt: stale, expiresAt: fs.Timestamp.fromMillis(Date.now() + 86400000),
        });
        await fs.setDoc(fs.doc(d, 'pokerLobby', roomId), {
          ...original.lobby, code: '000', hostUid: 'host', status: 'lobby', createdAt: stale,
        });
      });
      const opener = { fs, db: db('third') };
      await assertFails(fs.updateDoc(fs.doc(db('third'), 'pokerPlayers', 'host'), {
        bank: 2000, inPlay: 0, total: 2000, tableRoomId: null, updatedAt: fs.serverTimestamp(),
      }));
      const created = await assertSucceeds(createSingleTable(opener, {
        uid: 'third', name: '牌桌', displayName: '新房主', sb: 10, bb: 20, newPlayerChips: 2000,
      }));
      assert.notEqual(created.roomId, roomId);
      assert.equal(created.code, '000');
      const closed = (await fs.getDoc(roomRef(db('host')))).data();
      assert.equal(closed.status, 'closed');
      assert.equal(closed.closedBy, 'auto');
      assert.equal(closed.stacks[0], 2000);
      let player = (await fs.getDoc(fs.doc(db('host'), 'pokerPlayers', 'host'))).data();
      assert.equal(player.bank, 0);
      assert.equal(player.inPlay, 2000);
      const hostFb = { fs, db: db('host') };
      await assertSucceeds(settleClosedRoomBinding(hostFb, 'host', { ...closed, id: roomId }));
      await assertSucceeds(settleClosedRoomBinding(hostFb, 'host', { ...closed, id: roomId }));
      player = (await fs.getDoc(fs.doc(db('host'), 'pokerPlayers', 'host'))).data();
      assert.equal(player.bank, 2000);
      assert.equal(player.inPlay, 0);
      assert.equal(player.tableRoomId, null);
      assert.equal((await fs.getDoc(fs.doc(db('third'), 'pokerCodes', '000'))).data().roomId, created.roomId);
    });
    await t.test('房主心跳新鮮：開桌者加入原 000，不收桌、不回收', async () => {
      const original = await seed();
      const stale = fs.Timestamp.fromMillis(Date.now() - 31 * 60_000);
      await env.withSecurityRulesDisabled(async c => {
        const d = c.firestore();
        await fs.updateDoc(roomRef(d), { code: '000', updatedAt: stale,
          seatUids: ['host', '', '', '', '', ''], stacks: [2000, 0, 0, 0, 0, 0],
          chipTotal: 2000, sess: [original.sess[0], null, null, null, null, null] });
        await fs.setDoc(fs.doc(d, 'pokerRooms', roomId, 'presence', 'host'), { beat: fs.Timestamp.now(), vis: true });
        await fs.setDoc(fs.doc(d, 'pokerCodes', '000'), { roomId, hostUid: 'host', createdAt: stale,
          expiresAt: fs.Timestamp.fromMillis(Date.now() + 86400000) });
      });
      const joined = await assertSucceeds(createSingleTable({ fs, db: db('third') }, {
        uid: 'third', name: '牌桌', sb: 10, bb: 20, newPlayerChips: 2000,
      }));
      assert.equal(joined.roomId, roomId);
      assert.equal(joined.existing, true);
      assert.equal((await fs.getDoc(roomRef(db('host')))).data().status, 'lobby');
    });
    await t.test('固定碼 000：建立／加入／並行唯一／關閉後回收', async () => {
      await env.clearFirestore();
      const opts = { uid: 'host', name: '牌桌', displayName: '房主', sb: 10, bb: 20, newPlayerChips: 2000 };
      const hostFb = { fs, db: db('host') };
      const created = await assertSucceeds(createSingleTable(hostFb, opts));
      assert.equal(created.code, '000');
      const joined = await assertSucceeds(createSingleTable({ fs, db: db('friend') }, { ...opts, uid: 'friend' }));
      assert.equal(joined.roomId, created.roomId);
      assert.ok((await fs.getDoc(fs.doc(db('friend'), 'pokerRooms', created.roomId))).data().members.includes('friend'));
      assert.equal(joined.existing, true);
      await assertSucceeds(closeRoom(hostFb, created.roomId));
      // 關閉文件保留時仍可重新開桌；不重用已關閉房間 ID。
      const reopened = await assertSucceeds(createSingleTable({ fs, db: db('third') }, { ...opts, uid: 'third' }));
      assert.notEqual(reopened.roomId, created.roomId);
      assert.equal(reopened.code, '000');
      assert.equal((await fs.getDoc(fs.doc(db('third'), 'pokerCodes', '000'))).data().roomId, reopened.roomId);
      await env.clearFirestore();
      // 兩人完成 legacy 預查與固定碼預讀後才繼續，交給真實交易處理衝突。
      let arrivals = 0, release;
      const barrier = new Promise(resolve => { release = resolve; });
      const concurrentFs = { ...fs, getDoc: async ref => {
        const snap = await fs.getDoc(ref);
        if (ref.path === 'pokerCodes/000' && arrivals < 2) {
          if (++arrivals === 2) release();
          await barrier;
        }
        return snap;
      } };
      const concurrent = await Promise.all([
        assertSucceeds(createSingleTable({ fs: concurrentFs, db: db('host') }, opts)),
        assertSucceeds(createSingleTable({ fs: concurrentFs, db: db('friend') }, { ...opts, uid: 'friend' })),
      ]);
      assert.equal(arrivals, 2);
      assert.equal(concurrent[0].roomId, concurrent[1].roomId);
      assert.equal(concurrent.filter(r => !r.existing).length, 1);
      await env.withSecurityRulesDisabled(async c => {
        const rooms = await fs.getDocs(fs.collection(c.firestore(), 'pokerRooms'));
        assert.equal(rooms.size, 1, '不得先建立多桌再關閉收斂');
      });
    });
    await t.test('兩人各買入 2000，未開局 closeAll 七文件原子結算成功', async () => {
      const room = await seed();
      await assertSucceeds(hostCloseAllBatch({ fs, db: db('host') }, { hostUid: 'host', roomId, room, displayNameOf: uid => uid }));
      assert.equal((await fs.getDoc(roomRef(db('host')))).data().status, 'closed');
      for (const uid of ['host', 'friend']) {
        const p = (await fs.getDoc(fs.doc(db(uid), 'pokerPlayers', uid))).data();
        assert.equal(p.bank, 2000); assert.equal(p.inPlay, 0); assert.equal(p.tableRoomId, null);
      }
    });
    await t.test('第三個新帳號贈送 2000、整筆買入、房主寫入第三席成功', async () => {
      let room = await seed();
      const thirdFb = { fs, db: db('third') };
      await assertSucceeds(ensurePlayerGrant(thirdFb, 'third', roomId, 2000, { displayName: '第三人', photoURL: null }));
      await assertSucceeds(buyinAll(thirdFb, 'third', roomId, 20));
      const loop = createHostLoop({ fs, db: db('host') }, { roomId, uid: 'host', getRoom: () => room, stats: { enabled: false } });
      try {
        loop.start();
        await assertSucceeds(loop.seatPlayer(2, 'third'));
        room = (await fs.getDoc(roomRef(db('host')))).data();
        assert.equal(room.seatUids[2], 'third'); assert.equal(room.chipTotal, 6000);
      } finally { loop.stop(); }
    });
    for (const [name, oldPhase, newPhase, stacks, opts = {}] of [
      ['lobby 同總和重分配', 'lobby', 'lobby', [4000, 0, 0, 0, 0, 0]],
      ['兩人互換不同 stacks', 'lobby', 'lobby', [1000, 3000, 0, 0, 0, 0], { before: [3000, 1000, 0, 0, 0, 0] }],
      ['兩手之間移錢', 'hand_over', 'hand_over', [2100, 1900, 0, 0, 0, 0]],
      ['牌局中移錢', 'preflop', 'flop', [2100, 1900, 0, 0, 0, 0]],
      ['結算讓棄牌者變多', 'river', 'hand_over', [2100, 1900, 0, 0, 0, 0], { folded: 0 }],
      ['結算贏家超領導致他人低於投入下限', 'river', 'hand_over', [2200, 1800, 0, 0, 0, 0]],
      ['作廢讓未棄牌者變少', 'flop', 'hand_over', [2100, 1900, 0, 0, 0, 0], { voided: true }],
      ['接手同時移錢', 'preflop', 'hand_over', [2100, 1900, 0, 0, 0, 0], { takeover: true, voided: true }],
    ]) {
      await t.test(name, async () => {
        const room = await seed();
        const before = opts.before || room.stacks;
        const seats = before.map((chips, i) => i < 2 ? { chips, contributed: 100, folded: opts.folded === i } : null);
        await env.withSecurityRulesDisabled(c => fs.updateDoc(roomRef(c.firestore()), {
          stacks: before, pub: { ...room.pub, phase: oldPhase, seats },
          updatedAt: fs.Timestamp.fromMillis(Date.now() - 60000),
        }));
        const patch = { rev: 3, updatedAt: fs.serverTimestamp(), stacks,
          pub: { ...room.pub, phase: newPhase, seats: seats.map((p, i) => p ? { ...p, chips: stacks[i] } : null),
            ...(opts.voided ? { voided: true } : {}) },
          ...(opts.takeover ? { hostUid: 'friend', hostSince: fs.serverTimestamp() } : {}),
        };
        await assertFails(fs.updateDoc(roomRef(db(opts.takeover ? 'friend' : 'host')), patch));
        // 同樣攻擊也走 sess.hands 變動的完整 roomWriteOk 分支。
        if (!opts.takeover) await assertFails(fs.updateDoc(roomRef(db('host')), {
          ...patch, sess: room.sess.map(p => p ? { ...p, hands: 1 } : null),
        }));
      });
    }
    // 對照組：同一套種子資料，合法結算／作廢必須通過（證明上面被拒是因為移錢，不是資料格式）
    for (const [name, oldPhase, stacks, opts = {}] of [
      ['合法結算：朋友棄牌輸掉投入 100', 'river', [2100, 1900, 0, 0, 0, 0], { folded: 1 }],
      ['合法結算：平手各拿回投入', 'river', [2000, 2000, 0, 0, 0, 0]],
      ['合法作廢：中離棄牌者的投入分給留下的人', 'flop', [2100, 1900, 0, 0, 0, 0], { folded: 1, voided: true }],
    ]) {
      await t.test(name, async () => {
        const room = await seed();
        const seats = room.stacks.map((chips, i) => i < 2 ? { chips, contributed: 100, folded: opts.folded === i } : null);
        await env.withSecurityRulesDisabled(c => fs.updateDoc(roomRef(c.firestore()), { pub: { ...room.pub, phase: oldPhase, seats } }));
        await assertSucceeds(fs.updateDoc(roomRef(db('host')), { rev: 3, updatedAt: fs.serverTimestamp(), stacks,
          pub: { ...room.pub, phase: 'hand_over', seats: seats.map((p, i) => p ? { ...p, chips: stacks[i] } : null),
            ...(opts.voided ? { voided: true } : {}) } }));
      });
    }
    await t.test('帳務事件（第三人買入）不能順便挪其他座位的籌碼', async () => {
      let room = await seed();
      const thirdFb = { fs, db: db('third') };
      await assertSucceeds(ensurePlayerGrant(thirdFb, 'third', roomId, 2000, { displayName: '第三人', photoURL: null }));
      await assertSucceeds(buyinAll(thirdFb, 'third', roomId, 20));
      let denied = null;
      const evilFs = { ...fs, updateDoc: async (ref, patch) => {
        if (!patch?.lastMoneyEvent) return fs.updateDoc(ref, patch);
        const stacks = [...patch.stacks]; stacks[0] += 1000; stacks[1] -= 1000;
        try { return await fs.updateDoc(ref, { ...patch, stacks }); } catch (e) { denied = e; throw e; }
      } };
      const loop = createHostLoop({ fs: evilFs, db: db('host') }, { roomId, uid: 'host', getRoom: () => room, stats: { enabled: false } });
      try {
        loop.start();
        await loop.seatPlayer(2, 'third').catch(() => {});
        assert.equal(denied?.code, 'permission-denied');
        room = (await fs.getDoc(roomRef(db('host')))).data();
        assert.deepEqual(room.stacks, [2000, 2000, 0, 0, 0, 0]);
      } finally { loop.stop(); }
    });
    await t.test('房主沒有對應結帳帳本，不能移動朋友的錢', async () => {
      await seed();
      await assertFails(fs.updateDoc(fs.doc(db('host'), 'pokerPlayers', 'friend'), {
        bank: 2000, inPlay: 0, total: 2000, tableRoomId: null, updatedAt: fs.serverTimestamp(),
      }));
      await assertFails(fs.updateDoc(roomRef(db('host')), {
        stacks: [4000, 0, 0, 0, 0, 0], rev: 3, updatedAt: fs.serverTimestamp(),
      }));
    });
  } finally { await env.cleanup(); globalThis.document = previousDocument; }
});
