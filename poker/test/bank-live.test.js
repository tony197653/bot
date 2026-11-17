// 帳戶即時顯示（1117）：登入補發事件、監聽自己帳戶、未拿到伺服器資料顯示「—」
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const mp = readFileSync(new URL('../js/ui/mp-app.js', import.meta.url), 'utf8');
const auth = readFileSync(new URL('../../lib/auth/auth.js', import.meta.url), 'utf8');
const lobby = readFileSync(new URL('../js/ui/lobby.js', import.meta.url), 'utf8');
const cut = (s, a, b) => s.slice(s.indexOf(a), s.indexOf(b, s.indexOf(a)));

test('onUser 晚訂閱：Firebase 已確認登入就不能標成只有快取', () => {
  const src = cut(auth, 'export function onUser(', '\n}\n').replace('export ', '') + '\n}';
  const ctx = vm.createContext({ listeners: new Set(), currentStatus: 'signed-in', currentUser: { uid: 'u' }, confirmed: false });
  vm.runInContext(src, ctx);
  let ev; ctx.onUser((e) => { ev = e; });
  assert.equal(ev.fromCache, true, '只有快取時仍是 fromCache');
  ctx.confirmed = true;
  ctx.onUser((e) => { ev = e; });
  assert.equal(ev.fromCache, false, '已確認登入的補發事件要讀伺服器');
});

function watcherCtx() {
  let cb; const cached = [];
  const ctx = vm.createContext({
    console, playerDoc: null, playerFresh: false, stopSelfPlayer: null, selfPlayerUid: null, screen: 'lobby', paints: 0,
    readCachedPlayer: () => null, cachePlayer: (uid, d) => cached.push([uid, d]),
    fmtChips: (n) => n.toLocaleString('en-US'), globalThis: { document: null },
  });
  ctx.paint = () => { ctx.paints++; };
  vm.runInContext(cut(mp, 'function watchSelfPlayer(', '\nfunction stopWatchSelfPlayer(')
    + cut(mp, '\nfunction stopWatchSelfPlayer(', '\n/** 帳戶數字變了') + cut(mp, '\n/** 帳戶數字變了', '\n}\n') + '\n}', ctx);
  const fb = { db: {}, fs: { doc: (_d, ...p) => p.join('/'), onSnapshot: (_ref, fn) => { cb = fn; return () => { cb = null; }; } } };
  const snap = (d, meta = {}) => ({ exists: () => true, data: () => d, metadata: meta });
  return { ctx, fb, fire: (d, m) => cb(snap(d, m)), cached, hasCb: () => !!cb };
}

test('監聽自己帳戶：伺服器數字到才算數、外部加減帳戶即時重畫並寫快取', () => {
  const t = watcherCtx();
  assert.equal(vm.runInContext('accountText()', t.ctx), '—', '沒拿到伺服器資料前顯示 —');
  vm.runInContext('watchSelfPlayer', t.ctx)(t.fb, 'u');
  t.fire({ bank: 2000, inPlay: 0, total: 2000 }, { fromCache: true });
  assert.equal(t.ctx.playerFresh, false, '本機快取的快照不算');
  t.fire({ bank: 2000, inPlay: 0, total: 2000, tableRoomId: null });
  assert.equal(vm.runInContext('accountText()', t.ctx), '2,000');
  assert.equal(t.ctx.paints, 1);
  t.fire({ bank: 4000, inPlay: 0, total: 4000, tableRoomId: null });
  assert.equal(t.ctx.playerDoc.bank, 4000);
  assert.equal(t.ctx.paints, 2);
  assert.equal(t.cached.at(-1)[1].bank, 4000, '本機快取跟著更新（含結帳後）');
  t.fire({ bank: 4000, inPlay: 0, total: 4000 }, { hasPendingWrites: true });
  assert.equal(t.ctx.paints, 2, '本機未送出的寫入不重畫');
  vm.runInContext('stopWatchSelfPlayer()', t.ctx);
  assert.equal(t.hasCb(), false); assert.equal(t.ctx.playerFresh, false);
});

test('大廳、開新牌桌、入座小框都有帳戶，未確認顯示 —', () => {
  assert.match(lobby, /bankFresh === false \|\| !player \? '—'/);
  assert.match(lobby, /id="mpCreateBank">\$\{bankText\}/);
  assert.match(mp, /id="mpBuyinBank">\$\{options\.bankText \?\? '—'\}/);
  assert.match(mp, /bankText: accountText\(\)/);
});

test('管理頁用獨立 Firebase app，登入狀態不跟大廳共用', () => {
  const admin = readFileSync(new URL('../admin/admin.js', import.meta.url), 'utf8');
  const load = readFileSync(new URL('../../lib/firebase/load.js', import.meta.url), 'utf8');
  assert.match(admin, /const ADMIN_APP = 'poker-admin'/);
  assert.match(admin, /loadFirebase\([^)]*\{ appName: ADMIN_APP \}\)/);
  assert.match(load, /initializeApp\(firebaseConfig, name\)/);
  assert.match(load, /getApps\(\)\.length \? getApp\(\) : initializeApp\(firebaseConfig\)/, '未指定 appName 時行為不變');
});

test('戰績前 3 名即時監聽：依 total 排序、資料變就重畫', () => {
  const ledger = readFileSync(new URL('../js/net/ledger.js', import.meta.url), 'utf8');
  const src = cut(ledger, 'export function listenLeaderboard(', '\nexport async function fetchNightBoard(').replace('export ', '');
  let cb, q;
  const ctx = vm.createContext({});
  vm.runInContext(src, ctx);
  const fs = { collection: () => 'c', orderBy: (f, d) => `${f} ${d}`, limit: (n) => `limit ${n}`, query: (...a) => (q = a),
    onSnapshot: (_q, fn) => { cb = fn; return () => {}; } };
  let rows = null;
  ctx.listenLeaderboard({ db: {}, fs }, 3, (r) => { rows = r; });
  assert.deepEqual(q, ['c', 'total desc', 'limit 3']);
  const snap = (list, meta = {}) => ({ metadata: meta, docs: list.map(([id, total]) => ({ id, data: () => ({ total }) })) });
  cb(snap([['a', 1]], { fromCache: true }));
  assert.equal(rows, null, '本機快取不算');
  cb(snap([['b', 5000], ['a', 4500]]));
  assert.deepEqual(rows.map((r) => r.uid), ['b', 'a']);
  assert.match(mp, /watchLeaderboard\(getFirebase\(\)\)/);
  assert.match(mp, /stopLeaders\?\.\(\)/);
});
