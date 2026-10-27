import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shuffle, mulberry32, makeDeck, cardKey } from '../js/engine/index.js';

describe('洗牌', () => {
  it('Fisher–Yates 保持 52 張且無重複', () => {
    const deck = makeDeck();
    const shuffled = shuffle(deck, mulberry32(42));
    assert.equal(shuffled.length, 52);
    const keys = new Set(shuffled.map(cardKey));
    assert.equal(keys.size, 52);
  });

  it('可注入 RNG 使結果確定', () => {
    const a = shuffle(makeDeck(), mulberry32(7)).map(cardKey).join(',');
    const b = shuffle(makeDeck(), mulberry32(7)).map(cardKey).join(',');
    const c = shuffle(makeDeck(), mulberry32(8)).map(cardKey).join(',');
    assert.equal(a, b);
    assert.notEqual(a, c);
  });

  it('卡方均勻性健全檢查（多輪洗牌後首位牌分布）', () => {
    const N = 52 * 200; // 10400 shuffles
    const counts = Array(52).fill(0);
    const base = makeDeck();
    const labels = base.map(cardKey);
    const rng = mulberry32(12345);
    for (let i = 0; i < N; i++) {
      const s = shuffle(base, rng);
      const idx = labels.indexOf(cardKey(s[0]));
      counts[idx]++;
    }
    const expected = N / 52;
    let chi = 0;
    for (const c of counts) {
      chi += (c - expected) ** 2 / expected;
    }
    // df=51; critical value ~78.2 at p=0.01; use generous 90
    assert.ok(chi < 90, `chi-square too high: ${chi.toFixed(2)}`);
  });
});
