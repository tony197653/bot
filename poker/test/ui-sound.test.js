import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { classifyUiSound, wireUiSound } from '../js/ui/sound.js';
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

test('主要 render markup 明確標記音效，新增靜音位於設定之前', () => {
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  const lobby = read('../js/ui/lobby.js');
  const create = lobby.slice(lobby.indexOf('export function renderCreateRoom'));
  assert.match(create, /<button data-sfx="tick"[^>]*data-chips-minus/);
  assert.match(create, /<button data-sfx="tick"[^>]*data-chips-plus/);
  assert.match(create, /<button data-sfx="confirm" type="submit"/);
  assert.match(lobby, /id="mpBtnMute"[^>]*role="menuitem"[^>]*data-sfx="tap"[^>]*aria-pressed=/);
  assert.ok(lobby.indexOf('id="mpBtnMute"') < lobby.indexOf('data-act="settings"'));
  assert.match(lobby, /setSoundOn\(!isSoundOn\(\)\)/);
  assert.match(lobby, /settings: \(\) => vm.onSettings\?\.\(\)/);
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
  assert.equal(handlers.length,1);
  assert.equal(handlers[0].type,'click');
  assert.equal(handlers[0].capture,true);
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
    assert.deepEqual(s.UI_GAIN, { tap: 0.028, confirm: 0.035, tick: 0.0245 });
    s.initSound(); s.playUiSound('tap'); assert.equal(sources.length,0); assert.equal(oscillators.length,0);
    gestures.get('pointerdown')(); await new Promise(setImmediate);
    assert.equal(sources.length,1, '解鎖靜音 buffer');
    assert.ok(fetched.some((url) => url.endsWith('ui-tap.mp3')));
    assert.ok(fetched.some((url) => url.endsWith('ui-tick.mp3')));
    s.playSound('deal'); const deal=sources.at(-1);
    const beforeTicks=sources.length;
    for(let i=0;i<5;i++) s.playUiSound('tick');
    assert.equal(sources.length, beforeTicks+3); assert.equal(oscillators.length,0); assert.equal(deal.stopped,undefined);
    assert.equal(gains.at(-1).gain.value, 0.0245);
    sources[beforeTicks].onended(); s.playUiSound('tick'); assert.equal(sources.length, beforeTicks+4);
    s.playSound('win'); assert.equal(deal.stopped,true);
    assert.ok(sources.slice(beforeTicks).every(n=>!n.stopped));
    s.stopSound(); s.playSound('deal'); assert.equal(sources.at(-1).started,true);
    const afterDeal=sources.length;
    s.playUiSound('tap'); s.playUiSound('confirm');
    assert.equal(sources.length, afterDeal+1);
    assert.equal(oscillators.length,1);
    assert.equal(gains.filter(g => g.gain.value===0.028).length,1);
    s.playUiSound('unknown'); s.playUiSound('toString');
    assert.equal(sources.length, afterDeal+1); assert.equal(oscillators.length,1);
    s.setSoundOn(false); assert.equal(storage.get('poker.sfx'),'off');
    assert.equal(oscillators[0].stopped,true); assert.equal(sources.at(-1).stopped,true);
    const countS=sources.length, countO=oscillators.length;
    s.playSound('hurry'); s.playUiSound('tap'); s.playUiSound('tick'); s.playUiSound('confirm');
    assert.equal(sources.length,countS); assert.equal(oscillators.length,countO);
    s.setSoundOn(true); assert.equal(storage.get('poker.sfx'),'on'); s.playUiSound('tap');
    assert.equal(sources.length,countS+1); assert.equal(oscillators.length,countO);
    window.document.hidden=true; s.playUiSound('tap'); assert.equal(sources.length,countS+1);
    window.document.hidden=false; context.state='suspended'; s.playUiSound('tap'); assert.equal(sources.length,countS+1);
    assert.equal(s.SOUND_OPTIONS.usePlaybackAudioSession,true);
  } finally { if(oldWindow===undefined) delete globalThis.window; else globalThis.window=oldWindow; }
});

test('UI 音檔已進 assets，CREDITS 註明 Kenney CC0 來源', () => {
  for (const name of ['ui-tap', 'ui-tick']) {
    const st = statSync(new URL(`../assets/sfx/${name}.mp3`, import.meta.url));
    assert.ok(st.size > 500 && st.size < 8000, name);
  }
  const credits = readFileSync(new URL('../assets/sfx/CREDITS.md', import.meta.url), 'utf8');
  assert.match(credits, /ui-tap\.mp3/);
  assert.match(credits, /drop_003/);
  assert.match(credits, /https:\/\/kenney\.nl\/assets\/interface-sounds/);
  assert.match(credits, /ui-tick\.mp3/);
  assert.match(credits, /chip-lay-1/);
  assert.match(credits, /https:\/\/kenney\.nl\/assets\/casino-audio/);
  assert.match(credits, /CC0 1\.0/);
  assert.match(credits, /Web Audio 合成，未改/);
});
