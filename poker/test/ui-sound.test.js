import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { classifyUiSound, wireUiSound, UI_GAIN, SOUND_UNLOCK_EVENTS } from '../js/ui/sound.js';
import { raisePresetsMarkup } from '../js/ui/cards-dom.js';

// Minimal DOM control supporting the selectors used by the classifier.
function element(attrs = {}, parent = null, tag = 'button', radio = null) {
  const el = {
    id: attrs.id || '', parent, disabled: 'disabled' in attrs,
    getAttribute: (key) => attrs[key] ?? null,
    matches(selectors) {
      return selectors.split(',').some((raw) => {
        const selector = raw.trim();
        const space = selector.indexOf(' ');
        if (space >= 0) return !!parent?.matches(selector.slice(0, space)) && el.matches(selector.slice(space + 1));
        if (selector === ':disabled') return el.disabled;
        let rest = selector;
        const type = rest.match(/^[a-z]+/);
        if (type) { if (type[0] !== tag) return false; rest = rest.slice(type[0].length); }
        const id = rest.match(/#([\w-]+)/);
        if (id && attrs.id !== id[1]) return false;
        for (const [, cls] of rest.matchAll(/\.([\w-]+)/g)) if (!(attrs.class || '').split(' ').includes(cls)) return false;
        for (const [, key, value] of rest.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
          if (!(key in attrs) || (value !== undefined && attrs[key] !== value)) return false;
        }
        return true;
      });
    },
    closest(selector) { return el.matches(selector) ? el : parent?.closest(selector) ?? null; },
    querySelector: () => radio?.disabled ? radio : null,
  };
  return el;
}

test('分類：大廳、牌桌、單機與管理頁的實際控制項及 fallback', () => {
  const cases = [
    ...['mpMenuBtn','btnMute','mpBtnMute','mpAddon','mpRaise','raiseCancel','raiseScrim','mpCloseLobby','mpLeave','mpShow','mpMuck','opAdd','opSub','logout','mCancel','clearBtn'].map(id => [{ id }, 'tap']),
    ...['mpBtnCreate','btnGoogle','gateBtn','mpStart','mpFold','btnFold','mpCheck','btnCheck','mpCall','btnCall','btnAllIn','raiseConfirm','mpLeaveConfirmOk','soloLobbyConfirmOk','mpCloseConfirmOk','mpHostAloneClose','mpQuotaClose','mpCloseRetry','confirmAdj','mOk'].map(id => [{ id }, 'confirm']),
    ...['create','enter','continue','rescue'].map(act => [{'data-act':act}, 'confirm']),
    ...['avatar','stats','my-stats','settings','signout','open-table','cancel','share','copy','back','lobby'].map(act => [{'data-act':act}, 'tap']),
    ...['raiseMinus','raisePlus'].map(id => [{ id }, 'tick']),
    ...['data-minus','data-plus','data-chips-minus','data-chips-plus'].map(key => [{[key]:''},'tick']),
    ...['mp-chip','mp-seg-item','mp-lb-av','mp-empty-seat'].map(cls => [{class:cls},'tap']),
    [{'data-confirm':''},'confirm'], [{'data-cancel':''},'tap'], [{'data-ps':'pick-choice'},'tap'],
    [{'data-sfx':'confirm'},'confirm'], [{'data-sfx':'tick'},'tick'], [{'data-sfx':'none',id:'mpFold'},null],
    [{id:'mpFold',disabled:''},null], [{id:'mpFold','aria-disabled':'true'},null],
    [{id:'mpFold','data-sfx':'confirm',disabled:''},null], [{id:'unknown'},null],
  ];
  for (const [attrs, expected] of cases) assert.equal(classifyUiSound(element(attrs)), expected, JSON.stringify(attrs));
  for (const id of ['raiseRange','buyinRange']) assert.equal(classifyUiSound(element({id,type:'range','data-sfx':'tap'},null,'input')),null);
  assert.equal(classifyUiSound(element({class:'mp-seg-item','data-sfx':'tap'},null,'label', {disabled:true})),null);
  assert.equal(classifyUiSound(element({id:'mpFold'},element({'aria-disabled':'true'}))),null);
  assert.equal(classifyUiSound(element({'data-to':'100'},element({id:'presets'}))), 'tap');
  assert.equal(classifyUiSound(element({class:'row','data-uid':'u'},element({id:'players'}))), 'tap');
  assert.equal(classifyUiSound(element({class:'av'},element({id:'seats'}), 'div')), 'tap');
  assert.equal(classifyUiSound(element({type:'submit'},element({id:'createForm'}))), 'confirm');
});

test('主要 render markup 明確標記音效，新增靜音位於登出之前', () => {
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  const lobby = read('../js/ui/lobby.js');
  const create = lobby.slice(lobby.indexOf('export function renderCreateRoom'));
  const menu = lobby.slice(lobby.indexOf('id="mpMenu"'), lobby.indexOf('mp-cols'));
  assert.match(create, /<button data-sfx="tick"[^>]*data-chips-minus/);
  assert.match(create, /<button data-sfx="tick"[^>]*data-chips-plus/);
  assert.match(create, /<button data-sfx="confirm" type="submit"/);
  assert.match(lobby, /id="mpBtnMute"[^>]*role="menuitem"[^>]*data-sfx="tap"[^>]*aria-pressed=/);
  assert.ok(lobby.indexOf('id="mpBtnMute"') < lobby.indexOf('data-act="signout"'));
  assert.match(lobby, /setSoundOn\(!isSoundOn\(\)\)/);
  assert.match(menu, /data-act="my-stats"/);
  assert.match(menu, /data-act="signout"/);
  assert.doesNotMatch(menu, /data-act="stats"/);
  assert.doesNotMatch(menu, /data-act="settings"/);
  assert.match(lobby, /class="mp-card mp-c1" data-act="stats"/);
  const mp = read('../js/ui/mp-app.js');
  for (const [attr,kind] of [['minus','tick'],['plus','tick'],['confirm','confirm'],['cancel','tap']]) {
    assert.match(mp, new RegExp(`<button data-sfx="${kind}"[^>]*data-${attr}`));
  }
  const presets = raisePresetsMarkup([{id:'all',label:'全下',to:100}], null);
  assert.match(presets, /<button data-sfx="tap"[^>]*data-to="100"/);
  assert.match(read('../admin/admin.js'), /initSound\(\)/);
});

test('委派只綁一次；子元素一個 click 只播一次，radio 的 label 合成 click 不重播', () => {
  const handlers = [];
  const root = {addEventListener(type, handler, capture) { handlers.push({type,handler,capture}); }};
  wireUiSound(root); wireUiSound(root);
  assert.equal(handlers.length,6);
  assert.deepEqual(handlers.map((h) => h.type).sort(), ['click', 'keydown', 'pointercancel', 'pointerdown', 'pointerup', 'touchend']);
  assert.ok(handlers.every((h) => h.capture === true));
  // No running context means these delegated clicks are safely silent.
  handlers[0].handler({target:element({},element({id:'mpFold'}),'span')});
  handlers[0].handler({target:element({type:'radio'},element({class:'mp-seg-item'}),'input')});
});

test('播放器：樣本增益、共用靜音、tick 上限及與牌桌雙向隔離', async () => {
  const oldWindow = globalThis.window;
  const storage = new Map();
  const gestures = new Map();
  const sources = [], oscillators = [], gains = [];
  const fetched = [];
  let context;
  const param = () => ({setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}});
  class AudioContext {
    constructor() { context=this; this.state='suspended'; this.destination={}; this.currentTime=0; this.sampleRate=22050; }
    resume() { this.state='running'; return Promise.resolve(); }
    decodeAudioData() { return Promise.resolve({ numberOfChannels: 0, length: 0 }); }
    createBuffer() { return {}; }
    createBufferSource() { const node={connect(){},disconnect(){},start(){this.started=true;},stop(){this.stopped=true;}}; sources.push(node); return node; }
    createOscillator() { const node={frequency:param(),connect(){},disconnect(){},start(){this.started=true;},stop(at){ if(at===undefined) this.stopped=true; else this.end=at; }}; oscillators.push(node); return node; }
    createGain() { const node={gain:Object.assign(param(),{value:1}),connect(){},disconnect(){}}; gains.push(node); return node; }
  }
  try {
    globalThis.window={AudioContext,localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},
      document:{hidden:false,addEventListener(){}},addEventListener:(type,fn)=>gestures.set(type,fn),removeEventListener:type=>gestures.delete(type),
      fetch:async(url)=>{ fetched.push(String(url)); return {ok:true,arrayBuffer:async()=>new ArrayBuffer(1)}; }};
    const s=await import('../js/ui/sound.js?ui-isolation');
    assert.deepEqual(s.UI_GAIN, { tap: 0.40, confirm: 0.40, tick: 0.28 });
    s.initSound(); s.playUiSound('tap'); assert.equal(sources.length,0); assert.equal(oscillators.length,0);
    gestures.get('pointerdown')(); await new Promise(setImmediate);
    assert.equal(sources.length,1, '解鎖靜音 buffer');
    assert.ok(!fetched.some((url) => url.endsWith('ui-tap.mp3')));
    assert.ok(fetched.some((url) => url.endsWith('ui-tick.mp3')));
    s.playSound('deal'); const deal=sources.at(-1);
    const beforeTicks=sources.length;
    for(let i=0;i<5;i++) s.playUiSound('tick');
    assert.equal(sources.length, beforeTicks+3); assert.equal(oscillators.length,0); assert.equal(deal.stopped,undefined);
    assert.equal(gains.at(-1).gain.value, 0.28);
    sources[beforeTicks].onended(); s.playUiSound('tick'); assert.equal(sources.length, beforeTicks+4);
    s.playSound('win'); assert.equal(deal.stopped,true);
    assert.ok(sources.slice(beforeTicks).every(n=>!n.stopped));
    s.stopSound(); s.playSound('deal'); assert.equal(sources.at(-1).started,true);
    const afterDeal=sources.length;
    s.playUiSound('tap'); s.playUiSound('confirm');
    assert.equal(sources.length, afterDeal, 'A/B 用合成音，不播樣本');
    assert.equal(oscillators.length,2);
    s.playUiSound('unknown'); s.playUiSound('toString');
    assert.equal(sources.length, afterDeal); assert.equal(oscillators.length,2);
    s.setSoundOn(false); assert.equal(storage.get('poker.sfx'),'off');
    assert.ok(oscillators.every((o)=>o.stopped)); assert.equal(sources.at(-1).stopped,true);
    const countS=sources.length, countO=oscillators.length;
    s.playSound('hurry'); s.playUiSound('tap'); s.playUiSound('tick'); s.playUiSound('confirm');
    assert.equal(sources.length,countS); assert.equal(oscillators.length,countO);
    s.setSoundOn(true); assert.equal(storage.get('poker.sfx'),'on'); s.playUiSound('tap');
    assert.equal(sources.length,countS); assert.equal(oscillators.length,countO+1);
    window.document.hidden=true; s.playUiSound('tap'); assert.equal(oscillators.length,countO+1);
    window.document.hidden=false; context.state='suspended'; context.onstatechange(); s.playUiSound('tap'); assert.equal(oscillators.length,countO+1);
    assert.equal(s.SOUND_OPTIONS.usePlaybackAudioSession,true);
  } finally { if(oldWindow===undefined) delete globalThis.window; else globalThis.window=oldWindow; }
});

test('UI tick 音檔仍在，CREDITS 註明 C 為 Kenney CC0、A／B 為合成', () => {
  const st = statSync(new URL('../assets/sfx/ui-tick.mp3', import.meta.url));
  assert.ok(st.size > 500 && st.size < 8000, 'ui-tick');
  let missing = false;
  try { statSync(new URL('../assets/sfx/ui-tap.mp3', import.meta.url)); }
  catch { missing = true; }
  assert.equal(missing, true, 'ui-tap.mp3 should be removed');
  const credits = readFileSync(new URL('../assets/sfx/CREDITS.md', import.meta.url), 'utf8');
  assert.doesNotMatch(credits, /ui-tap\.mp3/);
  assert.match(credits, /ui-tick\.mp3/);
  assert.match(credits, /chip-lay-1/);
  assert.match(credits, /https:\/\/kenney\.nl\/assets\/casino-audio/);
  assert.match(credits, /CC0 1\.0/);
  assert.match(credits, /660→990Hz/);
});

test('UI 目的地音量與牌桌音在合理比例：略小於下注，不小於發牌的一半', () => {
  // playSound connects table buffers at gain 1. Peaks measured from the shipped
  // mp3s (ffmpeg and Chromium decodeAudioData). UI destination peak equals UI_GAIN[kind].
  const table = { deal: 0.273, bet: 0.775 };
  assert.equal(UI_GAIN.tap, UI_GAIN.confirm);
  assert.ok(Math.abs(UI_GAIN.tick - 0.7 * UI_GAIN.confirm) < 1e-12);
  for (const [kind, peak] of Object.entries(UI_GAIN)) {
    assert.ok(peak < table.bet, `${kind} must be softer than bet (${peak} vs ${table.bet})`);
    assert.ok(peak >= 0.5 * table.deal, `${kind} must stay audible vs deal (${peak} vs 0.5*${table.deal})`);
    const vsBet = peak / table.bet;
    assert.ok(vsBet >= 0.25 && vsBet <= 0.9, `${kind} / bet = ${vsBet}`);
  }
});

test('解鎖事件包含 iOS 有效的 pointerup／touchend／click', () => {
  for (const type of ['pointerup', 'touchend', 'click', 'keydown']) {
    assert.ok(SOUND_UNLOCK_EVENTS.includes(type), type);
  }
});

test('大廳第一次：touch 的 pointerdown 不播，pointerup／click 才播', async () => {
  const oldWindow = globalThis.window;
  const storage = new Map();
  const gestures = new Map();
  const sources = [], oscillators = [];
  const handlers = [];
  class AudioContext {
    constructor() { this.state = 'suspended'; this.destination = {}; this.currentTime = 0; this.sampleRate = 22050; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    decodeAudioData() {
      const data = new Float32Array([0.9, -0.9, 0.5]);
      return Promise.resolve({
        numberOfChannels: 1, length: data.length, duration: 0.001, getChannelData: () => data,
      });
    }
    createBuffer() { return { length: 1 }; }
    createBufferSource() {
      const node = { connect() {}, disconnect() {}, start() { this.started = true; }, stop() { this.stopped = true; } };
      sources.push(node);
      return node;
    }
    createGain() { return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    createOscillator() { const node={frequency:{setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){},start(){this.started=true;},stop(){}}; oscillators.push(node); return node; }
  }
  try {
    const root = { addEventListener(type, handler, capture) { handlers.push({ type, handler, capture }); } };
    globalThis.window = {
      AudioContext,
      localStorage: { getItem: (k) => storage.get(k), setItem: (k, v) => storage.set(k, v) },
      document: { hidden: false, addEventListener() {}, ...root },
      addEventListener: (type, fn) => gestures.set(type, fn),
      removeEventListener: (type) => gestures.delete(type),
      fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }),
    };
    const s = await import('../js/ui/sound.js?first-pointerup');
    s.initSound();
    assert.equal(s.isSoundOn(), true);
    await new Promise(setImmediate);
    const down = handlers.find((h) => h.type === 'pointerdown');
    const up = handlers.find((h) => h.type === 'pointerup');
    assert.ok(down && up, 'document pointerdown + pointerup listeners');
    const btn = element({ 'data-sfx': 'tap' });
    // Touch pointerdown is not an activation event (HTML / WebKit).
    gestures.get('pointerdown')();
    const afterUnlock = sources.length;
    down.handler({ type: 'pointerdown', button: 0, pointerType: 'touch', target: btn });
    assert.equal(sources.length, afterUnlock, 'touch pointerdown must not play');
    assert.equal(oscillators.length, 0, 'touch pointerdown must not start the B tone');
    up.handler({ type: 'pointerup', button: 0, pointerType: 'touch', target: btn });
    assert.equal(oscillators.length, 1, 'touch pointerup plays the B confirm tone for A');
    assert.equal(sources.length, afterUnlock, 'A no longer plays a sample');
    assert.ok(gestures.has('click') && gestures.has('pointerup') && gestures.has('touchend'), 'unlock listeners include activation events');
  } finally {
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
  }
});

test('同一次觸控的 pointerup／touchend／click 只播一聲；滑鼠也只一聲；連點 −／＋ 仍可各播', async () => {
  const oldWindow = globalThis.window;
  const oldPerf = globalThis.performance;
  const storage = new Map();
  const gestures = new Map();
  const oscillators = [];
  const sources = [];
  const handlers = [];
  let now = 0;
  globalThis.performance = { now: () => now };
  class AudioContext {
    constructor() { this.state = 'suspended'; this.destination = {}; this.currentTime = 0; this.sampleRate = 22050; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    decodeAudioData() {
      const data = new Float32Array([0.9, -0.9, 0.5]);
      return Promise.resolve({
        numberOfChannels: 1, length: data.length, duration: 0.001, getChannelData: () => data,
      });
    }
    createBuffer() { return { length: 1, duration: 0.05, getChannelData: () => new Float32Array([0.5]) }; }
    createBufferSource() {
      const node = { connect() {}, disconnect() {}, start() { this.started = true; }, stop() { this.stopped = true; } };
      sources.push(node);
      return node;
    }
    createGain() { return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    createOscillator() { const node={frequency:{setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){},start(){this.started=true;},stop(){}}; oscillators.push(node); return node; }
  }
  try {
    const root = { addEventListener(type, handler, capture) { handlers.push({ type, handler, capture }); } };
    globalThis.window = {
      AudioContext,
      localStorage: { getItem: (k) => storage.get(k), setItem: (k, v) => storage.set(k, v) },
      document: { hidden: false, addEventListener() {}, ...root },
      addEventListener: (type, fn) => gestures.set(type, fn),
      removeEventListener: (type) => gestures.delete(type),
      fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }),
    };
    const s = await import('../js/ui/sound.js?touch-dedupe');
    s.initSound();
    await new Promise(setImmediate);
    gestures.get('pointerdown')?.();
    const byType = Object.fromEntries(handlers.map((h) => [h.type, h.handler]));
    const tap = element({ 'data-sfx': 'tap' });
    const plus = element({ 'data-sfx': 'tick', 'data-plus': '' });

    now = 0;
    byType.pointerdown({ type: 'pointerdown', button: 0, pointerType: 'touch', target: tap });
    byType.pointerup({ type: 'pointerup', button: 0, pointerType: 'touch', target: tap });
    byType.touchend({ type: 'touchend', target: tap });
    now = 80;
    byType.click({ type: 'click', button: 0, target: tap });
    assert.equal(oscillators.length, 1, 'one touch tap must play one confirm tone');

    now = 1000;
    byType.pointerdown({ type: 'pointerdown', button: 0, pointerType: 'mouse', target: tap });
    now = 1080;
    byType.click({ type: 'click', button: 0, target: tap });
    assert.equal(oscillators.length, 2, 'one mouse click must play one confirm tone');

    const beforeTick = sources.length;
    now = 2000;
    byType.pointerdown({ type: 'pointerdown', button: 0, pointerType: 'touch', target: plus });
    byType.pointerup({ type: 'pointerup', button: 0, pointerType: 'touch', target: plus });
    byType.touchend({ type: 'touchend', target: plus });
    now = 2050;
    byType.pointerdown({ type: 'pointerdown', button: 0, pointerType: 'touch', target: plus });
    byType.pointerup({ type: 'pointerup', button: 0, pointerType: 'touch', target: plus });
    byType.touchend({ type: 'touchend', target: plus });
    now = 2100;
    byType.pointerdown({ type: 'pointerdown', button: 0, pointerType: 'touch', target: plus });
    byType.pointerup({ type: 'pointerup', button: 0, pointerType: 'touch', target: plus });
    byType.touchend({ type: 'touchend', target: plus });
    assert.equal(sources.length - beforeTick, 3, 'three rapid + taps 50ms apart must each play a tick');
    assert.equal(oscillators.length, 2, 'rapid ticks must not add confirm tones');
  } finally {
    if (oldPerf === undefined) delete globalThis.performance; else globalThis.performance = oldPerf;
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
  }
});

test('滑鼠或觸控按住超過 120ms 只播一聲；鍵盤 click 仍各播一次；連點 −／＋ 仍可各播', async () => {
  const oldWindow = globalThis.window;
  const oldPerf = globalThis.performance;
  const storage = new Map();
  const gestures = new Map();
  const oscillators = [];
  const sources = [];
  const handlers = [];
  let now = 0;
  globalThis.performance = { now: () => now };
  class AudioContext {
    constructor() { this.state = 'suspended'; this.destination = {}; this.currentTime = 0; this.sampleRate = 22050; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    decodeAudioData() {
      const data = new Float32Array([0.9, -0.9, 0.5]);
      return Promise.resolve({
        numberOfChannels: 1, length: data.length, duration: 0.001, getChannelData: () => data,
      });
    }
    createBuffer() { return { length: 1, duration: 0.05, getChannelData: () => new Float32Array([0.5]) }; }
    createBufferSource() {
      const node = { connect() {}, disconnect() {}, start() { this.started = true; }, stop() { this.stopped = true; } };
      sources.push(node);
      return node;
    }
    createGain() { return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    createOscillator() { const node={frequency:{setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){},start(){this.started=true;},stop(){}}; oscillators.push(node); return node; }
  }
  try {
    const root = { addEventListener(type, handler, capture) { handlers.push({ type, handler, capture }); } };
    globalThis.window = {
      AudioContext,
      localStorage: { getItem: (k) => storage.get(k), setItem: (k, v) => storage.set(k, v) },
      document: { hidden: false, addEventListener() {}, ...root },
      addEventListener: (type, fn) => gestures.set(type, fn),
      removeEventListener: (type) => gestures.delete(type),
      fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }),
    };
    const s = await import('../js/ui/sound.js?held-press');
    s.initSound();
    await new Promise(setImmediate);
    gestures.get('pointerdown')?.();
    const byType = Object.fromEntries(handlers.map((h) => [h.type, h.handler]));
    const tap = element({ 'data-sfx': 'tap' });
    const plus = element({ 'data-sfx': 'tick', 'data-plus': '' });

    now = 0;
    byType.pointerdown({ type: 'pointerdown', button: 0, pointerType: 'mouse', target: tap });
    now = 200;
    byType.pointerup({ type: 'pointerup', button: 0, pointerType: 'mouse', target: tap });
    byType.click({ type: 'click', button: 0, target: tap });
    assert.equal(oscillators.length, 1, 'held mouse press must play once, not again on click after 200ms');

    now = 1000;
    byType.pointerdown({ type: 'pointerdown', button: 0, pointerType: 'touch', target: tap });
    now = 1200;
    byType.pointerup({ type: 'pointerup', button: 0, pointerType: 'touch', target: tap });
    byType.touchend({ type: 'touchend', target: tap });
    now = 1203;
    byType.click({ type: 'click', button: 0, target: tap });
    assert.equal(oscillators.length, 2, 'held touch press must play once');

    now = 2000;
    byType.click({ type: 'click', button: 0, target: tap });
    now = 2300;
    byType.click({ type: 'click', button: 0, target: tap });
    assert.equal(oscillators.length, 4, 'keyboard Enter/Space clicks each play once');

    const beforeTick = sources.length;
    now = 4000;
    byType.pointerdown({ type: 'pointerdown', button: 0, pointerType: 'mouse', target: plus });
    now = 4200;
    byType.click({ type: 'click', button: 0, target: plus });
    now = 4250;
    byType.pointerdown({ type: 'pointerdown', button: 0, pointerType: 'mouse', target: plus });
    now = 4450;
    byType.click({ type: 'click', button: 0, target: plus });
    assert.equal(sources.length - beforeTick, 2, 'two held mouse + taps must each play a tick');
  } finally {
    if (oldPerf === undefined) delete globalThis.performance; else globalThis.performance = oldPerf;
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
  }
});

test('取消按壓後鍵盤 Enter 仍播一聲（pointercancel／keydown 會重設旗標）', async () => {
  const oldWindow = globalThis.window;
  const oldPerf = globalThis.performance;
  const storage = new Map();
  const gestures = new Map();
  const oscillators = [];
  const handlers = [];
  let now = 0;
  globalThis.performance = { now: () => now };
  class AudioContext {
    constructor() { this.state = 'suspended'; this.destination = {}; this.currentTime = 0; this.sampleRate = 22050; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    decodeAudioData() {
      const data = new Float32Array([0.9, -0.9, 0.5]);
      return Promise.resolve({
        numberOfChannels: 1, length: data.length, duration: 0.001, getChannelData: () => data,
      });
    }
    createBuffer() { return { length: 1, duration: 0.05, getChannelData: () => new Float32Array([0.5]) }; }
    createBufferSource() {
      return { connect() {}, disconnect() {}, start() { this.started = true; }, stop() { this.stopped = true; } };
    }
    createGain() { return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    createOscillator() { const node={frequency:{setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){},start(){this.started=true;},stop(){}}; oscillators.push(node); return node; }
  }
  try {
    const root = { addEventListener(type, handler, capture) { handlers.push({ type, handler, capture }); } };
    globalThis.window = {
      AudioContext,
      localStorage: { getItem: (k) => storage.get(k), setItem: (k, v) => storage.set(k, v) },
      document: { hidden: false, addEventListener() {}, ...root },
      addEventListener: (type, fn) => gestures.set(type, fn),
      removeEventListener: (type) => gestures.delete(type),
      fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }),
    };
    const s = await import('../js/ui/sound.js?cancel-press');
    s.initSound();
    await new Promise(setImmediate);
    gestures.get('pointerdown')?.();
    const byType = Object.fromEntries(handlers.map((h) => [h.type, h.handler]));
    const tap = element({ 'data-sfx': 'tap' });

    now = 0;
    byType.pointerdown({ type: 'pointerdown', button: 0, pointerType: 'mouse', target: tap });
    now = 200;
    byType.pointerup({ type: 'pointerup', button: 0, pointerType: 'mouse', target: tap });
    // Slid off: no click. keydown must clear the flag before the Enter click.
    byType.keydown({ type: 'keydown', key: 'Enter', target: tap });
    now = 250;
    byType.click({ type: 'click', button: 0, target: tap });
    assert.equal(oscillators.length, 2, 'keyboard Enter after a slid-off mouse press must still play');

    now = 1000;
    byType.pointerdown({ type: 'pointerdown', button: 0, pointerType: 'mouse', target: tap });
    now = 1100;
    byType.pointercancel({ type: 'pointercancel', button: 0, pointerType: 'mouse', target: tap });
    now = 1200;
    byType.click({ type: 'click', button: 0, target: tap });
    assert.equal(oscillators.length, 4, 'click after pointercancel must play (flag was reset)');
  } finally {
    if (oldPerf === undefined) delete globalThis.performance; else globalThis.performance = oldPerf;
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
  }
});


test('背景返回後按鍵會 resume suspended／interrupted 並播一聲', async () => {
  for (const returnedState of ['suspended', 'interrupted']) {
    const oldWindow = globalThis.window;
    const oldPerf = globalThis.performance;
    const storage = new Map();
    const gestures = new Map();
    const oscillators = [];
    const handlers = [];
    let visibility;
    let audio;
    let created = 0;
    let now = 0;
    globalThis.performance = { now: () => now };
    class AudioContext {
      constructor() {
        created += 1;
        audio = this;
        this.state = 'suspended';
        this.destination = {};
        this.currentTime = 0;
        this.sampleRate = 22050;
        this.resumed = 0;
      }
      resume() {
        this.resumed += 1;
        if (this.state === 'closed') return Promise.reject(new Error('closed'));
        if (this.blockResume) return Promise.reject(new Error('interrupted'));
        this.state = 'running';
        return Promise.resolve();
      }
      close() { this.state = 'closed'; }
      decodeAudioData() { return Promise.resolve({ numberOfChannels: 0, length: 0 }); }
      createBuffer() { return {}; }
      createBufferSource() {
        return { connect() {}, disconnect() {}, start() { this.started = true; }, stop() { this.stopped = true; } };
      }
      createGain() { return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
      createOscillator() { const node={frequency:{setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){},start(){this.started=true;},stop(){}}; oscillators.push(node); return node; }
    }
    try {
      globalThis.window = {
        AudioContext,
        localStorage: { getItem: (k) => storage.get(k), setItem: (k, v) => storage.set(k, v) },
        document: {
          hidden: false,
          addEventListener(type, handler, capture) {
            if (type === 'visibilitychange') visibility = handler;
            else handlers.push({ type, handler, capture });
          },
        },
        addEventListener: (type, fn) => gestures.set(type, fn),
        removeEventListener: (type) => gestures.delete(type),
        fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }),
      };
      const s = await import(`../js/ui/sound.js?resume-after-bg-${returnedState}`);
      s.initSound();
      await new Promise(setImmediate);
      assert.equal(typeof gestures.get('pageshow'), 'function', 'pageshow 重設解鎖');
      assert.equal(typeof gestures.get('focus'), 'function', 'focus 重設解鎖');
      gestures.get('pointerdown')();
      await new Promise(setImmediate);
      assert.equal(audio.state, 'running');
      const firstResumes = audio.resumed;
      now = 5000;
      window.document.hidden = true;
      visibility();
      audio.state = returnedState;
      audio.blockResume = true;
      if (audio.onstatechange) audio.onstatechange();
      window.document.hidden = false;
      visibility();
      await new Promise(setImmediate);
      assert.equal(audio.state, returnedState, 'visibility 時沒有使用者啟動，state 維持中斷');
      assert.equal(typeof gestures.get('pointerup'), 'function', `${returnedState} 返回後應重新掛解鎖手勢`);
      audio.blockResume = false;
      const byType = Object.fromEntries(handlers.map((h) => [h.type, h.handler]));
      const tap = element({ 'data-sfx': 'tap' });
      const before = oscillators.length;
      // Window unlock (capture) then the button click.
      gestures.get('click')();
      byType.click({ type: 'click', button: 0, target: tap });
      assert.equal(audio.state, 'running', `${returnedState} 按鍵後應 resume`);
      assert.ok(audio.resumed > firstResumes, `${returnedState} 應呼叫 resume`);
      assert.equal(oscillators.length, before + 1, `${returnedState} 按鍵應播一聲`);
      s.setSoundOn(false);
      gestures.get('click')();
      byType.click({ type: 'click', button: 0, target: tap });
      assert.equal(oscillators.length, before + 1, '音效關閉後不播');
      s.setSoundOn(true);
    } finally {
      if (oldPerf === undefined) delete globalThis.performance; else globalThis.performance = oldPerf;
      if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
    }
  }
});

test('visibility 仍為 running 時 pageshow／focus 也會重掛解鎖；closed 會重建', async () => {
  const oldWindow = globalThis.window;
  const oldPerf = globalThis.performance;
  const storage = new Map();
  const gestures = new Map();
  const oscillators = [];
  const handlers = [];
  let visibility;
  let audio;
  let created = 0;
  let now = 0;
  globalThis.performance = { now: () => now };
  class AudioContext {
    constructor() {
      created += 1;
      audio = this;
      this.state = 'suspended';
      this.destination = {};
      this.currentTime = 0;
      this.sampleRate = 22050;
      this.resumed = 0;
    }
    resume() {
      this.resumed += 1;
      if (this.state === 'closed') return Promise.reject(new Error('closed'));
      this.state = 'running';
      return Promise.resolve();
    }
    close() { this.state = 'closed'; }
    decodeAudioData() { return Promise.resolve({ numberOfChannels: 0, length: 0 }); }
    createBuffer() { return {}; }
    createBufferSource() {
      return { connect() {}, disconnect() {}, start() { this.started = true; }, stop() { this.stopped = true; } };
    }
    createGain() { return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    createOscillator() { const node={frequency:{setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){},start(){this.started=true;},stop(){}}; oscillators.push(node); return node; }
  }
  try {
    globalThis.window = {
      AudioContext,
      localStorage: { getItem: (k) => storage.get(k), setItem: (k, v) => storage.set(k, v) },
      document: {
        hidden: false,
        addEventListener(type, handler, capture) {
          if (type === 'visibilitychange') visibility = handler;
          else handlers.push({ type, handler, capture });
        },
      },
      addEventListener: (type, fn) => gestures.set(type, fn),
      removeEventListener: (type) => gestures.delete(type),
      fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }),
    };
    const s = await import('../js/ui/sound.js?resume-closed-and-focus');
    s.initSound();
    await new Promise(setImmediate);
    gestures.get('pointerdown')();
    await new Promise(setImmediate);
    assert.equal(created, 1);
    assert.equal(typeof gestures.get('pointerdown'), 'undefined', '首次解鎖後卸下手勢');
    now = 5000;
    // State still 'running' (WebKit stale-running after app switch).
    gestures.get('focus')();
    assert.equal(typeof gestures.get('pointerdown'), 'function', 'focus 時即使 state=running 也重掛');
    gestures.get('pointerdown')();
    await new Promise(setImmediate);
    assert.equal(typeof gestures.get('pointerdown'), 'undefined', '解鎖成功後再次卸下');
    gestures.get('pageshow')();
    assert.equal(typeof gestures.get('pointerdown'), 'function', 'pageshow 同樣重掛');

    const byType = Object.fromEntries(handlers.map((h) => [h.type, h.handler]));
    const tap = element({ 'data-sfx': 'tap' });
    audio.state = 'closed';
    window.document.hidden = true;
    visibility();
    window.document.hidden = false;
    visibility();
    await new Promise(setImmediate);
    const before = oscillators.length;
    gestures.get('click')();
    byType.click({ type: 'click', button: 0, target: tap });
    assert.equal(created, 2, 'closed 的 context 應重建');
    assert.equal(audio.state, 'running');
    assert.equal(oscillators.length, before + 1, '重建後按鍵應播一聲');
  } finally {
    if (oldPerf === undefined) delete globalThis.performance; else globalThis.performance = oldPerf;
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
  }
});
