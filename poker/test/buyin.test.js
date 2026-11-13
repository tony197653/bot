import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { DEFAULT_NEW_PLAYER_CHIPS, createRoomBuyinError, assertMinimumBuyin, wholeBalance, buyinOptions, buyinLabel } from '../js/net/buyin-policy.js';
import { buyinAll, buyinAmount, ensurePlayerGrant } from '../js/net/ledger.js';

const source = readFileSync(new URL('../js/ui/mp-app.js', import.meta.url), 'utf8');
function fakeFirebase(player) {
  const writes = [];
  let commits = 0;
  const batch = {
    update: (ref, data) => writes.push({ ref, data }),
    set: (ref, data) => writes.push({ ref, data }),
    commit: async () => { commits++; },
  };
  return {
    writes, get commits() { return commits; }, db: {},
    fs: {
      doc: (_db, ...path) => path.join('/'),
      getDoc: async () => ({ exists: () => player != null, data: () => player }),
      writeBatch: () => batch, serverTimestamp: () => 'now',
    },
  };
}

for (const bb of [10, 20, 50, 100]) {
  test(`${bb} 大盲：低於 50BB 阻擋，等於與高於均可整筆買入`, async () => {
    assert.throws(() => assertMinimumBuyin(50 * bb - 1, bb), /籌碼不足.*50 大盲/);
    for (const bank of [50 * bb, 123 * bb]) {
      const fb = fakeFirebase({ bank, total: bank, tableRoomId: null, sessionNo: 0 });
      const result = await buyinAmount(fb, 'u', 'r', bb);
      assert.equal(result.amount, bank);
      assert.equal(fb.commits, 1);
      assert.equal(fb.writes[0].data.bank, 0);
      assert.equal(fb.writes[0].data.inPlay, bank);
      assert.equal(fb.writes[1].data.amount, bank);
    }
  });
}

test('最新帳戶不足時，不建立買入或帳本寫入', async () => {
  const fb = fakeFirebase({ bank: 499, tableRoomId: null, sessionNo: 0 });
  await assert.rejects(buyinAll(fb, 'u', 'r', 10), /籌碼不足/);
  assert.equal(fb.commits, 0);
  assert.deepEqual(fb.writes, []);
});

test('已帶入但尚未入座：用 inPlay 判斷且不重複買入', async () => {
  const player = { bank: 0, inPlay: 2000, tableRoomId: 'r', sessionNo: 1 };
  assert.equal(wholeBalance(player, 'r'), 2000);
  const fb = fakeFirebase(player);
  assert.equal((await buyinAmount(fb, 'u', 'r', 20)).skipped, true);
  assert.equal(fb.commits, 0);
  await assert.rejects(buyinAll(fb, 'u', 'r', 50), /籌碼不足/);
});

test('禁止帶著另一桌帳戶買入', async () => {
  await assert.rejects(buyinAll(fakeFirebase({ bank: 2000, tableRoomId: 'other' }), 'u', 'r', 20), /別桌/);
});

test('牌桌顯示整筆餘額，入座後顯示實際 session 買入而非輸贏後籌碼', () => {
  assert.equal(buyinLabel({ bank: 8765 }, 'r'), '攜入 2,000 籌碼');
  assert.equal(buyinLabel({ bank: 0, inPlay: 8765, tableRoomId: 'r' }, 'r'), '攜入 8,765 籌碼');
  assert.equal(buyinLabel({ bank: 0, inPlay: 8765 }, 'r', { buyIn: 8765 }), '本次買入 8,765 籌碼');
});

test('實際入座 handler 同步提示且不呼叫任何網路方法', async () => {
  const body = source.slice(source.indexOf('async function sitDown(seat)'), source.indexOf('async function requestLeave()'));
  let networkCalls = 0;
  const messages = [];
  const context = vm.createContext({
    getFirebase: () => ({}), getUser: () => ({ uid: 'u' }),
    room: { seatUids: Array(6).fill(null), config: { bb: 50 } },
    roomId: 'r', sittingBusy: false, playerDoc: { bank: 2000 },
    assertMinimumBuyin, wholeBalance, toast: msg => messages.push(msg),
    buyinAll: () => { networkCalls++; },
  });
  vm.runInContext(body, context);
  const started = performance.now();
  const pending = context.sitDown(0);
  assert.ok(performance.now() - started < 200, '不足提示須於 200ms 內同步出現');
  assert.match(messages[0], /籌碼不足.*2,500.*2,000/);
  assert.equal(context.sittingBusy, false);
  await pending;
  assert.equal(networkCalls, 0);
});

test('房主自動入座同樣先檢查門檻', () => {
  const start = source.indexOf('        if (needHostSit) {');
  const block = source.slice(start, source.indexOf('// L3: ensure hostRoomId', start));
  assert.ok(block.indexOf('assertMinimumBuyin(') < block.indexOf('await buyinAmount('));
  assert.ok(block.indexOf('await buyinAmount(') < block.indexOf('await hostLoop?.seatPlayer('));
});

test('新玩家預設 2000，首次贈送仍依房間設定；不覆寫既有帳戶', async () => {
  assert.equal(DEFAULT_NEW_PLAYER_CHIPS, 2000);
  const room = readFileSync(new URL('../js/net/room.js', import.meta.url), 'utf8');
  assert.match(room, /newPlayerChips: opts.newPlayerChips \?\? DEFAULT_NEW_PLAYER_CHIPS/);
  for (const amount of [2000, 5000]) {
    const fb = fakeFirebase(null);
    await ensurePlayerGrant(fb, 'u', 'r', amount, { displayName: '玩家', photoURL: null });
    assert.equal(fb.writes[0].data.bank, amount);
    assert.equal(fb.writes[1].data.amount, amount);
  }
  const fb = fakeFirebase({ bank: 9999 });
  assert.equal((await ensurePlayerGrant(fb, 'u', 'r', 2000, {})).created, false);
  assert.equal(fb.commits, 0);
});

test('四種盲注選項保留', () => {
  const lobby = readFileSync(new URL('../js/ui/lobby.js', import.meta.url), 'utf8');
  assert.ok(lobby.includes("[['5','10'],['10','20'],['25','50'],['50','100']]"));
});


test('足額入座先同步提示，再買入並送出 SIT', async () => {
  const body = source.slice(source.indexOf('async function sitDown(seat)'), source.indexOf('async function requestLeave()'));
  const events = [];
  const context = vm.createContext({
    getFirebase: () => ({}), getUser: () => ({ uid: 'u' }),
    room: { seatUids: Array(6).fill(null), config: { bb: 20 }, pub: { handNo: 3, actionSeq: 4 } },
    roomId: 'r', sittingBusy: false, playerDoc: { bank: 8765 },
    assertMinimumBuyin, wholeBalance, buyinOptions,
    pickBuyinAmount: options => { events.push('picker'); return options.amount; }, toast: msg => events.push(msg),
    buyinAmount: async (...args) => { events.push(['buyin', args[3]]); },
    getPlayer: async () => ({ bank: 0, inPlay: 8765, tableRoomId: 'r' }),
    intents: { send: async intent => events.push([intent.type, intent.seat]) },
    friendlyError: e => e.message,
  });
  vm.runInContext(body, context);
  const started = performance.now();
  const pending = context.sitDown(2);
  assert.equal(events[0], 'picker');
  assert.ok(performance.now() - started < 200);
  await pending;
  assert.deepEqual(events, ['picker', '入座中…', ['buyin', 20], ['SIT', 2]]);
  assert.equal(context.sittingBusy, false);
});

test('實際買入放在手機也顯示的 meta-a 區塊', () => {
  assert.match(source, /class="meta-a">[^\n]*\$\{esc\(buyin\)\}<\/span><span class="meta-b">/);
});

test('訪客入座先讀房主 presence：離線阻擋，近期活動或讀取失敗保留入座', async () => {
  const body = source.slice(source.indexOf('async function sitDown(seat)'), source.indexOf('async function requestLeave()'));
  const now = 2_000_000_000_000;
  for (const scenario of [
    { name: '過期房主', beatAge: 120_000, roomAge: 180_000, minutes: 28 },
    { name: '缺少 presence', missing: true, roomAge: 90_000, minutes: 29 },
    { name: '超過關桌時間', beatAge: 1_900_000, roomAge: 2_000_000, minutes: 1 },
    { name: '近期房主', beatAge: 10_000, roomAge: 180_000 },
    { name: '近期房間更新', beatAge: 180_000, roomAge: 10_000 },
    { name: '剛好 30 秒', beatAge: 30_000, roomAge: 180_000 },
    { name: '讀取失敗', fail: true, roomAge: 180_000 },
    { name: '房主本人', host: true, roomAge: 180_000 },
  ]) {
    const events = [];
    const context = vm.createContext({
      Date: { now: () => now },
      getFirebase: () => ({ db: {}, fs: {
        doc: (_db, ...path) => path.join('/'),
        getDoc: async ref => {
          events.push(['presence', ref]);
          if (scenario.fail) throw new Error('offline');
          return {
            exists: () => !scenario.missing,
            data: () => ({ beat: { toMillis: () => now - scenario.beatAge } }),
          };
        },
      } }),
      getUser: () => ({ uid: 'u' }),
      room: {
        hostUid: scenario.host ? 'u' : 'host',
        seatUids: Array(6).fill(null), config: { bb: 20 },
        updatedAt: { toMillis: () => now - scenario.roomAge },
      },
      roomId: 'r', sittingBusy: false, playerDoc: { bank: 8765 },
      assertMinimumBuyin, wholeBalance, buyinOptions,
      pickBuyinAmount: options => { events.push('picker'); return options.amount; },
      toast: msg => events.push(msg),
      buyinAmount: async () => { events.push('buyin'); },
      getPlayer: async () => ({ bank: 0, inPlay: 8765, tableRoomId: 'r' }),
      intents: { send: async intent => events.push(intent.type) },
      hostLoop: { seatPlayer: async () => {} },
      friendlyError: e => e.message,
    });
    vm.runInContext(body, context);
    const started = performance.now();
    const pending = context.sitDown(2);
    assert.equal(events[0], 'picker', scenario.name);
    assert.ok(performance.now() - started < 200, scenario.name);
    await pending;
    const expected = ['picker', '入座中…'];
    if (!scenario.host) expected.push(['presence', 'pokerRooms/r/presence/host']);
    if (scenario.minutes) {
      expected.push(`房主已離線，暫時無法入座；牌桌約 ${scenario.minutes} 分鐘後會自動關閉，之後就能開新牌桌`);
    } else {
      expected.push('buyin', 'SIT');
    }
    assert.deepEqual(events, expected, scenario.name);
    assert.equal(context.sittingBusy, false, scenario.name);
  }
});


test('自選買入只扣指定金額、帳本餘額正確且 total 不變', async () => {
  const fb = fakeFirebase({ bank: 8765, inPlay: 0, total: 8765, tableRoomId: null, sessionNo: 0 });
  const result = await buyinAmount(fb, 'u', 'r', 20, 2000);
  assert.equal(result.player.bank, 6765);
  assert.equal(result.player.total, 8765);
  assert.equal(result.player.inPlay, 2000);
  assert.equal(fb.writes[0].data.bank, 6765);
  assert.equal(fb.writes[0].data.total, undefined);
  assert.equal(fb.writes[1].data.amount, 2000);
  assert.equal(fb.writes[1].data.bankAfter, 6765);
  await assert.rejects(buyinAmount(fb, 'u', 'r', 20, 8766), /籌碼不足/);
  await assert.rejects(buyinAmount(fb, 'u', 'r', 20, 999), /籌碼不足/);
});

test('選額預設、最低、上限與不整除的餘額', () => {
  for (const [bank, preset, amount, step] of [[8765,2000,2000,1],[2000,5000,2000,20],[2000,500,1000,20]]) {
    assert.deepEqual(buyinOptions({ bank }, { bb: 20, newPlayerChips: preset }), { min:1000,max:bank,amount,step });
  }
  assert.throws(() => buyinOptions({ bank:999 }, { bb:20 }), /籌碼不足/);
});

test('補碼介面、處理與排行榜欄位移除，開桌文案正確', () => {
  for (const file of ['ui/mp-app.js','net/host.js','net/client.js']) {
    const text = readFileSync(new URL('../js/' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /TOPUP_REQ|TOPUP_CANCEL|approveTopUp|denyTopUp|mpTopup|補碼/);
  }
  const lobby = readFileSync(new URL('../js/ui/lobby.js', import.meta.url), 'utf8');
  assert.match(lobby, /<span>攜入籌碼<\/span>/);
  assert.match(lobby, /入座時預設帶入這個數字，可自行調整；第一次來的人也送這筆。/);
  assert.doesNotMatch(lobby, /<em>送<\/em>|<em>籌碼<\/em>|補碼 2,000/);
  assert.doesNotMatch(readFileSync(new URL('../js/ui/stats.js', import.meta.url),'utf8'), /<th>補碼/);
});

test('大廳先結算、重讀再檢查；不足不進桌，已綁同桌可回桌', async () => {
  for (const bound of [false,true]) {
    const events = [], messages = [];
    const ctx = vm.createContext({
      getFirebase:()=>({}),getUser:()=>({uid:'u'}),openJoinBusy:false,
      toast:msg=>messages.push(msg),$:()=>null,screen:'lobby',playerDoc:{bank:99999},
      silentlySettleClosedBinding:async()=>events.push('settle'),
      getPlayer:async()=>{events.push('read');return {bank:999,tableRoomId:bound?'r':null};},
      maybeAutoCloseSingleTable:async()=>false,
      joinByRoomId:async()=>({room:{config:{bb:20}}}),
      assertMinimumBuyin,enterRoom:async()=>events.push('enter'),
      friendlyError:e=>e.message,paint:()=>{},
    });
    vm.runInContext(source.slice(source.indexOf('async function enterOpenTable('),source.indexOf('function lobbyBindKey(')),ctx);
    const pending=ctx.enterOpenTable('r');
    assert.equal(messages[0],'正在確認牌桌…');
    await pending;
    assert.deepEqual(events,bound?['settle','read','enter']:['settle','read']);
    if(!bound)assert.match(messages.at(-1),/籌碼不足.*50 大盲/);
    assert.equal(ctx.screen,'lobby');
  }
});

test('選額視窗同步建立，取消不送出、確認保留指定額並同步提示', async () => {
  for(const confirm of [false,true]) {
    const nodes=new Map(),events=[];
    const node=key=>{if(!nodes.has(key))nodes.set(key,{value:'1500',addEventListener:(type,fn)=>nodes.get(key)[type]=fn,reportValidity(){}});return nodes.get(key);};
    const el={setAttribute(){},querySelector:node,remove:()=>events.push('remove')};
    const ctx=vm.createContext({document:{createElement:()=>el,body:{appendChild:()=>events.push('paint')}},toast:msg=>events.push(msg)});
    vm.runInContext(source.slice(source.indexOf('function pickBuyinAmount('),source.indexOf('async function sitDown(')),ctx);
    const started=performance.now(),pending=ctx.pickBuyinAmount({min:1000,max:8765,step:1,amount:2000});
    assert.deepEqual(events,['paint']);assert.ok(performance.now()-started<200);
    assert.match(el.innerHTML,/type="number".*min="1000".*max="8765".*value="2000"/);
    assert.match(el.innerHTML,/type="range"/);
    node(confirm?'[data-confirm]':'[data-cancel]').click();
    if(confirm)assert.deepEqual(events,['paint','入座中…','remove']);
    assert.equal(await pending,confirm?1500:null);
  }
});

test('hand_over 輸光者走既有 cashoutSeat，離座通知先回大廳再提示', async () => {
  const host=readFileSync(new URL('../js/net/host.js',import.meta.url),'utf8');
  const events=[];
  const ctx=vm.createContext({
    getRoom:()=>({pub:{phase:'hand_over',handNo:1},seatUids:['u','','','','',''],stacks:[0,0,0,0,0,0]}),
    engine:{phase:'hand_over',handNumber:1,seats:[{chips:0}]},PHASE:{LOBBY:'lobby',HAND_OVER:'hand_over'},
    writeChain:Promise.resolve(),lastHandsBumpHandNo:1,leaveQueue:[],sitQueue:[],closing:false,running:true,
    cashoutSeat:async(seat,uid)=>{events.push([seat,uid,0]);return true;},pendingSeats:[],
  });
  vm.runInContext(host.slice(host.indexOf('  async function drainSitLeaveInner('),host.indexOf('  function seatPlayer(')),ctx);
  await ctx.drainSitLeaveInner();assert.deepEqual(events,[[0,'u',0]]);
  const begin=source.indexOf('      const previousSelfSeat');
  const end=source.indexOf('      lastRecvAt',begin);
  const ui=vm.createContext({metadata:undefined,hostRoomUpdatedMs:null,hostBeatMs:null,hostLoop:null,watchHostBeat:()=>{},updateHostDisconnect:()=>{},fb:{},id:'r',room:{seatUids:['u'],stacks:[0]},r:{status:'lobby',seatUids:[''],lastMoneyEvent:{type:'cashout',uid:'u',amount:0}},user:{uid:'u'},
    goLobbyClean:()=>events.push('lobby'),toast:msg=>events.push(msg)});
  vm.runInContext('(function(){'+source.slice(begin,end)+'})()',ui);
  assert.deepEqual(events.slice(1),['lobby','籌碼輸光了，已離座回大廳']);
});

test('開桌遇到既有桌：依該桌大盲阻擋，留在大廳；先結算才讀帳戶', async () => {
  const events=[],messages=[];
  const ctx=vm.createContext({
    getFirebase:()=>({}),getUser:()=>({uid:'u',displayName:'玩家'}),
    createRoomBuyinError,createDraft:{},creating:false,createError:'',screen:'create',playerDoc:{bank:99999},
    paint:()=>events.push('paint'),toast:msg=>messages.push(msg),console,
    silentlySettleClosedBinding:async()=>events.push('settle'),
    getPlayer:async()=>{events.push('read');return {bank:2000,tableRoomId:null};},
    createSingleTable:async()=>{events.push('existing');return {existing:true,roomId:'r',config:{bb:100,newPlayerChips:5000}};},
    enterRoom:async()=>events.push('enter'),assertMinimumBuyin,friendlyError:e=>e.message,
  });
  vm.runInContext(source.slice(source.indexOf('async function doCreate('),source.indexOf('async function doJoin(')),ctx);
  const pending=ctx.doCreate({name:'桌',sb:5,bb:10,newPlayerChips:2000});
  assert.equal(events[0],'paint');await pending;
  assert.deepEqual(events,['paint','settle','read','existing','read','paint']);
  assert.equal(ctx.screen,'lobby');assert.match(messages[0],/籌碼不足.*5,000/);
});
