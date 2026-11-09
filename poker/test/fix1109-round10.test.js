import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { settleClosedRoomBinding } from '../js/net/ledger.js';

const app = readFileSync(new URL('../js/ui/mp-app.js', import.meta.url), 'utf8');
const section = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));

test('清單進桌同步回饋；過期關桌走開桌流程，新鮮牌桌維持加入且防重複點擊', async () => {
  for (const closed of [true, false]) {
    const calls = [];
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const row = { setAttribute: () => calls.push('busy'), querySelector: () => ({ textContent: '' }) };
    const ctx = vm.createContext({
      getFirebase: () => ({}), getUser: () => ({ uid: 'visitor' }), openJoinBusy: false,
      toast: () => calls.push('toast'), $: () => ({ querySelector: () => row }), CSS: { escape: s => s },
      openTables: [{ id: 'old' }], screen: 'lobby', playerDoc: null,
      silentlySettleClosedBinding: async () => {}, getPlayer: async () => null,
      maybeAutoCloseSingleTable: async (_fb, rid, uid) => {
        assert.equal(rid, 'old'); assert.equal(uid, 'visitor'); calls.push('check'); return pending;
      },
      onCreateTable: async () => {
        calls.push('create');
        await Promise.resolve();
        assert.equal(ctx.openJoinBusy, false, '開桌查詢後仍可加入競態中新建的牌桌');
      },
      joinByRoomId: async () => { calls.push('join'); return { room: {config:{bb:20,newPlayerChips:2000}} }; },
      assertMinimumBuyin: (amount, bb) => { assert.ok(amount >= 50 * bb); },
      enterRoom: async () => { calls.push('enter'); },
      friendlyError: e => { throw e; }, paint: () => {},
    });
    vm.runInContext(section('async function enterOpenTable(', 'function lobbyBindKey('), ctx);
    const entering = ctx.enterOpenTable('old');
    assert.deepEqual(calls, ['toast', 'busy']);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['toast', 'busy', 'check']);
    assert.equal(row.disabled, true);
    await ctx.enterOpenTable('old');
    assert.equal(calls.length, 3);
    finish(closed); await entering;
    assert.deepEqual(calls.slice(3), closed ? ['create'] : ['join', 'enter']);
    assert.equal(ctx.openJoinBusy, false);
    assert.equal(ctx.openTables.length, closed ? 0 : 1);
  }
});

test('房主重新登入先靜默結算已被關閉的房間，回大廳且不重複退籌碼', async () => {
  const docs = new Map([
    ['pokerPlayers/host', { bank: 300, inPlay: 2000, total: 2300, tableRoomId: 'old', hostRoomId: 'old',
      topUps: 0, topUpChips: 0, handsPlayed: 0 }],
    ['pokerRooms/old', { status: 'closed', closedBy: 'auto', seatUids: ['host'], stacks: [2000],
      sess: [{ sessionNo: 1, buyIn: 2000, topUps: 0, topUpChips: 0, hands: 0, nightKey: '20261109' }] }],
  ]);
  let commits = 0, authHandler, paints = 0;
  const fs = {
    doc: (_db, ...p) => p.join('/'), serverTimestamp: () => 1,
    getDoc: async ref => ({ exists: () => docs.has(ref), data: () => docs.get(ref) }),
    deleteDoc: async ref => { docs.delete(ref); },
    updateDoc: async (ref, patch) => { docs.set(ref, { ...docs.get(ref), ...patch }); },
    writeBatch: () => {
      const writes = [];
      return {
        set: (ref, data) => writes.push([ref, data]),
        update: (ref, patch) => writes.push([ref, { ...docs.get(ref), ...patch }]),
        commit: async () => { commits++; for (const [ref, data] of writes) docs.set(ref, data); },
      };
    },
  };
  const fb = { db: {}, fs };
  const ctx = vm.createContext({
    console, getFirebase: () => fb, getUser: () => ({ uid: 'host' }),
    getPlayer: async () => docs.get('pokerPlayers/host'), settleClosedRoomBinding,
    playerDoc: null, rescueReason: null, rescueOk: false, rescueChips: null,
    authState: { user: null }, hostLoop: null, leaderPreview: [], fetchLeaderboard: async () => [],
    onUser: fn => { authHandler = fn; }, screen: 'auth', deepRoom: null,
    paint: () => {
      paints++;
      assert.equal(ctx.screen, 'lobby');
      assert.equal(ctx.playerDoc.tableRoomId, null);
      assert.equal(ctx.playerDoc.hostRoomId, null);
    },
  });
  vm.runInContext(section('async function silentlySettleClosedBinding()', '/** @deprecated'), ctx);
  vm.runInContext(section('  onUser(async (ev) => {', '  // takeover poll'), ctx);
  await authHandler({ status: 'signed-in', user: { uid: 'host' } });
  assert.equal(paints, 1);
  assert.equal(ctx.playerDoc.bank, 2300);
  assert.equal(ctx.playerDoc.inPlay, 0);
  assert.equal(commits, 1);
  assert.equal(docs.get('pokerPlayers/host/ledger/old_1_cashout').amount, 2000);
  await authHandler({ status: 'signed-in', user: { uid: 'host' } });
  assert.equal(ctx.playerDoc.bank, 2300);
  assert.equal(commits, 1);
});
