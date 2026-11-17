import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { renderCreateRoom } from '../js/ui/lobby.js';
import { canAffordBlinds, createRoomBuyinError, defaultCreateBuyin, buyinLabel } from '../js/net/buyin-policy.js';

const chipsOf = v => Number(String(v).replaceAll(',', ''));
function formHarness({ bank = 2000, sb = 10, chips = 2000 } = {}) {
  const events = {}, drafts = [], submitted = [];
  const radios = ['5/10', '10/20', '25/50', '50/100'].map(value => ({
    value, checked: Number(value.split('/')[0]) === sb, attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
  }));
  const minus = { addEventListener(_type, fn) { this.click = fn; } }, plus = { addEventListener(_type, fn) { this.click = fn; } }, hint = {};
  const hintClasses = new Set();
  const minHint = { classList: {
    add: name => hintClasses.add(name), remove: name => hintClasses.delete(name), contains: name => hintClasses.has(name),
  } };
  const bankEl = { textContent: '', dataset: {} };
  const input = { value: chips, addEventListener(type, fn) { this[type] = fn; } }, error = {}, button = { addEventListener() {}, focus() {} }, cancel = {};
  const form = {
    querySelectorAll: () => radios, querySelector: () => button,
    addEventListener: (type, callback) => { events[type] = callback; },
  };
  cancel.addEventListener = (_type, fn) => { cancel.click = fn; };
  const root = { querySelector: selector => ({
    '[data-chips-minus]': minus, '[data-chips-plus]': plus, '#mpCreateMinHint': minHint, '#mpCreateChipsHint': hint, '#createForm': form, '#mpCreateChips': input, '#mpCreateLiveErr': error, '#mpCreateBank': bankEl,
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
    return { radios, input, error, button, drafts, submitted, cancel, minus, plus, hint, minHint, bankEl, root,
      get cancelled() { return cancelled; },
      change(name) { events.change({ target: { name: name || '' } }); },
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
    h.change('blinds'); assert.equal(h.drafts.at(-1).sb, 5);
    assert.equal(chipsOf(h.input.value), 500);
    assert.equal(h.input.min, '500');
    assert.match(h.hint.textContent, /500–100,000/);
    h.minus.click(); assert.equal(chipsOf(h.input.value), 500);
    h.submit(); assert.equal(h.submitted.pop().newPlayerChips, 500);
    h.radios.forEach(r => { r.checked = r.value === '10/20'; });
    h.change('blinds');
    assert.equal(Number(String(h.input.value).replaceAll(',', '')), 1000);
    h.input.value = 500; h.change('chips');
    h.submit(); assert.equal(h.submitted.length, 0);
    h.input.value = 2000; h.change('chips'); h.submit();
    assert.equal(h.button.disabled, false); assert.equal(h.submitted[0].newPlayerChips, 2000);
    h.input.value = 2500; h.change('chips'); assert.equal(h.button.disabled, true);
  } finally { h.restore(); }
});

test('R33b 四組盲注預設、input min、提示及減號下限同步', () => {
  const h = formHarness({ bank: 100000 });
  try {
    for (const [value, minimum] of [['5/10',500],['10/20',1000],['25/50',2500],['50/100',5000]]) {
      h.radios.forEach(r => { r.checked = r.value === value; });
      h.change('blinds');
      assert.equal(chipsOf(h.input.value), minimum);
      assert.equal(h.input.min, String(minimum));
      assert.ok(h.hint.textContent.includes(`${minimum.toLocaleString('en-US')}–100,000`));
      h.minus.click(); assert.equal(chipsOf(h.input.value), minimum);
      h.submit(); assert.equal(h.submitted.at(-1).newPlayerChips, minimum);
    }
  } finally { h.restore(); }
});

test('餘額低於所有盲注：欄位旁短提示且不抬高攜入', () => {
  const h = formHarness({ bank: 200, chips: 200, sb: 25 });
  try {
    assert.equal(h.button.disabled, true); assert.equal(h.error.hidden, false);
    assert.match(h.error.textContent, /200.*2,500/);
    assert.equal(chipsOf(h.input.value), 200);
    h.submit(); assert.equal(h.submitted.length, 0);
  } finally { h.restore(); }
});

test('首次無帳戶：盲注可用且自動補足；標籤不高於 bank', () => {
  const h = formHarness({ bank: null, chips: 2000, sb: 25 });
  try {
    assert.ok(h.radios.every(r => !r.disabled)); assert.equal(chipsOf(h.input.value), 2500);
    h.submit(); assert.equal(h.submitted[0].newPlayerChips, 2500);
    assert.equal(defaultCreateBuyin(2000, 50, 2000), 2000);
    assert.equal(buyinLabel({ bank: 2000 }, 'r', null, { bb: 50, newPlayerChips: 2000 }), '攜入 2,000 籌碼');
  } finally { h.restore(); }
});

const source = readFileSync(new URL('../js/ui/mp-app.js', import.meta.url), 'utf8');
test('doCreate 使用重讀 bank：拒絕不足／超額／低於50BB，合法才建立', async () => {
  for (const [bank, bb, chips, allowed] of [[1300,10,1300,true],[8000,10,1300,true],[5000,20,1234,true],[1000,10,500,true],[2000,50,2000,false],[2000,20,2500,false],[2000,20,500,false],[2000,20,2000,true],[null,50,2000,false]]) {
    let creates = 0, reads = 0;
    const ctx = vm.createContext({ getFirebase: () => ({}), getUser: () => ({ uid: 'u' }),
      createAttempt: 0, createTimeoutMs: () => 15000, setTimeout, clearTimeout, createDraft: {}, creating: false, createError: '', playerDoc: { bank: 99999 },
      paint() {}, silentlySettleClosedBinding: async () => {},
      getPlayer: async () => { reads++; return bank == null ? null : { bank }; },
      createSingleTable: async () => { creates++; return { roomId: 'r' }; },
      createRoomBuyinError, DEFAULT_NEW_PLAYER_CHIPS: 2000,
    });
    vm.runInContext(source.slice(source.indexOf('async function doCreate('), source.indexOf('async function doJoin(')), ctx);
    await ctx.doCreate({ sb: bb / 2, bb, newPlayerChips: chips });
    assert.equal(creates, allowed ? 1 : 0);
    if (chips >= 50 * bb) assert.equal(reads, 1);
    if (!allowed) assert.ok(ctx.createError);
  }
});


test('R36 開桌最低提示與帳戶、標籤順序', () => {
  const h = formHarness({ bank: 8000, sb: 5, chips: 500 });
  try {
    const labelRow = /<span class="mp-min-hint-row"><label for="mpCreateChips">攜入籌碼<\/label><span class="mp-min-hint" id="mpCreateMinHint" role="status">已是最低攜入（50 大盲）<\/span><\/span>\s*<input name="chips"/;
    assert.match(h.root.innerHTML, labelRow);
    assert.ok(h.root.innerHTML.indexOf('id="mpCreateBank"') < h.root.innerHTML.search(labelRow));
    // is-visible 只切換 CSS visibility，提示在標籤行內持續佔位。
    const hintVisible = () => h.minHint.classList.contains('is-visible');
    assert.equal(hintVisible(), false);
    h.minus.click();
    assert.equal(chipsOf(h.input.value), 500);
    assert.equal(hintVisible(), true);
    assert.equal(h.error.hidden, true);
    h.plus.click(); assert.equal(hintVisible(), false);
    h.input.value = 500; h.change('chips'); h.minus.click();
    h.change('chips'); assert.equal(hintVisible(), false);
    h.minus.click(); h.radios.forEach(r => { r.checked = r.value === '10/20'; });
    h.change('blinds'); assert.equal(hintVisible(), false);
    h.minus.click(); assert.equal(hintVisible(), true);
    assert.equal(chipsOf(h.input.value), 1000);
  } finally { h.restore(); }
});

test('R39 開桌＋補滿帳戶與自行輸入 1,234 都可送出', () => {
  const h = formHarness({ bank: 1300, sb: 10, chips: 1000 });
  try {
    h.plus.click(); assert.equal(chipsOf(h.input.value), 1300);
    assert.equal(h.button.disabled, false); h.submit();
    assert.equal(h.submitted[0].newPlayerChips, 1300);
    assert.match(h.root.innerHTML, /id="mpCreateChips"[^>]*step="1"/);
    assert.match(h.hint.textContent, /按 ± 每次增減 500/);
    h.input.value = '1,234';
    h.change('chips');
    h.input.blur();
    assert.equal(h.input.value, '1,234');
    assert.equal(h.bankEl.textContent, '66');
    assert.equal(h.button.disabled, false);
    h.submit();
    assert.equal(h.submitted[1].newPlayerChips, 1234);
  } finally { h.restore(); }
});

test('R38 開桌 ±：500→1,000→1,300，帳戶剩餘跟著變，− 回到倍數並在 50 大盲停下', () => {
  const h = formHarness({ bank: 1300, sb: 5, chips: 500 });
  try {
    assert.equal(chipsOf(h.input.value), 500);
    assert.equal(h.bankEl.textContent, '800');
    h.plus.click(); assert.equal(chipsOf(h.input.value), 1000); assert.equal(h.bankEl.textContent, '300');
    h.plus.click(); assert.equal(chipsOf(h.input.value), 1300); assert.equal(h.bankEl.textContent, '0');
    assert.equal(h.button.disabled, false);
    h.minus.click(); assert.equal(chipsOf(h.input.value), 1000); assert.equal(h.bankEl.textContent, '300');
    h.minus.click(); assert.equal(chipsOf(h.input.value), 500); assert.equal(h.bankEl.textContent, '800');
    h.minus.click();
    assert.equal(chipsOf(h.input.value), 500);
    assert.equal(h.minHint.classList.contains('is-visible'), true);
  } finally { h.restore(); }
});
