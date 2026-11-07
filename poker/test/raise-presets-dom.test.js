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
import { raisePresetsMarkup, raisePanelCopy, fmtChips } from '../js/ui/cards-dom.js';

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

function assertQuickPickDom(presets, selectedId, expectedLabels) {
  const html = raisePresetsMarkup(presets, selectedId);
  const buttons = parsePresetButtons(html);
  assert.equal(buttons.length, 6, `want 6 quick-picks, got ${buttons.length}: ${html}`);
  assert.deepEqual(
    buttons.map((b) => b.label),
    expectedLabels,
  );
  for (const b of buttons) {
    assert.equal(b.amt, fmtChips(b.to), `amount under「${b.label}」`);
    assert.ok(b.amt.length > 0, `empty amount under「${b.label}」`);
    assert.equal(b.pressed, b.id === selectedId);
  }
  // Exactly one pressed when an id is selected
  if (selectedId) {
    assert.equal(buttons.filter((b) => b.pressed).length, 1);
  } else {
    assert.equal(buttons.filter((b) => b.pressed).length, 0);
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
    const preferred = presets.find((p) => p.preferred);
    const buttons = assertQuickPickDom(presets, preferred?.id, [
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
    const preferred = presets.find((p) => p.preferred);
    assertQuickPickDom(presets, preferred?.id, [
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
    const preferred = presets.find((p) => p.preferred);
    assertQuickPickDom(presets, preferred?.id, [
      '最小',
      '1/3 池',
      '半池',
      '2/3 池',
      '一池',
      '全下',
    ]);
  });

  it('#1 相同金額只亮使用者點的那顆（或預設），不因 to 相同全亮', () => {
    // Synthetic: 3x and pot both resolve to 180
    const presets = [
      { id: 'min', label: '最小', to: 120 },
      { id: '2.5x', label: '2.5 倍', to: 150 },
      { id: '3x', label: '3 倍', to: 180 },
      { id: '4x', label: '4 倍', to: 240 },
      { id: 'pot', label: '一池', to: 180 },
      { id: 'allin', label: '全下', to: 2000 },
    ];
    assert.equal(presets.filter((p) => p.to === 180).length, 2);

    // Default preselect = preferred 3x only
    let buttons = parsePresetButtons(raisePresetsMarkup(presets, '3x'));
    assert.deepEqual(
      buttons.filter((b) => b.pressed).map((b) => b.id),
      ['3x'],
    );
    assert.equal(buttons.find((b) => b.id === 'pot')?.pressed, false);

    // User taps 一池 — only pot lights, even though amount still 180
    buttons = parsePresetButtons(raisePresetsMarkup(presets, 'pot'));
    assert.deepEqual(
      buttons.filter((b) => b.pressed).map((b) => b.id),
      ['pot'],
    );
    assert.equal(buttons.find((b) => b.id === '3x')?.pressed, false);

    // Slider drift (no id) — none pressed despite amount 180 matching two
    buttons = parsePresetButtons(raisePresetsMarkup(presets, null));
    assert.equal(buttons.filter((b) => b.pressed).length, 0);
  });

  it('#3 標題與確認鈕同一動詞：無注→下注，否則加注到', () => {
    const bet = raisePanelCopy(true, 90);
    assert.equal(bet.verb, '下注');
    assert.equal(bet.title, '下注 90');
    assert.equal(bet.confirm, '確認下注 90');
    assert.equal(bet.minHint, '最少下注 90');
    assert.match(bet.title, /^下注 /);
    assert.match(bet.confirm, /^確認下注 /);

    const raise = raisePanelCopy(false, 180);
    assert.equal(raise.verb, '加注到');
    assert.equal(raise.title, '加注到 180');
    assert.equal(raise.confirm, '確認加注到 180');
    assert.equal(raise.minHint, '最少加到 180');

    // Postflop opening bet uses same 下注 path as isBet
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
    assert.equal(s.currentBet, 0);
    const L = getLegalActions(s, s.actor);
    assert.equal(L.bet, true);
    const preferred = raisePresets(s, s.actor).find((p) => p.preferred);
    const copy = raisePanelCopy(!!L.bet, preferred?.to ?? L.minRaiseTo);
    assert.equal(copy.verb, '下注');
    assert.equal(copy.title, `下注 ${fmtChips(preferred?.to ?? L.minRaiseTo)}`);
    assert.equal(copy.confirm, `確認下注 ${fmtChips(preferred?.to ?? L.minRaiseTo)}`);
    assert.equal(copy.minHint, `最少下注 ${fmtChips(preferred?.to ?? L.minRaiseTo)}`);
    // Hint for min uses lo (= minRaiseTo) via same helper
    assert.equal(raisePanelCopy(true, L.minRaiseTo).minHint, `最少下注 ${fmtChips(L.minRaiseTo)}`);
    assert.equal(raisePanelCopy(false, L.minRaiseTo).minHint, `最少加到 ${fmtChips(L.minRaiseTo)}`);
  });
});

describe('加注面板 wiring：MP / solo / HTML 不得再漏接 #presets', () => {
  it('index.html 保留 #raisePanel + #presets + #raiseVerb 容器', () => {
    const html = read('index.html');
    assert.match(html, /id="raisePanel"/);
    assert.match(html, /id="presets"/);
    assert.match(html, /id="raiseMinus"/);
    assert.match(html, /id="raisePlus"/);
    assert.match(html, /id="raiseVerb"/);
    assert.match(html, /id="raiseTitle"/);
  });

  it('mp-toast 不貼底（避開加注面板／行動列／hero 名牌）', () => {
    const css = read('css/game.css');
    const block = css.slice(css.indexOf('.mp-toast'), css.indexOf('.mp-toast') + 280);
    assert.match(block, /top:\s*max\(/);
    assert.match(block, /bottom:\s*auto/);
    assert.doesNotMatch(block, /bottom:\s*\d+px/);
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
