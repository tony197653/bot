import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapSeatsClockwise,
  clockwiseFrom,
  seatVisualPos,
  dealOrderFromSb,
  rolesAreClockwiseAdjacent,
  visualAngle,
  CW_OPPONENT_SLOTS,
  SLOT_BY_REL,
} from '../js/ui/seating.js';
import {
  createInitialState,
  applyAction,
  mulberry32,
  PHASE,
  foldWinCenterNote,
} from '../js/engine/index.js';

function seatPlayers(names) {
  let s = createInitialState({ timerEnabled: false });
  names.forEach((name, i) => {
    s = applyAction(s, {
      type: 'SEAT',
      seat: i,
      name,
      buyIn: 2000,
      isHost: i === 0,
    });
  });
  return s;
}

describe('畫面座位：固定六位＋順時針', () => {
  it('clockwiseFrom 由指定座位起依引擎座位遞增繞圈', () => {
    assert.deepEqual(clockwiseFrom([0, 1, 2, 3], 3), [3, 0, 1, 2]);
    assert.deepEqual(clockwiseFrom([0, 2, 5], 2), [2, 5, 0]);
  });

  it('相對位移固定：加人只填空位、不重排既有座位', () => {
    const viewer = 0;
    // seats 0+2 occupied → opponent at rel 2 → TL (pos 4)
    let occupied = [0, 2];
    let { seatToPos, emptySlots } = mapSeatsClockwise(occupied, viewer);
    assert.equal(seatToPos.get(0), 'hero');
    assert.equal(seatToPos.get(2), SLOT_BY_REL[2]);
    assert.ok(emptySlots.includes(SLOT_BY_REL[1]));
    // add seat 1 → fills rel 1 (BL); seat 2 stays at same visual pos
    occupied = [0, 1, 2];
    ({ seatToPos, emptySlots } = mapSeatsClockwise(occupied, viewer));
    assert.equal(seatToPos.get(1), SLOT_BY_REL[1]);
    assert.equal(seatToPos.get(2), SLOT_BY_REL[2]);
    assert.equal(emptySlots.length, 3);
  });

  it('6 人全滿：五個對手位皆占用、無空位', () => {
    const occupied = [0, 1, 2, 3, 4, 5];
    const viewer = 3;
    const { seatToPos, emptySlots } = mapSeatsClockwise(occupied, viewer);
    assert.equal(seatToPos.get(3), 'hero');
    assert.equal(emptySlots.length, 0);
    for (const seat of occupied) {
      if (seat === viewer) continue;
      assert.equal(seatToPos.get(seat), seatVisualPos(seat, viewer));
      assert.notEqual(seatToPos.get(seat), 'hero');
    }
  });

  it('空位清單＝未占用的固定對手格', () => {
    const { emptySlots } = mapSeatsClockwise([0, 1], 0);
    assert.deepEqual(emptySlots.sort((a, b) => a - b), [0, 1, 2, 4].sort((a, b) => a - b));
    assert.equal(emptySlots.length, CW_OPPONENT_SLOTS.length - 1);
  });

  it('渲染順時針順序＝引擎順序（以 viewer 為起點）', () => {
    for (let n = 2; n <= 6; n++) {
      const occupied = Array.from({ length: n }, (_, i) => i);
      for (const viewer of occupied) {
        const { order } = mapSeatsClockwise(occupied, viewer);
        assert.deepEqual(order, clockwiseFrom(occupied, viewer));
        assert.equal(order[0], viewer);
      }
    }
  });

  it('button→SB→BB 在畫面上順時針相鄰（含單挑 button=SB）', () => {
    for (let n = 2; n <= 6; n++) {
      const names = ['宗良', '阿哲', '小芸', '志明', '小美', '老K'].slice(0, n);
      let s = seatPlayers(names);
      s = applyAction(s, { type: 'START_HAND' }, { randUnit: mulberry32(n * 17), now: 1e6 });
      assert.equal(s.phase, PHASE.PREFLOP);
      const occupied = s.seats.map((p, i) => (p && p.hasHole ? i : null)).filter((x) => x != null);
      const button = s.button;
      const sb = s.sbSeat;
      const bb = s.bbSeat;
      if (n === 2) {
        assert.equal(sb, button, '單挑：按鈕＝小盲');
        assert.notEqual(bb, button);
      } else {
        assert.notEqual(sb, button);
        assert.notEqual(bb, sb);
      }
      for (const viewer of occupied) {
        assert.ok(
          rolesAreClockwiseAdjacent(occupied, viewer, button, sb, bb),
          `n=${n} viewer=${viewer} D=${button} SB=${sb} BB=${bb}`,
        );
      }
      if (n > 2) {
        const { order } = mapSeatsClockwise(occupied, button);
        const bbIdx = order.indexOf(bb);
        const utg = order[(bbIdx + 1) % order.length];
        assert.equal(s.actor, utg, '翻牌前第一個行動應為 BB 下一位（UTG）');
      }
    }
  });

  it('重現主人回報的 4 人桌：D→SB→BB 不得被 hero 隔開', () => {
    const occupied = [0, 1, 2, 3];
    const viewer = 3;
    const button = 0;
    const sb = 1;
    const bb = 2;
    assert.ok(rolesAreClockwiseAdjacent(occupied, viewer, button, sb, bb));
    const { order, seatToPos } = mapSeatsClockwise(occupied, viewer);
    const iSb = order.indexOf(sb);
    const iBb = order.indexOf(bb);
    assert.equal((iSb + 1) % 4, iBb);
    // Fixed relative: seat0→top, seat1→TR, seat2→BR; BL/TL empty (seats 4/5)
    assert.equal(seatToPos.get(0), 0);
    assert.equal(seatToPos.get(1), 1);
    assert.equal(seatToPos.get(2), 2);
    assert.ok(visualAngle(seatToPos.get(sb)) < visualAngle(seatToPos.get(bb)));
  });
});

describe('發牌順序：自小盲起順時針兩輪', () => {
  it('回傳 occupied×2，且每輪皆自 SB 起', () => {
    const occupied = [0, 1, 2, 3];
    const sb = 1;
    const order = dealOrderFromSb(occupied, sb);
    assert.equal(order.length, 8);
    assert.deepEqual(order.slice(0, 4), [1, 2, 3, 0]);
    assert.deepEqual(order.slice(4), [1, 2, 3, 0]);
  });

  it('與引擎實際發牌座位順序一致', () => {
    let s = seatPlayers(['宗良', '阿哲', '小芸', '志明']);
    s = applyAction(s, { type: 'START_HAND' }, { randUnit: mulberry32(99), now: 1e6 });
    const occupied = s.seats.map((p, i) => (p ? i : null)).filter((x) => x != null);
    const expected = dealOrderFromSb(occupied, s.sbSeat);
    // Engine deals two rounds from left of button (= SB in multiway)
    assert.equal(expected[0], s.sbSeat);
    assert.equal(expected[occupied.length], s.sbSeat);
    for (const seat of occupied) {
      assert.equal(s.seats[seat].hole.length, 2);
    }
  });
});

describe('蓋牌獲勝中央文案', () => {
  it('全員蓋牌時產生「X 贏得 N（其他人蓋牌）」', () => {
    let s = seatPlayers(['宗良', '阿哲', '小芸']);
    s = applyAction(s, { type: 'START_HAND' }, { randUnit: mulberry32(3), now: 1e6 });
    // Fold until one remains
    let guard = 0;
    while (s.phase === PHASE.PREFLOP && guard++ < 12) {
      const actor = s.actor;
      const live = s.seats.filter((p) => p && !p.folded).length;
      if (live <= 1) break;
      s = applyAction(s, { type: 'FOLD', seat: actor }, { now: 1e6 + guard });
    }
    assert.equal(s.phase, PHASE.HAND_OVER);
    const note = foldWinCenterNote(s);
    assert.ok(note);
    assert.match(note, /贏得/);
    assert.match(note, /其他人蓋牌/);
    assert.ok(s.winnerPayouts);
  });

  it('攤牌獲勝不產生蓋牌文案', () => {
    let s = seatPlayers(['宗良', '阿哲']);
    s = applyAction(s, { type: 'START_HAND' }, { randUnit: mulberry32(8), now: 1e6 });
    s = applyAction(s, { type: 'CALL', seat: s.actor }, { now: 1e6 + 1 });
    s = applyAction(s, { type: 'CHECK', seat: s.actor }, { now: 1e6 + 2 });
    // Check down to showdown
    let guard2 = 0;
    while (
      [PHASE.FLOP, PHASE.TURN, PHASE.RIVER].includes(s.phase) &&
      guard2++ < 20
    ) {
      s = applyAction(s, { type: 'CHECK', seat: s.actor }, { now: 1e6 + 10 + guard2 });
    }
    if (s.phase === PHASE.SHOWDOWN && s.showdown?.pending?.length) {
      while (s.showdown?.pending?.length) {
        const seat = s.showdown.pending[0];
        s = applyAction(s, { type: 'MUCK', seat }, { now: Date.now() });
      }
    }
    assert.ok(s.phase === PHASE.HAND_OVER || s.phase === PHASE.SHOWDOWN);
    if (s.phase === PHASE.HAND_OVER) {
      assert.equal(foldWinCenterNote(s), null);
    }
  });
});
