import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  sweepStaleTable, pickListedOpenTables, isLobbyRoomSuppressed, _resetLobbyClosedSuppress,
} from '../js/net/room.js';

const app = readFileSync(new URL('../js/ui/mp-app.js', import.meta.url), 'utf8');
const section = (a, b) => app.slice(app.indexOf(a), app.indexOf(b, app.indexOf(a)));

// 重現：closed 房的殘留 lobby 列表（最舊）先被取成唯一一筆，巡查隱藏它之後，真桌沒有被重新選出。
test('殘留 closed 房列表被巡查隱藏後，從完整列表重選真桌並重畫', async () => {
  _resetLobbyClosedSuppress();
  const rooms = new Map([
    ['ghost', { status: 'closed', hostUid: 'gh', seatUids: [], updatedAt: { toMillis: () => 1 } }],
    ['real', { status: 'lobby', hostUid: 'rh', seatUids: ['rh'], updatedAt: { toMillis: () => Date.now() } }],
  ]);
  const fs = {
    doc: (_db, ...p) => p.join('/'),
    getDoc: async (ref) => {
      const [, id, sub] = ref.split('/');
      if (sub === 'presence') return { exists: () => true, data: () => ({ beat: { toMillis: () => Date.now() } }) };
      return { exists: () => rooms.has(id), data: () => rooms.get(id) };
    },
    runTransaction: async () => false,
  };
  const paints = [];
  let snapshot;
  const ctx = vm.createContext({
    screen: 'lobby', getUser: () => ({ uid: 'me' }), getFirebase: () => ({ db: {}, fs }),
    playerDoc: null, openTables: [], lobbySweepRows: [], lobbySweepInflight: false,
    stopOpenTables: null, lobbyExitSuppressMine: false, photoOf: () => undefined, Date,
    $: () => ({}), patchOpenTables: () => false, console,
    listenOpenTables: (_fb, cb) => { snapshot = cb; return () => {}; },
    sweepStaleTable, pickListedOpenTables, isLobbyRoomSuppressed,
    paint: () => paints.push(ctx.openTables.map((t) => t.id)),
  });
  vm.runInContext(section('function refreshOpenTables()', '\nfunction '), ctx);
  vm.runInContext(
    section('async function sweepLobbyTables()', '\nasync function enterOpenTable('), ctx);
  ctx.ensureOpenTablesListen();
  // 最舊的是殘留 ghost，真桌較新
  snapshot([
    { id: 'ghost', status: 'lobby', createdAtMs: 1 },
    { id: 'real', status: 'lobby', createdAtMs: 2 },
  ]);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(isLobbyRoomSuppressed('ghost'), true, '巡查應已隱藏殘留');
  assert.deepEqual(ctx.openTables.map((t) => t.id), ['real'], '隱藏殘留後要重新選出真桌');
  assert.ok(paints.length >= 1, '隱藏變動後要重畫');
  assert.deepEqual(paints.at(-1), ['real'], '重畫時看到的是真桌');
});

test('大廳畫面每次畫都從完整列表重選（原始碼合約）', () => {
  assert.ok(/function refreshOpenTables\(\)/.test(app), 'refreshOpenTables 存在');
  const paintSrc = app.slice(app.indexOf('function paint()'), app.indexOf('function paintEnterShell') > 0 ? app.indexOf('function paintEnterShell') : undefined);
  assert.ok(/refreshOpenTables\(\);\n\s+renderMpLobby/.test(paintSrc), '畫大廳前先重選');
});
