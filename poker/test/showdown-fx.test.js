/**
 * Showdown helpers: best-5, split/side-pot order, chip target seat, pause gating.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialState,
  applyAction,
  getLegalActions,
  PHASE,
  bestFive,
  evaluate,
  compareRanks,
  categoryZh,
  splitPot,
  showdownRevealOrder,
  FOLD_WIN_ONLY_WINNER_CHOOSES,
  HOLD_MS_SHOWDOWN,
  HOLD_MS_FOLD_WIN,
  parseCard,
} from '../js/engine/index.js';
import { chipTargetPos, sidePotPayoutOrder, SHOWDOWN_FX } from '../js/ui/fx.js';
import { seatVisualPos } from '../js/ui/seating.js';

function C(...keys) {
  return keys.map(parseCard);
}

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

describe('bestFive', () => {
  it('回傳與 evaluate 相同的牌力，並含 5 張成牌', () => {
    const hole = C('As', 'Ah');
    const board = C('Kd', 'Kc', '2s', '3d', '9c');
    const bf = bestFive(hole, board);
    assert.ok(bf);
    assert.equal(bf.cards.length, 5);
    assert.equal(compareRanks(bf.rank, evaluate([...hole, ...board])), 0);
    assert.equal(categoryZh(bf.rank), '兩對');
    // Best five should include both aces and both kings
    const ranks = bf.cards.map((c) => c.r).sort((a, b) => b - a);
    assert.deepEqual(ranks.slice(0, 4), [14, 14, 13, 13]);
  });

  it('葫蘆選對的三＋對', () => {
    const bf = bestFive(C('Qs', 'Qh'), C('Qd', '2c', '2s', '9d', '3c'));
    assert.equal(categoryZh(bf.rank), '葫蘆');
    assert.equal(bf.rank[1], 12);
    assert.equal(bf.rank[2], 2);
  });
});

describe('分池／邊池順序與金額', () => {
  it('平分池 shares 加總等於底池', () => {
    const shares = splitPot(100, [0, 2], 1, 6);
    const total = [...shares.values()].reduce((a, b) => a + b, 0);
    assert.equal(total, 100);
    assert.equal(shares.size, 2);
  });

  it('邊池發放順序：後形成的邊池先發（reverse）', () => {
    const winners = [
      { seats: [0, 1, 2], amount: 300, shares: { 0: 100, 1: 100, 2: 100 } },
      { seats: [1, 2], amount: 400, shares: { 1: 200, 2: 200 } },
    ];
    const order = sidePotPayoutOrder(winners);
    assert.equal(order[0].amount, 400);
    assert.equal(order[1].amount, 300);
    assert.deepEqual(order[0].seats, [1, 2]);
  });

  it('SHOWDOWN_FX 時間參數符合規格', () => {
    assert.equal(SHOWDOWN_FX.betsToPotMs, 360);
    assert.equal(SHOWDOWN_FX.flipMs, 380);
    assert.equal(SHOWDOWN_FX.flipStagger, 550);
    assert.equal(SHOWDOWN_FX.chipFlyMs, 650);
    assert.equal(SHOWDOWN_FX.potGap, 450);
    assert.equal(HOLD_MS_SHOWDOWN, 8000);
    assert.equal(HOLD_MS_FOLD_WIN, 4000);
  });
});

describe('籌碼飛向正確座位', () => {
  it('viewerSeat=0、贏家在正上方 → 目標 pos 0（不是 hero）', () => {
    // Fixed seating: seat 3 is opposite when viewer is 0 → visual pos 0 (top)
    const winnerSeat = 3;
    const viewerSeat = 0;
    const pos = chipTargetPos(winnerSeat, viewerSeat);
    assert.equal(pos, 0);
    assert.notEqual(pos, 'hero');
    assert.equal(seatVisualPos(winnerSeat, viewerSeat), 0);
  });

  it('贏家是自己 → 目標 hero', () => {
    assert.equal(chipTargetPos(2, 2), 'hero');
  });
});

describe('攤牌順序', () => {
  it('有 streetAggressor 時由其起順時針', () => {
    const order = showdownRevealOrder(
      { streetAggressor: 2, button: 0, config: { maxSeats: 6 } },
      [0, 1, 2, 4],
    );
    assert.equal(order[0], 2);
    assert.deepEqual(order, [2, 4, 0, 1]);
  });

  it('無 aggressor 時由按鈕左側起', () => {
    const order = showdownRevealOrder(
      { streetAggressor: null, button: 0, config: { maxSeats: 6 } },
      [0, 2, 4],
    );
    assert.equal(order[0], 2);
  });
});

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

function finishReveal(s) {
  let guard = 0;
  while (s.phase === PHASE.SHOWDOWN && s.showdown?.pending?.length && guard++ < 20) {
    s = applyAction(s, { type: 'MUCK', seat: s.showdown.pending[0] }, { now: 1e6 });
  }
  return s;
}

describe('暫停：僅房主、全員回來才開下一手', () => {
  it('非房主 REQUEST_PAUSE 被拒', () => {
    let s = createInitialState({ timerEnabled: false });
    s = seatAll(s, ['宗良', '阿哲']);
    s = start(s, 3);
    assert.equal(s.room.hostSeat, 0);
    assert.throws(
      () => applyAction(s, { type: 'REQUEST_PAUSE', seat: 1 }, { now: 1e6 }),
      /只有房主/,
    );
  });

  it('HAND_OVER 時房主暫停 → active；NEXT_HAND 被擋直到全員 ready', () => {
    let s = createInitialState({ timerEnabled: false });
    s = seatAll(s, ['宗良', '阿哲', '小芸']);
    s = start(s, 11);
    s = playToFoldWin(s);
    s = finishReveal(s);
    assert.equal(s.phase, PHASE.HAND_OVER);
    assert.equal(FOLD_WIN_ONLY_WINNER_CHOOSES, true);

    s = applyAction(s, { type: 'REQUEST_PAUSE', seat: 0 }, { now: 1e6 });
    assert.ok(s.pause?.active);
    assert.throws(
      () => applyAction(s, { type: 'NEXT_HAND' }, { now: 1e6 }),
      /暫停中/,
    );

    const seats = Object.keys(s.pause.ready).map(Number);
    assert.ok(seats.length >= 2);
    for (let i = 0; i < seats.length - 1; i++) {
      s = applyAction(s, { type: 'PLAYER_READY', seat: seats[i] }, { now: 1e6 });
      assert.ok(s.pause?.active);
    }
    s = applyAction(s, { type: 'PLAYER_READY', seat: seats[seats.length - 1] }, { now: 1e6 });
    assert.equal(s.pause, null);
    s = applyAction(s, { type: 'ACK_HAND' }, { now: 1e6 });
    s = applyAction(s, { type: 'NEXT_HAND' }, { now: 1e6 });
    assert.equal(s.phase, PHASE.PREFLOP);
    assert.ok(s.handNumber >= 2);
  });

  it('牌局中預約暫停：NEXT_HAND 先進入暫停而非發牌', () => {
    let s = createInitialState({ timerEnabled: false });
    s = seatAll(s, ['宗良', '阿哲']);
    s = start(s, 9);
    assert.equal(s.phase, PHASE.PREFLOP);
    s = applyAction(s, { type: 'REQUEST_PAUSE', seat: 0 }, { now: 1e6 });
    assert.equal(s.pause?.requested, true);
    assert.equal(s.pause?.active, false);
    s = playToFoldWin(s);
    s = finishReveal(s);
    assert.equal(s.phase, PHASE.HAND_OVER);
    s = applyAction(s, { type: 'ACK_HAND' }, { now: 1e6 });
    s = applyAction(s, { type: 'NEXT_HAND' }, { now: 1e6 });
    assert.ok(s.pause?.active, 'should activate pause instead of dealing');
    assert.notEqual(s.phase, PHASE.PREFLOP);
  });
});
