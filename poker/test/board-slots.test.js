import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { boardSlotsMarkup } from '../js/ui/cards-dom.js';

const C = (r, s) => ({ r, s });

function slotChunks(html) {
  return html.match(/<div class="slot(?: is-filled)?"[^>]*>[\s\S]*?(?=<div class="slot|$)/g) || [];
}

describe('boardSlotsMarkup — five fixed community slots', () => {
  it('always emits exactly five .slot wrappers', () => {
    for (const n of [0, 1, 3, 4, 5]) {
      const cards = Array.from({ length: n }, (_, i) => C(14 - i, i % 4));
      const html = boardSlotsMarkup(cards);
      assert.equal((html.match(/<div class="slot/g) || []).length, 5, `n=${n}`);
    }
  });

  it('flop fills slots 1–3; 4–5 stay empty placeholders', () => {
    const html = boardSlotsMarkup([C(14, 3), C(13, 2), C(12, 1)]);
    assert.equal((html.match(/class="slot is-filled"/g) || []).length, 3);
    assert.equal((html.match(/class="slot" aria-hidden="true"/g) || []).length, 2);
    assert.match(html, /aria-label="黑桃 A"/);
  });

  it('turn fills slot 4 without dropping earlier cards from markup', () => {
    const turn = boardSlotsMarkup([C(14, 3), C(13, 2), C(12, 1), C(11, 0)]);
    assert.equal((turn.match(/class="slot is-filled"/g) || []).length, 4);
    assert.equal((turn.match(/class="slot" aria-hidden="true"/g) || []).length, 1);
    assert.match(turn, /aria-label="黑桃 A"/);
    assert.match(turn, /aria-label="紅心 K"/);
    assert.match(turn, /aria-label="方塊 Q"/);
    assert.match(turn, /aria-label="梅花 J"/);
  });

  it('river fills all five slots', () => {
    const html = boardSlotsMarkup([
      C(14, 3),
      C(13, 2),
      C(12, 1),
      C(11, 0),
      C(10, 3),
    ]);
    assert.equal((html.match(/class="slot is-filled"/g) || []).length, 5);
    assert.equal((html.match(/class="slot" aria-hidden="true"/g) || []).length, 0);
    assert.equal(slotChunks(html).length, 5);
  });
});
