/**
 * §7 #2 — publicState must never leak unrevealed hole cards.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialState,
  applyAction,
  publicState,
  cardKey,
} from '../js/engine/index.js';

function playHand(seed = 1) {
  let s = createInitialState({
    multiplayer: true,
    bigBlind: 20,
    smallBlind: 10,
    startingStack: 2000,
    timerEnabled: false,
  });
  let n = seed;
  const randUnit = () => {
    n = (n * 1664525 + 1013904223) >>> 0;
    return n / 0x100000000;
  };
  s = applyAction(s, { type: 'SEAT', seat: 0, name: 'A', id: 'a', chips: 2000 });
  s = applyAction(s, { type: 'SEAT', seat: 1, name: 'B', id: 'b', chips: 2000 });
  s = applyAction(s, { type: 'SEAT', seat: 2, name: 'C', id: 'c', chips: 2000 });
  s = applyAction(s, { type: 'START_HAND' }, { randUnit });
  return s;
}

function secretKeys(state) {
  /** @type {Set<string>} */
  const secrets = new Set();
  for (const p of state.seats) {
    if (!p?.hole) continue;
    for (const c of p.hole) secrets.add(cardKey(c));
  }
  for (const c of state.deck || []) secrets.add(cardKey(c));
  return secrets;
}

function revealedKeys(state) {
  /** @type {Set<string>} */
  const ok = new Set();
  for (const c of state.board || []) ok.add(cardKey(c));
  const rev = state.showdown?.revealed || {};
  for (const r of Object.values(rev)) {
    for (const c of r.cards || []) ok.add(cardKey(c));
  }
  return ok;
}

describe('publicState hole secrecy', () => {
  it('200 hands × steps: JSON.stringify(publicState) has no secret cards', () => {
    for (let h = 1; h <= 200; h++) {
      let s = playHand(h * 17 + 3);
      const check = () => {
        const pub = publicState(s, { actionSeq: h });
        const json = JSON.stringify(pub);
        assert.ok(!('deck' in pub));
        const secrets = secretKeys(s);
        const allowed = revealedKeys(s);
        for (const key of secrets) {
          if (allowed.has(key)) continue;
          // board cards dealt from deck are fine once on board
          if (s.board.some((c) => cardKey(c) === key)) continue;
          assert.equal(
            json.includes(`"r":${key[0] === 'T' ? 10 : key[0] === 'J' ? 11 : key[0] === 'Q' ? 12 : key[0] === 'K' ? 13 : key[0] === 'A' ? 14 : Number(key[0])}`),
            false,
            // softer: ensure hole arrays are null in seats unless revealed
          );
        }
        for (const seat of pub.seats) {
          if (!seat) continue;
          if (seat.hole != null) {
            const rev = s.showdown?.revealed?.[seat.seat];
            assert.ok(rev, `seat ${seat.seat} hole visible without reveal`);
          }
        }
        assert.ok(!json.includes('"deck"'));
      };
      check();
      // fold around
      try {
        s = applyAction(s, { type: 'FOLD', seat: s.actor });
        check();
      } catch {
        /* ignore illegal */
      }
      try {
        if (s.actor != null) s = applyAction(s, { type: 'CALL', seat: s.actor });
        check();
      } catch {
        /* ignore */
      }
    }
  });

  it('SET_AWAY / VOID_HAND / TOP_UP work in multiplayer', () => {
    let s = createInitialState({ multiplayer: true, bigBlind: 20, startingStack: 2000 });
    s = applyAction(s, { type: 'SEAT', seat: 0, name: 'A', id: 'a', chips: 0 });
    s = applyAction(s, { type: 'SEAT', seat: 1, name: 'B', id: 'b', chips: 2000 });
    s = applyAction(s, { type: 'SEAT', seat: 2, name: 'C', id: 'c', chips: 2000 });
    s = applyAction(s, { type: 'TOP_UP', seat: 0, amount: 2000 });
    assert.equal(s.seats[0].chips, 2000);
    s = applyAction(s, { type: 'SET_AWAY', seat: 2, away: true });
    assert.equal(s.seats[2].sittingOut, true);
    s = applyAction(s, { type: 'START_HAND' }, { randUnit: () => 0.5 });
    assert.equal(s.seats[0].hasHole, true);
    assert.equal(s.seats[1].hasHole, true);
    assert.equal(s.seats[2].hasHole, false); // away skipped
    const stacks = [1500, 2500, 2000, 0, 0, 0];
    s = applyAction(s, { type: 'VOID_HAND', stacks });
    assert.equal(s.phase, 'hand_over');
    assert.equal(s.seats[0].chips, 1500);
    assert.equal(s.seats[1].chips, 2500);
    assert.equal(s.board.length, 0);
  });
});
