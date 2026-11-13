import { test } from 'node:test';
import assert from 'node:assert/strict';
import { disconnectState, refundAtSeat, resumeDeadline, DISCONNECT_COPY, closeDisconnectedRoom, hostLivenessMs, hostAliveMs, HOST_PAUSE_MS, HOST_CLOSE_MS } from '../js/net/host-disconnect.js';
const minute = 60_000;
test('HD1113 r4：20 秒內閃斷不提示，20 秒到 60 秒暫停，T+60 秒隱藏並收桌', () => {
  assert.equal(HOST_PAUSE_MS, 20000); assert.equal(HOST_CLOSE_MS, 60000);
  assert.deepEqual(disconnectState(1000,20999),{paused:false,hidden:false,reclaim:false});
  assert.deepEqual(disconnectState(1000,21000),{paused:true,hidden:false,reclaim:false});
  assert.deepEqual(disconnectState(1000,60999),{paused:true,hidden:false,reclaim:false});
  assert.deepEqual(disconnectState(1000,61000),{paused:true,hidden:true,reclaim:true});
});
test('HD1113：回來繼續與 deadline 延長', () => {
  assert.equal(resumeDeadline(50000, 10000, 100000), 140000);
  assert.equal(resumeDeadline(null, 10000, 100000), null);
  assert.equal(DISCONNECT_COPY.returned, '房主已回來');
});
test('HD1113：liveness 只看房主 beat，缺 presence 才用 updatedAt',()=>{
  const r={updatedAt:{toMillis:()=>100000}};
  assert.equal(hostLivenessMs(r,50000),50000);
  assert.equal(hostLivenessMs(r,150000),150000);
  assert.equal(hostLivenessMs(r,{exists:()=>false}),100000);
  assert.equal(hostAliveMs(null,null),null);
});
test('HD1113 r2：暫停中客人離桌（寫 room.updatedAt）不延後暫停與 T+2 收桌',()=>{
  const lastBeat=1_000_000;
  // Guests leave at T+10s, T+60s and T+110s; each bumps room.updatedAt.
  for (const guestWrite of [lastBeat+10_000,lastBeat+60_000,lastBeat+110_000]) {
    const r={updatedAt:{toMillis:()=>guestWrite}};
    const live=hostLivenessMs(r,{exists:()=>true,data:()=>({beat:{toMillis:()=>lastBeat}})});
    assert.equal(live,lastBeat);
    assert.equal(disconnectState(live,lastBeat+HOST_PAUSE_MS).paused,true);
    assert.equal(disconnectState(live,lastBeat+HOST_CLOSE_MS-1).reclaim,false);
    assert.equal(disconnectState(live,lastBeat+HOST_CLOSE_MS).reclaim,true);
    assert.equal(disconnectState(hostAliveMs(lastBeat,guestWrite),lastBeat+HOST_CLOSE_MS).hidden,true);
  }
});
test('HD1113：退款為座位＋本手下注，不重加街下注；結果卡文案', () => {
  assert.equal(refundAtSeat({ pub: { phase: 'flop', seats: [{chips: 1600, contributed: 400, bet: 100}] } }, 0), 2000);
  assert.equal(refundAtSeat({ stacks: [2300], pub: {phase: 'hand_over'} }, 0), 2300);
  assert.equal(DISCONNECT_COPY.closed, '原牌桌已關閉，籌碼已回到帳戶');
});
test('HD1113：搶收重試讀到 closed 只成功一次', async () => {
  let closed = false, writes = 0;
  const room = { hostUid:'host', status:'playing', updatedAt:{toMillis:()=>1}, rev:1, seatUids:[], sess:[], pub:{} };
  const fs = { doc: (...a)=>a.slice(1).join('/'), serverTimestamp:()=>0,
    runTransaction: async (_, fn)=>fn({ get:async ref=>({exists:()=>true,data:()=>ref.includes('presence') ? {beat:{toMillis:()=>1}} : {...room,status:closed?'closed':'playing'}}), update:()=>{closed=true;writes++;},set:()=>{} }) };
  assert.equal(await closeDisconnectedRoom({db:{},fs}, 'r', 130000), true);
  assert.equal(await closeDisconnectedRoom({db:{},fs}, 'r', 130000), false);
  assert.equal(writes,1);
});

test('HD1113：完整交易一次退回所有玩家籌碼、下注及帳本，不寫戰績', async () => {
  const r = {hostUid:'h',status:'playing',rev:2,seatUids:['h','p','','','',''],
    sess:[{sessionNo:1,buyIn:2000,topUps:0,topUpChips:0,hands:3,nightKey:'20261113'},
      {sessionNo:1,buyIn:2000,topUps:0,topUpChips:0,hands:3,nightKey:'20261113'}],
    updatedAt:{toMillis:()=>1},pub:{phase:'flop',seats:[{chips:1700,contributed:300},{chips:1800,contributed:200}]}};
  const writes=[];
  const fs={doc:(_, ...p)=>p.join('/'),serverTimestamp:()=>123,
    runTransaction:async (_,fn)=>fn({get:async ref=>({exists:()=>true,data:()=>
      ref.includes('presence')?{beat:{toMillis:()=>1}}:ref.startsWith('pokerPlayers')?
      {bank:100,inPlay:2000,tableRoomId:'r',sessionNo:1,topUps:0,topUpChips:0,handsPlayed:0}:r}),
      update:(ref,data)=>writes.push({ref,data}),set:(ref,data)=>writes.push({ref,data})})};
  assert.equal(await closeDisconnectedRoom({db:{},fs,uid:'outsider'},'r',130000),true);
  assert.equal(writes.length,5);
  assert.equal(writes[0].data.bank,2100);assert.equal(writes[2].data.bank,2100);
  assert.equal(writes[1].data.amount,2000); assert.equal(writes[3].data.amount,2000);
  assert.deepEqual(writes[4].data.seatUids,Array(6).fill(''));
  assert.equal(writes.some(w=>/nights|Stats/.test(w.ref)),false);
});

import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const appSource=readFileSync(new URL('../js/ui/mp-app.js',import.meta.url),'utf8');
const extract=(start,end)=>appSource.slice(appSource.indexOf(start),appSource.indexOf(end,appSource.indexOf(start)));
function bannerElement(textContent = '') {
  const classes = new Set(['mp-banner', 'mp-banner--hd']);
  return {textContent, hidden:false, classList:{
    remove:name=>classes.delete(name),
    contains:name=>classes.has(name),
    toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
  }};
}
test('HD1113：實際動作列停用且隱藏倒數；既有 banner 顯示等待文案',()=>{
  const btns={innerHTML:'bet'},hint={textContent:'20 秒'},banner=bannerElement();let locked=0;
  const c=vm.createContext({hostPaused:true,hostReturned:false,room:{seatUids:['p'],hostUid:'h',pub:{phase:'flop',actor:0}},
    screen:'table',getUser:()=>({uid:'p'}),DISCONNECT_COPY,
    $:s=>s==='#btns'?btns:s==='#turnHint'?hint:s==='#mpBanner'?banner:{},lockMpRaisePanel:()=>locked++});
  vm.runInContext(extract('function renderActBar()', 'function clearMpRaiseHold()'),c);
  vm.runInContext(extract('function tickTurnHint()', 'function consumeRoomSound'),c);
  vm.runInContext(extract('function renderBanner()', 'function renderSidePanels'),c);
  vm.runInContext('renderActBar(); tickTurnHint(); renderBanner();',c);
  assert.equal(btns.innerHTML,'<div class="mp-spec">等待房主回來</div>');assert.equal(locked,1);assert.equal(hint.textContent,'');
  assert.equal(banner.textContent,DISCONNECT_COPY.paused);
  assert.equal(banner.classList.contains('mp-banner--hd'),true);
});

test('HD1113：斷線 modifier 僅用於暫停／回來，清空及其他提示均移除',()=>{
  const banner=bannerElement();
  banner.classList.remove('mp-banner--hd');
  const c=vm.createContext({hostPaused:true,hostReturned:false,
    room:{hostUid:'h',seatUids:['p'],pub:{}},getUser:()=>({uid:'p'}),DISCONNECT_COPY,
    hostShouldWarn:()=>false,resetTimeTaipeiLabel:()=> '00:00',esc:s=>s,
    $:s=>s==='#mpBanner'?banner:null});
  vm.runInContext(extract('function renderBanner()', 'function renderSidePanels'),c);
  for (const state of ['paused','returned','clear','voided','warn','quota','no-room']) {
    c.hostPaused=state==='paused';c.hostReturned=state==='returned';
    c.room.pub={voided:state==='voided',quotaStop:state==='quota'};
    c.hostShouldWarn=()=>state==='warn';
    if (state==='no-room') c.room=null;
    const hd=state==='paused'||state==='returned';
    banner.classList.toggle('mp-banner--hd',!hd);
    c.renderBanner();
    assert.equal(banner.classList.contains('mp-banner--hd'),hd,state);
    assert.equal(banner.classList.contains('mp-banner'),true,state);
    if (hd) assert.equal(banner.textContent,DISCONNECT_COPY[state]);
    if (state==='clear') {assert.equal(banner.hidden,true);assert.equal(banner.textContent,'');}
    if (state==='voided') assert.equal(banner.textContent,'這一手作廢，即將重新開局');
    if (state==='warn') assert.match(banner.textContent,/今天的免費用量快用完了/);
    if (state==='quota') assert.match(banner.innerHTML,/mpQuotaLeave/);
  }
});

test('HD1113：暫停顯示等待文字，房主回來或收桌清除暫停後恢復動作',()=>{
  for (const closed of [false,true]) {
    const btns={innerHTML:'old buttons'},act={};
    const c=vm.createContext({hostPaused:true,hostReturned:false,hostReturnedTimer:7,
      room:{status:'playing',hostUid:'h',seatUids:['p'],config:{bb:20},pub:{phase:'flop',actor:0}},
      getUser:()=>({uid:'p'}),hostBeatMs:Date.now(),hostRoomUpdatedMs:null,
      disconnectState,hostAliveMs,DISCONNECT_COPY,hostSitPending:false,
      clearTimeout(){},setTimeout(){},paintTableChrome(){},tickTurnHint(){},lockMpRaisePanel(){},
      $:s=>s==='#btns'?btns:s==='#act'?act:null});
    vm.runInContext(extract('function renderActBar()', 'function clearMpRaiseHold()'),c);
    vm.runInContext(extract('function updateHostDisconnect()', 'let lastRecvAt'),c);
    c.renderActBar();assert.match(btns.innerHTML,/等待房主回來/);assert.doesNotMatch(btns.innerHTML,/<button/);
    if (closed) c.room.status='closed';
    c.updateHostDisconnect();c.renderActBar();
    assert.equal(c.hostPaused,false);assert.equal(c.hostReturned,!closed);
    assert.match(btns.innerHTML,/id="mpCheck"/);assert.match(btns.innerHTML,/id="mpRaise"/);
    assert.doesNotMatch(btns.innerHTML,/等待房主回來|disabled/);
  }
});

import {remainingMs} from '../js/net/client.js';
test('HD1113：房主恢復延長 deadline，訪客保留剩餘秒數；不重給 30 秒',()=>{
  const src=readFileSync(new URL('../js/net/host.js',import.meta.url),'utf8');let now=10000,writes=0;
  const c=vm.createContext({HOST_PAUSE_MS,resumeDeadline,Date:{now:()=>now},navigator:{onLine:true},
    engine:{deadline:30000},hostClockAt:0,syncDeadlineFromEngine:()=>{},queueWrite:()=>writes++,afterEngineChange:()=>{}});
  vm.runInContext(src.slice(src.indexOf('  let connectionBeat ='),src.indexOf('  let revealTimer =')),c);
  c.observeHostBeat(10000);now=55000;assert.equal(c.connectionPaused(),true);
  now=100000;c.observeHostBeat(now);
  assert.equal(c.engine.deadline,120000);assert.equal(writes,1);
  assert.equal(remainingMs(c.engine.deadline,c.hostClockAt,100000,100000),20000);
  assert.equal(remainingMs(c.engine.deadline,c.hostClockAt,100000,105000),15000);
  assert.equal(c.connectionPaused(),false);
});
test('HD1113：房主回來顯示「房主已回來」banner（不重複 toast），4 秒後收起',()=>{
  const messages=[];const timers=[];let paints=0;
  const c=vm.createContext({room:{status:'playing'},hostBeatMs:Date.now(),hostRoomUpdatedMs:null,
    hostPaused:true,hostReturned:false,hostReturnedTimer:null,disconnectState,hostAliveMs,DISCONNECT_COPY,toast:m=>messages.push(m),
    setTimeout:(fn,ms)=>{timers.push([fn,ms]);return timers.length;},clearTimeout:()=>{},
    paintTableChrome:()=>{paints++;},tickTurnHint:()=>{}});
  vm.runInContext(extract('function updateHostDisconnect()', 'let lastRecvAt'),c);c.updateHostDisconnect();
  assert.deepEqual(messages,[]);assert.equal(c.hostReturned,true);assert.equal(c.hostPaused,false);
  assert.equal(timers.length,1);assert.equal(timers[0][1],4000);
  const before=paints;timers[0][0]();assert.equal(c.hostReturned,false);assert.equal(paints,before+1);
});

test('HD1113：收桌清除暫停、回來狀態與計時器，不殘留斷線 banner',()=>{
  for (const closedBy of [undefined, 'host-disconnect']) {
    for (const copy of [DISCONNECT_COPY.paused, DISCONNECT_COPY.returned, '其他既有提示']) {
      const banner=bannerElement(copy);const cleared=[];
      const c=vm.createContext({room:{status:'playing',closedBy},hostPaused:true,hostReturned:true,
        hostReturnedTimer:7,DISCONNECT_COPY,$:s=>s==='#mpBanner'?banner:null,
        clearTimeout:id=>cleared.push(id)});
      vm.runInContext(extract('function updateHostDisconnect()', 'let lastRecvAt'),c);
      c.room.status='closed';
      c.updateHostDisconnect();
      assert.equal(c.hostPaused,false);assert.equal(c.hostReturned,false);
      assert.deepEqual(cleared,[7]);assert.equal(c.hostReturnedTimer,null);
      assert.equal(banner.classList.contains('mp-banner--hd'),false);
      if (copy==='其他既有提示') {
        assert.equal(banner.textContent,copy);assert.equal(banner.hidden,false);
      } else {
        assert.equal(banner.textContent,'');assert.equal(banner.hidden,true);
      }
    }
  }
});

test('HD1113：執行完整 tearDownRoom 清空斷線 banner，保留其他既有提示',()=>{
  for (const copy of [DISCONNECT_COPY.paused, DISCONNECT_COPY.returned, '其他既有提示']) {
    const banner=bannerElement(copy);const cleared=[];
    const c=vm.createContext({hostPaused:true,hostReturned:true,hostReturnedTimer:7,
      stopHostBeat:null,stopSoundVisibility:null,stopRoom:null,stopHole:null,enterRoomTimeout:null,
      presence:null,hostLoop:null,intents:null,animQ:null,room:{status:'playing'},roomId:'r',
      DISCONNECT_COPY,$:s=>s==='#mpBanner'?banner:null,
      document:{getElementById:()=>null},clearTimeout:id=>cleared.push(id),
      stopTurnClock(){},resetRoomSound(){},clearMpRaiseHold(){},hideCloseResultCard(){},removeMpMenuExtras(){}});
    vm.runInContext(extract('function tearDownRoom()', 'function ensureMpMenu()'),c);
    c.tearDownRoom();
    assert.equal(c.hostPaused,false);assert.equal(c.hostReturned,false);
    assert.equal(c.hostReturnedTimer,null);assert.ok(cleared.includes(7));
    assert.equal(banner.classList.contains('mp-banner--hd'),false);
    assert.equal(c.room,null);assert.equal(c.roomId,null);
    assert.equal(banner.textContent.includes('房主連線中斷，等待回來'),false);
    if (copy==='其他既有提示') {
      assert.equal(banner.textContent,copy);assert.equal(banner.hidden,false);
    } else {
      assert.equal(banner.textContent,'');assert.equal(banner.hidden,true);
    }
  }
});

import {createSingleTable} from '../js/net/room.js';
import {webcrypto} from 'node:crypto';
test('HD1113：T+2 退款收桌後 createSingleTable 建新 000；收桌失敗仍加入既有桌',async()=>{
  globalThis.crypto ||= webcrypto;
  for(const denied of [false,true]) {
    const old={code:'000',name:'舊桌',hostUid:'h',status:'playing',updatedAt:{toMillis:()=>1},
      rev:1,members:['h','new'],seatUids:[],stacks:[],sess:[],pub:{phase:'lobby'},config:{}};
    const docs=new Map([['pokerRooms/old',old],['pokerCodes/000',{roomId:'old',expiresAt:{toMillis:()=>9999999999999}}]]);
    const snap=p=>({exists:()=>docs.has(p),data:()=>docs.get(p)});
    const fs={doc:(_, ...p)=>p.join('/'),collection:(_, ...p)=>p.join('/'),query:()=>0,where:()=>0,orderBy:()=>0,limit:()=>0,
      getDocs:async()=>({forEach:cb=>cb({id:'old',data:()=>({code:'000'})})}),getDoc:async p=>snap(p),
      serverTimestamp:()=>1,Timestamp:{fromMillis:n=>({toMillis:()=>n})},deleteDoc:async p=>docs.delete(p),
      runTransaction:async(_,fn)=>{
        const writes=[];
        const result=await fn({get:async p=>snap(p),set:(p,v)=>writes.push([p,v]),update:(p,v)=>writes.push([p,{...docs.get(p),...v}])});
        if(denied && writes.some(([p,v])=>p==='pokerRooms/old'&&v.status==='closed')) throw Error('permission-denied');
        for(const [p,v] of writes)docs.set(p,v);return result;
      }};
    const result=await createSingleTable({db:{},fs,uid:'new'},{uid:'new',name:'新桌',sb:10,bb:20,newPlayerChips:2000});
    if(denied){assert.equal(result.roomId,'old');assert.equal(result.existing,true);}
    else {assert.equal(docs.get('pokerRooms/old').status,'closed');assert.notEqual(result.roomId,'old');assert.equal(result.code,'000');}
  }
});

test('HD1113：沿用結果卡顯示精確文案，已有同桌結果卡不重建',()=>{
  let card=null,builds=0;
  const c=vm.createContext({room:{id:'r',closedBy:'host-disconnect'},roomId:'r',screen:'table',DISCONNECT_COPY,
    closeResultDismissedFor:null,closeResultShownFor:null,closeResultChipsShown:0,closeInFlight:false,
    document:{getElementById:()=>card,createElement:()=>({dataset:{},setAttribute(){},removeAttribute(){},
      set innerHTML(s){this.html=s;builds++;}}),body:{appendChild:e=>card=e}},$:()=>null});
  vm.runInContext(extract('function showCloseResultCard(', 'function showHostAloneLeaveDialog('),c);
  c.showCloseResultCard({chips:2000});assert.ok(card.html.includes('原牌桌已關閉，籌碼已回到帳戶'));
  c.showCloseResultCard({chips:2000});assert.equal(builds,1);
});
