import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sweepStaleTable, isLobbyRoomSuppressed, _resetLobbyClosedSuppress } from '../js/net/room.js';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const now = 2_000_000;
const row = {id:'r',status:'lobby'};
function fixture(beat) {
  const room={hostUid:'h',status:'lobby',updatedAt:{toMillis:()=>1}};
  const fs={doc:(_, ...p)=>p.join('/'), getDoc:async p=>({exists:()=>true,data:()=>
    p.includes('presence') ? {beat:{toMillis:()=>beat}} : room})};
  fs.runTransaction=async()=>false;
  return {db:{},fs};
}
test('T+60 秒大廳隱藏，房主恢復後重新顯示',async()=>{
  _resetLobbyClosedSuppress(); const fb=fixture(now-60000);
  assert.equal(await sweepStaleTable(fb,row,'guest',now),true);
  assert.equal(isLobbyRoomSuppressed('r'),true);
  const get=fb.fs.getDoc;
  fb.fs.getDoc=async p=>p.includes('presence')?{exists:()=>true,data:()=>({beat:{toMillis:()=>now}})}:get(p);
  assert.equal(await sweepStaleTable(fb,row,'guest',now+10000),false);
  assert.equal(isLobbyRoomSuppressed('r'),false);
});
test('60 秒內不隱藏，讀取失敗不冒充房主失聯',async()=>{
  _resetLobbyClosedSuppress(); const fb=fixture(now-59000);
  assert.equal(await sweepStaleTable(fb,row,'guest',now),false);
  fb.fs.getDoc=async()=>{throw Error('unavailable');};
  assert.equal(await sweepStaleTable(fb,row,'guest',now+10000),false);
  assert.equal(isLobbyRoomSuppressed('r'),false);
});
const app = readFileSync(new URL('../js/ui/mp-app.js', import.meta.url), 'utf8');
const section = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
test('大廳巡查同時只執行一輪，離開大廳後停止下一桌', async () => {
  let release, calls = 0;
  const ctx = vm.createContext({
    getFirebase: () => ({}), getUser: () => ({ uid: 'guest' }), screen: 'lobby',
    lobbySweepInflight: false, playerDoc: null, lobbySweepRows: [row, { ...row, id: 'r2' }],
    sweepStaleTable: async () => { calls++; await new Promise(resolve => { release = resolve; }); },
    paint: () => {}, Date,
  });
  vm.runInContext(section('async function sweepLobbyTables()', 'function ensureOpenTablesListen()'), ctx);
  const pending = ctx.sweepLobbyTables();
  await ctx.sweepLobbyTables();
  assert.equal(calls, 1);
  ctx.screen = 'table'; release(); await pending;
  assert.equal(calls, 1);
  assert.equal(ctx.lobbySweepInflight, false);
});

test('idleCloseMs：非模擬器（正式站）固定 30 分鐘', async () => {
  const { idleCloseMs } = await import('../js/net/room.js');
  assert.equal(idleCloseMs(), 30 * 60_000);
});

test('巡查節流：同一 db 包裝、執行中與 10 秒內不重讀',async()=>{
  const fb=fixture(now), get=fb.fs.getDoc; let reads=0,release;
  fb.fs.getDoc=async p=>{reads++;if(reads===1) await new Promise(r=>release=r);return get(p);};
  const pending=sweepStaleTable(fb,row,'guest',now);
  assert.equal(await sweepStaleTable({...fb},row,'guest',now+10000),false);
  release();await pending;const count=reads;
  await sweepStaleTable({...fb},row,'guest',now+9999);assert.equal(reads,count);
  await sweepStaleTable({...fb},row,'guest',now+10000);assert.ok(reads>count);
});
test('不巡查自己已入座桌；closed 立即隱藏且不讀 presence',async()=>{
  const fb=fixture(1),get=fb.fs.getDoc;let reads=0;
  fb.fs.getDoc=async p=>{reads++;return get(p);};
  await sweepStaleTable(fb,{...row,seatUids:['guest']},'guest',now);assert.equal(reads,0);
  fb.fs.getDoc=async()=>({exists:()=>true,data:()=>({status:'closed'})});
  assert.equal(await sweepStaleTable(fb,row,'guest',now),true);
  assert.equal(isLobbyRoomSuppressed('r'),true);
});
test('收桌被拒恢復可見；成功則清座、原子退款與 ledger 由交易處理',async()=>{
  _resetLobbyClosedSuppress();const fb=fixture(1);const changes=[];
  fb.fs.runTransaction=async()=>{throw Error('permission-denied');};
  assert.equal(await sweepStaleTable(fb,row,'guest',now,()=>changes.push(isLobbyRoomSuppressed('r'))),false);
  assert.deepEqual(changes,[true,false]);assert.equal(isLobbyRoomSuppressed('r'),false);
});
