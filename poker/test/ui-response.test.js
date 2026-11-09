import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { webcrypto } from 'node:crypto';
import * as net from '../js/net/room.js';
import { renderMpLobby } from '../js/ui/lobby.js';
globalThis.crypto ||= webcrypto;
const app = readFileSync(new URL('../js/ui/mp-app.js', import.meta.url), 'utf8');
function section(start, end) { return app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start))); }
function fakeFirebase(delay = 0) {
  const docs = new Map([['pokerPlayers/u', { bank: 2000, inPlay: 0, total: 2000, sessionNo: 0, tableRoomId: null, hostRoomId: null }]]);
  const calls = [];
  const snapshotErrors = [];
  const snap = ref => ({ id: ref.split('/').at(-1), exists: () => docs.has(ref), data: () => structuredClone(docs.get(ref)) });
  async function trip(kind, fn) {
    calls.push(kind);
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    return fn();
  }
  const write = (ref, value) => {
    const patch = { ...value };
    if (patch.members?.union) patch.members = [...new Set([...(docs.get(ref)?.members || []), ...patch.members.union])];
    docs.set(ref, { ...docs.get(ref), ...patch });
  };
  const fs = {
    collection: (_db, ...path) => path.join('/'), query: (...args) => args,
    where: () => null, orderBy: () => null, limit: () => null,
    getDocs: () => trip('getDocs', () => ({ forEach: cb => {
      for (const [ref, data] of docs) if (ref.startsWith('pokerLobby/') && data.status !== 'closed') cb(snap(ref));
    } })),
    doc: (_db, ...path) => path.join('/'), serverTimestamp: () => 1,
    Timestamp: { fromMillis: n => ({ toMillis: () => n }), now: () => 1 },
    arrayUnion: (...union) => ({ union }),
    deleteDoc: ref => trip('deleteDoc', () => docs.delete(ref)),
    getDoc: ref => trip('getDoc', () => snap(ref)),
    updateDoc: (ref, value) => trip('updateDoc', () => write(ref, value)),
    setDoc: (ref, value) => trip('setDoc', () => write(ref, value)),
    runTransaction: (_db, fn) => trip('runTransaction', async () => {
      const writes = [];
      const result = await fn({ get: async ref => snap(ref), set: (r, v) => writes.push([r, v]), update: (r, v) => writes.push([r, v]) });
      for (const [r, v] of writes) write(r, v);
      return result;
    }),
    writeBatch: () => {
      const writes = [];
      return { set: (r, v) => writes.push([r, v]), update: (r, v) => writes.push([r, v]), commit: () => trip('batch.commit', () => writes.forEach(([r, v]) => write(r, v))) };
    },
    onSnapshot: (ref, cb, onErr) => {
      const error = snapshotErrors.shift();
      pending = trip('onSnapshot:first', () => error ? onErr(error) : cb(snap(ref)));
      return () => {};
    },
  };
  let pending;
  return { db: {}, fs, docs, calls, snapshotErrors, settle: () => pending };
}

const opts = { uid: 'u', name: '牌桌', displayName: '玩家', sb: 10, bb: 20, newPlayerChips: 2000 };
for (const exists of [false, true]) test(`開新牌桌立即回饋：${exists ? '已有牌桌' : '尚無牌桌'}`, async t => {
  const fb = fakeFirebase();
  if (exists) await net.createRoom(fb, opts);
  const original = fb.fs.getDocs;
  let completed = 0;
  fb.fs.getDocs = async (...args) => { await new Promise(r => setTimeout(r, 300)); completed++; return original(...args); };
  let feedback, entered, paints = 0;
  const start = performance.now();
  const ctx = vm.createContext({ ...net, getFirebase: () => fb, getUser: () => ({ uid: 'u' }),
    playerDoc: {}, rescueOk: false, screen: 'lobby',
    toast: () => { feedback ??= performance.now() - start; },
    paint: () => { paints++; }, friendlyError: e => String(e),
    enterOpenTable: async id => { entered = await net.joinByRoomId(fb, id, 'u'); },
  });
  vm.runInContext(section('async function onCreateTable()', '\nasync function doCreate('), ctx);
  const pending = ctx.onCreateTable();
  assert.equal(completed, 0);
  assert.ok(feedback >= 0 && feedback < 200);
  t.diagnostic(`首次回饋 ${feedback.toFixed(3)} ms；網路延遲 300 ms`);
  await pending;
  assert.equal(ctx.screen, exists ? 'lobby' : 'create');
  assert.equal(paints, exists ? 0 : 1);
  assert.equal(!!entered?.roomId, exists);
});

test('收桌確認按鈕：網路返回前同步顯示收桌中', async t => {
  const handlers = {};
  let feedback, completed = 0, pending;
  const start = performance.now();
  const button = { disabled: false, set textContent(value) { assert.equal(value, '收桌中…'); feedback = performance.now() - start; } };
  const modal = { hidden: true };
  const ctx = vm.createContext({ document: { getElementById: id => id === 'mpCloseConfirm' ? modal : button },
    $: selector => ({ addEventListener: (_event, handler) => { handlers[selector] = handler; } }),
    getFirebase: () => ({}), room: {}, closingFreeze: false,
    startHostClose: () => { pending = new Promise(r => setTimeout(() => { completed++; r(); }, 300)); return pending; },
  });
  vm.runInContext(section('function showCloseRoomConfirm(', '\nexport function mpCloseRoom()') + app.slice(app.indexOf('function doCloseRoom()')), ctx);
  ctx.showCloseRoomConfirm(() => ctx.doCloseRoom());
  handlers['#mpCloseConfirmOk']();
  assert.equal(completed, 0);
  assert.equal(button.disabled, true);
  assert.equal(ctx.closingFreeze, true);
  assert.ok(feedback >= 0 && feedback < 200);
  t.diagnostic(`首次回饋 ${feedback.toFixed(3)} ms；網路延遲 300 ms`);
  await pending;
});

test('單桌：無桌建立；已有桌加入成員、不再建立，沿用選位提示', async () => {
  const fb = fakeFirebase();
  const first = await net.createSingleTable(fb, opts);
  assert.ok(first.roomId);
  const second = await net.createSingleTable(fb, { ...opts, uid: 'v' });
  assert.equal(second.roomId, first.roomId);
  assert.equal(second.existing, true);
  assert.ok(fb.docs.get(`pokerRooms/${first.roomId}`).members.includes('v'));
  assert.equal([...fb.docs.keys()].filter(k => k.startsWith('pokerRooms/')).length, 1);
  assert.match(app, /請選位子，點牌桌上的空位入座/);
});

test('同時開桌：兩筆建立後查詢收斂到同桌，多開空桌關閉（非嚴格唯一保證）', async () => {
  const fb = fakeFirebase(2);
  const result = await Promise.all([net.createSingleTable(fb, opts), net.createSingleTable(fb, { ...opts, uid: 'v' })]);
  assert.equal(result[0].roomId, result[1].roomId);
  const open = [...fb.docs.entries()].filter(([k, v]) => k.startsWith('pokerRooms/') && v.status !== 'closed');
  assert.equal(open.length, 1);
});

test('大廳實際 HTML：沒有房號輸入；已有桌僅一個清單入口', () => {
  const root = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  globalThis.window = {}; globalThis.document = { addEventListener() {}, removeEventListener() {} };
  try {
    renderMpLobby(root, { user: { displayName: '玩家' }, player: {}, openTables: [
      { id: 'a', name: '牌桌', seated: 0 }, { id: 'b', name: '另一桌', seated: 0 },
    ] });
    assert.doesNotMatch(root.innerHTML, /mpJoinCode|name="roomcode"|輸入房號加入|data-act="create"/);
    assert.equal((root.innerHTML.match(/class="mp-row[ "]/g) || []).length, 1);
  } finally { globalThis.window = previousWindow; globalThis.document = previousDocument; }
});
