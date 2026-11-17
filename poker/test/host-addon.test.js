import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHostLoop } from '../js/net/host.js';

function fixture(t, { bank = 1000, seated = true, failAddon = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const previous = globalThis.document;
  globalThis.document = { visibilityState: 'visible' };
  const room = { id: 'r', hostUid: 'h', status: 'lobby', rev: 3, members: ['h', 'u'],
    config: { sb: 10, bb: 20 }, seatUids: ['h', seated ? 'u' : '', '', '', '', ''],
    stacks: [500, seated ? 500 : 0, 0, 0, 0, 0], chipTotal: seated ? 1000 : 500,
    sess: [{ uid: 'h', sessionNo: 1, topUps: 0, topUpChips: 0 },
      seated ? { uid: 'u', sessionNo: 2, topUps: 0, topUpChips: 0 } : null, null, null, null, null],
    pub: { phase: 'lobby', handNo: 0 } };
  // Deliberately never deliver room snapshots: the host must retain confirmed transaction state.
  const data = new Map([['pokerRooms/r', structuredClone(room)],
    ['pokerPlayers/u', { bank, inPlay: 500, tableRoomId: 'r', sessionNo: 2 }]]);
  const listeners = new Map();
  const writes = [];
  let transactions = 0;
  const snap = ref => ({ exists: () => data.has(ref), data: () => structuredClone(data.get(ref)) });
  const fs = { doc: (_, ...p) => p.join('/'), collection: (_, ...p) => p.join('/'),
    serverTimestamp: () => 1, onSnapshot: (ref, cb) => { listeners.set(ref, cb); return () => listeners.delete(ref); },
    getDoc: async ref => snap(ref), setDoc: async () => {},
    updateDoc: async (ref, patch) => { writes.push(patch); data.set(ref, { ...data.get(ref), ...patch }); },
    writeBatch: () => ({ set() {}, commit: async () => {} }),
    runTransaction: async (_, fn) => {
      transactions++;
      if (failAddon && transactions === 1) throw new Error('permission-denied');
      const pending = [];
      const result = await fn({ get: async ref => snap(ref),
        update: (ref, value) => pending.push([ref, { ...data.get(ref), ...value }]),
        set: (ref, value) => pending.push([ref, value]) });
      for (const [ref, value] of pending) data.set(ref, value);
      return result;
    } };
  const loop = createHostLoop({ fs, db: {} }, { uid: 'h', roomId: 'r',
    getRoom: () => room, stats: { enabled: false } });
  loop.start();
  t.after(() => { loop.stop(); t.mock.timers.reset(); globalThis.document = previous; });
  const enqueue = (items = [{ id: 'u_1', amount: 100 }]) => {
    const q = { items, seq: 1 };
    data.set('pokerRooms/r/addons/u', q);
    listeners.get('pokerRooms/r/addons')({ docChanges: () => [
      { type: 'added', doc: { id: 'u', data: () => q } }] });
  };
  const flush = async () => {
    for (let i = 0; i < 60; i++) { await Promise.resolve(); t.mock.timers.tick(250); }
  };
  return { loop, data, room, writes, enqueue, flush, transactions: () => transactions };
}

test('兩手之間加碼：同步引擎與房間，快照延遲仍沿用新 rev、stacks、sess', async t => {
  const f = fixture(t);
  f.enqueue(); await f.flush();
  assert.equal(f.loop.getEngine().seats[1].chips, 600);
  const room = f.data.get('pokerRooms/r');
  assert.equal(room.stacks[1], 600);
  assert.equal(room.chipTotal, 1100);
  assert.equal(room.sess[1].topUpChips, 100);
  assert.ok(room.rev >= 5);
  assert.deepEqual(f.writes.map(p => p.rev), f.writes.map((_, i) => 5 + i));
  assert.equal(f.writes[0].rev, 5);
  assert.equal(room.lastMoneyEvent.type, 'addon');
  assert.equal(f.data.get('pokerPlayers/u').bank, 900);
});

test('手中排隊不處理、不扣款', async t => {
  const f = fixture(t);
  f.loop.startHand();
  f.enqueue(); await f.flush();
  assert.equal(f.transactions(), 0);
  assert.equal(f.data.get('pokerPlayers/u').bank, 1000);
  assert.equal(f.data.get('pokerRooms/r/addons/u').items.length, 1);
});

test('已離座者排隊清空、不扣款', async t => {
  const f = fixture(t, { seated: false });
  f.enqueue(); await f.flush();
  assert.deepEqual(f.data.get('pokerRooms/r/addons/u').items, []);
  assert.equal(f.data.get('pokerPlayers/u').bank, 1000);
  assert.equal(f.data.get('pokerRooms/r').chipTotal, 500);
});

test('帳戶不足整批拒絕，發布本人提示、不改籌碼', async t => {
  const f = fixture(t, { bank: 50 });
  f.enqueue(); await f.flush();
  const room = f.data.get('pokerRooms/r');
  assert.equal(room.pub.rejects.u, '帳戶不足，沒有加碼');
  assert.equal(room.stacks[1], 500);
  assert.equal(f.loop.getEngine().seats[1].chips, 500);
  assert.equal(f.data.get('pokerPlayers/u').bank, 50);
  assert.deepEqual(f.data.get('pokerRooms/r/addons/u').items, []);
});

for (const sittingOut of [false, true]) {
  test(`HAND_OVER 排隊手動開手前上桌（暫離=${sittingOut}）`, async t => {
    const f = fixture(t);
    const engine = f.loop.getEngine();
    // 暫離案例保留兩位可參與者，確保真的開出下一手。
    if (sittingOut) {
      engine.seats[2] = { ...engine.seats[0], uid: 'v', chips: 500 };
      f.room.seatUids[2] = 'v';
      f.room.stacks[2] = 500;
      f.room.chipTotal += 500;
      Object.assign(f.data.get('pokerRooms/r'), structuredClone(f.room));
    }
    engine.seats[1].sittingOut = sittingOut;
    engine.phase = 'hand_over';
    f.room.pub.phase = 'hand_over';
    f.data.get('pokerRooms/r').pub.phase = 'hand_over';
    f.enqueue();
    assert.equal(await f.loop.startHand(), true);
    const next = f.loop.getEngine();
    assert.notEqual(next.phase, 'hand_over');
    assert.equal(next.seats[1].chips + (next.seats[1].bet || 0), 600);
    assert.equal(next.seats[1].sittingOut, sittingOut);
    assert.equal(f.data.get('pokerRooms/r').stacks[1], 600);
    assert.equal(f.data.get('pokerRooms/r').chipTotal, sittingOut ? 1600 : 1100);
    assert.equal(f.data.get('pokerPlayers/u').bank, 900);
    await f.flush();
  });
}


test('R32b 加碼 transaction 被拒仍發布本人中文提示、清除佇列且不扣款', async t => {
  const f = fixture(t, { failAddon: true });
  f.enqueue(); await f.flush();
  assert.equal(f.data.get('pokerRooms/r').pub.rejects.u, '加碼沒成功，請再試一次');
  assert.deepEqual(f.data.get('pokerRooms/r/addons/u').items, []);
  assert.equal(f.data.get('pokerPlayers/u').bank, 1000);
  assert.equal(f.loop.getEngine().seats[1].chips, 500);
});
