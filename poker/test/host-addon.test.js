import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHostLoop } from '../js/net/host.js';

function fixture(t, { bank = 1000, seated = true } = {}) {
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

test('HAND_OVER 的排隊在下一手前處理完成', async t => {
  const f = fixture(t);
  f.loop.getEngine().phase = 'hand_over';
  f.room.pub.phase = 'hand_over';
  f.data.get('pokerRooms/r').pub.phase = 'hand_over';
  f.enqueue();
  assert.equal(await f.loop.startHand(), false);
  await f.flush();
  assert.equal(f.loop.getEngine().seats[1].chips, 600);
  assert.equal(f.data.get('pokerRooms/r').stacks[1], 600);
  assert.equal(f.data.get('pokerPlayers/u').bank, 900);
});
