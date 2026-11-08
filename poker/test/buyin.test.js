import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { DEFAULT_NEW_PLAYER_CHIPS, assertMinimumBuyin, wholeBalance, buyinLabel } from '../js/net/buyin-policy.js';
import { buyinAll, ensurePlayerGrant } from '../js/net/ledger.js';

const source = readFileSync(new URL('../js/ui/mp-app.js', import.meta.url), 'utf8');
function fakeFirebase(player) {
  const writes = [];
  let commits = 0;
  const batch = {
    update: (ref, data) => writes.push({ ref, data }),
    set: (ref, data) => writes.push({ ref, data }),
    commit: async () => { commits++; },
  };
  return {
    writes, get commits() { return commits; }, db: {},
    fs: {
      doc: (_db, ...path) => path.join('/'),
      getDoc: async () => ({ exists: () => player != null, data: () => player }),
      writeBatch: () => batch, serverTimestamp: () => 'now',
    },
  };
}

for (const bb of [10, 20, 50, 100]) {
  test(`${bb} 大盲：低於 50BB 阻擋，等於與高於均可整筆買入`, async () => {
    assert.throws(() => assertMinimumBuyin(50 * bb - 1, bb), /籌碼不足.*50 大盲/);
    for (const bank of [50 * bb, 123 * bb]) {
      const fb = fakeFirebase({ bank, total: bank, tableRoomId: null, sessionNo: 0 });
      const result = await buyinAll(fb, 'u', 'r', bb);
      assert.equal(result.amount, bank);
      assert.equal(fb.commits, 1);
      assert.equal(fb.writes[0].data.bank, 0);
      assert.equal(fb.writes[0].data.inPlay, bank);
      assert.equal(fb.writes[1].data.amount, bank);
    }
  });
}

test('最新帳戶不足時，不建立買入或帳本寫入', async () => {
  const fb = fakeFirebase({ bank: 499, tableRoomId: null, sessionNo: 0 });
  await assert.rejects(buyinAll(fb, 'u', 'r', 10), /籌碼不足/);
  assert.equal(fb.commits, 0);
  assert.deepEqual(fb.writes, []);
});

test('已帶入但尚未入座：用 inPlay 判斷且不重複買入', async () => {
  const player = { bank: 0, inPlay: 2000, tableRoomId: 'r', sessionNo: 1 };
  assert.equal(wholeBalance(player, 'r'), 2000);
  const fb = fakeFirebase(player);
  assert.equal((await buyinAll(fb, 'u', 'r', 20)).skipped, true);
  assert.equal(fb.commits, 0);
  await assert.rejects(buyinAll(fb, 'u', 'r', 50), /籌碼不足/);
});

test('禁止帶著另一桌帳戶買入', async () => {
  await assert.rejects(buyinAll(fakeFirebase({ bank: 2000, tableRoomId: 'other' }), 'u', 'r', 20), /別桌/);
});

test('牌桌顯示整筆餘額，入座後顯示實際 session 買入而非輸贏後籌碼', () => {
  assert.equal(buyinLabel({ bank: 8765 }, 'r'), '整筆買入 8,765 籌碼');
  assert.equal(buyinLabel({ bank: 0, inPlay: 8765, tableRoomId: 'r' }, 'r'), '整筆買入 8,765 籌碼');
  assert.equal(buyinLabel({ bank: 0, inPlay: 8765 }, 'r', { buyIn: 8765 }), '本次買入 8,765 籌碼');
});

test('實際入座 handler 同步提示且不呼叫任何網路方法', async () => {
  const body = source.slice(source.indexOf('async function sitDown(seat)'), source.indexOf('async function requestLeave()'));
  let networkCalls = 0;
  const messages = [];
  const context = vm.createContext({
    getFirebase: () => ({}), getUser: () => ({ uid: 'u' }),
    room: { seatUids: Array(6).fill(null), config: { bb: 50 } },
    roomId: 'r', sittingBusy: false, playerDoc: { bank: 2000 },
    assertMinimumBuyin, wholeBalance, toast: msg => messages.push(msg),
    buyinAll: () => { networkCalls++; },
  });
  vm.runInContext(body, context);
  const started = performance.now();
  const pending = context.sitDown(0);
  assert.ok(performance.now() - started < 200, '不足提示須於 200ms 內同步出現');
  assert.match(messages[0], /籌碼不足.*2,500.*2,000/);
  assert.equal(context.sittingBusy, false);
  await pending;
  assert.equal(networkCalls, 0);
});

test('房主自動入座同樣先檢查門檻', () => {
  const start = source.indexOf('        if (needHostSit) {');
  const block = source.slice(start, source.indexOf('// L3: ensure hostRoomId', start));
  assert.ok(block.indexOf('assertMinimumBuyin(') < block.indexOf('await buyinAll('));
  assert.ok(block.indexOf('await buyinAll(') < block.indexOf('await hostLoop?.seatPlayer('));
});

test('新玩家預設 2000，首次贈送仍依房間設定；不覆寫既有帳戶', async () => {
  assert.equal(DEFAULT_NEW_PLAYER_CHIPS, 2000);
  const room = readFileSync(new URL('../js/net/room.js', import.meta.url), 'utf8');
  assert.match(room, /newPlayerChips: opts.newPlayerChips \?\? DEFAULT_NEW_PLAYER_CHIPS/);
  for (const amount of [2000, 5000]) {
    const fb = fakeFirebase(null);
    await ensurePlayerGrant(fb, 'u', 'r', amount, { displayName: '玩家', photoURL: null });
    assert.equal(fb.writes[0].data.bank, amount);
    assert.equal(fb.writes[1].data.amount, amount);
  }
  const fb = fakeFirebase({ bank: 9999 });
  assert.equal((await ensurePlayerGrant(fb, 'u', 'r', 2000, {})).created, false);
  assert.equal(fb.commits, 0);
});

test('四種盲注選項保留', () => {
  const lobby = readFileSync(new URL('../js/ui/lobby.js', import.meta.url), 'utf8');
  assert.ok(lobby.includes("[['5','10'],['10','20'],['25','50'],['50','100']]"));
});


test('足額入座先同步提示，再買入並送出 SIT', async () => {
  const body = source.slice(source.indexOf('async function sitDown(seat)'), source.indexOf('async function requestLeave()'));
  const events = [];
  const context = vm.createContext({
    getFirebase: () => ({}), getUser: () => ({ uid: 'u' }),
    room: { seatUids: Array(6).fill(null), config: { bb: 20 }, pub: { handNo: 3, actionSeq: 4 } },
    roomId: 'r', sittingBusy: false, playerDoc: { bank: 8765 },
    assertMinimumBuyin, wholeBalance, toast: msg => events.push(msg),
    buyinAll: async (...args) => { events.push(['buyin', args[3]]); },
    getPlayer: async () => ({ bank: 0, inPlay: 8765, tableRoomId: 'r' }),
    intents: { send: async intent => events.push([intent.type, intent.seat]) },
    friendlyError: e => e.message,
  });
  vm.runInContext(body, context);
  const started = performance.now();
  const pending = context.sitDown(2);
  assert.equal(events[0], '入座中…');
  assert.ok(performance.now() - started < 200);
  await pending;
  assert.deepEqual(events, ['入座中…', ['buyin', 20], ['SIT', 2]]);
  assert.equal(context.sittingBusy, false);
});

test('實際買入放在手機也顯示的 meta-a 區塊', () => {
  assert.match(source, /class="meta-a">[^\n]*\$\{esc\(buyin\)\}<\/span><span class="meta-b">/);
});
