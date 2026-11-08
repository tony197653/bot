import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, applyAction, mulberry32, PHASE } from '../js/engine/index.js';

import { createPreflopFlagTracker } from '../js/stats/preflop-flags.js';

const env = { now: 1000, randUnit: mulberry32(42) };
function start(count) {
  let s = createInitialState({ multiplayer: true, timerEnabled: false, smallBlind: 5, bigBlind: 10 });
  for (let seat = 0; seat < count; seat++) {
    s = applyAction(s, { type: 'SEAT', seat, name: `P${seat}`, buyIn: 2000 }, env);
  }
  return applyAction(s, { type: 'START_HAND' }, env);
}
function chips(s) {
  return s.seats.filter(Boolean).reduce((sum, p) => sum + p.chips, 0) +
    s.pots.reduce((sum, pot) => sum + pot.amount, 0);
}

describe('中離比照蓋牌', () => {
  it('當前行動者的 LEAVE_FOLD 除中離旗標外與 FOLD 相同', () => {
    for (const count of [2, 3]) {
      const s = start(count);
      const next = applyAction(s, { type: 'LEAVE_FOLD', seat: s.actor }, env);
      const folded = applyAction(s, { type: 'FOLD', seat: s.actor }, env);
      assert.equal(next.seats[s.actor].leftHand, true);
      folded.seats[s.actor].leftHand = true;
      assert.deepEqual(next, folded);
    }
  });

  it('三人桌非當前行動者離開後繼續，保留 actor、時限及已投入籌碼', () => {
    const s = start(3);
    const seat = s.seats.findIndex((p) => p && p.seat !== s.actor && p.bet > 0);
    const next = applyAction(s, { type: 'LEAVE_FOLD', seat }, env);
    assert.equal(next.seats[seat].folded, true);
    assert.equal(next.seats[seat].contributed, s.seats[seat].contributed);
    assert.equal(next.actor, s.actor);
    assert.equal(next.deadline, s.deadline);
    assert.equal(next.phase, s.phase);
    assert.equal(chips(next), 6000);
    assert.equal(s.seats[seat].folded, false);
  });

  it('非當前行動者離開只剩一人時，沿用 fold-win 派彩且籌碼守恆', () => {
    const s = start(2);
    const seat = s.seats.findIndex((p) => p && p.seat !== s.actor);
    const pot = s.pots.reduce((sum, p) => sum + p.amount, 0);
    const next = applyAction(s, { type: 'LEAVE_FOLD', seat }, env);
    assert.equal(next.phase, PHASE.HAND_OVER);
    assert.equal(next.lastHandSummary.foldWin, true);
    assert.equal(next.winnerPayouts[s.actor], pot);
    assert.equal(next.seats[s.actor].chips, s.seats[s.actor].chips + pot);
    assert.equal(next.seats[seat].chips, s.seats[seat].chips);
    assert.equal(chips(next), 4000);
    assert.equal(next.actor, null);
  });

  it('全下玩家保留牌局資格；重複蓋牌為 no-op；非有效座位拒絕', () => {
    let s = start(3);
    const allInSeat = s.actor;
    s = applyAction(s, { type: 'ALL_IN', seat: allInSeat }, env);
    assert.deepEqual(applyAction(s, { type: 'LEAVE_FOLD', seat: allInSeat }, env), s);
    s = applyAction(s, { type: 'LEAVE_FOLD', seat: s.actor }, env);
    const folded = s.seats.findIndex((p) => p?.folded);
    assert.deepEqual(applyAction(s, { type: 'LEAVE_FOLD', seat: folded }, env), s);
    assert.equal(chips(s), 6000);
    assert.throws(() => applyAction(s, { type: 'LEAVE_FOLD', seat: 5 }, env));
    assert.throws(() => applyAction(createInitialState(), { type: 'LEAVE_FOLD', seat: 0 }, env));
  });
});


describe('收桌 VOID 中離籌碼分配', () => {
  it('投入 10 分為 4/3/3，退回在座者本手投入且總籌碼守恆', () => {
    let s = start(4);
    const stacks = s.seats.map((p) => p ? p.chips + p.contributed : 0);
    // Seat 2 posts 10; seat 1 posts 5; button is seat 0.
    assert.equal(s.button, 0);
    assert.equal(s.seats[2].contributed, 10);
    s = applyAction(s, { type: 'LEAVE_FOLD', seat: 2 }, env);
    assert.equal(s.phase, PHASE.PREFLOP);
    const next = applyAction(s, { type: 'VOID_HAND', stacks }, env);
    assert.deepEqual(next.seats.map((p) => p?.chips ?? 0), [2003, 2004, 1990, 2003, 0, 0]);
    assert.equal(chips(next), chips(s));
    assert.equal(chips(next), stacks.reduce((a, b) => a + b, 0));
    assert.equal(next.seats[1].chips, stacks[1] + 4);
    assert.equal(next.seats[2].chips, stacks[2] - 10);
    assert.ok(next.seats.filter(Boolean).every((p) => p.contributed === 0 && !p.leftHand));
    assert.equal(next.pots.length, 0);
  });

  it('已蓋牌後中離仍記錄旗標；新手牌清除旗標', () => {
    let s = start(4);
    const seat = s.actor;
    s = applyAction(s, { type: 'FOLD', seat }, env);
    s = applyAction(s, { type: 'LEAVE_FOLD', seat }, env);
    assert.equal(s.seats[seat].leftHand, true);
    const stacks = s.seats.map((p) => p ? p.chips + p.contributed : 0);
    s = applyAction(s, { type: 'VOID_HAND', stacks }, env);
    s = applyAction(s, { type: 'START_HAND' }, env);
    assert.ok(s.seats.filter(Boolean).every((p) => !p.leftHand));
  });

  it('當前行動者中離直接結束牌局時沿用正常 fold-win', () => {
    const s = start(2);
    const seat = s.actor;
    const next = applyAction(s, { type: 'LEAVE_FOLD', seat }, env);
    assert.equal(next.phase, PHASE.HAND_OVER);
    assert.equal(next.lastHandSummary.foldWin, true);
    assert.equal(next.seats[seat].chips, s.seats[seat].chips);
    assert.equal(chips(next), chips(s));
  });

  it('統計 observer 將當前行動者 LEAVE_FOLD 視為 fold，非當前行動者不計機會', () => {
    const s = start(4);
    const observe = (type, seat) => {
      const tracker = createPreflopFlagTracker();
      tracker.observe(s, { type, seat }, applyAction(s, { type, seat }, env));
      return tracker.snapshot();
    };
    const flags = observe('LEAVE_FOLD', s.actor);
    assert.deepEqual(flags, observe('FOLD', s.actor));
    assert.equal(flags[s.actor].pfrOpp, true);
    assert.equal(flags[s.actor].vpipOpp, true);
    assert.equal(flags[s.actor].vpip, false);
    assert.equal(flags[s.actor].pfr, false);
    assert.deepEqual(observe('LEAVE_FOLD', 2), {});
  });
});
