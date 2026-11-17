import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { DEFAULT_NEW_PLAYER_CHIPS, createRoomBuyinError, assertMinimumBuyin, wholeBalance, buyinOptions, buyinLabel, defaultCreateBuyin, stepBuyinAmount, remainingBank } from '../js/net/buyin-policy.js';
import { buyinAll, buyinAmount, ensurePlayerGrant } from '../js/net/ledger.js';
import { addonOptions, queuedTotal } from '../js/net/addon-client.js';
import { hostAliveMs } from '../js/net/host-disconnect.js';

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
  assert.equal(buyinLabel({ bank: 8765 }, 'r'), '攜入 1,000 籌碼');
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

test('新玩家預設 1000，首次贈送仍依房間設定；不覆寫既有帳戶', async () => {
  assert.equal(DEFAULT_NEW_PLAYER_CHIPS, 1000);
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
  const context = vm.createContext({ accountText: () => '—',
    getFirebase: () => ({}), getUser: () => ({ uid: 'u' }),
    room: { seatUids: Array(6).fill(null), config: { bb: 20 }, pub: { handNo: 3, actionSeq: 4 } },
    roomId: 'r', sittingBusy: false, playerDoc: { bank: 8765 },
    assertMinimumBuyin, wholeBalance, buyinOptions,
    pickBuyinAmount: options => { events.push('picker'); return options.amount; }, toast: msg => events.push(msg),
    buyinAmount: async (...args) => { events.push(['buyin', args[3]]); },
    getPlayer: (function () {
      let reads = 0;
      return async () => {
        reads += 1;
        return reads === 1
          ? { bank: 8765, inPlay: 0, tableRoomId: null }
          : { bank: 0, inPlay: 8765, tableRoomId: 'r' };
      };
    })(),
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
    { name: '近期房間更新（客人寫入不算房主活動）', beatAge: 180_000, roomAge: 10_000, minutes: 27 },
    { name: '剛好 30 秒', beatAge: 30_000, roomAge: 180_000 },
    { name: '讀取失敗', fail: true, roomAge: 180_000 },
    { name: '房主本人', host: true, roomAge: 180_000 },
  ]) {
    const events = [];
    const context = vm.createContext({ accountText: () => '—',
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
      assertMinimumBuyin, wholeBalance, buyinOptions, hostAliveMs,
      pickBuyinAmount: options => { events.push('picker'); return options.amount; },
      toast: msg => events.push(msg),
      buyinAmount: async () => { events.push('buyin'); },
      getPlayer: (function () {
        let reads = 0;
        return async () => {
          reads += 1;
          return reads === 1
            ? { bank: 8765, inPlay: 0, tableRoomId: null }
            : { bank: 0, inPlay: 8765, tableRoomId: 'r' };
        };
      })(),
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
  for (const [bank, preset, amount] of [[8765,2000,2000],[2000,5000,2000],[2000,500,1000]]) {
    assert.deepEqual(buyinOptions({ bank }, { bb: 20, newPlayerChips: preset }), { min:1000,max:bank,amount,step:1 });
  }
  assert.throws(() => buyinOptions({ bank:999 }, { bb:20 }), /籌碼不足/);
});

test('舊房主審核補碼流程與排行榜欄位移除，開桌文案正確', () => {
  for (const file of ['ui/mp-app.js','net/host.js','net/client.js']) {
    const text = readFileSync(new URL('../js/' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /TOPUP_REQ|TOPUP_CANCEL|approveTopUp|denyTopUp|mpTopup/);
  }
  const lobby = readFileSync(new URL('../js/ui/lobby.js', import.meta.url), 'utf8');
  assert.match(lobby, /<label for="mpCreateChips">攜入籌碼<\/label>/);
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
    const node=key=>{if(!nodes.has(key))nodes.set(key,{value:'1,500',focus:()=>events.push('focus'),addEventListener:(type,fn)=>nodes.get(key)[type]=fn,reportValidity(){}});return nodes.get(key);};
    const el={setAttribute(){},addEventListener(){},querySelector:node,remove:()=>events.push('remove')};
    const ctx=vm.createContext({fmtChips:n=>n.toLocaleString('en-US'),stepBuyinAmount,document:{createElement:()=>el,body:{classList:{add(){},remove(){}},appendChild:()=>events.push('paint')}},toast:msg=>events.push(msg)});
    vm.runInContext(source.slice(source.indexOf('function pickBuyinAmount('),source.indexOf('async function sitDown(')),ctx);
    const started=performance.now(),pending=ctx.pickBuyinAmount({min:1000,max:8765,step:1,amount:2000});
    assert.deepEqual(events,['paint','focus']);assert.ok(performance.now()-started<200);
    assert.match(el.innerHTML,/type="text".*value="2,000"/);
    assert.match(el.innerHTML,/type="range"/);
    node(confirm?'[data-confirm]':'[data-cancel]').click();
    if(confirm)assert.deepEqual(events,['paint','focus','入座中…','remove']);
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
    cashoutSeat:async(seat,uid)=>{events.push([seat,uid,0]);return true;},pendingSeats:[],addonQueue:new Map(),
  });
  vm.runInContext(host.slice(host.indexOf('  async function drainSitLeaveInner('),host.indexOf('  function seatPlayer(')),ctx);
  await ctx.drainSitLeaveInner();assert.deepEqual(events,[[0,'u',0]]);
  const begin=source.indexOf('      const previousSelfSeat');
  const end=source.indexOf('      lastRecvAt',begin);
  const ui=vm.createContext({metadata:undefined,hostRoomUpdatedMs:null,hostBeatMs:null,hostLoop:null,watchHostBeat:()=>{},noteAddonEvents:()=>{},first:false,updateHostDisconnect:()=>{},fb:{},id:'r',room:{seatUids:['u'],stacks:[0]},r:{status:'lobby',seatUids:[''],lastMoneyEvent:{type:'cashout',uid:'u',amount:0}},user:{uid:'u'},
    goLobbyClean:()=>events.push('lobby'),toast:msg=>events.push(msg)});
  vm.runInContext('(function(){'+source.slice(begin,end)+'})()',ui);
  assert.deepEqual(events.slice(1),['lobby','籌碼輸光了，已離座回大廳']);
});

test('開桌遇到既有桌：依該桌大盲阻擋，留在大廳；先結算才讀帳戶', async () => {
  const events=[],messages=[];
  const ctx=vm.createContext({
    getFirebase:()=>({}),getUser:()=>({uid:'u',displayName:'玩家'}),
    createAttempt: 0, createTimeoutMs: () => 15000, setTimeout, clearTimeout, createRoomBuyinError,createDraft:{},creating:false,createError:'',screen:'create',playerDoc:{bank:99999},
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


test('R33b 開桌換盲注重設 50BB，並受帳戶與上限限制', () => {
  for (const [bb, expected] of [[10,500],[20,1000],[50,2500],[100,5000]]) {
    assert.equal(defaultCreateBuyin(90000, bb, 99999), expected);
  }
  assert.equal(defaultCreateBuyin(1000, 100, 3456), 3456);
  assert.equal(defaultCreateBuyin(1000, 5000, 200000), 100000);
  assert.equal(createRoomBuyinError(500,5,10,1000), '');
  assert.equal(createRoomBuyinError(500,10,20,1000), '攜入須為 1,000–100,000');
  for (const bb of [10,20,50,100]) {
    assert.equal(stepBuyinAmount(50 * bb,-1,50 * bb,100000),50 * bb);
    assert.equal(createRoomBuyinError(50 * bb,bb / 2,bb,100000), '');
  }
});

test('R39 開桌接受範圍內的任意整數', () => {
  assert.equal(createRoomBuyinError(1234, 10, 20, 5000), '');
  assert.equal(createRoomBuyinError(1501, 10, 20, 5000), '');
  assert.equal(createRoomBuyinError(1300, 5, 10, 8000), '');
  assert.equal(createRoomBuyinError(1300, 5, 10, 1300), '');
  assert.equal(createRoomBuyinError(300, 5, 10, 1300), '攜入須為 500–100,000');
});

test('R32b ±500 與不足 500 的剩餘額、上下限', () => {
  assert.equal(stepBuyinAmount(1000,1,1000,5000),1500);
  assert.equal(stepBuyinAmount(1234,1,1000,5000),1734);
  assert.equal(stepBuyinAmount(1234,1,1000,1300),1300);
  assert.equal(stepBuyinAmount(1500,-1,1000,5000),1000);
  assert.equal(stepBuyinAmount(1000,-1,1000,5000),1000);
  assert.equal(stepBuyinAmount(2000,1,20,2237),2237);
  assert.equal(stepBuyinAmount(99500,1,1000,99800),99800);
});

test('R38 ±：滿額非整數先回到上一檔 500，再按下限停住', () => {
  // 5/10，帳戶 1,300：500→1,000→1,300，− 反向 1,300→1,000→500
  assert.equal(stepBuyinAmount(500,1,500,1300),1000);
  assert.equal(stepBuyinAmount(1000,1,500,1300),1300);
  assert.equal(stepBuyinAmount(1300,-1,500,1300),1000);
  assert.equal(stepBuyinAmount(1000,-1,500,1300),500);
  assert.equal(stepBuyinAmount(500,-1,500,1300),500);
  // 10/20 最低 1,000：1,000→1,300→1,000
  assert.equal(stepBuyinAmount(1000,1,1000,1300),1300);
  assert.equal(stepBuyinAmount(1300,-1,1000,1300),1000);
  assert.equal(stepBuyinAmount(1000,-1,1000,1300),1000);
  // 補碼最低 1 大盲（20）：1,300→1,000→500→20
  assert.equal(stepBuyinAmount(1300,-1,20,1300),1000);
  assert.equal(stepBuyinAmount(500,-1,20,1300),20);
  assert.equal(remainingBank(1300,500),800);
  assert.equal(remainingBank(1300,1000),300);
  assert.equal(remainingBank(1300,1300),0);
  assert.equal(remainingBank(null,1000),null);
});

test('R32b F3 合計獨立列，四顆動作鈕不含取消；範圍錯誤中文與焦點鍵盤', () => {
  const ctx=vm.createContext({queuedTotal:q=>q.items.reduce((n,i)=>n+i.amount,0),myAddonQueue:{items:[{amount:1000},{amount:1500}]},fmtChips:n=>n.toLocaleString('en-US'),addonBusy:false,addonOptions,playerDoc:{bank:8000},room:{config:{bb:20}}});
  vm.runInContext(source.slice(source.indexOf('function addonButtonsHtml('),source.indexOf('function wireAddonButtons(')),ctx);
  assert.doesNotMatch(ctx.addonButtonsHtml(true),/mpAddonCancel/);
  const bar=source.slice(source.indexOf('function renderActBar('),source.indexOf('function pickBuyinAmount('));
  assert.match(bar,/下一手前補碼 \$\{fmtChips\(queued\)\}/);
  assert.match(bar,/取消補碼 \$\{fmtChips\(queued\)\}/);
  assert.match(bar,/btns.before\(row\)/);
  const picker=source.slice(source.indexOf('function pickBuyinAmount('),source.indexOf('function addonButtonsHtml('));
  assert.doesNotMatch(picker,/reportValidity/);
  assert.match(picker,/請輸入/);
  assert.match(picker,/number.focus\(\)/);
  assert.match(picker,/e.key === 'Escape'/);
});


test('R32b 選額面板 Esc 取消、焦點復原、尾數全加與中文錯誤', async () => {
  const nodes = new Map(), events = [], keys = {};
  const node = key => {
    if (!nodes.has(key)) nodes.set(key, {value:'2,000', hidden:true,
      addEventListener(type, fn) { this[type] = fn; }, focus() { events.push(key); }});
    return nodes.get(key);
  };
  const el = {setAttribute(){},querySelector:node,addEventListener:(type,fn)=>keys[type]=fn,remove:()=>events.push('remove')};
  const ctx = vm.createContext({fmtChips:n=>n.toLocaleString('en-US'),stepBuyinAmount,remainingBank,toast:()=>events.push('toast'),
    document:{activeElement:{focus:()=>events.push('restore')},createElement:()=>el,
      body:{appendChild(){},classList:{add(){},remove(){}}}}});
  vm.runInContext(source.slice(source.indexOf('function pickBuyinAmount('),source.indexOf('async function sitDown(')),ctx);
  const pending=ctx.pickBuyinAmount({min:20,max:2237,step:1,amount:2000});
  assert.equal(events[0],'input[type="text"]');
  node('[data-plus]').click();
  assert.equal(node('input[type="text"]').value,'2,237');
  node('input[type="text"]').value='2,238';
  node('[data-confirm]').click();
  assert.equal(node('[data-error]').hidden,false);
  assert.match(node('[data-error]').textContent,/請輸入 20–2,237/);
  assert.ok(!events.includes('toast'));
  keys.keydown({key:'Escape',preventDefault(){}});
  assert.equal(await pending,null);
  assert.deepEqual(events.slice(-2),['remove','restore']);
});


test('R36 補碼最低行內提示由 minHint 啟用，入座維持原行為', async () => {
  for (const minHint of ['已是最低補碼', undefined]) {
    const nodes = new Map();
    const hintClasses = new Set();
    const hintVisible = () => hintClasses.has('is-visible');
    const node = key => {
      if (!nodes.has(key)) nodes.set(key, { value: '20', hidden: true,
        classList: { add: name => hintClasses.add(name), remove: name => hintClasses.delete(name) },
        addEventListener(type, fn) { this[type] = fn; }, focus() {} });
      return nodes.get(key);
    };
    const el = { setAttribute() {}, querySelector: node, addEventListener() {}, remove() {} };
    const ctx = vm.createContext({ fmtChips: n => n.toLocaleString('en-US'), stepBuyinAmount, remainingBank,
      document: { createElement: () => el, body: { appendChild() {}, classList: { add() {}, remove() {} } } } });
    vm.runInContext(source.slice(source.indexOf('function pickBuyinAmount('), source.indexOf('function addonButtonsHtml(')), ctx);
    const pending = ctx.pickBuyinAmount({ min: 20, max: 2000, step: 1, amount: 20, minHint });
    // is-visible 只切換 CSS visibility；提示在帳戶文字容器內絕對定位，不佔流內寬度。
    assert.equal(hintVisible(), false);
    node('[data-minus]').click();
    assert.equal(node('input[type="text"]').value, '20');
    assert.doesNotMatch(el.innerHTML, /已是最低攜入/);
    if (minHint) {
      assert.match(el.innerHTML, /<p class="mp-acct mp-acct-bank mp-min-hint-row"><span class="mp-buyin-bank-anchor">帳戶 <b id="mpBuyinBank"[^>]*>[^<]*<\/b><span class="mp-min-hint" data-min-hint role="status"><\/span><\/span><\/p>\s*<div class="mp-buyin-step">/);
      assert.equal(node('[data-min-hint]').textContent, minHint);
      assert.equal(hintVisible(), true);
      node('[data-plus]').click(); assert.equal(hintVisible(), false);
      node('input[type="text"]').value = '20'; node('[data-minus]').click();
      node('input[type="text"]').input(); assert.equal(hintVisible(), false);
      node('[data-minus]').click(); node('input[type="range"]').value = '100';
      node('input[type="range"]').input(); assert.equal(hintVisible(), false);
    } else {
      assert.match(el.innerHTML, /<p class="mp-acct mp-acct-bank">帳戶 /);
      assert.doesNotMatch(el.innerHTML, /data-min-hint|mp-min-hint-row/);
      assert.equal(nodes.has('[data-min-hint]'), false);
    }
    node('[data-cancel]').click(); assert.equal(await pending, null);
  }
  assert.match(source, /minHint: '已是最低補碼'/);
});

for (const state of ['兩手之間', '蓋牌', '暫離', '手中未蓋牌']) {
  test(`R38 ${state} 帳戶不足一大盲停用並優先提示`, () => {
    const ctx = vm.createContext({ addonOptions, queuedTotal, playerDoc: { bank: 19 }, room: { config: { bb: 20 } }, myAddonQueue: null, addonBusy: false });
    vm.runInContext(source.slice(source.indexOf('function addonButtonsHtml('), source.indexOf('function wireAddonButtons(')), ctx);
    const html = ctx.addonButtonsHtml(state !== '手中未蓋牌');
    assert.match(html, /帳戶不足 1 大盲/);
    assert.match(html, /aria-describedby="mpAddonHint" disabled/);
    assert.doesNotMatch(html, /這手結束後可補碼/);
    ctx.playerDoc.bank = 1019; ctx.myAddonQueue = { items: [{ amount: 1000 }] };
    assert.match(ctx.addonButtonsHtml(true), /帳戶不足 1 大盲/);
  });
}
test('R38 取消觸控尺寸與公共牌可及性名稱', () => {
  const css = readFileSync(new URL('../css/game.css', import.meta.url), 'utf8');
  assert.match(css, /#mpAddonQueueRow button\{min-width:44px;min-height:44px;/);
  assert.match(readFileSync(new URL('../index.html', import.meta.url), 'utf8'), /id="board" role="group" aria-label="公共牌"/);
});

test('R39 補碼滿額及補碼／入座自行輸入 1,234 都可確認', async () => {
  const nodes = new Map();
  const node = key => {
    if (!nodes.has(key)) nodes.set(key, { value: '1,000', hidden: true, textContent: '', dataset: {},
      addEventListener(type, fn) { this[type] = fn; }, focus() {} });
    return nodes.get(key);
  };
  const el = { setAttribute() {}, querySelector: node, addEventListener() {}, remove() {} };
  const ctx = vm.createContext({ fmtChips: n => n.toLocaleString('en-US'), stepBuyinAmount, remainingBank,
    document: { createElement: () => el, body: { appendChild() {}, classList: { add() {}, remove() {} } } } });
  vm.runInContext(source.slice(source.indexOf('function pickBuyinAmount('), source.indexOf('function addonButtonsHtml(')), ctx);
  const opts = addonOptions(2300, 20, 1000);
  const pending = ctx.pickBuyinAmount({ ...opts, bank: opts.max, bankSuffix: '（上桌時才扣）', pendingText: null });
  assert.equal(node('#mpBuyinBank').textContent, '300（上桌時才扣）');
  node('[data-plus]').click();
  assert.equal(node('input[type="text"]').value, '1,300');
  assert.equal(node('#mpBuyinBank').textContent, '0（上桌時才扣）');
  node('[data-minus]').click();
  assert.equal(node('input[type="text"]').value, '1,000');
  assert.equal(node('#mpBuyinBank').textContent, '300（上桌時才扣）');
  node('[data-plus]').click();
  node('[data-confirm]').click();
  assert.equal(await pending, 1300);

  for (const options of [
    { ...opts, bank: opts.max, title: '補碼', confirmText: '補碼' },
    { ...buyinOptions({ bank: 5000 }, { bb: 20 }), bank: 5000 },
  ]) {
    nodes.clear();
    const selected = ctx.pickBuyinAmount({ ...options, pendingText: null });
    assert.match(el.innerHTML, /type="range"[^>]*step="1"/);
    const number = node('input[type="text"]');
    const slider = node('input[type="range"]');
    number.value = '1,234.0001';
    number.blur();
    node('[data-confirm]').click();
    assert.equal(node('[data-error]').hidden, false);
    number.value = '1,234';
    number.input();
    number.blur();
    assert.equal(slider.value, '1234');
    assert.equal(node('#mpBuyinBank').textContent, (options.bank - 1234).toLocaleString('en-US'));
    node('[data-confirm]').click();
    assert.equal(await selected, 1234);
  }
});
test('R38 伺服器帳戶更新時同步重畫補碼動作列', () => {
  let renders = 0;
  const ctx = vm.createContext({ screen: 'table', renderActBar: () => renders++, globalThis: {} });
  vm.runInContext(source.slice(source.indexOf('function paintAccount('), source.indexOf('/** @type {any} */', source.indexOf('function paintAccount('))), ctx);
  ctx.paintAccount(); assert.equal(renders, 1);
});
