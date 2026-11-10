import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { readSelfCashoutAmount } from '../js/net/ledger.js';

const app = readFileSync(new URL('../js/ui/mp-app.js', import.meta.url), 'utf8');

test('cashout 讀取本人、房間與 session 文件；缺值或失敗回 null', async () => {
  for (const amount of [2010, 1990, 0, '2010', NaN, undefined]) {
    const fb = { db: {}, fs: {
      doc: (_db, ...parts) => parts.join('/'),
      getDoc: async (path) => {
        assert.equal(path, 'pokerPlayers/guest/ledger/room_7_cashout');
        return { exists: () => true, data: () => ({ amount }) };
      },
    } };
    assert.equal(await readSelfCashoutAmount(fb, 'guest', 'room', 7),
      typeof amount === 'number' && Number.isFinite(amount) ? amount : null);
  }
  for (const getDoc of [async () => ({ exists: () => false }), async () => { throw Error('denied'); }]) {
    assert.equal(await readSelfCashoutAmount({ fs: { doc: () => '', getDoc } }, 'g', 'r', 1), null);
  }
  assert.equal(await readSelfCashoutAmount({}, 'g', 'r', null), null);
});

test('座位籌碼 2010 不會被 closed 快照的舊 inPlay 2000 覆寫', () => {
  const track = app.slice(app.indexOf('      // Track self stack'), app.indexOf("      if (r.status === 'closed')"));
  const ctx = vm.createContext({ getUser: () => ({ uid: 'g' }), id: 'r',
    playerDoc: { tableRoomId: 'r', inPlay: 2000 },
    lastKnownSelfTableChips: 0, lastKnownSelfTableChipsRoomId: null, lastKnownSelfSessionNo: null,
    r: { seatUids: ['g'], stacks: [2010], sess: [{ sessionNo: 7 }] } });
  vm.runInContext(track, ctx);
  ctx.r = { status: 'closed', seatUids: [], stacks: [] };
  vm.runInContext(track, ctx);
  assert.equal(ctx.lastKnownSelfTableChips, 2010);
  assert.equal(ctx.lastKnownSelfSessionNo, 7);
  ctx.id = 'other';
  ctx.playerDoc.tableRoomId = 'other';
  vm.runInContext(track, ctx);
  assert.equal(ctx.lastKnownSelfTableChips, 2000);
  assert.match(app, /lastKnownSelfTableChips = 0;\s*lastKnownSelfTableChipsRoomId = null;\s*lastKnownSelfSessionNo = null/);
  assert.match(app, /function tearDownRoom\(\) \{\s*lastKnownSelfTableChipsRoomId = null;\s*lastKnownSelfSessionNo = null/);
});

test('closed 結果優先用 ledger，保留靜默結帳與 pending／settled／lastKnown 備援', async () => {
  const start = app.indexOf('        const cashoutSessionNo =');
  const closed = app.slice(start, app.indexOf('        pendingCloseReturnChips = null;', start));
  for (const [ledger, pending, settled, lastKnown, expected] of [
    [2010, 2000, 2000, 2000, 2010], [null, 1990, 0, 2000, 1990],
    [null, null, 2010, 2000, 2010], [null, null, 0, 2010, 2010],
    [0, null, 0, 2010, 2010],
  ]) {
    let calls = 0;
    const ctx = vm.createContext({ lastKnownSelfSessionNo: 7, playerDoc: { sessionNo: 8, tableRoomId: 'r' },
      fb: {}, user: { uid: 'g' }, id: 'r', auto: false,
      readSelfCashoutAmount: async (_fb, _uid, _id, sessionNo) => { assert.equal(sessionNo, 7); return ledger; },
      pendingCloseReturnChips: pending, lastKnownSelfTableChips: lastKnown,
      getFirebase: () => ({}), getUser: () => ({ uid: 'g' }),
      getPlayer: async () => ({ tableRoomId: settled ? 'r' : null }),
      silentlySettleClosedBinding: async () => { calls++; return settled; },
      showCloseResultCard: ({ chips }) => assert.equal(chips, expected),
    });
    await vm.runInContext(`(async () => {${closed}})()`, ctx);
    assert.equal(calls, 1);
  }
  assert.match(closed, /lastKnownSelfSessionNo \?\? playerDoc\?\.sessionNo/);
});
