/**
 * Deal FX timing constants + avatar timer ring helpers.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEAL_FX } from '../js/ui/fx.js';
import { dealOrderFromSb } from '../js/ui/seating.js';

describe('發牌動畫節奏', () => {
  it('DEAL_FX 單卡飛行約 0.3 秒且總時長接近 3 秒（6 人）', () => {
    assert.equal(DEAL_FX.cardFlightMs, 300);
    assert.ok(DEAL_FX.cardStaggerMs >= 120 && DEAL_FX.cardStaggerMs <= 180);
    assert.ok(DEAL_FX.dealerMs >= 350);
    assert.ok(DEAL_FX.blindMs >= 300);
    const seats = 6;
    const cards = seats * 2;
    const dealMs =
      DEAL_FX.dealerMs +
      DEAL_FX.blindMs +
      DEAL_FX.blindStaggerMs +
      (cards - 1) * DEAL_FX.cardStaggerMs +
      DEAL_FX.cardFlightMs;
    // Allow pad-to-2800 in playDealAnimation; raw sequence should be ~2.5–3.5s
    assert.ok(dealMs >= 2400, `dealMs ${dealMs} too short`);
    assert.ok(dealMs <= 3600, `dealMs ${dealMs} too long`);
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
