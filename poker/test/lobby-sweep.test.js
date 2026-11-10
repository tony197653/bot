import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sweepStaleTable, isLobbyRoomSuppressed, _resetLobbyClosedSuppress } from '../js/net/room.js';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const now = 2_000_000;
const stamp = n => ({ toMillis: () => n });
function fixture({ fresh = false, denied = false, code = '000', beat = 1 } = {}) {
  let room = { code, status: 'lobby', hostUid: 'host', members: ['host'],
    seatUids: ['host', ''], stacks: [2000, 0], pub: { phase: 'lobby' }, updatedAt: stamp(fresh ? now : 1) };
  const writes = [], reads = [];
  const fs = {
    doc: (_db, ...parts) => parts.join('/'), collection: (_db, ...parts) => parts.join('/'),
    arrayUnion: uid => [...room.members, uid], serverTimestamp: () => now,
    getDoc: async path => { reads.push(path); return { exists: () => path === 'pokerRooms/r', data: () => room }; },
    getDocs: async () => ({ docs: [{ id: 'host', data: () => ({ beat: stamp(beat) }) }] }),
    updateDoc: async (path, patch) => {
      if (denied) throw new Error('permission-denied');
      writes.push({ path, patch });
      if (path === 'pokerRooms/r') room = { ...room, ...patch };
    },
    deleteDoc: async path => writes.push({ path, deleted: true }),
  };
  return { fb: { db: {}, fs }, writes, reads, room: () => room };
}
const row = { id: 'r', status: 'lobby' };

test('過期獨坐桌：非房主關桌，立即隱藏，籌碼不變', async () => {
  _resetLobbyClosedSuppress();
  const f = fixture();
  let release, closing;
  const blocked = new Promise(resolve => { release = resolve; });
  const update = f.fb.fs.updateDoc;
  f.fb.fs.updateDoc = async (path, patch) => {
    if (patch.closedBy) {
      assert.equal(isLobbyRoomSuppressed('r'), true);
      closing = true;
      await blocked;
    }
    return update(path, patch);
  };
  let paints = 0;
  const pending = sweepStaleTable(f.fb, row, 'guest', now, () => paints++);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closing, true);
  assert.equal(paints, 1);
  release();
  assert.equal(await pending, true);
  assert.equal(f.room().status, 'closed');
  assert.equal(f.room().closedBy, 'auto');
  assert.deepEqual(f.room().stacks, [2000, 0]);
  assert.ok(f.writes.some(w => w.path === 'pokerLobby/r' && w.deleted));
  assert.ok(f.writes.every(w => !w.path.startsWith('pokerPlayers/')));
});

test('新鮮牌桌與自己入座的桌不改寫', async () => {
  _resetLobbyClosedSuppress();
  const f = fixture({ fresh: true });
  assert.equal(await sweepStaleTable(f.fb, row, 'guest', now), false);
  assert.equal(isLobbyRoomSuppressed('r'), false);
  assert.deepEqual(f.writes, []);
  const seated = fixture();
  assert.equal(await sweepStaleTable(seated.fb, row, 'host', now), false);
  assert.deepEqual(seated.writes, []);
});

test('權限失敗保留清單；關桌寫入失敗會恢復暫時隱藏的列', async () => {
  for (const closeOnly of [false, true]) {
    _resetLobbyClosedSuppress();
    const f = fixture({ denied: !closeOnly });
    if (closeOnly) {
      const update = f.fb.fs.updateDoc;
      f.fb.fs.updateDoc = (path, patch) => patch.closedBy
        ? Promise.reject(new Error('permission-denied')) : update(path, patch);
    }
    const visibility = [];
    assert.equal(await sweepStaleTable(f.fb, row, 'guest', now,
      () => visibility.push(isLobbyRoomSuppressed('r'))), false);
    assert.equal(isLobbyRoomSuppressed('r'), false);
    assert.deepEqual(visibility, closeOnly ? [true, false] : []);
  }
});

test('同桌不重複巡查：執行中與 30 秒內不重讀，時間到可再檢查', async () => {
  _resetLobbyClosedSuppress();
  const f = fixture({ fresh: true });
  let release;
  const get = f.fb.fs.getDoc;
  f.fb.fs.getDoc = async path => { await new Promise(resolve => { release = resolve; }); return get(path); };
  const pending = sweepStaleTable(f.fb, row, 'guest', now);
  assert.equal(await sweepStaleTable({ ...f.fb }, row, 'guest', now + 30_000), false);
  release(); await pending;
  f.fb.fs.getDoc = get;
  assert.equal(await sweepStaleTable({ ...f.fb }, row, 'guest', now + 29_999), false);
  assert.equal(f.reads.length, 1);
  await sweepStaleTable({ ...f.fb }, row, 'guest', now + 30_000);
  assert.equal(f.reads.length, 2);
});

test('一般桌沿用 idle 心跳條件；已關閉桌立即隱藏', async () => {
  for (const beat of [1, now]) {
    _resetLobbyClosedSuppress();
    const f = fixture({ code: '123', beat });
    assert.equal(await sweepStaleTable(f.fb, row, 'guest', now), beat === 1);
  }
  _resetLobbyClosedSuppress();
  const f = fixture();
  f.room().status = 'closed';
  assert.equal(await sweepStaleTable(f.fb, row, 'guest', now), true);
  assert.equal(isLobbyRoomSuppressed('r'), true);
  assert.deepEqual(f.writes, []);
});

test('emulator staleMs 覆寫用於大廳巡查', async () => {
  const previous = globalThis.location;
  try {
    globalThis.location = { hostname: 'localhost', search: '?emu=1&staleMs=8000' };
    _resetLobbyClosedSuppress();
    const f = fixture();
    assert.equal(await sweepStaleTable(f.fb, row, 'guest', 10_000), true);
  } finally { globalThis.location = previous; }
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
