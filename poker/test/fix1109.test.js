import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHostLoop } from '../js/net/host.js';
import { hostCloseAllBatch } from '../js/net/ledger.js';
import { openRowHtml } from '../js/ui/lobby.js';
const source = readFileSync(new URL('../js/ui/mp-app.js', import.meta.url), 'utf8');

test('所有進桌入口：第一筆網路讀取前立即顯示牌桌載入畫面', async () => {
  const body = source.slice(source.indexOf('async function enterRoom('), source.indexOf('  stopRoom = listenRoom(', source.indexOf('async function enterRoom(')));
  const events = [];
  const context = vm.createContext({ getFirebase: () => ({ db: {}, fs: {
    doc: () => 'room', getDoc: () => { events.push('read'); return new Promise(() => {}); },
  } }), getUser: () => ({ uid: 'u' }), closingFreeze: false, hostSitPending: false,
  closeResultDismissedFor: null, closeResultShownFor: null, roomId: null, room: null,
  tearDownRoom() {}, lobbyClosedSynced: new Set(),
  paintEnterShell() { events.push('paint'); }, getLastRoom: () => ({ name: '牌桌' }),
  lastKnownSelfTableChips: 0, pendingCloseReturnChips: null, closeResultChipsShown: 0,
  });
  vm.runInContext(body + '\n}', context);
  void context.enterRoom('r');
  assert.deepEqual(events.slice(0, 2), ['paint', 'read']);
});

function fixture(options = {}) {
  let room = { id: 'r', hostUid: 'h', status: 'lobby', rev: 0, name: '牌桌',
    config: { sb: 10, bb: 20, newPlayerChips: 2000, actionMs: 30000, topUpAmount: 2000 },
    members: ['h', 'b', 'c'], seatUids: ['h', '', '', '', '', ''], stacks: [2000, 0, 0, 0, 0, 0], chipTotal: 2000,
    sess: [{ uid: 'h', sessionNo: 1, buyIn: 2000, topUps: 0, topUpChips: 0, hands: 0, nightKey: '20261109' }, null, null, null, null, null],
    pub: { phase: 'lobby', handNo: 0, seats: [] } };
  let deny = false;
  const fs = { doc: (_db, ...p) => p.join('/'), collection: () => '',
    Timestamp: { now: () => 123 }, serverTimestamp: () => 'now', onSnapshot: () => () => {},
    getDoc: async path => {
      if (path === 'pokerPlayers/b') await options.beforePlayerRead?.();
      return { exists: () => true, data: () => path === 'pokerRooms/r' ? room : {
        displayName: path.split('/').at(-1), tableRoomId: 'r', inPlay: 2000, sessionNo: 1,
      } };
    },
    updateDoc: async (path, patch) => {
      if (deny && patch.lastMoneyEvent) throw Object.assign(Error('denied'), { code: 'permission-denied' });
      if (path === 'pokerRooms/r') {
        assert.equal(patch.rev, room.rev + 1, 'rev 必須依最新已寫入文件遞增');
        room = { ...room, ...patch };
      }
    }, setDoc: async () => {},
  };
  const loop = createHostLoop({ db: {}, fs }, { roomId: 'r', uid: 'h', getRoom: () => room, stats: { enabled: false } });
  loop.start();
  return { loop, room: () => room, deny: value => { deny = value; } };
}

test('座位寫入被拒時還原引擎，重試後可收桌', async () => {
  const f = fixture();
  try {
    f.deny(true);
    await assert.rejects(f.loop.seatPlayer(1, 'b'), /denied/);
    assert.equal(f.loop.getEngine().seats[1], null);
    f.deny(false);
    await f.loop.seatPlayer(1, 'b');
    assert.equal((await f.loop.prepareClose()).chipTotal, 4000);
  } finally { f.loop.stop(); }
});

test('第二、第三人同時入座須保留兩人的座位與 6000 籌碼', async () => {
  const f = fixture();
  try {
    await Promise.all([f.loop.seatPlayer(1, 'b'), f.loop.seatPlayer(2, 'c')]);
    assert.deepEqual(f.room().seatUids, ['h', 'b', 'c', '', '', '']);
    assert.equal(f.room().chipTotal, 6000);
    assert.equal((await f.loop.prepareClose()).chipTotal, 6000);
  } finally { f.loop.stop(); }
});

test('滿桌停用加入，沒有觀戰入口', () => {
  const html = openRowHtml({ id: 'r', name: '桌', seated: 6, code: '930' });
  assert.doesNotMatch(html, /觀戰/);
  assert.match(html, /disabled/);
  assert.doesNotMatch(source, /你正在觀戰|　觀戰 |textContent = '觀戰'/);
});


test('closeAll：仍佔座但帳戶已解除綁定時，提交前明確拒絕，不能漏寫必須的帳本', async () => {
  let commits = 0;
  const room = { hostUid: 'h', status: 'lobby', rev: 1, pub: { phase: 'lobby' },
    seatUids: ['h', 'b', '', '', '', ''], stacks: [2000, 2000, 0, 0, 0, 0],
    sess: [0, 1].map(() => ({ sessionNo: 1, nightKey: '20261109' })) };
  const fs = { doc: (_db, ...p) => p.join('/'), serverTimestamp: () => 'now',
    getDoc: async () => ({ exists: () => true, data: () => ({ tableRoomId: null }) }),
    writeBatch: () => ({ update() {}, set() {}, commit: async () => { commits++; } }),
  };
  await assert.rejects(hostCloseAllBatch({ db: {}, fs }, { hostUid: 'h', roomId: 'r', room }), /玩家帳戶與座位帳不同步/);
  assert.equal(commits, 0);
});

test('滿桌不能用房號或直接 roomId 進入觀戰；在座者仍可重連', async () => {
  const { joinByCode, joinByRoomId } = await import('../js/net/room.js');
  const room = { status: 'lobby', members: ['a'], seatUids: ['a', 'b', 'c', 'd', 'e', 'f'], code: '930' };
  let writes = 0;
  const fb = { db: {}, fs: {
    doc: (_db, ...p) => p.join('/'),
    getDoc: async path => ({ exists: () => true, data: () => path.startsWith('pokerCodes')
      ? { roomId: 'r', expiresAt: { toMillis: () => Date.now() + 60000 } } : room }),
    updateDoc: async () => { writes++; }, arrayUnion: x => x,
  } };
  for (const join of [() => joinByCode(fb, '930', 'new'), () => joinByRoomId(fb, 'r', 'new')]) {
    assert.match((await join()).error || '', /已滿/);
  }
  assert.equal(writes, 0);
  assert.equal((await joinByRoomId(fb, 'r', 'a')).error, undefined);
});

test('兩人各 2000、零手數：closeAll 批次保留 pub/lobby，送出七文件與兩筆零輸贏', async () => {
  const writes = [];
  const room = { hostUid: 'h', status: 'lobby', rev: 2, pub: { phase: 'lobby', handNo: 0 },
    seatUids: ['h', 'b', '', '', '', ''], stacks: [2000, 2000, 0, 0, 0, 0],
    sess: ['h', 'b', null, null, null, null].map(uid => uid ? {
      uid, sessionNo: 1, buyIn: 2000, topUps: 0, topUpChips: 0, hands: 0, nightKey: '20261109',
    } : null) };
  const fs = { doc: (_db, ...p) => p.join('/'), serverTimestamp: () => 'now',
    getDoc: async path => ({ exists: () => !path.includes('/nights/'), data: () => ({
      bank: 0, tableRoomId: 'r', sessionNo: 1, topUps: 0, topUpChips: 0, handsPlayed: 0,
    }) }),
    writeBatch: () => ({ update: (path, data) => writes.push({ path, data }),
      set: (path, data) => writes.push({ path, data }), commit: async () => {} }),
  };
  await hostCloseAllBatch({ db: {}, fs }, { hostUid: 'h', roomId: 'r', room });
  assert.equal(writes.length, 7);
  assert.deepEqual(writes[0].data.lastMoneyEvent, { type: 'closeAll' });
  assert.equal(writes[0].data.pub, undefined); assert.equal(writes[0].data.lobby, undefined);
  for (const row of writes.filter(row => row.path.includes('/ledger/'))) {
    assert.equal(row.data.amount, 2000); assert.equal(row.data.hands, 0);
    assert.equal(row.data.bankAfter, 2000); assert.equal(row.data.by, 'h');
  }
  for (const row of writes.filter(row => row.path.includes('/nights/'))) {
    assert.equal(row.data.net, 0); assert.equal(row.data.hands, 0);
  }
});


test('收桌開始後，已在等待帳戶讀取的 SIT 不得插入結算中', async () => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const reading = new Promise(resolve => { entered = resolve; });
  const f = fixture({ beforePlayerRead: () => { entered(); return gate; } });
  try {
    const sit = f.loop.seatPlayer(1, 'b');
    await reading;
    const close = f.loop.prepareClose();
    release(); await sit;
    assert.equal((await close).chipTotal, 2000);
    assert.equal(f.room().seatUids[1], '');
  } finally { release(); f.loop.stop(); }
});
