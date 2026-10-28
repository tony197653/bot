/**
 * Deal FX timing constants + avatar timer ring helpers + ARM_DEADLINE.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEAL_FX,
  cardStaggerMs,
  cardFlightMs,
  dealerMoveMs,
  estimateDealTotalMs,
} from '../js/ui/fx.js';
import { dealOrderFromSb } from '../js/ui/seating.js';
import {
  createInitialState,
  applyAction,
  PHASE,
} from '../js/engine/index.js';
import { mulberry32 } from '../js/engine/shuffle.js';

describe('發牌動畫節奏（spec v1）', () => {
  it('間隔依人數：2→200、4→150、6→130', () => {
    assert.equal(cardStaggerMs(2), 200);
    assert.equal(cardStaggerMs(4), 150);
    assert.equal(cardStaggerMs(6), 130);
  });

  it('飛行時間依距離 clamp 400–520', () => {
    assert.equal(cardFlightMs(0), 400);
    assert.equal(cardFlightMs(130), 400); // 360+39=399 → 400
    assert.ok(cardFlightMs(300) >= 400 && cardFlightMs(300) <= 520);
    assert.equal(cardFlightMs(300), Math.round(360 + 0.3 * 300)); // 450
    assert.equal(cardFlightMs(1000), 520);
  });

  it('D 移動時間 clamp 480–640', () => {
    assert.equal(dealerMoveMs(0), 480);
    assert.ok(dealerMoveMs(400) >= 480 && dealerMoveMs(400) <= 640);
    assert.equal(dealerMoveMs(2000), 640);
  });

  it('第 0 張於 1040ms；settle 180；無 2800 硬墊', () => {
    assert.equal(DEAL_FX.card0Ms, 1040);
    assert.equal(DEAL_FX.settleMs, 180);
    assert.equal(DEAL_FX.lookPauseMs, 300);
    assert.ok(!('padToMs' in DEAL_FX));
  });

  it('6 人總長約 3.65s、4 人約 3.15s、2 人約 2.6s', () => {
    const t6 = estimateDealTotalMs(6, 440);
    const t4 = estimateDealTotalMs(4, 440);
    const t2 = estimateDealTotalMs(2, 440);
    assert.ok(t6 >= 3400 && t6 <= 3900, `6p ${t6}`);
    assert.ok(t4 >= 2900 && t4 <= 3500, `4p ${t4}`);
    assert.ok(t2 >= 2400 && t2 <= 3000, `2p ${t2}`);
  });

  it('發牌順序自小盲起兩圈', () => {
    const occupied = [0, 1, 2, 3, 4, 5];
    const order = dealOrderFromSb(occupied, 2);
    assert.equal(order.length, 12);
    assert.equal(order[0], 2);
    assert.equal(order[6], 2);
  });
});

describe('行動計時環', () => {
  it('剩餘比例對應 stroke-dashoffset（pathLength 100）', () => {
    const offset = (leftMs, total = 30000) => 100 * (1 - Math.max(0, Math.min(1, leftMs / total)));
    assert.equal(offset(30000), 0);
    assert.equal(offset(15000), 50);
    assert.equal(offset(0), 100);
    assert.ok(offset(5000) > 80);
  });

  it('最後 5 秒為緊急狀態', () => {
    const urgent = (leftMs) => leftMs <= 5000;
    assert.equal(urgent(5000), true);
    assert.equal(urgent(5001), false);
    assert.equal(urgent(1000), true);
  });
});

describe('計時自翻牌後開始（ARM_DEADLINE）', () => {
  function seatAll(s, names) {
    let st = s;
    names.forEach((name, i) => {
      st = applyAction(st, { type: 'SEAT', seat: i, name, isHost: i === 0 });
    });
    return st;
  }

  it('START_HAND 不 arm deadline；ARM_DEADLINE 才開始', () => {
    let s = createInitialState({ timerEnabled: true, actionTimeoutMs: 30000 });
    s = seatAll(s, ['A', 'B', 'C', 'D']);
    const t0 = 1_000_000;
    s = applyAction(s, { type: 'START_HAND' }, { randUnit: mulberry32(7), now: t0 });
    assert.equal(s.phase, PHASE.PREFLOP);
    assert.equal(s.deadline, null, 'deadline must stay null during deal/換人');

    const t1 = t0 + 5000; // 5s of deal+pass elapsed
    s = applyAction(s, { type: 'ARM_DEADLINE' }, { now: t1 });
    assert.ok(s.deadline != null);
    assert.equal(s.deadline, t1 + 30000);
  });

  it('timerEnabled=false 時 ARM_DEADLINE 仍保持 null', () => {
    let s = createInitialState({ timerEnabled: false });
    s = seatAll(s, ['A', 'B']);
    s = applyAction(s, { type: 'START_HAND' }, { randUnit: mulberry32(3), now: 1e6 });
    s = applyAction(s, { type: 'ARM_DEADLINE' }, { now: 1e6 + 100 });
    assert.equal(s.deadline, null);
  });
});

describe('動作列發牌鎖（UI contract）', () => {
  it('is-deal-locked 語意：handUiReady 前不可行動', () => {
    // Pure contract: myTurn requires handUiReady (mirrored from app.js)
    const myTurn = (handUiReady, needsPass, dealPresenting, heroFlipping, canAct) =>
      handUiReady && !needsPass && !dealPresenting && !heroFlipping && canAct;
    assert.equal(myTurn(false, false, false, false, true), false);
    assert.equal(myTurn(true, false, true, false, true), false);
    assert.equal(myTurn(true, false, false, true, true), false);
    assert.equal(myTurn(true, true, false, false, true), false);
    assert.equal(myTurn(true, false, false, false, true), true);
  });
});
