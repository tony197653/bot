// HD1113 §4 驗收案例；僅供 PM 在 localhost emulator 執行。未執行。
// 僅使用 localhost，規則相容性另以基底 6d86ba3 的程式函式驗證。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import * as fs from 'firebase/firestore';
import { hostCloseAllBatch, hostCashoutBatch, ensurePlayerGrant, buyinAll } from '../js/net/ledger.js';
import { createHostLoop } from '../js/net/host.js';
import { closeDisconnectedRoom } from '../js/net/host-disconnect.js';

const endpoint = process.env.FIRESTORE_EMULATOR_HOST;
if (!endpoint || !/^(localhost|127\.0\.0\.1):\d+$/.test(endpoint)) {
  throw Error('只允許 FIRESTORE_EMULATOR_HOST=localhost:port 或 127.0.0.1:port');
}
const [host, port] = endpoint.split(':');
const projectId = 'demo-hd1113';
const roomId = 'old-table';
let seats = ['host', 'friend', '', '', '', ''];

test('HD1113：房主失聯原子退款權限（需 PM 執行 emulator）', async t => {
  const env = await initializeTestEnvironment({ projectId, firestore: {
    host, port: Number(port), rules: readFileSync(new URL('./firestore.rules', import.meta.url), 'utf8'),
  } });
  const seed = async (minutes = 70 / 60, phase = 'flop', full = false) => {
    seats = full ? ['host','friend','p2','p3','p4','p5'] : ['host','friend','','','',''];
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async c => {
      const db = c.firestore();
      const old = fs.Timestamp.fromMillis(Date.now() - minutes * 60_000);
      const sess = seats.map(uid => uid ? { uid, sessionNo: 1, buyIn: 2000,
        topUps: 0, topUpChips: 0, hands: 0, nightKey: '20261113', startAt: old } : null);
      await fs.setDoc(fs.doc(db, 'pokerRooms', roomId), {
        name: '牌桌', code: '000', hostUid: 'host', hostSince: old, createdAt: old, updatedAt: old,
        status: 'playing', rev: 3, members: seats.filter(Boolean), seatUids: seats,
        stacks: seats.map(u=>u?2000:0), chipTotal: seats.filter(Boolean).length*2000, sess,
        config: { sb: 10, bb: 20, newPlayerChips: 2000, actionMs: 30000, topUpAmount: 2000 },
        pub: { phase, handNo: 1, seats: seats.map((u,i)=>u ? {id:u,seat:i,chips:1700,contributed:300}:null) }, deadlineAt: old.toMillis() + 30000, lastMoneyEvent: null,
        lobby: { name: '牌桌', hostName: '房主', hostPhoto: '', blinds: '10/20', seated: 2 },
      });
      await fs.setDoc(fs.doc(db, 'pokerRooms', roomId, 'presence', 'host'), { beat: old, vis: true });
      await fs.setDoc(fs.doc(db,'pokerCodes','000'), {roomId,hostUid:'host',createdAt:old,expiresAt:fs.Timestamp.fromMillis(Date.now()+86400000)});
      await fs.setDoc(fs.doc(db,'pokerRooms',roomId,'presence','friend'),{beat:old,vis:true});
      for (const uid of seats.filter(Boolean)) await fs.setDoc(fs.doc(db, 'pokerPlayers', uid), {
        displayName: uid, photoURL: null, bank: 100, inPlay: 2000, total: 2100,
        tableRoomId: roomId, lastRoomId: roomId, sessionNo: 1, topUps: 0, topUpChips: 0,
        handsPlayed: 0, hostRoomId: uid === 'host' ? roomId : null, createdAt: old, updatedAt: old,
      });
    });
  };
  // 候選交易格式：固定 cashout ID；保留 pub 作為退款證據，不產生戰績。
  const close = async (uid, { extra = 0, omitPlayer = false, omitLedger = false, omitClear = false } = {}) => {
    const db = env.authenticatedContext(uid).firestore();
    return fs.runTransaction(db, async tx => {
      const ref = fs.doc(db, 'pokerRooms', roomId);
      const r = (await tx.get(ref)).data();
      if (r.status === 'closed') return false;
      const players = await Promise.all(seats.filter(Boolean).map(u => tx.get(fs.doc(db, 'pokerPlayers', u))));
      tx.update(ref, { status: 'closed', closedBy: 'host-disconnect', closedAt: fs.serverTimestamp(),
        rev: r.rev + 1, updatedAt: fs.serverTimestamp(),
        seatUids: omitClear ? seats : Array(6).fill(''), stacks: Array(6).fill(0),
        chipTotal: 0, sess: Array(6).fill(null), deadlineAt: null,
        lastMoneyEvent: { type: 'hostDisconnectClose' },
      });
      for (let i = 0; i < seats.filter(Boolean).length; i++) {
        const p = players[i].data(), s = r.sess[i], u = seats[i];
        const amount = (['lobby', 'hand_over'].includes(r.pub.phase) ? r.stacks[i]
          : r.pub.seats[i].chips + r.pub.seats[i].contributed) + (i === 1 ? extra : 0);
        if (!(omitLedger && i === 1)) tx.set(fs.doc(db, 'pokerPlayers', u, 'ledger', `${roomId}_1_cashout`), {
          type: 'cashout', amount, roomId, sessionNo: 1, seat: i, buyIn: s.buyIn,
          topUps: s.topUps, topUpChips: s.topUpChips, hands: s.hands, nightKey: s.nightKey,
          bankAfter: p.bank + amount, by: uid, at: fs.serverTimestamp(),
        });
        if (!(omitPlayer && i === 1)) tx.update(fs.doc(db, 'pokerPlayers', u), {
          bank: p.bank + amount, inPlay: 0, total: p.bank + amount, tableRoomId: null,
          topUps: p.topUps + s.topUps, topUpChips: p.topUpChips + s.topUpChips,
          handsPlayed: p.handsPlayed + s.hands, updatedAt: fs.serverTimestamp(),
        });
      }
      return true;
    });
  };
  try {
    await t.test('任一已登入非成員，70 秒可退款並清空全桌；原座位玩家重送不重複退款', async () => {
      await seed();
      await assertSucceeds(close('outsider'));
      const od = env.authenticatedContext('outsider').firestore();
      for (const uid of seats.filter(Boolean)) {
        const p = (await fs.getDoc(fs.doc(od, 'pokerPlayers', uid))).data();
        assert.equal(p.bank, 2100); assert.equal(p.inPlay, 0); assert.equal(p.tableRoomId, null);
        assert.equal(p.handsPlayed, 0);
      }
      assert.equal((await fs.getDoc(fs.doc(od, 'pokerRooms', roomId))).data().closedBy, 'host-disconnect');
      assert.equal(await close('friend'), false, '原座位玩家不重複退款');
    });
    for (const [name, options] of [
      ['多退一元', { extra: 1 }], ['少更新玩家', { omitPlayer: true }],
      ['缺一筆帳本', { omitLedger: true }], ['不清座位', { omitClear: true }],
    ]) await t.test(`${name}必須拒絕`, async () => {
      await seed(); await assertFails(close('friend', options));
    });
    await t.test('50 秒不得收桌', async () => { await seed(50 / 60); await assertFails(close('friend')); });
    await t.test('舊房間但房主剛重連，拒絕退款', async () => {
      await seed();
      await env.withSecurityRulesDisabled(c => fs.updateDoc(
        fs.doc(c.firestore(), 'pokerRooms', roomId, 'presence', 'host'), { beat: fs.Timestamp.now() }));
      await assertFails(close('friend'));
    });
    await t.test('非成員只可 get 房主 presence，不可讀他人或 list；可讀 closed 房間', async () => {
      await seed();
      const d = env.authenticatedContext('outsider').firestore();
      await assertSucceeds(fs.getDoc(fs.doc(d,'pokerRooms',roomId,'presence','host')));
      await assertFails(fs.getDoc(fs.doc(d,'pokerRooms',roomId,'presence','friend')));
      await assertFails(fs.getDocs(fs.collection(d,'pokerRooms',roomId,'presence')));
      await assertSucceeds(close('outsider'));
      await assertSucceeds(fs.getDoc(fs.doc(d,'pokerRooms',roomId)));
      await assertFails(fs.getDocs(fs.query(fs.collection(d,'pokerRooms'),fs.where('status','==','closed'),fs.limit(20))));
      assert.equal(await close('outsider'),false);
    });
    await t.test('T+2 收桌後新使用者可 reclaim 000 並建房', async () => {
      const d = env.authenticatedContext('outsider').firestore();
      // Legacy room shape, to isolate code-lock compatibility without new product helpers.
      const reopen = async () => {
        const b = fs.writeBatch(d), id = 'new-table';
        b.set(fs.doc(d,'pokerRooms',id), {
          name:'牌桌',code:'000',hostUid:'outsider',hostSince:fs.serverTimestamp(),
          members:['outsider'],status:'lobby',lobby:{name:'牌桌',hostName:'新房主',hostPhoto:'',blinds:'10/20',seated:0},rev:0,createdAt:fs.serverTimestamp(),updatedAt:fs.serverTimestamp(),
          config:{sb:10,bb:20,newPlayerChips:2000,actionMs:30000,topUpAmount:2000},
          pub:{phase:'lobby'},deadlineAt:null,seatUids:Array(6).fill(''),stacks:Array(6).fill(0),
          chipTotal:0,sess:Array(6).fill(null),lastMoneyEvent:null,
        });
        // New lobby schema supports three digit codes; include required player host binding.
        b.set(fs.doc(d,'pokerPlayers','outsider'), {
          displayName:'新房主',photoURL:null,bank:2000,inPlay:0,total:2000,tableRoomId:null,
          sessionNo:0,topUps:0,topUpChips:0,handsPlayed:0,lastRoomId:id,hostRoomId:id,
          createdAt:fs.serverTimestamp(),updatedAt:fs.serverTimestamp(),
        });
        b.set(fs.doc(d,'pokerPlayers','outsider','ledger',id+'_0_grant'),{
          type:'grant',amount:2000,roomId:id,sessionNo:0,bankAfter:2000,by:'outsider',at:fs.serverTimestamp(),
        });
        b.set(fs.doc(d,'pokerCodes','000'),{roomId:id,hostUid:'outsider',createdAt:fs.serverTimestamp(),expiresAt:fs.Timestamp.fromMillis(Date.now()+86400000)});
        return b.commit();
      };
      await seed(50 / 60); await assertFails(reopen());
      await seed(); await assertSucceeds(close('outsider')); await assertSucceeds(reopen());
    });
    await t.test('多人競爭只成功一次', async () => {
      await seed();
      // 原始交易：輸家可能重試讀到 closed（回 false）或在 commit 被規則拒絕；無論如何只成功一次。
      const results = await Promise.allSettled([close('outsider'),close('friend')]);
      assert.equal(results.filter(x => x.status === 'fulfilled' && x.value === true).length,1);
      const d=env.authenticatedContext('outsider').firestore();
      for(const u of seats.filter(Boolean)) assert.equal((await fs.getDoc(fs.doc(d,'pokerPlayers',u))).data().bank,2100);
    });
    await t.test('presence 新 beat 不能收；沒有 presence 時 updatedAt 新也不能收', async () => {
      for (const kind of ['presence','no-presence-room']) {
        await seed();
        await env.withSecurityRulesDisabled(async c => {
          const f=c.firestore();
          if (kind === 'presence') await fs.updateDoc(fs.doc(f,'pokerRooms',roomId,'presence','host'),{beat:fs.Timestamp.now()});
          else { await fs.deleteDoc(fs.doc(f,'pokerRooms',roomId,'presence','host'));
            await fs.updateDoc(fs.doc(f,'pokerRooms',roomId),{updatedAt:fs.Timestamp.now()}); }
        });
        await assertFails(close('outsider'));
      }
    });
    await t.test('HD1113 r2：房主 beat 過期，客人離桌讓 updatedAt 變新，仍可 T+2 收桌', async () => {
      await seed();
      await env.withSecurityRulesDisabled(c =>
        fs.updateDoc(fs.doc(c.firestore(),'pokerRooms',roomId),{updatedAt:fs.Timestamp.now()}));
      await assertSucceeds(close('outsider'));
    });
    await t.test('滿六席進行中有下注，一筆 transaction 退款成功且每人只退一次', async () => {
      await seed(70 / 60,'flop',true);
      await assertSucceeds(close('outsider'));
      const d=env.authenticatedContext('outsider').firestore();
      for (const u of seats) {
        const p=(await fs.getDoc(fs.doc(d,'pokerPlayers',u))).data();
        assert.equal(p.bank,2100); assert.equal(p.inPlay,0);
        assert.equal((await fs.getDoc(fs.doc(d,'pokerPlayers',u,'ledger',roomId+'_1_cashout'))).data().amount,2000);
      }
      assert.equal(await close('friend'),false);
    });
    await t.test('產品 closeDisconnectedRoom：滿六席進行中，一筆交易退款；第二次回 false', async () => {
      await seed(70 / 60, 'turn', true);
      const d = env.authenticatedContext('outsider').firestore();
      assert.equal(await closeDisconnectedRoom({ db: d, fs, uid: 'outsider' }, roomId), true);
      for (const u of seats) {
        const p = (await fs.getDoc(fs.doc(d, 'pokerPlayers', u))).data();
        assert.equal(p.bank, 2100); assert.equal(p.inPlay, 0); assert.equal(p.tableRoomId, null);
      }
      const r = (await fs.getDoc(fs.doc(d, 'pokerRooms', roomId))).data();
      assert.equal(r.status, 'closed'); assert.equal(r.closedBy, 'host-disconnect');
      assert.equal(await closeDisconnectedRoom({ db: d, fs, uid: 'outsider' }, roomId), false);
    });
    await t.test('產品 closeDisconnectedRoom：六席三人同時搶收只成功一次、籌碼只加一次', async () => {
      await seed(70 / 60, 'flop', true);
      const ctx = u => ({ db: env.authenticatedContext(u).firestore(), fs, uid: u });
      const res = await Promise.allSettled([ctx('outsider'), ctx('p2'), ctx('x9')]
        .map(c => closeDisconnectedRoom(c, roomId)));
      const why = JSON.stringify(res.map(x => x.status + ':' + (x.value ?? x.reason?.code)));
      // 輸家要嘛交易重試讀到 closed，要嘛被規則拒後讀到已關閉；兩者都回 false，不拋錯。
      assert.deepEqual(res.map(x => x.status), ['fulfilled', 'fulfilled', 'fulfilled'], why);
      assert.equal(res.filter(x => x.value === true).length, 1, why);
      const d = env.authenticatedContext('outsider').firestore();
      for (const u of seats) assert.equal((await fs.getDoc(fs.doc(d, 'pokerPlayers', u))).data().bank, 2100);
    });
    await t.test('產品 closeDisconnectedRoom：1 分 50 秒回 false 且規則也拒絕', async () => {
      await seed(50 / 60, 'flop', true);
      const d = env.authenticatedContext('outsider').firestore();
      assert.equal(await closeDisconnectedRoom({ db: d, fs, uid: 'outsider' }, roomId), false);
      // 客戶端時鐘快 20 秒也不能騙過規則（request.time 為準）
      await assertFails(closeDisconnectedRoom({ db: d, fs, uid: 'outsider' }, roomId, Date.now() + 20_000));
    });
    await t.test('舊 isAutoClose：30 分鐘成員仍可 closedBy auto（不搬籌碼）',async()=>{
      await seed(31,'lobby');
      const d=env.authenticatedContext('friend').firestore();
      await assertSucceeds(fs.updateDoc(fs.doc(d,'pokerRooms',roomId),{
        status:'closed',closedBy:'auto',closedAt:fs.serverTimestamp()}));
    });
    await t.test('舊路徑：非成員讀 lobby 房、grant/buyin/seat、房主 closeAll', async () => {
      await seed(0.5,'lobby');
      const hostDb = env.authenticatedContext('host').firestore();
      let r = (await fs.getDoc(fs.doc(hostDb,'pokerRooms',roomId))).data();
      await env.withSecurityRulesDisabled(c => fs.updateDoc(fs.doc(c.firestore(),'pokerRooms',roomId),{status:'lobby'}));
      const thirdDb = env.authenticatedContext('third').firestore();
      await assertSucceeds(fs.getDoc(fs.doc(thirdDb,'pokerRooms',roomId)));
      // 舊版加入：先 arrayUnion 成為成員（isJoin），才可建帳戶領 grant。
      await assertSucceeds(fs.updateDoc(fs.doc(thirdDb,'pokerRooms',roomId),{members:fs.arrayUnion('third')}));
      await assertSucceeds(ensurePlayerGrant({db:thirdDb,fs},'third',roomId,2000,{displayName:'third',photoURL:null}));
      await assertSucceeds(buyinAll({db:thirdDb,fs},'third',roomId,20));
      r = (await fs.getDoc(fs.doc(hostDb,'pokerRooms',roomId))).data();
      const previous = globalThis.document;
      globalThis.document = {visibilityState:'visible'};
      const loop = createHostLoop({db:hostDb,fs},{roomId,uid:'host',getRoom:()=>r,stats:{enabled:false}});
      try {
        loop.start(); await assertSucceeds(loop.seatPlayer(2,'third'));
      } finally { loop.stop(); globalThis.document = previous; }
      r = (await fs.getDoc(fs.doc(hostDb,'pokerRooms',roomId))).data();
      await assertSucceeds(hostCloseAllBatch({db:hostDb,fs},{hostUid:'host',roomId,room:r,displayNameOf:u=>u}));
    });
    await t.test('舊路徑：房主逐座 cashout', async () => {
      await seed(0.5,'lobby');
      const d = env.authenticatedContext('host').firestore();
      for (const seat of [0,1]) {
        const r = (await fs.getDoc(fs.doc(d,'pokerRooms',roomId))).data();
        const seatUids = [...r.seatUids], stacks = [...r.stacks], sess = [...r.sess];
        seatUids[seat]=''; stacks[seat]=0; sess[seat]=null;
        const id = `${roomId}_1_cashout`;
        await assertSucceeds(hostCashoutBatch({db:d,fs},{hostUid:'host',roomId,seat,uid:seats[seat],
          sessRow:r.sess[seat],amount:r.stacks[seat],playerName:seats[seat],
          roomPatch:{rev:r.rev+1,seatUids,stacks,sess,chipTotal:r.chipTotal-r.stacks[seat],
            lastMoneyEvent:{type:'cashout',uid:seats[seat],id,seat,amount:r.stacks[seat]}}}));
      }
    });
    await t.test('未到收桌門檻不能任意改別人 bank', async () => {
      await seed(0.5);
      await assertFails(fs.updateDoc(fs.doc(env.authenticatedContext('friend').firestore(),
        'pokerPlayers', 'host'), { bank: 999999 }));
    });
  } finally { await env.cleanup(); }
});
