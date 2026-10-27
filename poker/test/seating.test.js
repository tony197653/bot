import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapSeatsClockwise,
  clockwiseFrom,
  opponentSlotsForCount,
  rolesAreClockwiseAdjacent,
  visualAngle,
} from '../js/ui/seating.js';
import {
  createInitialState,
  applyAction,
  mulberry32,
  PHASE,
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

describe('畫面座位：順時針對齊引擎', () => {
  it('clockwiseFrom 由指定座位起依引擎座位遞增繞圈', () => {
    assert.deepEqual(clockwiseFrom([0, 1, 2, 3], 3), [3, 0, 1, 2]);
    assert.deepEqual(clockwiseFrom([0, 2, 5], 2), [2, 5, 0]);
  });

  it('4 人：hero 在底，順時針為 hero → 下一位 → …，視覺角遞增', () => {
    const occupied = [0, 1, 2, 3];
    const viewer = 3;
    const { order, seatToPos } = mapSeatsClockwise(occupied, viewer);
    assert.deepEqual(order, [3, 0, 1, 2]);
    assert.equal(seatToPos.get(3), 'hero');
    // Clockwise after hero: leftish → top → rightish
    assert.deepEqual(
      [seatToPos.get(0), seatToPos.get(1), seatToPos.get(2)],
      opponentSlotsForCount(3),
    );
    let prev = 0;
    for (const seat of order.slice(1)) {
      const ang = visualAngle(seatToPos.get(seat));
      assert.ok(ang > prev, `angle should increase CW (${prev} → ${ang})`);
      prev = ang;
    }
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
      // UTG (first to act multiway) is seat after BB — adjacent CW from BB
      if (n > 2) {
        const { order } = mapSeatsClockwise(occupied, button);
        const bbIdx = order.indexOf(bb);
        const utg = order[(bbIdx + 1) % order.length];
        assert.equal(s.actor, utg, '翻牌前第一個行動應為 BB 下一位（UTG）');
      }
    }
  });

  it('重現主人回報的 4 人桌：D→SB→BB 不得被 hero 隔開', () => {
    // Engine seats 0宗良 1阿哲 2小芸 3志明; viewer=志明
    const occupied = [0, 1, 2, 3];
    const viewer = 3;
    const button = 0;
    const sb = 1;
    const bb = 2;
    assert.ok(rolesAreClockwiseAdjacent(occupied, viewer, button, sb, bb));
    const { order, seatToPos } = mapSeatsClockwise(occupied, viewer);
    // order: 志明, 宗良, 阿哲, 小芸 — SB then BB with no one between
    const iSb = order.indexOf(sb);
    const iBb = order.indexOf(bb);
    assert.equal((iSb + 1) % 4, iBb);
    // Visual: 宗良 leftish, 阿哲 top, 小芸 rightish — not BB on opposite side of SB across hero
    assert.equal(seatToPos.get(0), 4); // TL
    assert.equal(seatToPos.get(1), 0); // top
    assert.equal(seatToPos.get(2), 1); // TR
    // Angles: SB then BB clockwise (top → TR), not SB(right) then skip hero to BB(left)
    assert.ok(visualAngle(seatToPos.get(sb)) < visualAngle(seatToPos.get(bb)));
  });
});
