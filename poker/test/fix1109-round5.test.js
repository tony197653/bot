import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { renderMpLobby, renderShareRoom } from '../js/ui/lobby.js';
import { createSingleTable } from '../js/net/room.js';
import { startPresence } from '../js/net/presence.js';
const app = readFileSync(new URL('../js/ui/mp-app.js', import.meta.url), 'utf8');
const section = (a, b) => app.slice(app.indexOf(a), app.indexOf(b, app.indexOf(a)));
const flush = () => new Promise(resolve => setImmediate(resolve));

// 解析實際 renderer 產出的 data-act 元素，執行 wire() 註冊的 click。
function lobbyRoot() {
  const root = { nodes: [], classList: { remove() {} }, hidden: false,
    querySelector: () => null,
    querySelectorAll: selector => selector === '[data-act]' ? root.nodes : [],
    set innerHTML(html) {
      this.html = html;
      this.nodes = [...html.matchAll(/<(button|article)\b([^>]*data-act="([^"]+)"[^>]*)>/g)].map(m => ({
        attrs: m[2], act: m[3], listeners: {},
        getAttribute: name => name === 'data-act' ? m[3] : null,
        addEventListener(event, fn) { this.listeners[event] = fn; },
      }));
    },
  };
  return root;
}

test('大廳實際可見頭像 click → 立即繪製個人紀錄；網路未返回及後續快照/paint 都維持 stats', async () => {
  const root = lobbyRoot();
  let snapshot, finish;
  const ctx = vm.createContext({ screen: 'lobby', paintCount: 0, window: {},
    $: sel => sel === '#mpRoot' ? root : null,
    silenceSoloScreens() {}, renderStats: () => { ctx.shown = '個人紀錄'; },
    statsMode: 'total', statsRows: [], statsNight: '20261109', authState: { user: { uid: 'me' } },
    loadStats: () => new Promise(resolve => { finish = resolve; }),
    stopOpenTables: null, openTables: [{ id: 'r' }], getFirebase: () => ({}),
    listenOpenTables: (_fb, cb) => { snapshot = cb; return () => {}; },
    lobbyExitSuppressMine: false, playerDoc: {}, isRoomOpenStatus: () => true,
    patchOpenTables: r => { assert.equal(r.nodes[0], avatar); return true; }, console,
  });
  vm.runInContext(section('function paint()', '\nfunction paintEnterShell(')
    + section('async function openStats()', '\nasync function loadStats()')
    + section('function ensureOpenTablesListen()', '\nasync function enterOpenTable('), ctx);
  const wiring = /onAvatar:\s*(\w+)/.exec(app)[1];
  renderMpLobby(root, { user: { uid: 'me', displayName: '本人' }, onAvatar: ctx[wiring] });
  const avatar = root.nodes.find(n => /class="mp-av"/.test(n.attrs));
  assert.ok(avatar); assert.equal(avatar.act, 'avatar');
  assert.equal(root.nodes.filter(n => /class="mp-av"/.test(n.attrs)).length, 1);
  ctx.ensureOpenTablesListen();
  snapshot([{ id: 'r', status: 'playing' }]); // 手指按下後、click 前的快照不得移除頭像。
  assert.equal(root.nodes.find(n => n.act === 'avatar'), avatar);
  avatar.listeners.click();
  assert.equal(ctx.screen, 'stats'); assert.equal(ctx.shown, '個人紀錄');
  snapshot([{ id: 'r', status: 'playing' }]); ctx.paint();
  assert.equal(ctx.screen, 'stats'); assert.equal(ctx.shown, '個人紀錄');
  finish(); await flush(); assert.equal(ctx.screen, 'stats');
});

test('分享頁只保留既有連結加入文字；牌桌選單刪除兩入口及死 handler', () => {
  const previous = globalThis.location;
  globalThis.location = { href: 'http://localhost/poker/' };
  try {
    const root = lobbyRoot(); renderShareRoom(root, { name: '桌', code: '000', roomId: 'r' });
    assert.doesNotMatch(root.html, /mp-code|複製房號|或在大廳輸入房號|24 小時有效/);
    assert.match(root.html, />點連結加入</);
    for (const text of ['分享連結', '複製連結', '進入牌桌']) assert.ok(root.html.includes(text));
    assert.doesNotMatch(app, /mpBtnExtend|mpExtendCode|mpBtnCopyLink|延長房號 24 小時|複製房號連結/);
  } finally { globalThis.location = previous; }
});

test('房主進桌與既有心跳靜默續期；未達門檻、非房主、已收桌皆不寫', async () => {
  let time = Date.now(), expiry = time + 11 * 3600e3, tick, host = true;
  let room = { id: 'r', code: '000', status: 'playing' };
  const writes = [];
  const fb = { db: {}, fs: { doc: (_db, ...p) => p.join('/'),
    getDoc: async () => ({ exists: () => true, data: () => ({ roomId: 'r', expiresAt: { toMillis: () => expiry } }) }),
    updateDoc: async (ref, patch) => { writes.push([ref, patch]); expiry = patch.expiresAt.toMillis(); },
    Timestamp: { fromMillis: n => ({ toMillis: () => n }) }, serverTimestamp: () => 0, setDoc: async () => {},
  } };
  const presence = startPresence(fb, 'r', 'h', { isHost: () => host, getRoom: () => room,
    lastRoomWriteAt: () => time, now: () => time,
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    setInterval: fn => { tick = fn; return 1; }, clearInterval() {},
  });
  try {
    await flush(); assert.equal(writes.length, 1); assert.equal(writes[0][0], 'pokerCodes/000');
    assert.ok(Math.abs(expiry - (Date.now() + 24 * 3600e3)) < 1000);
    time += 60000; tick(); await flush(); assert.equal(writes.length, 1);
    expiry = time; host = false; time += 60000; tick(); await flush(); assert.equal(writes.length, 1);
    host = true; room.status = 'closed'; time += 60000; tick(); await flush(); assert.equal(writes.length, 1);
    room.status = 'playing'; time += 60000; tick(); await flush(); assert.equal(writes.length, 2);
    assert.equal((app.match(/getRoom: \(\) => room,/g) || []).length >= 2, true);
  } finally { presence.stop(); }
});

test('000 鎖已過期但房間仍開放，清單漏列時仍加入而不回收或建立', async () => {
  const room = { status: 'playing', code: '000', name: '桌', config: {}, members: ['u'], seatUids: ['u'] };
  const fb = { db: {}, fs: { doc: (_db, ...p) => p.join('/'), collection() {}, query() {}, where() {}, orderBy() {}, limit() {},
    getDocs: async () => ({ forEach() {} }),
    getDoc: async ref => ({ exists: () => true, data: () => ref === 'pokerCodes/000'
      ? { roomId: 'r', expiresAt: { toMillis: () => 1 } } : room }),
    runTransaction: () => assert.fail('仍開放的鎖不得回收'),
    updateDoc: () => assert.fail('既有成員不需寫入'),
  } };
  const result = await createSingleTable(fb, { uid: 'u' });
  assert.equal(result.roomId, 'r'); assert.equal(result.existing, true);
});
