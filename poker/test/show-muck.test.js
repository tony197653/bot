/**
 * Show / muck (亮牌／不亮) rules at hand end.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialState,
  applyAction,
  getLegalActions,
  PHASE,
  REVEAL_MS,
  viewForSeat,
} from '../js/engine/index.js';

function seatAll(s, names) {
  let out = s;
  names.forEach((name, seat) => {
    out = applyAction(out, { type: 'SEAT', seat, name, isHost: seat === 0 });
  });
  return out;
}

function start(s, seed = 42) {
  return applyAction(s, { type: 'START_HAND' }, {
    now: 1e6,
    randUnit: (() => {
      let i = seed;
      return () => {
        i = (i * 1103515245 + 12345) & 0x7fffffff;
        return (i % 10000) / 10000;
      };
    })(),
  });
}

/** Drive to fold-win: one player bets; everyone else folds when facing a bet. */
function playToFoldWin(s) {
  let guard = 0;
  let raised = false;
  while (
    [PHASE.PREFLOP, PHASE.FLOP, PHASE.TURN, PHASE.RIVER].includes(s.phase) &&
    s.actor != null &&
    guard++ < 80
  ) {
    const actor = s.actor;
    const live = s.seats.filter((p) => p && !p.folded && !p.sittingOut);
    if (live.length <= 1) break;
    const L = getLegalActions(s, actor);
    if (!L.canAct) break;
    // First chance: open a bet/raise so others can fold
    if (!raised && (L.bet || L.raise)) {
      s = applyAction(
        s,
        { type: 'BET_RAISE', seat: actor, amount: L.minRaiseTo },
        { now: 1e6 },
      );
      raised = true;
      continue;
    }
    if (L.fold) {
      s = applyAction(s, { type: 'FOLD', seat: actor }, { now: 1e6 });
    } else if (L.check) {
      s = applyAction(s, { type: 'CHECK', seat: actor }, { now: 1e6 });
    } else {
      break;
    }
  }
  return s;
}

/** Check/call to showdown. */
function playToShowdown(s) {
  let guard = 0;
  while (
    [PHASE.PREFLOP, PHASE.FLOP, PHASE.TURN, PHASE.RIVER].includes(s.phase) &&
    s.actor != null &&
    guard++ < 100
  ) {
    const L = getLegalActions(s, s.actor);
    if (L.check) s = applyAction(s, { type: 'CHECK', seat: s.actor }, { now: 1e6 });
    else if (L.call) s = applyAction(s, { type: 'CALL', seat: s.actor }, { now: 1e6 });
    else if (L.allIn) s = applyAction(s, { type: 'ALL_IN', seat: s.actor }, { now: 1e6 });
    else break;
  }
  return s;
}

describe('亮牌／不亮規則', () => {
  it('REVEAL_MS 為 5 秒', () => {
    assert.equal(REVEAL_MS, 5000);
  });

  it('蓋牌獲勝：贏家與蓋牌者皆可選亮牌／不亮（無人自動亮）', () => {
    let s = createInitialState({ timerEnabled: false });
    s = seatAll(s, ['宗良', '阿哲', '小芸']);
    s = start(s, 11);
    s = playToFoldWin(s);
    assert.equal(s.phase, PHASE.SHOWDOWN, 'phase=' + s.phase);
    assert.ok(s.showdown?.foldWin);
    const withHoles = s.seats.filter((p) => p && p.hole?.length === 2);
    assert.ok(withHoles.length >= 2);
    // Nobody auto-revealed on fold-win
    for (const p of withHoles) {
      assert.notEqual(p.showChoice, 'auto');
      assert.ok(s.showdown.pending.includes(p.seat), `seat ${p.seat} should be pending`);
    }
    assert.deepEqual(
      Object.keys(s.showdown.revealed || {}).map(Number).sort(),
      [],
    );
  });

  it('攤牌：贏家自動亮兩張；輸家待選', () => {
    let s = createInitialState({ timerEnabled: false });
    s = seatAll(s, ['宗良', '阿哲', '小芸']);
    s = start(s, 21);
    s = playToShowdown(s);
    assert.ok(
      s.phase === PHASE.SHOWDOWN || s.phase === PHASE.HAND_OVER,
      'phase=' + s.phase,
    );
    if (s.phase === PHASE.HAND_OVER) {
      // All contenders may have been auto-finished if only winners and no pending
      assert.ok(s.lastHandSummary?.revealed);
      return;
    }
    assert.equal(s.showdown.foldWin, false);
    const winnerSeats = new Set(
      (s.winners || []).flatMap((w) => w.seats || []),
    );
    assert.ok(winnerSeats.size >= 1);
    for (const seat of winnerSeats) {
      assert.equal(s.seats[seat].showChoice, 'auto');
      assert.ok(s.showdown.revealed[seat]);
      assert.equal(s.showdown.revealed[seat].mode, 'both');
      assert.equal(s.showdown.revealed[seat].cards.length, 2);
      assert.ok(!s.showdown.pending.includes(seat));
    }
    for (const seat of s.showdown.pending) {
      assert.ok(!winnerSeats.has(seat));
      assert.equal(s.seats[seat].showChoice, null);
    }
  });

  it('亮牌只能同時亮兩張（拒 one0）', () => {
    let s = createInitialState({ timerEnabled: false });
    s = seatAll(s, ['宗良', '阿哲']);
    s = start(s, 3);
    s = playToFoldWin(s);
    assert.equal(s.phase, PHASE.SHOWDOWN);
    const seat = s.showdown.pending[0];
    assert.throws(
      () => applyAction(s, { type: 'SHOW', seat, mode: 'one0' }, { now: 1e6 }),
      /亮牌須同時亮兩張/,
    );
    s = applyAction(s, { type: 'SHOW', seat, mode: 'both' }, { now: 1e6 });
    assert.equal(s.seats[seat].showChoice, 'both');
    assert.equal(s.showdown.revealed[seat].cards.length, 2);
    assert.equal(s.seats[seat].lastAction, '亮牌');
  });

  it('不亮（MUCK）寫入正確文案', () => {
    let s = createInitialState({ timerEnabled: false });
    s = seatAll(s, ['宗良', '阿哲']);
    s = start(s, 5);
    s = playToFoldWin(s);
    const seat = s.showdown.pending[0];
    s = applyAction(s, { type: 'MUCK', seat }, { now: 1e6 });
    assert.equal(s.seats[seat].showChoice, 'muck');
    assert.equal(s.seats[seat].lastAction, '不亮');
    assert.ok(!s.showdown?.revealed?.[seat]);
  });

  it('逾時 REVEAL_TIMEOUT 將剩餘座位改為不亮並結束', () => {
    let s = createInitialState({ timerEnabled: false });
    s = seatAll(s, ['宗良', '阿哲', '小芸']);
    s = start(s, 7);
    s = playToFoldWin(s);
    assert.ok(s.showdown.pending.length >= 2);
    s = applyAction(s, { type: 'REVEAL_TIMEOUT' }, { now: 1e6 });
    assert.equal(s.phase, PHASE.HAND_OVER);
    for (const p of s.seats.filter(Boolean)) {
      if (p.showChoice != null) {
        assert.ok(p.showChoice === 'muck' || p.showChoice === 'both' || p.showChoice === 'auto');
      }
    }
  });

  it('視角：亮牌後其他玩家可見兩張牌', () => {
    let s = createInitialState({ timerEnabled: false });
    s = seatAll(s, ['宗良', '阿哲']);
    s = start(s, 9);
    s = playToFoldWin(s);
    const shower = s.showdown.pending[0];
    const other = s.showdown.pending.find((x) => x !== shower) ?? (shower === 0 ? 1 : 0);
    s = applyAction(s, { type: 'SHOW', seat: shower, mode: 'both' }, { now: 1e6 });
    const v = viewForSeat(s, other);
    assert.ok(v.seats[shower].hole);
    assert.equal(v.seats[shower].hole.length, 2);
    assert.equal(v.seats[shower].holeHidden, false);
  });
});
