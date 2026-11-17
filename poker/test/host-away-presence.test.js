// 重現：多人桌只要有人送心跳，房主就把所有人的在線時間一起刷新，沒人會被自動標暫離（host.js presence 監聽）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHostLoop } from '../js/net/host.js';

test('只有自己沒心跳超過 60 秒的玩家被標暫離；別人的心跳不能刷新他的在線時間', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  const previous = globalThis.document;
  globalThis.document = { visibilityState: 'visible' };
  const room = { id: 'r', hostUid: 'h', status: 'lobby', rev: 3, members: ['h', 'a', 'b'],
    config: { sb: 10, bb: 20 }, seatUids: ['h', 'a', 'b', '', '', ''],
    stacks: [500, 500, 500, 0, 0, 0], chipTotal: 1500,
    sess: [{ uid: 'h', sessionNo: 1, topUps: 0, topUpChips: 0 }, { uid: 'a', sessionNo: 1, topUps: 0, topUpChips: 0 },
      { uid: 'b', sessionNo: 1, topUps: 0, topUpChips: 0 }, null, null, null],
    pub: { phase: 'lobby', handNo: 0 } };
  const listeners = new Map();
  const writes = [];
  const fs = { doc: (_, ...p) => p.join('/'), collection: (_, ...p) => p.join('/'),
    serverTimestamp: () => 1, onSnapshot: (ref, cb) => { listeners.set(ref, cb); return () => listeners.delete(ref); },
    getDoc: async () => ({ exists: () => false, data: () => null }), setDoc: async () => {},
    updateDoc: async (_ref, patch) => { writes.push(patch); if (patch.rev) room.rev = patch.rev; },
    writeBatch: () => ({ set() {}, commit: async () => {} }), runTransaction: async () => ({}) };
  const loop = createHostLoop({ fs, db: {} }, { uid: 'h', roomId: 'r', getRoom: () => room, stats: { enabled: false } });
  loop.start();
  t.after(() => { loop.stop(); t.mock.timers.reset(); globalThis.document = previous; });
  const beats = { h: Date.now(), a: Date.now(), b: Date.now() };
  const deliver = () => listeners.get('pokerRooms/r/presence')?.({
    forEach: (fn) => Object.entries(beats).forEach(([id, ms]) => fn({ id, data: () => ({ beat: { toMillis: () => ms }, vis: true }) })) });
  deliver();
  // 70 秒內 h、b 每 10 秒送心跳，a 完全沒心跳
  for (let s = 0; s < 70; s++) {
    if (s % 10 === 0) { beats.h = Date.now(); beats.b = Date.now(); deliver(); }
    t.mock.timers.tick(1000);
    await Promise.resolve();
  }
  for (let i = 0; i < 20; i++) { await Promise.resolve(); t.mock.timers.tick(250); }
  const away = writes.map(w => w.pub?.away).filter(Boolean).at(-1) || {};
  assert.equal(!!away[1], true, `a（座位 1）應被標暫離，實際 away=${JSON.stringify(away)}`);
  assert.equal(!!away[2], false, 'b 有心跳，不應暫離');
});
