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
  startRoomSound() {}, tearDownRoom() {}, lobbyClosedSynced: new Set(),
  paintEnterShell() { events.push('paint'); }, getLastRoom: () => ({ name: '牌桌' }),
  lastKnownSelfTableChips: 0, pendingCloseReturnChips: null, closeResultChipsShown: 0,
  });
  context.listenRoom = () => { events.push('subscribe'); return null; };
  vm.runInContext(body + '\n stopRoom = listenRoom();\n}', context);
  void context.enterRoom('r');
  assert.deepEqual(events.slice(0, 2), ['paint', 'subscribe']);
});

function fixture(options = {}) {
  let room = { id: 'r', hostUid: 'h', status: 'lobby', rev: 0, name: '牌桌',
    config: { sb: 10, bb: 20, newPlayerChips: 2000, actionMs: 30000, topUpAmount: 2000 },
    members: ['h', 'b', 'c', 'd'], seatUids: ['h', '', '', '', '', ''], stacks: [2000, 0, 0, 0, 0, 0], chipTotal: 2000,
    sess: [{ uid: 'h', sessionNo: 1, buyIn: 2000, topUps: 0, topUpChips: 0, hands: 0, nightKey: '20261109' }, null, null, null, null, null],
    pub: { phase: 'lobby', handNo: 0, seats: [] } };
  let deny = false;
  const fs = { doc: (_db, ...p) => p.join('/'), collection: (_db, ...p) => p.join('/'),
    Timestamp: { now: () => 123 }, serverTimestamp: () => 'now', onSnapshot: (ref, cb) => { options.onSnapshot?.(ref, cb); return () => {}; },
    getDoc: async path => {
      if (path === 'pokerPlayers/b') await options.beforePlayerRead?.();
      return { exists: () => true, data: () => path === 'pokerRooms/r' ? room : {
        displayName: path.split('/').at(-1), tableRoomId: 'r', inPlay: 2000, sessionNo: 1,
      } };
    },
    writeBatch: () => ({ set() {}, commit: async () => {} }),
    updateDoc: async (path, patch) => {
      if (deny && patch.lastMoneyEvent) throw Object.assign(Error('denied'), { code: 'permission-denied' });
      if (path === 'pokerRooms/r') {
        await options.beforeRoomWrite?.(patch, room);
        assert.equal(patch.rev, room.rev + 1, 'rev 必須依最新已寫入文件遞增');
        room = { ...room, ...patch };
      }
    }, setDoc: async () => {},
    writeBatch: () => ({ set() {}, commit: async () => {} }),
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

// 真 host queueWrite：觀察實際送出的 patch，驗證 stacks 存檔點與結算同步時機。
test('host stacks：進行中不變，foldWin 同筆 hand_over 同步 chips；hands+1 在下一筆、開下一手前', async () => {
  const priorDocument = globalThis.document;
  globalThis.document = { visibilityState: 'visible' };
  const f = fixture();
  const waitFor = async predicate => {
    for (let i = 0; i < 150; i++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('等待 host 寫入逾時');
  };
  try {
    await f.loop.seatPlayer(1, 'b');
    assert.equal(f.loop.startHand(), true);
    await waitFor(() => f.room().pub.phase === 'preflop');
    assert.deepEqual(f.room().stacks, [2000, 2000, 0, 0, 0, 0]);
    assert.notDeepEqual(f.room().stacks, f.loop.getEngine().seats.map(p => p?.chips ?? 0));
    f.loop.hostAction({ type: 'FOLD', seat: f.loop.getEngine().actor });
    await waitFor(() => f.room().pub.phase === 'hand_over');
    const engine = f.loop.getEngine();
    assert.deepEqual(f.room().stacks, engine.seats.map(p => p?.chips ?? 0));
    // 規則：結算那筆不能動 sess；hands+1 等房間已存成 hand_over 後的下一筆
    assert.deepEqual(f.room().sess.filter(Boolean).map(p => p.hands), [0, 0]);
    for (let i = 0; i < 2; i++) {
      const p = f.room().pub.seats[i];
      assert.equal(p.chips, f.room().stacks[i]);
      assert.ok(p.contributed >= 0 && p.contributed <= 2000);
      assert.ok(p.chips >= 2000 - p.contributed);
      if (p.folded) assert.equal(p.chips, 2000 - p.contributed);
    }
    // HAND_OVER 重送不再改 stacks，也不重複增加 hands。
    const rev = f.room().rev;
    f.loop.hostAction({ type: 'ACK_HAND' });
    await waitFor(() => f.room().rev > rev);
    assert.deepEqual(f.room().stacks, engine.seats.map(p => p?.chips ?? 0));
    assert.deepEqual(f.room().sess.filter(Boolean).map(p => p.hands), [1, 1]);
  } finally { f.loop.stop(); globalThis.document = priorDocument; }
});

test('host 收到非行動者 LEAVE 即刻蓋牌，後續行動跳過離桌席而不等 timeout', async () => {
  let intentSnapshot;
  const f = fixture({ onSnapshot: (ref, cb) => { if (ref.endsWith('/intents')) intentSnapshot = cb; } });
  try {
    await f.loop.seatPlayer(1, 'b');
    await f.loop.seatPlayer(2, 'c');
    assert.equal(f.loop.startHand(), true);
    const before = f.loop.getEngine();
    const seat = before.seats.findIndex(p => p && p.seat !== before.actor && p.bet > 0);
    const leaver = f.room().seatUids[seat];
    const contributed = before.seats[seat].contributed;
    intentSnapshot({ docChanges: () => [{ type: 'modified', doc: { id: leaver, data: () => ({ type: 'LEAVE', seq: 1 }) } }] });
    const after = f.loop.getEngine();
    assert.equal(after.seats[seat].folded, true, 'intent callback 返回前已蓋牌');
    assert.equal(after.seats[seat].contributed, contributed);
    assert.equal(after.actor, before.actor);
    assert.equal(after.deadline, before.deadline);
    // 不推進時間、不送 TIMEOUT，直接完成其餘玩家四個 street。
    for (let n = 0; n < 20; n++) {
      const state = f.loop.getEngine();
      if (!['preflop', 'flop', 'turn', 'river'].includes(state.phase)) break;
      assert.notEqual(state.actor, seat, '不能等待離桌者行動');
      const p = state.seats[state.actor];
      f.loop.hostAction({ type: p.bet < state.currentBet ? 'CALL' : 'CHECK', seat: state.actor });
    }
    assert.ok(['showdown', 'hand_over'].includes(f.loop.getEngine().phase));
  } finally { f.loop.stop(); }
});


test('host 手數：四人連續三手各加一次，拒絕後重試成功才開下一手', async () => {
  const priorDocument = globalThis.document;
  globalThis.document = { visibilityState: 'visible' };
  const bumps = [];
  let denied = 0;
  let release, entered;
  const blocked = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({
    onSnapshot(ref, cb) {
      if (ref.endsWith('/presence')) cb({ forEach: fn => ['h', 'b', 'c', 'd'].forEach(id =>
        fn({ id, data: () => ({ beat: { toMillis: () => Date.now() }, vis: true }) })) });
    },
    async beforeRoomWrite(patch, room) {
      if (!patch.sess || patch.sess[0].hands === room.sess[0].hands) return;
      assert.deepEqual(Object.keys(patch).sort(), ['rev', 'sess', 'updatedAt']);
      assert.equal(room.pub.phase, 'hand_over');
      if (room.pub.handNo === 2 && denied++ === 0) {
        throw Object.assign(Error('測試手數寫入遭拒'), { code: 'permission-denied' });
      }
      if (room.pub.handNo === 2 && denied === 2) {
        entered();
        await gate;
      }
      bumps.push(room.pub.handNo);
    },
  });
  const waitFor = async predicate => {
    for (let i = 0; i < 600; i++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('等待連續手數寫入逾時');
  };
  try {
    await f.loop.seatPlayer(1, 'b');
    await f.loop.seatPlayer(2, 'c');
    await f.loop.seatPlayer(3, 'd');
    assert.equal(f.loop.startHand(), true);
    for (let hand = 1; hand <= 3; hand++) {
      await waitFor(() => f.room().pub.phase === 'preflop' && f.room().pub.handNo === hand);
      while (f.loop.getEngine().phase === 'preflop') {
        f.loop.hostAction({ type: 'FOLD', seat: f.loop.getEngine().actor });
      }
      await waitFor(() => f.room().pub.phase === 'hand_over');
      if (hand === 2) {
        await Promise.race([blocked, waitFor(() => denied >= 2)]);
        assert.equal(f.loop.getEngine().handNumber, 2);
        assert.equal(f.loop.getEngine().phase, 'hand_over');
        assert.deepEqual(f.room().sess.filter(Boolean).map(p => p.hands), [1, 1, 1, 1]);
        release();
      }
      await waitFor(() => f.room().sess.filter(Boolean).every(p => p.hands === hand));
      await waitFor(() => f.room().pub.phase === 'preflop' && f.room().pub.handNo === hand + 1);
      assert.deepEqual(f.room().sess.filter(Boolean).map(p => p.hands), [hand, hand, hand, hand]);
    }
    assert.deepEqual(bumps, [1, 2, 3]);
    assert.ok(denied >= 2, '第二手必須真的重試');
  } finally { release(); f.loop.stop(); globalThis.document = priorDocument; }
});


test('手動下一手：結算後立即按，連續三手各計一次且按鈕同步停用', async () => {
  const previous = globalThis.document;
  globalThis.document = { visibilityState: 'visible' };
  const bumps = [];
  const f = fixture({ beforeRoomWrite(patch, room) {
    if (patch.sess?.[0]?.hands > room.sess[0].hands) bumps.push(room.pub.handNo);
  } });
  const context = vm.createContext({ hostLoop: f.loop, toast: message => assert.fail(message),
    friendlyError: e => e.message, paintTableChrome() {} });
  vm.runInContext(source.slice(source.indexOf('async function startHandFromButton('),
    source.indexOf('function renderActBar(')), context);
  try {
    await f.loop.seatPlayer(1, 'b');
    assert.equal(f.loop.startHand(), true);
    for (let hand = 1; hand <= 3; hand++) {
      f.loop.hostAction({ type: 'FOLD', seat: f.loop.getEngine().actor });
      assert.equal(f.loop.getEngine().phase, 'hand_over');
      const button = { disabled: false };
      const pending = context.startHandFromButton({ currentTarget: button });
      assert.equal(button.disabled, true, '等待寫入前同步停用');
      await pending;
      assert.equal(button.disabled, false);
      assert.equal(f.loop.getEngine().handNumber, hand + 1);
      assert.equal(f.loop.getEngine().phase, 'preflop');
      assert.deepEqual(f.room().sess.filter(Boolean).map(p => p.hands), [hand, hand]);
    }
    assert.deepEqual(bumps, [1, 2, 3]);
  } finally { f.loop.stop(); globalThis.document = previous; }
});


test('手動下一手：手數被拒重試一次，持續失敗顯示提示且可再次按', async () => {
  const previous = globalThis.document;
  globalThis.document = { visibilityState: 'visible' };
  let reject = true, attempts = 0;
  const f = fixture({ beforeRoomWrite(patch, room) {
    if (patch.sess?.[0]?.hands > room.sess[0].hands) {
      attempts++;
      if (reject) throw Error('測試拒絕');
    }
  } });
  const messages = [];
  const context = vm.createContext({ hostLoop: f.loop, toast: message => messages.push(message),
    friendlyError: e => e.message, paintTableChrome() {} });
  vm.runInContext(source.slice(source.indexOf('async function startHandFromButton('),
    source.indexOf('function renderActBar(')), context);
  try {
    await f.loop.seatPlayer(1, 'b');
    f.loop.startHand();
    f.loop.hostAction({ type: 'FOLD', seat: f.loop.getEngine().actor });
    const button = { disabled: false };
    await context.startHandFromButton({ currentTarget: button });
    assert.equal(attempts, 2);
    assert.equal(messages.length, 1);
    assert.equal(button.disabled, false);
    assert.equal(f.loop.getEngine().handNumber, 1);
    assert.equal(f.loop.getEngine().phase, 'hand_over');
    assert.equal(f.room().sess[0].hands, 0);
    reject = false;
    await context.startHandFromButton({ currentTarget: button });
    assert.equal(f.loop.getEngine().handNumber, 2);
    assert.equal(f.room().sess[0].hands, 1);
  } finally { f.loop.stop(); globalThis.document = previous; }
});
