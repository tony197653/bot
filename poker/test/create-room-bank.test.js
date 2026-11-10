import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { renderCreateRoom } from '../js/ui/lobby.js';
import { canAffordBlinds, createRoomBuyinError, defaultCreateBuyin, buyinLabel } from '../js/net/buyin-policy.js';

function formHarness({ bank = 2000, sb = 10, chips = 2000 } = {}) {
  const events = {}, drafts = [], submitted = [];
  const radios = ['5/10', '10/20', '25/50', '50/100'].map(value => ({
    value, checked: Number(value.split('/')[0]) === sb, attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
  }));
  const input = { value: chips }, error = {}, button = {}, cancel = {};
  const form = {
    querySelectorAll: () => radios, querySelector: () => button,
    addEventListener: (type, callback) => { events[type] = callback; },
  };
  cancel.addEventListener = (_type, fn) => { cancel.click = fn; };
  const root = { querySelector: selector => ({
    '#createForm': form, '#mpCreateChips': input, '#mpCreateLiveErr': error,
    '[data-act="cancel"]': cancel,
  })[selector] };
  const OriginalFormData = globalThis.FormData;
  globalThis.FormData = class {
    get(key) { return key === 'blinds' ? radios.find(r => r.checked)?.value : key === 'chips' ? input.value : '桌'; }
  };
  let cancelled = 0;
  try {
    renderCreateRoom(root, { defaults: { sb, chips }, bank, onDraft: d => drafts.push(d),
      onSubmit: d => submitted.push(d), onCancel: () => cancelled++ });
    return { radios, input, error, button, drafts, submitted, cancel,
      get cancelled() { return cancelled; },
      change() { events.change(); },
      submit() { events.submit({ preventDefault() {}, target: form }); },
      restore() { globalThis.FormData = OriginalFormData; } };
  } catch (e) { globalThis.FormData = OriginalFormData; throw e; }
}

test('帳戶 2000：高盲注停用並改選最高可負擔盲注', () => {
  const h = formHarness({ sb: 25 });
  try {
    assert.deepEqual(h.radios.map(r => r.disabled), [false, false, true, true]);
    assert.deepEqual(h.radios.map(r => r.attrs['aria-disabled']), ['false', 'false', 'true', 'true']);
    assert.equal(h.radios.find(r => r.checked).value, '10/20');
    assert.equal(h.drafts.at(-1).sb, 10);
    // 模擬繞過 disabled 的送出，驗證仍拒絕。
    h.radios.forEach(r => { r.checked = r.value === '25/50'; });
    h.submit();
    // 有其他可用盲注時會回到 10/20，送出資料不會含 25/50。
    assert.equal(h.submitted[0].bb, 20);
    assert.equal(canAffordBlinds(2000, 50), false);
    const msg = createRoomBuyinError(2000, 25, 50, 2000);
    assert.match(msg, /2,000.*2,500/);
    assert.ok(msg.length <= 32);
  } finally { h.restore(); }
});

test('取消、可用盲注切換、草稿與合法送出保留', () => {
  const h = formHarness();
  try {
    h.cancel.click(); assert.equal(h.cancelled, 1);
    h.radios.forEach(r => { r.checked = r.value === '5/10'; });
    h.change(); assert.equal(h.drafts.at(-1).sb, 5);
    h.radios.forEach(r => { r.checked = r.value === '10/20'; });
    h.input.value = 500; h.change();
    assert.equal(Number(h.input.value), 1000);
    h.input.value = 500; h.submit(); assert.equal(h.submitted.length, 0);
    h.input.value = 2000; h.change(); h.submit();
    assert.equal(h.button.disabled, false); assert.equal(h.submitted[0].newPlayerChips, 2000);
    h.input.value = 2500; h.change(); assert.equal(h.button.disabled, true);
  } finally { h.restore(); }
});

test('餘額低於所有盲注：欄位旁短提示且不抬高攜入', () => {
  const h = formHarness({ bank: 200, chips: 200, sb: 25 });
  try {
    assert.equal(h.button.disabled, true); assert.equal(h.error.hidden, false);
    assert.match(h.error.textContent, /200.*2,500/);
    assert.equal(Number(h.input.value), 200);
    h.submit(); assert.equal(h.submitted.length, 0);
  } finally { h.restore(); }
});

test('首次無帳戶：盲注可用且自動補足；標籤不高於 bank', () => {
  const h = formHarness({ bank: null, chips: 2000, sb: 25 });
  try {
    assert.ok(h.radios.every(r => !r.disabled)); assert.equal(Number(h.input.value), 2500);
    h.submit(); assert.equal(h.submitted[0].newPlayerChips, 2500);
    assert.equal(defaultCreateBuyin(2000, 50, 2000), 2000);
    assert.equal(buyinLabel({ bank: 2000 }, 'r', null, { bb: 50, newPlayerChips: 2000 }), '攜入 2,000 籌碼');
  } finally { h.restore(); }
});

const source = readFileSync(new URL('../js/ui/mp-app.js', import.meta.url), 'utf8');
test('doCreate 使用重讀 bank：拒絕不足／超額／低於50BB，合法才建立', async () => {
  for (const [bank, bb, chips, allowed] of [[2000,50,2000,false],[2000,20,2500,false],[2000,20,500,false],[2000,20,2000,true],[null,50,2000,false]]) {
    let creates = 0, reads = 0;
    const ctx = vm.createContext({ getFirebase: () => ({}), getUser: () => ({ uid: 'u' }),
      createDraft: {}, creating: false, createError: '', playerDoc: { bank: 99999 },
      paint() {}, silentlySettleClosedBinding: async () => {},
      getPlayer: async () => { reads++; return bank == null ? null : { bank }; },
      createSingleTable: async () => { creates++; return { roomId: 'r' }; },
      createRoomBuyinError, DEFAULT_NEW_PLAYER_CHIPS: 2000,
    });
    vm.runInContext(source.slice(source.indexOf('async function doCreate('), source.indexOf('async function doJoin(')), ctx);
    await ctx.doCreate({ sb: bb / 2, bb, newPlayerChips: chips });
    assert.equal(creates, allowed ? 1 : 0);
    if (chips >= 1000) assert.equal(reads, 1);
    if (!allowed) assert.ok(ctx.createError);
  }
});
