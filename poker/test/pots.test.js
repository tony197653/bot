import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computePots, splitPot } from '../js/engine/index.js';

describe('邊池與奇數籌碼', () => {
  it('三人不同全下金額產生主池＋邊池', () => {
    // A all-in 100, B all-in 300, C has 500 and calls 300
    const pots = computePots([
      { seat: 0, contributed: 100, folded: false },
      { seat: 1, contributed: 300, folded: false },
      { seat: 2, contributed: 300, folded: false },
    ]);
    // Main: 100*3=300 eligible all three
    // Side: 200*2=400 eligible 1,2
    assert.equal(pots.length, 2);
    assert.equal(pots[0].amount, 300);
    assert.deepEqual(pots[0].eligible, [0, 1, 2]);
    assert.equal(pots[1].amount, 400);
    assert.deepEqual(pots[1].eligible, [1, 2]);
  });

  it('蓋牌者籌碼進池但不能贏', () => {
    const pots = computePots([
      { seat: 0, contributed: 50, folded: true },
      { seat: 1, contributed: 100, folded: false },
      { seat: 2, contributed: 100, folded: false },
    ]);
    assert.ok(pots[0].amount >= 50);
    for (const pot of pots) {
      assert.ok(!pot.eligible.includes(0));
    }
  });

  it('平分奇數籌碼給按鈕左側第一位贏家', () => {
    // button=0 → left is seat 1, then 2...
    const shares = splitPot(100, [2, 4, 1], 0, 6);
    // order from button: 1, 2, 4
    assert.equal(shares.get(1), 34); // gets first odd chips: 33+1
    assert.equal(shares.get(2), 33);
    assert.equal(shares.get(4), 33);
    assert.equal([...shares.values()].reduce((a, b) => a + b, 0), 100);
  });

  it('單一贏家拿全部', () => {
    const shares = splitPot(250, [3], 0, 6);
    assert.equal(shares.get(3), 250);
  });
});
