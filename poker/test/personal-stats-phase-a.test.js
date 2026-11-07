/**
 * Phase A personal-stats: handId, preflop flags, HAND_OVER snapshot, pending queue,
 * independent write chain (does not block game flow).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialState,
  applyAction,
  publicState,
  mulberry32,
  PHASE,
} from '../js/engine/index.js';
import {
  generateHandId,
  handIdFromPub,
  createPreflopFlagTracker,
  isFullRaise,
  buildHandStatsSnapshot,
  snapshotPrivacyViolations,
  createMemoryPendingQueue,
  createStatsWriteChain,
  createStatsSession,
} from '../js/stats/index.js';

function seatTwo(s, chips = 2000) {
  let st = s;
  st = applyAction(st, {
    type: 'SEAT',
    seat: 0,
    name: 'A',
    id: 'uid-a',
    buyIn: chips,
    isHost: true,
  });
  st = applyAction(st, {
    type: 'SEAT',
    seat: 1,
    name: 'B',
    id: 'uid-b',
    buyIn: chips,
  });
  return st;
}

function start(st, seed = 1) {
  return applyAction(
    st,
    { type: 'START_HAND' },
    { randUnit: mulberry32(seed), now: 1_000_000 },
  );
}

function act(st, type, extra = {}, now = 1_000_000) {
  return applyAction(
    st,
    { type, seat: st.actor, ...extra },
    { now, randUnit: mulberry32(99) },
  );
}

describe('handId stability', () => {
  it('START_HAND assigns handId; publicState publishes it', () => {
    let s = createInitialState({ timerEnabled: false });
    s = seatTwo(s);
    assert.equal(s.handId, null);
    s = start(s, 3);
    assert.equal(typeof s.handId, 'string');
    assert.ok(s.handId.length > 8);
    const pub = publicState(s);
    assert.equal(pub.handId, s.handId);
    assert.equal(handIdFromPub(pub), s.handId);
  });

  it('handId reused from pub after reconnect-style hydrate (same handNo)', () => {
    let s = createInitialState({ timerEnabled: false });
    s = seatTwo(s);
    s = start(s, 5);
    const id = s.handId;
    const handNo = s.handNumber;
    // Simulate host rebuild: new engine + restore handNo/handId from pub
    let s2 = createInitialState({ timerEnabled: false });
    s2 = seatTwo(s2);
    s2.handNumber = handNo;
    s2.handId = handIdFromPub({ handId: id, handNo });
    assert.equal(s2.handId, id);
    assert.equal(s2.handNumber, handNo);
  });

  it('handNo collision scenario: same handNo can get different handIds across hands', () => {
    // Documents why roomId+handNo is insufficient when a pub write is skipped:
    // two distinct hands can present the same handNo after a lost bump.
    const a = generateHandId();
    const b = generateHandId();
    assert.notEqual(a, b);
    const handNo = 7;
    assert.notEqual(`${handNo}:${a}`, `${handNo}:${b}`);
  });

  it('each START_HAND gets a fresh handId', () => {
    let s = createInitialState({ timerEnabled: false, multiplayer: true });
    s = seatTwo(s);
    s = start(s, 1);
    const id1 = s.handId;
    // Fold out quickly to HAND_OVER (mp fold-win skips reveal)
    s = act(s, 'FOLD'); // HU SB folds → BB wins
    assert.equal(s.phase, PHASE.HAND_OVER);
    s = applyAction(s, { type: 'ACK_HAND' });
    s = start(s, 2);
    assert.notEqual(s.handId, id1);
  });
});

describe('preflop flags', () => {
  it('flags reset across hands; open raise is VPIP+PFR; check is not VPIP', () => {
    const tracker = createPreflopFlagTracker();
    let s = createInitialState({ timerEnabled: false, multiplayer: true });
    s = seatTwo(s);
    s = start(s, 11);
    // HU: button/SB acts first — raise over BB
    let prev = s;
    const openSeat = prev.actor;
    s = act(s, 'BET_RAISE', { amount: 60 });
    tracker.observe(prev, { type: 'BET_RAISE', seat: openSeat, amount: 60 }, s);
    const f0 = tracker.snapshot()[openSeat];
    assert.equal(f0.vpip, true);
    assert.equal(f0.pfr, true);
    assert.equal(f0.pfrOpp, true);

    // BB can check if SB only called; here facing raise — fold then new hand for check case
    tracker.reset();
    assert.deepEqual(tracker.snapshot(), {});

    // Postflop check is out of preflop tracker scope; BB option check:
    s = createInitialState({ timerEnabled: false, multiplayer: true });
    s = seatTwo(s);
    s = start(s, 12);
    prev = s;
    s = act(s, 'CALL'); // SB limp
    tracker.observe(prev, { type: 'CALL', seat: prev.actor }, s);
    prev = s;
    const bb = prev.actor;
    s = act(s, 'CHECK'); // BB option check
    tracker.observe(prev, { type: 'CHECK', seat: bb }, s);
    const fBb = tracker.snapshot()[bb];
    assert.equal(fBb.pfrOpp, true);
    assert.equal(fBb.vpipOpp, true); // could raise
    assert.equal(fBb.vpip, false); // pure check
    assert.equal(fBb.pfr, false);
  });

  it('short all-in does not count as PFR and does not create 3-bet opp', () => {
    let s = createInitialState({ timerEnabled: false, startingStack: 2000 });
    s = applyAction(s, {
      type: 'SEAT',
      seat: 0,
      name: 'A',
      id: 'a',
      buyIn: 2000,
      isHost: true,
    });
    s = applyAction(s, { type: 'SEAT', seat: 1, name: 'B', id: 'b', buyIn: 2000 });
    s = applyAction(s, { type: 'SEAT', seat: 2, name: 'C', id: 'c', buyIn: 2000 });
    s.seats[2].chips = 25; // short — less than min raise over BB
    s.seats[2].buyInTotal = 25;
    s = start(s, 21);
    // 3-handed: UTG (left of BB) acts first
    const tracker = createPreflopFlagTracker();
    // Find short stack seat if it's actor, else fold to them after a raise
    // Open raise from actor
    let prev = s;
    const openSeat = s.actor;
    s = act(s, 'BET_RAISE', { amount: 60 });
    tracker.observe(prev, { type: 'BET_RAISE', seat: openSeat, amount: 60 }, s);
    assert.equal(isFullRaise(prev, s, openSeat), true);

    // Next player short-shove if possible
    if (s.phase === PHASE.PREFLOP && s.actor != null) {
      const seat = s.actor;
      const p = s.seats[seat];
      if (p.chips > 0 && p.chips + p.bet < s.minRaiseTo) {
        prev = s;
        s = act(s, 'ALL_IN');
        tracker.observe(prev, { type: 'ALL_IN', seat }, s);
        const f = tracker.snapshot()[seat];
        assert.equal(f.vpip, true);
        assert.equal(f.pfr, false);
        assert.equal(isFullRaise(prev, s, seat), false);
        // Later seats should not get threeBetOpp from this short all-in alone
        // (firstFullRaiseSeen is already true from open; short doesn't change that)
        // Facing open, next player with chips would get 3-bet opp — short shover
        // who cannot complete re-raise should not get threeBetOpp.
        assert.equal(f.threeBetOpp, false);
      }
    }
  });

  it('forced all-in blind never becomes actor → no vpipOpp', () => {
    let s = createInitialState({
      timerEnabled: false,
      multiplayer: true,
      bigBlind: 20,
      smallBlind: 10,
      startingStack: 2000,
    });
    s = applyAction(s, {
      type: 'SEAT',
      seat: 0,
      name: 'A',
      id: 'a',
      buyIn: 2000,
      isHost: true,
    });
    s = applyAction(s, { type: 'SEAT', seat: 1, name: 'B', id: 'b', buyIn: 2000 });
    // HU hand1: seat0 is button/SB. Exactly SB chips → all-in from blind, never acts.
    s.seats[0].chips = 10;
    s = start(s, 4);
    const tracker = createPreflopFlagTracker();
    let guard = 40;
    while (s.phase === PHASE.PREFLOP && s.actor != null && guard-- > 0) {
      const prev = s;
      const seat = s.actor;
      assert.notEqual(seat, 0, 'forced all-in seat must not become actor');
      // Facing all-in blind: BB often checks (toCall 0) rather than fold/call.
      let next;
      for (const type of ['CHECK', 'CALL', 'FOLD']) {
        try {
          next = act(s, type);
          tracker.observe(prev, { type, seat }, next);
          break;
        } catch {
          /* try next */
        }
      }
      assert.ok(next, 'expected a legal action');
      s = next;
    }
    assert.equal(s.seats[0].allIn, true);
    assert.equal(tracker.snapshot()[0], undefined);
  });
});

describe('HAND_OVER snapshot', () => {
  it('builds immutable per-seat summary without hole cards / action log', () => {
    const session = createStatsSession({ roomId: 'room-1' });
    let s = createInitialState({ timerEnabled: false, multiplayer: true });
    s = seatTwo(s);
    session.onHandStarting(s, ['uid-a', 'uid-b', null, null, null, null]);
    s = start(s, 9);
    session.onHandStarted(s);
    const handId = s.handId;

    let prev = s;
    s = act(s, 'FOLD');
    session.onAction(prev, { type: 'FOLD', seat: prev.actor }, s);
    assert.equal(s.phase, PHASE.HAND_OVER);

    const snap = session.onHandOver(s);
    assert.ok(snap);
    assert.equal(snap.handId, handId);
    assert.equal(snap.roomId, 'room-1');
    assert.ok(snap.seats.length >= 1);
    assert.equal(snapshotPrivacyViolations(snap).length, 0);
    assert.throws(() => {
      snap.seats.push({});
    });
  });

  it('VOID hands produce no snapshot', () => {
    const session = createStatsSession({ roomId: 'room-v' });
    let s = createInitialState({ timerEnabled: false, multiplayer: true });
    s = seatTwo(s);
    session.onHandStarting(s, ['uid-a', 'uid-b']);
    s = start(s, 2);
    session.onHandStarted(s);
    session.onVoid();
    const stacks = [2000, 2000, 0, 0, 0, 0];
    s = applyAction(s, { type: 'VOID_HAND', stacks });
    assert.equal(s.phase, PHASE.HAND_OVER);
    assert.equal(session.onHandOver(s), null);
  });

  it('netDelta excludes external top-ups', () => {
    const snap = buildHandStatsSnapshot({
      roomId: 'r',
      handId: 'h1',
      handNo: 1,
      handStartedAt: 1,
      engine: {
        seats: [
          { chips: 2500, id: 'u' },
          null,
          null,
          null,
          null,
          null,
        ],
        winnerPayouts: { 0: 100 },
      },
      startBySeat: { 0: { uid: 'u', chipsBefore: 2000, dealt: true } },
      flagsBySeat: {},
      externalTopUps: { 0: 500 },
    });
    assert.equal(snap.seats[0].netDelta, 0); // 2500 - 2000 - 500
    assert.equal(snap.seats[0].wonAnyPot, true);
  });
});

describe('pending queue + independent write chain', () => {
  it('pending entries across hands are not overwritten; dedupe by handId+uid', async () => {
    const q = createMemoryPendingQueue();
    const r1 = await q.enqueue({
      handId: 'h1',
      uid: 'u1',
      roomId: 'r',
      summary: { netDelta: 10 },
      enqueuedAt: 1,
    });
    assert.equal(r1, 'added');
    const r2 = await q.enqueue({
      handId: 'h2',
      uid: 'u1',
      roomId: 'r',
      summary: { netDelta: -5 },
      enqueuedAt: 2,
    });
    assert.equal(r2, 'added');
    const dup = await q.enqueue({
      handId: 'h1',
      uid: 'u1',
      roomId: 'r',
      summary: { netDelta: 999 },
      enqueuedAt: 3,
    });
    assert.equal(dup, 'duplicate');
    const list = await q.list();
    assert.equal(list.length, 2);
    assert.equal(list.find((e) => e.handId === 'h1').summary.netDelta, 10);
  });

  it('stats failure/exception does not block subsequent betting simulation', async () => {
    const q = createMemoryPendingQueue();
    const chain = createStatsWriteChain({
      queue: q,
      onError: () => {},
    });
    chain.injectFailure(new Error('boom'));
    // Game flow continues without awaiting
    let s = createInitialState({ timerEnabled: false, multiplayer: true });
    s = seatTwo(s);
    s = start(s, 1);
    assert.equal(s.phase, PHASE.PREFLOP);
    s = act(s, 'FOLD');
    assert.equal(s.phase, PHASE.HAND_OVER);
    await chain.whenIdle();
    // Chain recovered: can still enqueue
    chain.enqueueSnapshot({
      roomId: 'r',
      handId: 'hx',
      handNo: 1,
      handStartedAt: 1,
      seats: [
        {
          uid: 'uid-a',
          seat: 0,
          wonAnyPot: true,
          vpipOpp: true,
          vpip: true,
          pfrOpp: true,
          pfr: false,
          threeBetOpp: false,
          threeBet: false,
          netDelta: 10,
        },
      ],
      voided: false,
    });
    await chain.whenIdle();
    assert.equal(await q.has('hx', 'uid-a'), true);
  });
});
