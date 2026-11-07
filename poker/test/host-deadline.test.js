/**
 * Host action deadline: onTick must use engine.deadline (re-armed per act),
 * never a stale host-side arm from hand start / prior timeout.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createInitialState,
  applyAction,
  PHASE,
  getLegalActions,
} from '../js/engine/index.js';
import { hostShouldTimeout } from '../js/net/host.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ACTION_MS = 30_000;
const GRACE = 1000;

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seatAll(s, names) {
  let st = s;
  names.forEach((name, i) => {
    st = applyAction(st, {
      type: 'SEAT',
      seat: i,
      name,
      isHost: i === 0,
    });
  });
  return st;
}

function act(s, now) {
  const seat = s.actor;
  const L = getLegalActions(s, seat);
  if (L.check) return applyAction(s, { type: 'CHECK', seat }, { now });
  if (L.call) return applyAction(s, { type: 'CALL', seat }, { now });
  if (L.fold) return applyAction(s, { type: 'FOLD', seat }, { now });
  throw new Error('no legal action');
}

describe('hostShouldTimeout — engine per-action deadline', () => {
  it('no timeout when deadline is null (deal FX / hand start)', () => {
    let s = createInitialState({
      timerEnabled: true,
      actionTimeoutMs: ACTION_MS,
      multiplayer: true,
    });
    s = seatAll(s, ['A', 'B', 'C']);
    const t0 = 1_000_000;
    s = applyAction(s, { type: 'START_HAND' }, { randUnit: mulberry32(1), now: t0 });
    assert.equal(s.deadline, null);
    assert.equal(hostShouldTimeout(s, t0 + 40_000, GRACE), false);
  });

  it('each action re-arms; early wall-clock does not timeout', () => {
    let s = createInitialState({
      timerEnabled: true,
      actionTimeoutMs: ACTION_MS,
      multiplayer: true,
    });
    s = seatAll(s, ['A', 'B', 'C']);
    let now = 2_000_000;
    s = applyAction(s, { type: 'START_HAND' }, { randUnit: mulberry32(2), now });
    now += 5_000;
    s = applyAction(s, { type: 'ARM_DEADLINE' }, { now });
    const firstDeadline = s.deadline;
    assert.equal(firstDeadline, now + ACTION_MS);

    // Act well before first deadline — engine re-arms for next actor
    now += 20_000;
    const actorBefore = s.actor;
    s = act(s, now);
    assert.notEqual(s.deadline, firstDeadline);
    assert.equal(s.deadline, now + ACTION_MS);
    // Stale first arm (+grace) must NOT fire against the new actor
    assert.equal(hostShouldTimeout(s, firstDeadline + GRACE + 1, GRACE), false);
    assert.equal(hostShouldTimeout(s, now + ACTION_MS + GRACE + 1, GRACE), true);
    assert.ok(s.actor == null || s.actor !== actorBefore || s.deadline > firstDeadline);
  });

  it('real timeout after full per-action time → fold/check', () => {
    let s = createInitialState({
      timerEnabled: true,
      actionTimeoutMs: ACTION_MS,
      multiplayer: true,
    });
    s = seatAll(s, ['A', 'B', 'C']);
    let now = 3_000_000;
    s = applyAction(s, { type: 'START_HAND' }, { randUnit: mulberry32(3), now });
    now += 100;
    s = applyAction(s, { type: 'ARM_DEADLINE' }, { now });
    const seat = s.actor;
    const L = getLegalActions(s, seat);
    assert.ok(L.fold || L.check);

    // Not yet
    assert.equal(hostShouldTimeout(s, now + ACTION_MS, GRACE), false);
    assert.equal(hostShouldTimeout(s, now + ACTION_MS + GRACE + 1, GRACE), true);

    now = now + ACTION_MS + GRACE + 1;
    s = applyAction(s, { type: 'TIMEOUT', seat }, { now });
    if (L.check) {
      assert.ok(
        s.seats[seat].lastAction === '過牌' || s.actor !== seat || s.seats[seat].folded,
      );
    } else {
      assert.equal(s.seats[seat].folded, true);
    }
  });

  it('long hand (>31s) → next hand first actor NOT auto-folded before clock', () => {
    let s = createInitialState({
      timerEnabled: true,
      actionTimeoutMs: ACTION_MS,
      multiplayer: true,
    });
    s = seatAll(s, ['小明', '小芸', '大雄']);
    let now = 5_000_000;
    s = applyAction(s, { type: 'START_HAND' }, { randUnit: mulberry32(9), now });
    now += 200;
    s = applyAction(s, { type: 'ARM_DEADLINE' }, { now });

    // Simulate a long hand: many acts spanning > 31s of wall clock
    let guard = 0;
    while (
      s.phase !== PHASE.HAND_OVER &&
      s.phase !== PHASE.SHOWDOWN &&
      guard++ < 40
    ) {
      if (s.actor == null) break;
      now += 8_000; // each think ~8s; several acts ≫ 31s from hand start
      assert.equal(
        hostShouldTimeout(s, now, GRACE),
        false,
        `must not timeout mid-think after act re-arm (t+${now - 5e6})`,
      );
      s = act(s, now);
    }
    // Finish showdown / hand over if needed
    if (s.phase === PHASE.SHOWDOWN) {
      now += 100;
      s = applyAction(s, { type: 'REVEAL_TIMEOUT' }, { now });
    }
    assert.ok(
      s.phase === PHASE.HAND_OVER || s.phase === PHASE.SHOWDOWN || s.deadline == null,
    );
    const elapsed = now - 5_000_000;
    assert.ok(elapsed > 31_000, `hand must span >31s, got ${elapsed}`);

    // Next hand: START_HAND clears deadline — host must not fire on stale arm
    now += 3_000;
    s = applyAction(s, { type: 'ACK_HAND' }, { now });
    now += 50;
    s = applyAction(s, { type: 'START_HAND' }, { randUnit: mulberry32(10), now });
    assert.equal(s.handNumber, 2);
    assert.equal(s.deadline, null);
    const firstActor = s.actor;
    assert.ok(firstActor != null);
    // ~1s into hand 2 (bug: folded at 766ms) — must NOT timeout
    assert.equal(hostShouldTimeout(s, now + 766, GRACE), false);
    assert.equal(hostShouldTimeout(s, now + 40_000, GRACE), false);

    // Clock starts only after ARM_DEADLINE
    now += 4_000;
    s = applyAction(s, { type: 'ARM_DEADLINE' }, { now });
    assert.equal(s.deadline, now + ACTION_MS);
    assert.equal(s.actor, firstActor);
    assert.equal(s.seats[firstActor].folded, false);
    assert.equal(hostShouldTimeout(s, now + 766, GRACE), false);
    assert.equal(hostShouldTimeout(s, now + ACTION_MS + GRACE + 1, GRACE), true);
  });
});

describe('host.js source: onTick uses engine deadline, clears at hand end', () => {
  it('syncs deadlineLocal from engine; onTick uses hostShouldTimeout', () => {
    const src = readFileSync(join(ROOT, 'js/net/host.js'), 'utf8');
    assert.match(src, /export function hostShouldTimeout/);
    assert.match(src, /function syncDeadlineFromEngine/);
    assert.match(src, /syncDeadlineFromEngine\(\)/);
    assert.match(src, /hostShouldTimeout\(engine\)/);
    // Must not re-arm deadlineLocal with a fresh actionMs after TIMEOUT
    const onTick = src.slice(src.indexOf('function onTick'), src.indexOf('function start('));
    assert.match(onTick, /hostShouldTimeout/);
    assert.doesNotMatch(
      onTick,
      /deadlineLocal\s*=\s*hostClockAt\s*\+\s*\(room\.config\.actionMs/,
    );
    // ARM_DEADLINE path syncs (no independent stale formula alone)
    assert.match(src, /ARM_DEADLINE[\s\S]*?syncDeadlineFromEngine/);
  });
});
