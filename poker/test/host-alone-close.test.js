import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOST_ALONE_CLOSE_MS, hostAloneSince, maybeAutoCloseSingleTable } from '../js/net/room.js';
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

test('離線房主：新成員只寫關閉標記；房主心跳新鮮則保留牌桌', async () => {
  for (const fresh of [false, true]) {
    let r = base();
    const writes = [];
    const now = 1000 + HOST_ALONE_CLOSE_MS + 10;
    const fs = { doc: (_d, ...p) => p.join('/'), collection: (_d, ...p) => p.join('/'),
      arrayUnion: uid => [...r.members, uid], serverTimestamp: () => now,
      getDoc: async path => ({ exists: () => path === 'pokerRooms/r', data: () => r }),
      getDocs: async () => ({ docs: [{ id: 'h', data: () => ({ beat: { toMillis: () => fresh ? now : 1000 } }) }] }),
      updateDoc: async (path, patch) => { writes.push({ path, patch }); if (path === 'pokerRooms/r') r = { ...r, ...patch }; },
      deleteDoc: async () => {} };
    assert.equal(await maybeAutoCloseSingleTable({ db: {}, fs }, 'r', 'g', now), !fresh);
    assert.equal(r.status, fresh ? 'lobby' : 'closed');
    assert.equal(r.stacks[0], 2000);
    assert.ok(writes.every(w => !w.path.startsWith('pokerPlayers/')));
    if (!fresh) assert.deepEqual(Object.keys(writes.find(w => w.patch.closedBy).patch), ['status', 'closedBy', 'closedAt']);
  }
});
