/**
 * Regression: approved #20 raise quick-picks must stay wired in both solo and MP.
 * Engine raisePresets alone is not enough — M2 openMpRaise once shipped slider-only
 * and left #presets empty; layout-overlap only audited solo.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createInitialState,
  applyAction,
  raisePresets,
  mulberry32,
  PHASE,
  getLegalActions,
} from '../js/engine/index.js';
import { raisePresetsMarkup, fmtChips } from '../js/ui/cards-dom.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

function seatAll(s, names, chips) {
  let st = s;
  names.forEach((name, i) => {
    st = applyAction(st, {
      type: 'SEAT',
      seat: i,
      name,
      buyIn: chips ?? st.config.startingStack,
      isHost: i === 0,
    });
  });
  return st;
}

function start(st, seed = 1) {
  return applyAction(st, { type: 'START_HAND' }, { randUnit: mulberry32(seed), now: 1_000_000 });
}

function act(st, type, extra = {}, now = 1_000_000) {
  return applyAction(st, { type, seat: st.actor, ...extra }, { now, randUnit: mulberry32(99) });
}

/** Parse raisePresetsMarkup into structured buttons (no DOM lib required). */
function parsePresetButtons(html) {
  const buttons = [];
  const re =
    /<button type="button" data-to="(\d+)" data-id="([^"]+)" aria-pressed="(true|false)"><span class="preset-lbl">([^<]*)<\/span><span class="preset-amt">([^<]*)<\/span><\/button>/g;
  let m;
  while ((m = re.exec(html))) {
    buttons.push({
      to: Number(m[1]),
      id: m[2],
      pressed: m[3] === 'true',
      label: m[4],
      amt: m[5],
    });
  }
  return buttons;
}

function assertQuickPickDom(presets, selectedTo, expectedLabels) {
  const html = raisePresetsMarkup(presets, selectedTo);
  const buttons = parsePresetButtons(html);
  assert.equal(buttons.length, 6, `want 6 quick-picks, got ${buttons.length}: ${html}`);
  assert.deepEqual(
    buttons.map((b) => b.label),
    expectedLabels,
  );
  for (const b of buttons) {
    assert.equal(b.amt, fmtChips(b.to), `amount under「${b.label}」`);
    assert.ok(b.amt.length > 0, `empty amount under「${b.label}」`);
    assert.equal(b.pressed, b.to === selectedTo);
  }
  // Grid contract: every button carries label + amount spans
  assert.equal((html.match(/preset-lbl/g) || []).length, 6);
  assert.equal((html.match(/preset-amt/g) || []).length, 6);
  return buttons;
}

describe('加注面板 DOM：三組快捷鍵＋金額標籤（#20 regression）', () => {
  it('翻牌前未加注：最小 / 2.5 / 3 / 4 / 5 大盲 / 全下，金額在標籤下', () => {
    let s = createInitialState({ timerEnabled: false, bigBlind: 20, startingStack: 2000 });
    s = seatAll(s, ['宗良', '阿哲', '小芸']);
    s = start(s, 42);
    const seat = s.actor;
    const presets = raisePresets(s, seat);
    const preferred = presets.find((p) => p.preferred)?.to ?? presets[0].to;
    const buttons = assertQuickPickDom(presets, preferred, [
      '最小',
      '2.5 大盲',
      '3 大盲',
      '4 大盲',
      '5 大盲',
      '全下',
    ]);
    assert.equal(buttons.find((b) => b.id === '3bb')?.to, 60);
    assert.equal(buttons.find((b) => b.id === '3bb')?.amt, '60');
    assert.equal(buttons.find((b) => b.id === '3bb')?.pressed, true);
  });

  it('翻牌前面對加注：最小 / 2.5 / 3 / 4 倍 / 一池 / 全下，金額在標籤下', () => {
    let s = createInitialState({ timerEnabled: false, bigBlind: 20, startingStack: 2000 });
    s = seatAll(s, ['宗良', '阿哲', '小芸']);
    s = start(s, 7);
    s = act(s, 'BET_RAISE', { amount: 60 });
    assert.equal(s.phase, PHASE.PREFLOP);
    assert.ok(s.currentBet > s.config.bigBlind);
    const seat = s.actor;
    const presets = raisePresets(s, seat);
    const preferred = presets.find((p) => p.preferred)?.to ?? presets[0].to;
    assertQuickPickDom(presets, preferred, [
      '最小',
      '2.5 倍',
      '3 倍',
      '4 倍',
      '一池',
      '全下',
    ]);
  });

  it('翻牌後：最小 / 1/3 池 / 半池 / 2/3 池 / 一池 / 全下，金額在標籤下', () => {
    let s = createInitialState({ timerEnabled: false, bigBlind: 20, startingStack: 2000 });
    s = seatAll(s, ['宗良', '阿哲', '小芸']);
    s = start(s, 3);
    let guard = 0;
    while (s.phase === PHASE.PREFLOP && guard++ < 12) {
      const L = getLegalActions(s, s.actor);
      if (L.call) s = act(s, 'CALL');
      else if (L.check) s = act(s, 'CHECK');
      else break;
    }
    assert.equal(s.phase, PHASE.FLOP);
    const seat = s.actor;
    const presets = raisePresets(s, seat);
    const preferred = presets.find((p) => p.preferred)?.to ?? presets[0].to;
    assertQuickPickDom(presets, preferred, [
      '最小',
      '1/3 池',
      '半池',
      '2/3 池',
      '一池',
      '全下',
    ]);
  });
});

describe('加注面板 wiring：MP / solo / HTML 不得再漏接 #presets', () => {
  it('index.html 保留 #raisePanel + #presets 容器', () => {
    const html = read('index.html');
    assert.match(html, /id="raisePanel"/);
    assert.match(html, /id="presets"/);
    assert.match(html, /id="raiseMinus"/);
    assert.match(html, /id="raisePlus"/);
  });

  it('solo openRaisePanel 用 raisePresetsMarkup 填 #presets', () => {
    const src = read('js/ui/app.js');
    assert.match(src, /raisePresetsMarkup/);
    const open = src.slice(src.indexOf('function openRaisePanel'), src.indexOf('function openRaisePanel') + 1800);
    assert.match(open, /raisePresetsMarkup\s*\(/);
    assert.match(open, /\$\(['"]#presets['"]\)\.innerHTML/);
    assert.match(open, /bindRaiseStep/);
  });

  it('MP openMpRaise 必須填 #presets（regression vs 24e7322/7bbe896 slider-only）', () => {
    const src = read('js/ui/mp-app.js');
    assert.match(src, /raisePresetsMarkup/);
    assert.match(src, /function openMpRaise/);
    const open = src.slice(src.indexOf('function openMpRaise'), src.indexOf('function openMpRaise') + 2800);
    assert.match(open, /raisePresetsMarkup\s*\(/);
    assert.match(open, /#presets/);
    assert.match(open, /presetsEl\.innerHTML\s*=\s*raisePresetsMarkup/);
    // hold-to-repeat, not one-shot onclick ±
    assert.match(src, /function bindMpRaiseStep/);
    assert.match(src, /pointerdown/);
    // Must not regress to min-only BET_RAISE without panel presets
    assert.doesNotMatch(
      open,
      /raiseMinus['"]\)\.onclick/,
      'MP ± must use hold-to-repeat bindMpRaiseStep, not bare onclick',
    );
  });
});
