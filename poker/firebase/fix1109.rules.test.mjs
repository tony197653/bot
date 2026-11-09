// 僅連 PM 明確指定的本機 emulator；不替換正式 Rules、不啟用任何功能。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import * as fs from 'firebase/firestore';
import { hostCloseAllBatch, buyinAll, ensurePlayerGrant } from '../js/net/ledger.js';
import { createSingleTable, closeRoom } from '../js/net/room.js';
import { createHostLoop } from '../js/net/host.js';

const endpoint = process.env.FIRESTORE_EMULATOR_HOST;
if (!endpoint || !/^(127\.0\.0\.1|localhost):\d+$/.test(endpoint)) {
  throw Error('必須設定本機 FIRESTORE_EMULATOR_HOST；projectId 固定 demo-fix1109');
}
const [host, port] = endpoint.split(':');
const rules = readFileSync(new URL('./firestore.rules', import.meta.url), 'utf8');
fs.setLogLevel('silent');

test('fix1109：零手數收桌／第三人入座／禁止房主任意移錢', async t => {
  const previousDocument = globalThis.document;
  globalThis.document = { visibilityState: 'visible' };
  const env = await initializeTestEnvironment({ projectId: 'demo-fix1109', firestore: { host, port: Number(port), rules } });
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
  try {
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
    await t.test('房主沒有對應結帳帳本，不能移動朋友的錢', { todo: '現行正式規則允許房主重分 stacks（總額不變、無帳本），待宗良決定是否修規則' }, async () => {
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
