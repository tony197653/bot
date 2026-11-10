/**
 * 離線單元與 source contract；不連網、不啟動 emulator。
 * 若另做 emulator 瀏覽器驗證，只能在 FIRESTORE_EMULATOR_HOST 已設定時執行，
 * 並指定私有 POKER_EMU_PROJECT=demo-stalerejoin；禁止正式專案與共用 demo-poker。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const app = readFileSync(new URL('../js/ui/mp-app.js', import.meta.url), 'utf8');
const lobby = readFileSync(new URL('../js/ui/lobby.js', import.meta.url), 'utf8');
const between = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const confirmation = between(app, 'async function confirmContinueRoom', 'let lobbyIdleCheckAt');

for (const status of ['swept', 'missing', 'open', 'denied']) {
  test(`回桌重新確認：${status} 不會誤進空桌`, async () => {
    let reads = 0, settles = 0, entries = 0, paints = 0, cleared = 0;
    const results = [];
    const context = vm.createContext({
      screen: 'lobby', room: null, confirmedLobbyRoom: null, closeResultDismissedFor: null,
      getFirebase: () => ({ db: {}, fs: {
        doc: () => 'room', getDoc: async () => {
          reads++;
          if (status === 'denied') throw new Error('permission-denied');
          return { exists: () => status !== 'missing', data: () => ({ status: status === 'swept' && reads > 1 ? 'closed' : 'lobby' }) };
        },
      } }),
      maybeAutoCloseIdleRoom: async () => status === 'swept',
      isRoomOpenStatus: (s) => s === 'lobby',
      getLastRoom: () => ({ roomId: 'r' }), clearLastRoom: () => cleared++,
      silentlySettleClosedBinding: async () => { settles++; return 2000; },
      showCloseResultCard: (opt) => results.push(opt),
      enterRoom: async () => entries++, paint: () => paints++,
    });
    await vm.runInContext(`${confirmation}\ncontinueMyTable('r')`, context);
    assert.equal(entries, status === 'open' ? 1 : 0);
    assert.equal(paints, status === 'open' ? 0 : 1);
    assert.equal(context.screen, 'lobby');
    if (status === 'open') {
      assert.equal(results.length, 0);
    } else {
      assert.equal(settles, 1); assert.equal(cleared, 1);
      assert.equal(results.length, 1);
      assert.equal(results[0].roomId, 'r');
      assert.equal(results[0].chips, 2000);
    }
    if (status === 'swept') {
      assert.equal(reads, 2);
      assert.equal(results[0].auto, true);
    }
  });
}

test('回桌確認遇到暫時網路錯誤：不進桌、不誤顯示收桌結果', async () => {
  let settles = 0, entries = 0, results = 0, cleared = 0, paints = 0;
  const context = vm.createContext({
    screen: 'lobby', room: null, confirmedLobbyRoom: null, closeResultDismissedFor: null,
    getFirebase: () => ({ db: {}, fs: {
      doc: () => 'room', getDoc: async () => { throw new Error('unavailable'); },
    } }),
    maybeAutoCloseIdleRoom: async () => false,
    isRoomOpenStatus: (s) => s === 'lobby',
    getLastRoom: () => ({ roomId: 'r' }), clearLastRoom: () => cleared++,
    silentlySettleClosedBinding: async () => { settles++; return 0; },
    showCloseResultCard: () => results++,
    enterRoom: async () => entries++, paint: () => paints++,
  });
  await vm.runInContext(`${confirmation}\ncontinueMyTable('r')`, context);
  assert.equal(entries, 0);
  assert.equal(settles, 0);
  assert.equal(results, 0);
  assert.equal(cleared, 0);
  assert.equal(paints, 1);
  assert.equal(context.screen, 'lobby');
});

test('我的牌桌缺資料顯示 —，真實零籌碼保留 0', () => {
  const context = vm.createContext({ fmtChips: String, formatCode: (s) => s.padStart(3, '0'), esc: String, CHEV_SVG: '' });
  const build = between(lobby, 'function buildMyCard', 'export function fmtChips');
  vm.runInContext(build, context);
  const missing = vm.runInContext("buildMyCard({ myTable: {}, player: {} }).html", context);
  assert.match(missing, /房號 —/); assert.match(missing, /—\/6 人/);
  assert.match(missing, /我的籌碼 —/); assert.doesNotMatch(missing, /房號 000/);
  const zero = vm.runInContext("buildMyCard({ myTable: { chips: 0 }, player: {} }).html", context);
  assert.match(zero, /我的籌碼 0/);
});

test('room=null 過渡保留返回鈕、桌名與可空籌碼，不使用 bank', () => {
  const nodes = new Map();
  const context = vm.createContext({
    room: {}, screen: 'lobby', playerDoc: { bank: 999, inPlay: 0 },
    paint: () => {}, getUser: () => ({ uid: 'u' }), nameOrStub: () => '你',
    getLastRoom: () => null, fmtChips: String, esc: String,
    $: (s) => { if (!nodes.has(s)) nodes.set(s, { hidden: true, querySelectorAll: () => [] }); return nodes.get(s); },
  });
  vm.runInContext(between(app, 'function paintEnterShell', 'async function sweepLobbyTables'), context);
  vm.runInContext('paintEnterShell()', context);
  assert.equal(context.room, null); assert.equal(nodes.get('#btnBackLobby').hidden, false);
  assert.equal(nodes.get('#heroChips').textContent, '0');
  context.playerDoc = { bank: 999 };
  vm.runInContext('paintEnterShell()', context);
  assert.equal(nodes.get('#heroChips').textContent, '—');
  assert.equal(nodes.get('#roomTitle').textContent, '—');
});

test('過渡返回立刻回大廳；正常入桌保留離桌確認', () => {
  const start = app.indexOf("back.addEventListener('click', () => {");
  const body = app.slice(start + "back.addEventListener('click', () => {".length, app.indexOf('\n      });', start));
  let returns = 0, confirms = 0;
  const context = vm.createContext({ room: null, goLobbyClean: () => returns++, closeMpMenu: () => {}, showLeaveTableConfirm: () => confirms++ });
  vm.runInContext(`(() => {${body}})()`, context);
  assert.equal(returns, 1); assert.equal(confirms, 0);
  context.room = {};
  vm.runInContext(`(() => {${body}})()`, context);
  assert.equal(confirms, 1);
  const chrome = between(app, 'function paintTableChrome', 'function renderSeatOverlays');
  assert.match(chrome, /back.hidden = screen !== 'table'/);
});

test('未確認綁定不畫卡，進桌逾時 3000ms 回大廳，retry 保留回桌來源', () => {
  assert.match(app, /screen !== 'table' && screen !== 'linking' && screen !== 'lobby'/);
  assert.match(app, /revealClosedFromLobby/);
  assert.match(app, /continueId && liveRoom &&/);
  assert.match(app, /lobby\?\.seated \?\? null/);
  assert.match(app, /setTimeout\(\(\) => \{\s*if \(roomId === id && screen === 'table' && !room\) goLobbyClean\(\);\s*\}, 3000\)/);
  assert.match(app, /enterRoom\(id, \{ asHostSit, retryJoin: false, fromContinue \}\)/);
  assert.match(app, /if \(fromContinue\) \{\s*goLobbyClean\(\);\s*return;/);
  assert.match(app, /rememberLastRoom\(id, r.code, \{\s*name: r.name/);
});

test('訂閱沒有回應時，實際進桌計時器在 3000ms 返回大廳', async () => {
  let timeout, delay, returned = 0;
  const context = vm.createContext({
    getFirebase: () => ({}), getUser: () => ({ uid: 'u' }),
    closingFreeze: false, hostSitPending: false, closeResultDismissedFor: null,
    closeResultShownFor: null, roomId: null, room: null, lobbyClosedSynced: new Set(),
    tearDownRoom: () => {}, startRoomSound: () => {},
    getLastRoom: () => ({ name: '原桌' }),
    paintEnterShell: () => { context.screen = 'table'; },
    setTimeout: (fn, ms) => { timeout = fn; delay = ms; return 1; },
    listenRoom: () => {},
    goLobbyClean: () => { context.screen = 'lobby'; returned++; },
  });
  const start = app.indexOf('async function enterRoom(');
  const subscribe = app.indexOf('  stopRoom = listenRoom(', start);
  vm.runInContext(app.slice(start, subscribe) + '\nstopRoom = listenRoom();\n}', context);
  await context.enterRoom('r', { fromContinue: true });
  assert.equal(context.screen, 'table'); assert.equal(delay, 3000);
  timeout();
  assert.equal(context.screen, 'lobby'); assert.equal(returned, 1);
});
