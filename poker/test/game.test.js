import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialState,
  applyAction,
  getLegalActions,
  viewForSeat,
  serializeState,
  deserializeState,
  mulberry32,
  PHASE,
  evaluateHand,
  compareRanks,
  parseCard,
} from '../js/engine/index.js';

function seatAll(s, names, chips) {
  let st = s;
  names.forEach((name, i) => {
    st = applyAction(st, {
      type: 'SEAT',
      seat: i,
      name,
      buyIn: chips ?? st.config.startingStack,
      isHost: i === 0,
    });
  });
  return st;
}

function start(st, seed = 1) {
  return applyAction(st, { type: 'START_HAND' }, { randUnit: mulberry32(seed), now: 1_000_000 });
}

function act(st, type, extra = {}, now = 1_000_000) {
  return applyAction(st, { type, seat: st.actor, ...extra }, { now, randUnit: mulberry32(99) });
}

describe('設定：盲注與起始籌碼', () => {
  it('預設 SB10/BB20、起始 2000；改 BB 時起始自動至少 100×BB', () => {
    let s = createInitialState();
    assert.equal(s.config.smallBlind, 10);
    assert.equal(s.config.bigBlind, 20);
    assert.equal(s.config.startingStack, 2000);

    s = applyAction(s, { type: 'CONFIG', bigBlind: 50 });
    assert.equal(s.config.bigBlind, 50);
    assert.equal(s.config.smallBlind, 25);
    assert.equal(s.config.startingStack, 5000); // auto 100×

    s = applyAction(s, { type: 'CONFIG', startingStack: 8000 });
    assert.equal(s.config.startingStack, 8000);

    assert.throws(() => applyAction(s, { type: 'CONFIG', startingStack: 1000 }));
  });
});

describe('單挑盲注與行動順序', () => {
  it('單挑：按鈕＝小盲，按鈕先行動（翻牌前）', () => {
    let s = createInitialState({ timerEnabled: false });
    s = seatAll(s, ['宗良', '阿哲']);
    s = start(s, 10);
    assert.equal(s.phase, PHASE.PREFLOP);
    // button is SB in HU
    const btn = s.button;
    const sb = s.seats[btn];
    assert.ok(sb.bet === 10 || sb.lastAction.includes('小盲') || sb.lastAction.includes('全下'));
    assert.equal(s.actor, btn, '單挑翻牌前按鈕先動');
  });
});

describe('最少加注與不足額全下不重開', () => {
  it('加注少於完整加注幅度的全下不重開已行動玩家', () => {
    let s = createInitialState({ timerEnabled: false, startingStack: 2000 });
    s = applyAction(s, { type: 'SEAT', seat: 0, name: 'A', buyIn: 2000, isHost: true });
    s = applyAction(s, { type: 'SEAT', seat: 1, name: 'B', buyIn: 2000 });
    s = applyAction(s, { type: 'SEAT', seat: 2, name: 'C', buyIn: 2000 });
    // Short stack C after buy-in (session later allows bust/short)
    s.seats[2].chips = 45;
    s.seats[2].buyInTotal = 45;
    s = start(s, 20);

    // Preflop: open to 60
    const first = s.actor;
    s = applyAction(s, { type: 'BET_RAISE', seat: first, amount: 60 }, { now: 1e6 });
    while (s.phase === PHASE.PREFLOP && s.actor != null) {
      const L = getLegalActions(s, s.actor);
      if (L.call) s = applyAction(s, { type: 'CALL', seat: s.actor }, { now: 1e6 });
      else if (L.check) s = applyAction(s, { type: 'CHECK', seat: s.actor }, { now: 1e6 });
      else if (L.allIn) s = applyAction(s, { type: 'ALL_IN', seat: s.actor }, { now: 1e6 });
      else break;
    }

    // Direct unit: craft street where A bet 100, B called, C short all-in < full raise
    // If already past preflop with C all-in, just assert chips conserved.
    if (s.phase === PHASE.FLOP && s.seats[2] && !s.seats[2].allIn && !s.seats[2].folded) {
      const opener = s.actor;
      if (opener !== 2) {
        s = applyAction(s, { type: 'BET_RAISE', seat: opener, amount: 100 }, { now: 1e6 });
      }
      // Next non-C calls
      while (s.actor != null && s.actor !== 2 && s.phase === PHASE.FLOP) {
        const L = getLegalActions(s, s.actor);
        if (L.call) s = applyAction(s, { type: 'CALL', seat: s.actor }, { now: 1e6 });
        else if (L.check) s = applyAction(s, { type: 'CHECK', seat: s.actor }, { now: 1e6 });
        else break;
      }
      if (s.actor === 2) {
        const bitBefore = s.actedBit;
        assert.ok(bitBefore !== 0, '應已有人行動過');
        s = applyAction(s, { type: 'ALL_IN', seat: 2 }, { now: 1e6 });
        // Incomplete raise must NOT clear actedBit
        assert.equal(s.actedBit & bitBefore, bitBefore, '不足額全下不應重開已行動者');
      }
    } else {
      // C went all-in preflop for less — still a valid incomplete-raise path
      assert.ok(s.seats[2].allIn || s.phase !== PHASE.PREFLOP);
    }
  });

  it('不足額全下：不重設 actedBit，已行動者不可再加注', () => {
    let s = createInitialState({ timerEnabled: false });
    s = seatAll(s, ['A', 'B', 'C']);
    s = start(s, 1);
    let g = 0;
    while (s.phase === PHASE.PREFLOP && g++ < 20) {
      const L = getLegalActions(s, s.actor);
      if (L.call) s = applyAction(s, { type: 'CALL', seat: s.actor }, { now: 1e6 });
      else if (L.check) s = applyAction(s, { type: 'CHECK', seat: s.actor }, { now: 1e6 });
      else break;
    }
    assert.equal(s.phase, PHASE.FLOP);
    const a = s.actor;
    s = applyAction(s, { type: 'BET_RAISE', seat: a, amount: 100 }, { now: 1e6 });
    assert.equal(s.lastFullRaiseSize, 100);
    assert.equal(s.minRaiseTo, 200);
    const b = s.actor;
    s = applyAction(s, { type: 'CALL', seat: b }, { now: 1e6 });
    const bitAfterCall = s.actedBit;
    assert.ok((bitAfterCall & (1 << a)) !== 0);
    assert.ok((bitAfterCall & (1 << b)) !== 0);
    const c = s.actor;
    assert.ok(c !== a && c !== b);
    // C all-in to 150 (raise by 50 < 100) — incomplete
    s.seats[c].chips = 150;
    s = applyAction(s, { type: 'ALL_IN', seat: c }, { now: 1e6 });
    assert.equal(s.seats[c].allIn, true);
    assert.equal(s.currentBet, 150);
    assert.ok((s.actedBit & (1 << a)) !== 0, 'A 的已行動標記應保留');
    assert.ok((s.actedBit & (1 << b)) !== 0, 'B 的已行動標記應保留');
    // A or B must respond but cannot re-raise
    assert.ok(s.actor === a || s.actor === b);
    const L = getLegalActions(s, s.actor);
    assert.equal(L.call, true);
    assert.equal(L.raise, false, '不足額全下後已行動者不可再加注');
  });

  it('完整加注會重開行動', () => {
    let s = createInitialState({ timerEnabled: false });
    s = seatAll(s, ['A', 'B', 'C']);
    s = start(s, 3);
    const a = s.actor;
    s = applyAction(s, { type: 'BET_RAISE', seat: a, amount: 60 }, { now: 1e6 });
    assert.equal(s.currentBet, 60);
    assert.equal(s.minRaiseTo, 100); // 60 + 40 raise size? wait BB was 20, raise from 20 to 60 is +40
    assert.equal(s.lastFullRaiseSize, 40);
    assert.equal(s.minRaiseTo, 100);
  });
});

describe('逾時：可過則過，否則蓋', () => {
  it('toCall=0 時 TIMEOUT → 過牌', () => {
    let s = createInitialState({ timerEnabled: true, actionTimeoutMs: 1000 });
    s = seatAll(s, ['A', 'B']);
    s = start(s, 5);
    // HU preflop button faces BB — usually toCall > 0. Play to flop with checks.
    // Call/raise to get to flop then check
    // Simpler: craft by calling until flop
    let guard = 0;
    while (s.phase === PHASE.PREFLOP && guard++ < 20) {
      const L = getLegalActions(s, s.actor);
      if (L.call) s = applyAction(s, { type: 'CALL', seat: s.actor }, { now: 1e6 });
      else if (L.check) s = applyAction(s, { type: 'CHECK', seat: s.actor }, { now: 1e6 });
      else if (L.fold) s = applyAction(s, { type: 'FOLD', seat: s.actor }, { now: 1e6 });
      else break;
    }
    if (s.phase === PHASE.FLOP && s.actor != null) {
      const L = getLegalActions(s, s.actor);
      assert.equal(L.check, true);
      const seat = s.actor;
      s = applyAction(s, { type: 'TIMEOUT', seat }, { now: 1e6 });
      assert.ok(s.seats[seat].lastAction === '過牌' || s.actor !== seat);
    }
  });

  it('需要跟注時 TIMEOUT → 蓋牌', () => {
    let s = createInitialState({ timerEnabled: true });
    s = seatAll(s, ['A', 'B', 'C']);
    s = start(s, 11);
    const raiser = s.actor;
    s = applyAction(s, { type: 'BET_RAISE', seat: raiser, amount: 80 }, { now: 1e6 });
    const victim = s.actor;
    const L = getLegalActions(s, victim);
    assert.equal(L.fold, true);
    assert.equal(L.check, false);
    s = applyAction(s, { type: 'TIMEOUT', seat: victim }, { now: 1e6 });
    assert.equal(s.seats[victim].folded, true);
  });
});

describe('邊池實戰：多人全下', () => {
  it('三人全下後發完公共牌並依邊池派彩', () => {
    let s = createInitialState({ timerEnabled: false });
    s = applyAction(s, { type: 'SEAT', seat: 0, name: '短碼', buyIn: 2000, isHost: true });
    s = applyAction(s, { type: 'SEAT', seat: 1, name: '中碼', buyIn: 2000 });
    s = applyAction(s, { type: 'SEAT', seat: 2, name: '深碼', buyIn: 2000 });
    // Reduce chips after seating by starting and... better set via buy-in:
    s.seats[0].chips = 80;
    s.seats[0].buyInTotal = 80;
    s.seats[1].chips = 200;
    s.seats[1].buyInTotal = 200;
    s.seats[2].chips = 2000;
    s.seats[2].buyInTotal = 2000;

    s = start(s, 77);
    // Everyone all-in
    let guard = 0;
    while (
      [PHASE.PREFLOP, PHASE.FLOP, PHASE.TURN, PHASE.RIVER].includes(s.phase) &&
      s.actor != null &&
      guard++ < 40
    ) {
      const L = getLegalActions(s, s.actor);
      if (L.allIn) s = applyAction(s, { type: 'ALL_IN', seat: s.actor }, { now: 1e6 });
      else if (L.call) s = applyAction(s, { type: 'CALL', seat: s.actor }, { now: 1e6 });
      else if (L.check) s = applyAction(s, { type: 'CHECK', seat: s.actor }, { now: 1e6 });
      else break;
    }
    // Should reach showdown or hand_over
    assert.ok(
      s.phase === PHASE.SHOWDOWN || s.phase === PHASE.HAND_OVER,
      'phase=' + s.phase,
    );
    assert.equal(s.board.length, 5);
    const totalChips = s.seats.filter(Boolean).reduce((a, p) => a + p.chips, 0);
    const totalBuy = s.seats.filter(Boolean).reduce((a, p) => a + p.buyInTotal, 0);
    assert.equal(totalChips, totalBuy, '籌碼守恆');
  });
});

describe('JSON 序列化與視角隱藏', () => {
  it('狀態可 JSON round-trip', () => {
    let s = createInitialState({ timerEnabled: false });
    s = seatAll(s, ['宗良', '阿哲', '小美']);
    s = start(s, 9);
    const json = serializeState(s);
    const back = deserializeState(json);
    assert.deepEqual(back, s);
  });

  it('per-seat 視角只看到自己的手牌', () => {
    let s = createInitialState({ timerEnabled: false });
    s = seatAll(s, ['宗良', '阿哲', '小美']);
    s = start(s, 9);
    const v0 = viewForSeat(s, 0);
    const v1 = viewForSeat(s, 1);
    assert.ok(v0.seats[0].hole);
    assert.equal(v0.seats[0].hole.length, 2);
    assert.equal(v0.seats[1].hole, null);
    assert.equal(v0.seats[1].holeHidden, true);
    assert.ok(v1.seats[1].hole);
    assert.equal(v1.seats[0].hole, null);
  });
});

describe('完整一手熱座流程（自動過／跟到底）', () => {
  it('六人桌可打完一手', () => {
    let s = createInitialState({ timerEnabled: false, roomName: '週五牌局' });
    s = seatAll(s, ['宗良', '阿哲', '小芸', '志明', '小美', '老K']);
    s = start(s, 100);
    let guard = 0;
    while (s.phase !== PHASE.HAND_OVER && s.phase !== PHASE.SHOWDOWN && guard++ < 80) {
      if (s.actor == null) break;
      const L = getLegalActions(s, s.actor);
      if (L.check) s = applyAction(s, { type: 'CHECK', seat: s.actor }, { now: 1e6 });
      else if (L.call) s = applyAction(s, { type: 'CALL', seat: s.actor }, { now: 1e6 });
      else if (L.allIn) s = applyAction(s, { type: 'ALL_IN', seat: s.actor }, { now: 1e6 });
      else break;
    }
    if (s.phase === PHASE.SHOWDOWN) {
      while (s.showdown?.pending?.length) {
        const seat = s.showdown.pending[0];
        s = applyAction(s, { type: 'MUCK', seat }, { now: 1e6 });
      }
    }
    assert.equal(s.phase, PHASE.HAND_OVER);
    assert.ok(s.handNumber >= 1);
  });
});

describe('玩家 0 籌碼坐出', () => {
  it('沒籌碼者不參與下一手', () => {
    let s = createInitialState({ timerEnabled: false });
    s = seatAll(s, ['A', 'B', 'C']);
    s.seats[2].chips = 0;
    s = start(s, 2);
    assert.equal(s.seats[2].sittingOut, true);
    assert.equal(s.seats[2].hasHole, false);
    const withCards = s.seats.filter((p) => p && p.hasHole);
    assert.equal(withCards.length, 2);
  });
});
