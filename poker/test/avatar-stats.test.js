import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { renderCreateRoom, renderShareRoom, renderJoinCode, openRowHtml } from '../js/ui/lobby.js';
import { renderStats } from '../js/ui/stats.js';
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
for (const mode of ['total', 'night']) test(`個人紀錄 ${mode} 仍渲染自身頭像`, () => {
  const r = root(); renderStats(r, { mode, rows: [{ uid: 'me', displayName: '本人', name: '本人', total: 2000, net: 0 }], myUid: 'me', nights: [], nightKey: '20261109' });
  assert.match(r.innerHTML, /mp-lb-av" data-ps-uid="me"/);
});
