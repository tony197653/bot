import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, compareRanks, categoryZh, CATEGORY, parseCard } from '../js/engine/index.js';

function C(...keys) {
  return keys.map(parseCard);
}

function assertCat(cards, cat, msg) {
  const r = evaluate(C(...cards));
  assert.equal(r[0], cat, msg || `${cards.join(' ')} → ${categoryZh(r)}`);
  return r;
}

describe('手牌評分：每一種牌型', () => {
  it('同花大順', () => {
    const r = assertCat(['As', 'Ks', 'Qs', 'Js', 'Ts', '2d', '3c'], CATEGORY.STRAIGHT_FLUSH);
    assert.equal(categoryZh(r), '同花大順');
    assert.equal(r[1], 14);
  });

  it('同花順（含鋼鐵輪：A-2-3-4-5 同花）', () => {
    const r = assertCat(['As', '2s', '3s', '4s', '5s', '9d', 'Kc'], CATEGORY.STRAIGHT_FLUSH);
    assert.equal(categoryZh(r), '同花順');
    assert.equal(r[1], 5);
  });

  it('四條 + 踢腳', () => {
    const a = assertCat(['9s', '9h', '9d', '9c', 'As', '2d', '3c'], CATEGORY.QUADS);
    const b = assertCat(['9s', '9h', '9d', '9c', 'Ks', '2d', '3c'], CATEGORY.QUADS);
    assert.ok(compareRanks(a, b) > 0, 'A 踢腳勝過 K 踢腳');
  });

  it('葫蘆', () => {
    assertCat(['8s', '8h', '8d', '3c', '3s', 'Ad', 'Kc'], CATEGORY.FULL_HOUSE);
    const a = evaluate(C('Qs', 'Qh', 'Qd', '2c', '2s', '3d', '4c'));
    const b = evaluate(C('Js', 'Jh', 'Jd', 'As', 'Ah', '3d', '4c'));
    assert.ok(compareRanks(a, b) > 0, 'QQQ22 勝過 JJJAA');
  });

  it('同花', () => {
    const r = assertCat(['As', '9s', '7s', '4s', '2s', 'Kh', 'Qc'], CATEGORY.FLUSH);
    assert.equal(r[1], 14);
  });

  it('順子（含輪子 A-2-3-4-5）', () => {
    const wheel = assertCat(['As', '2h', '3d', '4c', '5s', '9d', 'Kc'], CATEGORY.STRAIGHT);
    assert.equal(wheel[1], 5);
    const broadway = assertCat(['As', 'Kh', 'Qd', 'Jc', 'Ts', '2d', '3c'], CATEGORY.STRAIGHT);
    assert.equal(broadway[1], 14);
    assert.ok(compareRanks(broadway, wheel) > 0);
  });

  it('三條 + 踢腳', () => {
    const a = assertCat(['7s', '7h', '7d', 'As', 'Kd', '2c', '3c'], CATEGORY.TRIPS);
    const b = assertCat(['7s', '7h', '7d', 'As', 'Qd', '2c', '3c'], CATEGORY.TRIPS);
    assert.ok(compareRanks(a, b) > 0);
  });

  it('兩對 + 踢腳', () => {
    const a = assertCat(['As', 'Ah', '8d', '8c', 'Ks', '2d', '3c'], CATEGORY.TWO_PAIR);
    const b = assertCat(['As', 'Ah', '8d', '8c', 'Qs', '2d', '3c'], CATEGORY.TWO_PAIR);
    assert.ok(compareRanks(a, b) > 0, 'K 踢腳勝過 Q');
  });

  it('一對 + 踢腳', () => {
    const a = assertCat(['As', 'Ah', 'Kd', '9c', '4s', '2d', '3c'], CATEGORY.PAIR);
    const b = assertCat(['As', 'Ah', 'Kd', '8c', '4s', '2d', '3c'], CATEGORY.PAIR);
    assert.ok(compareRanks(a, b) > 0);
  });

  it('高牌踢腳比較', () => {
    const a = assertCat(['As', 'Kh', 'Qd', '9c', '4s', '2d', '3c'], CATEGORY.HIGH);
    const b = assertCat(['As', 'Kh', 'Qd', '8c', '4s', '2d', '3c'], CATEGORY.HIGH);
    assert.ok(compareRanks(a, b) > 0);
  });

  it('公牌打到底：兩邊完全相同則平手', () => {
    // Board plays: both use board only
    const board = C('As', 'Kh', '9d', '5c', '2s');
    const a = evaluate([...C('3h', '3d'), ...board]);
    // Wait — pair of 3s beats high card board. Use kickers that don't help:
    // Actually for board-plays both players have same best 5 from board when holes don't improve.
    const board2 = C('As', 'Kh', 'Qd', 'Jc', '9s');
    const x = evaluate([...C('2h', '3d'), ...board2]);
    const y = evaluate([...C('4c', '5d'), ...board2]);
    assert.equal(compareRanks(x, y), 0);
    assert.equal(x[0], CATEGORY.HIGH);
  });

  it('最佳五張：七張中選出更強組合', () => {
    // Has pair of aces AND a flush possibility — flush should win if available
    const r = evaluate(C('As', '2s', '5s', '9s', 'Ks', 'Ah', 'Ad'));
    assert.equal(r[0], CATEGORY.FLUSH);
  });
});
