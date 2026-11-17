import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, applyAction, PHASE } from '../js/engine/index.js';

function seated() {
  let s = createInitialState({ multiplayer: true, bigBlind: 20 });
  for (let seat = 0; seat < 2; seat++) {
    s = applyAction(s, { type: 'SEAT', seat, name: `P${seat}`, chips: 2000 });
  }
  return s;
}
describe('玩家補碼引擎', () => {
  it('非零籌碼可加任意整數金額，保留暫離與原始狀態', () => {
    const s = applyAction(seated(), { type: 'SET_AWAY', seat: 0, away: true });
    const next = applyAction(s, { type: 'TOP_UP', seat: 0, amount: 37 });
    assert.equal(next.seats[0].chips, 2037);
    assert.equal(next.seats[0].buyInTotal, 2037);
    assert.equal(next.seats[0].sittingOut, true);
    assert.equal(s.seats[0].chips, 2000);
  });
  it('兩手之間可補碼，下一手帶入新增籌碼', () => {
    let s = seated();
    s.phase = PHASE.HAND_OVER;
    s = applyAction(s, { type: 'TOP_UP', seat: 0, amount: 20 });
    s = applyAction(s, { type: 'ACK_HAND' });
    s = applyAction(s, { type: 'START_HAND' }, { randUnit: () => 0.5 });
    assert.equal(s.seats[0].chips + s.seats[0].contributed, 2020);
  });
  it('牌局中拒絕補碼且不改籌碼與底池', () => {
    const s = applyAction(seated(), { type: 'START_HAND' }, { randUnit: () => 0.5 });
    const before = structuredClone(s);
    assert.throws(() => applyAction(s, { type: 'TOP_UP', seat: 0, amount: 2000 }), /牌局進行中無法補碼/);
    assert.deepEqual(s, before);
  });
  it('拒絕低於大盲、非整數、空座位與無效座位', () => {
    for (const amount of [0, -1, 19, 20.5, NaN, Infinity]) {
      assert.throws(() => applyAction(seated(), { type: 'TOP_UP', seat: 0, amount }), /補碼至少 1 大盲，且必須是整數/);
    }
    for (const seat of [-1, 6, 0.5, 2]) {
      assert.throws(() => applyAction(seated(), { type: 'TOP_UP', seat, amount: 20 }));
    }
  });
});
