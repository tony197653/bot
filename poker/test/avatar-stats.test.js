import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { renderCreateRoom, renderShareRoom, renderJoinCode, openRowHtml, renderMpLobby } from '../js/ui/lobby.js';
import { renderStats } from '../js/ui/stats.js';
import { playerPhotoSyncPatch } from '../js/ui/mp-app.js';
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const app = read('../js/ui/mp-app.js');
const lobby = read('../js/ui/lobby.js');
function section(start, end) { return app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start))); }
function harness() {
  let click;
  const ctx = vm.createContext({
    screen: 'table', document: { body: { dataset: {} }, addEventListener: (_event, cb) => { click = cb; } },
    getFirebase: () => ({}), getUser: () => ({ uid: 'me', displayName: '本人' }), playerDoc: null, loadStats: async () => {},
    paint: () => { ctx.painted = ctx.screen; }, openStatsFor: (...args) => { ctx.other = args; },
  });
  vm.runInContext(section('function openOwnStats()', '/** v1.0.5: after cash-out')
    + section('async function openStats()', '\nasync function loadStats()'), ctx);
  ctx.bindPersonalStatsEntry();
  return { ctx, tap: async (id, uid, className = '') => {
    let stopped = false;
    click({ target: { closest: selector => {
      assert.ok(selector.includes(id === 'heroAv' ? '#heroAv' : className || '#seats .av'));
      return { id, dataset: { psUid: uid, psName: '玩家' }, classList: { contains: c => c === className } };
    } }, stopPropagation: () => { stopped = true; } });
    await new Promise(resolve => setImmediate(resolve));
    return stopped;
  } };
}
for (const [name, id, uid, cls] of [
  ['牌桌本人座位', '', 'me', ''], ['牌桌自身頭像／進桌 shell 未入座', 'heroAv', '', ''],
  ['個人紀錄總籌碼與單晚列表', '', 'me', 'mp-lb-av'], ['大廳本人房主縮圖', '', 'me', 'mp-hav'],
]) test(`${name}點擊共用 openOwnStats 並開本人浮層`, async () => {
  const { ctx, tap } = harness();
  assert.equal(await tap(id, uid, cls), true);
  assert.equal(ctx.screen, 'table'); assert.deepEqual(Array.from(ctx.other), ['me', '本人']);
});
test('大廳主頭像直接接同一個 openOwnStats', () => {
  assert.match(app, /onAvatar: openOwnStats/);
  assert.match(lobby, /data-act="avatar"/); assert.match(lobby, /avatar: onAvatar/);
  assert.match(openRowHtml({ id: 'r', hostUid: 'me', hostName: '本人' }), /class="mp-hav" data-ps-uid="me"/);
});
test('其他玩家座位仍開該玩家浮層；其他房主縮圖仍走原本進桌', async () => {
  const { ctx, tap } = harness();
  await tap('', 'other'); assert.deepEqual(Array.from(ctx.other), ['other', '玩家']);
  assert.equal(ctx.screen, 'table');
  ctx.other = undefined;
  assert.equal(await tap('', 'other', 'mp-hav'), false); assert.equal(ctx.other, undefined);
});
const root = () => ({ innerHTML: '', querySelector: () => null, querySelectorAll: () => [] });
for (const [name, render, data] of [
  ['建立表單', renderCreateRoom, { defaults: {} }],
  ['分享', renderShareRoom, { name: '牌桌', code: '123', roomId: 'r' }],
  ['加入', renderJoinCode, {}],
]) test(`${name}目前沒有自身頭像，不新增 UI`, () => {
  const previous = globalThis.location; globalThis.location = { href: 'http://localhost/poker/' };
  try { const r = root(); render(r, data); assert.doesNotMatch(r.innerHTML, /mp-av|mp-hav|data-ps-uid/); }
  finally { globalThis.location = previous; }
});
test('收桌卡無頭像；沿用現有按鈕；單機 app 頭像未綁定登入帳號', () => {
  assert.doesNotMatch(section('function showCloseResultCard(', '\nlet '), /class="(?:mp-av|av)"|avatarHtml/);
  const solo = read('../js/ui/app.js'); assert.doesNotMatch(solo, /getUser\(|photoURL|data-ps-uid/);
});
for (const mode of ['total', 'night']) test(`戰績 ${mode} 將自身頭像與姓名放在同一容器`, () => {
  const r = root(); renderStats(r, { mode, rows: [{ uid: 'me', displayName: '本人', name: '本人', total: 2000, net: 0, tableRoomId: 'r' }], myUid: 'me', nights: [], nightKey: '20261109' });
  assert.match(r.innerHTML, /<td class="mp-lb-player"><span class="mp-lb-who"><button type="button" class="mp-lb-av" data-ps-uid="me"[^>]*>.*?<\/button>/);
  const tag = mode === 'total' ? '<span class="mp-tag">牌桌中</span>' : '';
  assert.ok(r.innerHTML.includes(`</button><span class="mp-lb-nm" title="本人">本人</span>${tag}</span></td>`));
});

test('大廳戰績前三名顯示靜態頭像、完整姓名提示與籌碼', () => {
  const r = root();
  renderMpLobby(r, {
    photoOf: (uid) => uid === 'cached' ? 'https://example.com/cached.png' : null,
    leaderPreview: [
      { uid: 'cached', displayName: '王"<長名>', photoURL: 'https://example.com/old.png', total: 2000 },
      { uid: 'row', displayName: '李', photoURL: 'https://example.com/row.png', total: 1000 },
      { uid: 'fallback', displayName: '陳玩家', total: 900 },
    ],
  });
  const ranks = r.innerHTML.match(/<ol class="mp-ranks">(.*?)<\/ol>/)[1];
  assert.match(ranks, /<span class="mp-lb-av" aria-hidden="true"><img[^>]*src="https:\/\/example\.com\/cached\.png"[^>]*width="28" height="28"/);
  assert.match(ranks, /<span class="mp-lb-nm" title="王&quot;&lt;長名&gt;">王&quot;&lt;長名&gt;<\/span><\/span><b>2,000<\/b>/);
  assert.match(ranks, /src="https:\/\/example\.com\/row\.png"/);
  assert.match(ranks, /<span class="mp-lb-av" aria-hidden="true"><span class="av-fallback">陳<\/span><\/span>/);
  assert.doesNotMatch(ranks, /<button|data-ps-uid|old\.png/);
});

test('頭像同步只為有 lastRoomId 且頭像變更的玩家產生合法 patch', () => {
  const player = { lastRoomId: '', photoURL: 'https://example.com/old.png' };
  const valid = 'https://example.com/'.padEnd(500, 'a');
  assert.deepEqual(playerPhotoSyncPatch(player, { photoURL: valid }), { photoURL: valid });
  assert.deepEqual(playerPhotoSyncPatch(player, {}), { photoURL: null });
  assert.equal(playerPhotoSyncPatch(player, { photoURL: player.photoURL }), null);
  assert.equal(playerPhotoSyncPatch({ lastRoomId: '' }, { photoURL: null }), null);
  for (const missing of [null, {}, { lastRoomId: null }]) {
    assert.equal(playerPhotoSyncPatch(missing, { photoURL: valid }), null);
  }
  for (const photoURL of [valid + 'a', 'http://example.com/', 'https://', 'https://bad host/', 123]) {
    assert.equal(playerPhotoSyncPatch(player, { photoURL }), null);
  }
});
