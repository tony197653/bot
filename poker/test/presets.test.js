import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialState,
  applyAction,
  getLegalActions,
  raisePresets,
  totalPot,
  mulberry32,
  PHASE,
} from '../js/engine/index.js';

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

function byId(presets) {
  return Object.fromEntries(presets.map((p) => [p.id, p]));
}

describe('加注快捷鍵：翻牌前尚未有人加注', () => {
  it('標籤為大盲倍數，數值為加到總額（BB20 → 3 大盲 = 60）', () => {
    let s = createInitialState({ timerEnabled: false, bigBlind: 20, startingStack: 2000 });
    s = seatAll(s, ['宗良', '阿哲', '小芸']);
    s = start(s, 42);
    assert.equal(s.phase, PHASE.PREFLOP);
    assert.equal(s.currentBet, 20);

    const seat = s.actor;
    const L = getLegalActions(s, seat);
    const presets = raisePresets(s, seat);
    assert.equal(presets.length, 6);
    assert.deepEqual(
      presets.map((p) => p.label),
      ['最小', '2.5 大盲', '3 大盲', '4 大盲', '5 大盲', '全下'],
    );

    const m = byId(presets);
    assert.equal(m.min.to, L.minRaiseTo);
    assert.equal(m.min.to, 40);
    assert.equal(m['2.5bb'].to, 50);
    assert.equal(m['3bb'].to, 60);
    assert.equal(m['4bb'].to, 80);
    assert.equal(m['5bb'].to, 100);
    assert.equal(m.allin.to, L.maxRaiseTo);
    assert.equal(m['3bb'].preferred, true);
  });
});

describe('加注快捷鍵：翻牌前面對加注', () => {
  it('倍數對準目前面額（面對 60 → 2.5 倍=150、3 倍=180、一池=210）', () => {
    let s = createInitialState({ timerEnabled: false, bigBlind: 20, startingStack: 2000 });
    s = seatAll(s, ['宗良', '阿哲', '小芸']);
    s = start(s, 7);
    // First actor raises to 60
    s = act(s, 'BET_RAISE', { amount: 60 });
    assert.equal(s.currentBet, 60);
    assert.equal(s.phase, PHASE.PREFLOP);

    const seat = s.actor;
    const p = s.seats[seat];
    const toCall = s.currentBet - p.bet;
    const pot = totalPot(s);
    const L = getLegalActions(s, seat);
    const presets = raisePresets(s, seat);
    assert.deepEqual(
      presets.map((x) => x.label),
      ['最小', '2.5 倍', '3 倍', '4 倍', '一池', '全下'],
    );
    const m = byId(presets);
    assert.equal(m.min.to, L.minRaiseTo);
    assert.equal(m['2.5x'].to, 150);
    assert.equal(m['3x'].to, 180);
    assert.equal(m['4x'].to, 240);
    // 一池：call + 1*(pot+call)
    const potTo = p.bet + toCall + (pot + toCall);
    assert.equal(m.pot.to, potTo);
    assert.equal(m['3x'].preferred, true);
  });
});

describe('加注快捷鍵：翻牌後', () => {
  it('維持池比例公式 call + frac×(pot+call)，半池為預設', () => {
    let s = createInitialState({ timerEnabled: false, bigBlind: 20, startingStack: 2000 });
    s = seatAll(s, ['宗良', '阿哲']);
    s = start(s, 3);
    // HU preflop: button acts first — call, then BB checks → flop
    s = act(s, 'CALL');
    s = act(s, 'CHECK');
    assert.equal(s.phase, PHASE.FLOP);
    assert.equal(s.currentBet, 0);

    const seat = s.actor;
    const pot = totalPot(s);
    const L = getLegalActions(s, seat);
    assert.equal(L.check, true);
    assert.equal(L.bet, true);

    const presets = raisePresets(s, seat);
    assert.deepEqual(
      presets.map((x) => x.label),
      ['最小', '1/3 池', '半池', '2/3 池', '一池', '全下'],
    );
    const m = byId(presets);
    assert.equal(m.min.to, L.minRaiseTo);
    assert.equal(m.min.to, 20);
    const clampTo = (n) => Math.max(L.minRaiseTo, Math.min(L.maxRaiseTo, Math.round(n)));
    // 底池約 40（各跟注 20）時 1/3 池會低於最小下注，應夾到 min
    assert.equal(m['1/3'].to, clampTo(pot / 3));
    assert.equal(m['1/2'].to, clampTo(pot / 2));
    assert.equal(m['2/3'].to, clampTo((pot * 2) / 3));
    assert.equal(m.pot.to, clampTo(pot));
    assert.equal(m['1/2'].preferred, true);
    assert.ok(m['1/3'].to >= L.minRaiseTo);
  });

  it('較大底池時池比例不被最少下注夾掉（mock：底池 120）', () => {
    let s = createInitialState({ timerEnabled: false, bigBlind: 20, startingStack: 2000 });
    s = seatAll(s, ['宗良', '阿哲', '小芸']);
    s = start(s, 21);
    // Build a pot then go to flop with checks
    s = act(s, 'BET_RAISE', { amount: 60 });
    s = act(s, 'CALL');
    s = act(s, 'CALL');
    // Flop — check around if needed until someone can open
    assert.equal(s.phase, PHASE.FLOP);
    // Drain checks until actor can bet with pot ≈ 180
    let guard = 0;
    while (s.phase === PHASE.FLOP && guard++ < 6) {
      const L = getLegalActions(s, s.actor);
      if (L.bet && totalPot(s) >= 120) break;
      if (L.check) s = act(s, 'CHECK');
      else break;
    }
    const seat = s.actor;
    const pot = totalPot(s);
    const L = getLegalActions(s, seat);
    assert.ok(L.bet);
    assert.ok(pot >= 120);
    const presets = raisePresets(s, seat);
    const m = byId(presets);
    assert.equal(m['1/3'].to, Math.round(pot / 3));
    assert.equal(m['1/2'].to, Math.round(pot / 2));
    assert.equal(m['2/3'].to, Math.round((pot * 2) / 3));
    assert.equal(m.pot.to, pot);
    assert.ok(m['1/3'].to >= L.minRaiseTo);
  });
});

describe('加注快捷鍵：夾限', () => {
  it('低於最少加注與高於全下都會夾到合法區間', () => {
    let s = createInitialState({ timerEnabled: false, bigBlind: 20, startingStack: 2000 });
    s = seatAll(s, ['宗良', '阿哲', '小芸']);
    s = start(s, 11);
    // Huge raise so face ×4 exceeds many stacks? Use normal stacks — 5bb is fine.
    // Force a facing raise where minRaise is high relative to a short stack later.
    s = act(s, 'BET_RAISE', { amount: 60 });
    const seat = s.actor;
    const L = getLegalActions(s, seat);
    const presets = raisePresets(s, seat);
    for (const p of presets) {
      assert.ok(p.to >= Math.min(L.minRaiseTo, L.maxRaiseTo));
      assert.ok(p.to <= L.maxRaiseTo);
    }
  });

  it('短籌碼：所有快捷鍵夾到全下金額，仍顯示六顆', () => {
    let s = createInitialState({ timerEnabled: false, bigBlind: 20, startingStack: 2000 });
    s = applyAction(s, { type: 'SEAT', seat: 0, name: 'A', buyIn: 2000, isHost: true });
    s = applyAction(s, { type: 'SEAT', seat: 1, name: 'B', buyIn: 2000 });
    s = applyAction(s, { type: 'SEAT', seat: 2, name: 'C', buyIn: 2000 });
    s.seats[2].chips = 55;
    s.seats[2].buyInTotal = 55;
    s = start(s, 5);

    // Get to actor C if possible, or raise then C faces
    // Play until seat 2 can act with short stack, or set actor manually after raise
    let guard = 0;
    while (s.actor !== 2 && s.phase === PHASE.PREFLOP && guard++ < 8) {
      const L = getLegalActions(s, s.actor);
      if (L.raise || L.bet) s = act(s, 'BET_RAISE', { amount: L.minRaiseTo });
      else if (L.call) s = act(s, 'CALL');
      else if (L.check) s = act(s, 'CHECK');
      else break;
    }
    if (s.actor !== 2) {
      // Direct short-stack scenario: seat 0 opens large, seat 2 to act with 55
      s = createInitialState({ timerEnabled: false, bigBlind: 20, startingStack: 2000 });
      s = applyAction(s, { type: 'SEAT', seat: 0, name: 'A', buyIn: 2000, isHost: true });
      s = applyAction(s, { type: 'SEAT', seat: 1, name: 'B', buyIn: 2000 });
      s = applyAction(s, { type: 'SEAT', seat: 2, name: 'C', buyIn: 80 });
      s = start(s, 9);
      // First to act raises to 60; continue until C acts
      guard = 0;
      while (s.phase === PHASE.PREFLOP && s.actor !== 2 && guard++ < 10) {
        const L = getLegalActions(s, s.actor);
        if ((L.bet || L.raise) && s.currentBet <= 20) s = act(s, 'BET_RAISE', { amount: 60 });
        else if (L.call) s = act(s, 'CALL');
        else if (L.check) s = act(s, 'CHECK');
        else if (L.raise) s = act(s, 'BET_RAISE', { amount: L.minRaiseTo });
        else break;
      }
    }

    assert.equal(s.actor, 2);
    const L = getLegalActions(s, 2);
    const presets = raisePresets(s, 2);
    assert.equal(presets.length, 6);
    // Short stack: maxRaiseTo is all chips + street bet
    for (const p of presets) {
      assert.equal(p.to, L.maxRaiseTo);
    }
    // Still show 全下 label on last, and duplicates of that amount on others
    assert.equal(presets[5].label, '全下');
    assert.ok(presets.some((p) => p.label.includes('大盲') || p.label.includes('倍') || p.label === '最小'));
  });
});
