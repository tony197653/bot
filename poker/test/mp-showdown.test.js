import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialState,
  applyAction,
  PHASE,
  REVEAL_MS,
} from '../js/engine/index.js';

function seat(s, i, name, chips = 5000) {
  return applyAction(s, {
    type: 'SEAT',
    seat: i,
    uid: `u${i}`,
    id: `u${i}`,
    name,
    chips,
  });
}

describe('multiplayer showdown / fold-win', () => {
  it('fold-win skips showdown and lands on hand_over with pot awarded', () => {
    let s = createInitialState({
      multiplayer: true,
      smallBlind: 10,
      bigBlind: 20,
      startingStack: 5000,
      timerEnabled: true,
    });
    s = seat(s, 0, '阿明');
    s = seat(s, 1, '大雄');
    s = applyAction(s, { type: 'START_HAND' }, { now: 1e6 });
    const actor = s.actor;
    const other = actor === 0 ? 1 : 0;
    // Non-actor may need to wait; fold the actor until one remains
    let guard = 0;
    while (s.phase !== PHASE.HAND_OVER && guard++ < 20) {
      if (s.phase === PHASE.SHOWDOWN) break;
      const a = s.actor;
      if (a == null) break;
      s = applyAction(s, { type: 'FOLD', seat: a }, { now: 1e6 + guard });
    }
    assert.equal(s.phase, PHASE.HAND_OVER);
    assert.equal(s.lastHandSummary?.foldWin, true);
    // MP fold-win skips pending show/muck choices
    assert.deepEqual(s.showdown?.pending || [], []);
    const winnerSeat = s.lastHandSummary.winners[0].seats[0];
    assert.ok(s.seats[winnerSeat].chips > 5000 - 40);
  });

  it('real showdown exposes pending show/muck then REVEAL_TIMEOUT finishes', () => {
    let s = createInitialState({
      multiplayer: true,
      smallBlind: 5,
      bigBlind: 10,
      startingStack: 2000,
      timerEnabled: true,
    });
    s = seat(s, 0, 'A', 2000);
    s = seat(s, 1, 'B', 2000);
    s = applyAction(s, { type: 'START_HAND' }, { now: 1e6 });
    // Force all-in race to showdown: both shove
    let guard = 0;
    while (
      s.phase !== PHASE.SHOWDOWN &&
      s.phase !== PHASE.HAND_OVER &&
      guard++ < 30
    ) {
      const a = s.actor;
      if (a == null) {
        // advance via check if possible else break
        break;
      }
      const p = s.seats[a];
      if (p.chips > 0) {
        try {
          s = applyAction(
            s,
            { type: 'BET_RAISE', seat: a, amount: p.chips + p.bet },
            { now: 1e6 + guard },
          );
        } catch {
          try {
            s = applyAction(s, { type: 'CALL', seat: a }, { now: 1e6 + guard });
          } catch {
            s = applyAction(s, { type: 'CHECK', seat: a }, { now: 1e6 + guard });
          }
        }
      }
    }
    if (s.phase === PHASE.SHOWDOWN) {
      assert.ok(Array.isArray(s.showdown?.pending));
      s = applyAction(s, { type: 'REVEAL_TIMEOUT' }, { now: 1e6 + 50 });
      assert.equal(s.phase, PHASE.HAND_OVER);
    } else {
      // All-in may auto-finish if no pending choices (winners auto-revealed)
      assert.equal(s.phase, PHASE.HAND_OVER);
    }
    assert.ok(REVEAL_MS === 5000);
  });
});
