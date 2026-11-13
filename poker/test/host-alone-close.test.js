import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOST_ALONE_CLOSE_MS, hostAloneCloseMs, hostAloneSince, maybeAutoCloseSingleTable } from '../js/net/room.js';
import { createHostLoop } from '../js/net/host.js';

const base = () => ({ id: 'r', code: '000', hostUid: 'h', members: ['h'], status: 'lobby', rev: 1,
  createdAt: { toMillis: () => 1000 }, updatedAt: { toMillis: () => 1000 },
  config: { sb: 10, bb: 20 }, seatUids: ['h', '', '', '', '', ''],
  stacks: [2000, 0, 0, 0, 0, 0], chipTotal: 2000, sess: Array(6).fill(null),
  pub: { phase: 'lobby', handNo: 0, seats: [] } });

test('房主獨坐：以建立時間起算，其他人入座清除，離座重新計時', () => {
  const r = base();
  assert.equal(HOST_ALONE_CLOSE_MS, 30 * 60_000);
  assert.equal(hostAloneSince(r, 5000), 1000);
  r.seatUids[1] = 'g';
  assert.equal(hostAloneSince(r, 6000), null);
  r.pub = { ...r.pub, hostAloneSince: null, hostHadOtherSeats: true };
  r.seatUids[1] = '';
  assert.equal(hostAloneSince(r, 7000), 7000);
  r.pub.hostAloneSince = 7000;
  assert.equal(hostAloneSince(r, 8000), 7000);
});

test('房主既有 tick：30 分鐘前不關閉，牌局中不關閉，手間只呼叫一次收桌', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const previous = globalThis.document;
  globalThis.document = { visibilityState: 'visible' };
  let now = 1000, closes = 0;
  let r = base();
  const fs = { doc: (_d, ...p) => p.join('/'), collection: (_d, ...p) => p.join('/'),
    onSnapshot: () => () => {}, serverTimestamp: () => 1,
    updateDoc: async (_ref, patch) => { r = { ...r, ...patch }; }, setDoc: async () => {} };
  const loop = createHostLoop({ fs, db: {} }, { uid: 'h', roomId: 'r', getRoom: () => r,
    now: () => now, stats: { enabled: false }, onHostAloneClose: () => { closes++; } });
  try {
    loop.start();
    now += HOST_ALONE_CLOSE_MS - 1;
    t.mock.timers.tick(1000);
    assert.equal(closes, 0);
    r = { ...r, seatUids: ['h', 'g', '', '', '', ''], pub: { ...r.pub, phase: 'flop' } };
    now++;
    t.mock.timers.tick(1000);
    assert.equal(closes, 0);
    r = { ...r, seatUids: base().seatUids, pub: { ...r.pub, phase: 'lobby', hostAloneSince: 1000 } };
    t.mock.timers.tick(1000);
    assert.equal(closes, 1);
    t.mock.timers.tick(1000);
    assert.equal(closes, 1);
  } finally { loop.stop(); globalThis.document = previous; t.mock.timers.reset(); }
});

test('離線收桌入口未到 2 分鐘不可收', async () => {
  let writes=0;
  const fs={doc:(_, ...p)=>p.join('/'),runTransaction:async(_,fn)=>fn({
    get:async p=>({exists:()=>true,data:()=>p.includes('presence')?{beat:{toMillis:()=>1000}}:base()}),
    update:()=>writes++,set:()=>writes++})};
  assert.equal(await maybeAutoCloseSingleTable({db:{},fs},'r','g',10000),false);
  assert.equal(writes,0);
});

test('獨坐 timeout 覆寫僅限 localhost emulator；斷線收桌固定 2 分鐘',async()=>{
  const prev=globalThis.location;
  try {
    for(const [hostname,search,expected] of [
      ['localhost','?emu=1&aloneMs=8000',8000],
      ['localhost','?aloneMs=8000',HOST_ALONE_CLOSE_MS],
      ['example.com','?emu=1&aloneMs=8000',HOST_ALONE_CLOSE_MS],
    ]) {
      globalThis.location={hostname,search};assert.equal(hostAloneCloseMs(),expected);
      assert.equal((await import('../js/net/host-disconnect.js')).HOST_CLOSE_MS,120000);
    }
  } finally {globalThis.location=prev;}
});
test('離線房主：新鮮 beat 或 updatedAt 都保留，兩者過期才原子退款',async()=>{
  for(const fresh of ['beat','room','none']) {
    let r=base();let transactions=0;const now=131001;
    if(fresh==='room')r.updatedAt={toMillis:()=>now};
    const fs={doc:(_, ...p)=>p.join('/'),getDoc:async p=>({exists:()=>true,data:()=>
      p.includes('presence')?{beat:{toMillis:()=>fresh==='beat'?now:1000}}:r}),
      runTransaction:async()=>{transactions++;return true;},deleteDoc:async()=>{}};
    assert.equal(await maybeAutoCloseSingleTable({db:{},fs},'r','g',now),fresh==='none');
    assert.equal(transactions,fresh==='none'?1:0);
  }
});
