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
import { hostShouldTimeout, cashoutStateReady } from '../js/net/host.js';

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


describe('離桌結帳的已提交狀態保護', () => {
  const engine = { phase: 'hand_over', seats: [{ chips: 2010 }, { chips: 1990 }] };
  const room = { pub: { phase: 'hand_over' }, seatUids: ['host', 'guest'],
    stacks: [2010, 1990], chipTotal: 4000 };
  it('拒絕手初快取 2000，允許蓋牌後 1990，且籌碼總額守恆', () => {
    assert.equal(cashoutStateReady({ ...room, stacks: [2000, 2000] }, engine, 1, 'guest'), false);
    assert.equal(cashoutStateReady(room, engine, 1, 'guest'), true);
    assert.equal(cashoutStateReady({ ...room, chipTotal: 3990 }, engine, 1, 'guest'), false);
    assert.equal(cashoutStateReady({ ...room, pub: { phase: 'preflop' } }, engine, 1, 'guest'), false);
    assert.equal(cashoutStateReady(room, engine, 1, 'other'), false);
    assert.equal(cashoutStateReady({ ...room, pub: { phase: 'hand_over', handNo: 1 } }, engine, 1, 'guest'), false);
    assert.equal(cashoutStateReady({ ...room, stacks: [2000, 1990], chipTotal: 3990 }, engine, 1, 'guest'), false);
  });
  it('結帳先等寫入鏈與重讀；未成功時保留離桌要求', () => {
    const host = readFileSync(join(ROOT, 'js/net/host.js'), 'utf8');
    const cashout = host.slice(host.indexOf('  async function cashoutSeat('), host.indexOf('  async function approveTopUp'));
    assert.match(cashout, /await writeChain;[\s\S]*await fs.getDoc[\s\S]*cashoutStateReady[\s\S]*hostCashoutBatch/);
    assert.match(host, /if \(!await cashoutSeat\(seat, item.uid\)\) return;\s*leaveQueue.splice/);
  });
  it('收桌先作廢並確認發布，再逐席結帳、關桌；立即顯示結算中', () => {
    const host = readFileSync(join(ROOT, 'js/net/host.js'), 'utf8');
    const app = readFileSync(join(ROOT, 'js/ui/mp-app.js'), 'utf8');
    const prepare = host.slice(host.indexOf('  async function prepareClose'), host.indexOf('  function voidHand'));
    assert.match(prepare, /closing = true;[\s\S]*clearNextHandTimer[\s\S]*VOID_HAND[\s\S]*await writeChain;[\s\S]*await fs.getDoc[\s\S]*cashoutStateReady/);
    const close = app.slice(app.indexOf('async function performHostCloseRoomInner'), app.indexOf('function showCloseRoomConfirm'));
    assert.match(close, /await closingLoop.prepareClose\(\);[\s\S]*await closingLoop.cashoutSeat[\s\S]*await closeRoom/);
    assert.match(app, /showCloseResultCard\(\{ state: 'pending' \}\);[\s\S]*closeInFlight = performHostCloseRoom/);
    assert.doesNotMatch(app, /mpClosingNotice/);
  });
});


describe('收桌作廢未完成牌局', () => {
  it('四人含離桌蓋牌者，保留先前結果並分配中離者本手投入', () => {
    let engine = createInitialState({ multiplayer: true, smallBlind: 10, bigBlind: 20 });
    const stacks = [2100, 1990, 1910, 2000, 0, 0];
    for (let seat = 0; seat < 4; seat++) {
      engine = applyAction(engine, { type: 'SEAT', seat, name: `P${seat}`, chips: stacks[seat] });
    }
    engine = applyAction(engine, { type: 'START_HAND' }, { randUnit: mulberry32(1), now: 1000 });
    engine = applyAction(engine, { type: 'LEAVE_FOLD', seat: 1 });
    assert.equal(engine.seats[1].folded, true);
    engine = applyAction(engine, { type: 'VOID_HAND', stacks });
    assert.equal(engine.phase, PHASE.HAND_OVER);
    assert.deepEqual(engine.seats.map((p) => p?.chips || 0), [2103, 1980, 1914, 2003, 0, 0]);
    assert.equal(engine.seats.reduce((sum, p) => sum + (p?.chips || 0), 0), 8000);
    assert.equal(engine.seats[1].folded, false);
  });
});

// 整桌批次 builder：以 SDK stub 驗證寫入內容、平行讀取與錯誤傳遞。
describe('hostCloseAllBatch', () => {
  async function fixture(n = 6, options = {}) {
    const { hostCloseAllBatch } = await import('../js/net/ledger.js');
    const writes = []; const reads = []; let commits = 0;
    const room = { hostUid: 'H', status: 'lobby', rev: 5, pub: { phase: 'hand_over' },
      seatUids: Array.from({ length: 6 }, (_, i) => i < n ? `u${i}` : ''),
      stacks: [0, 100, 200, 300, 400, 500],
      sess: Array.from({ length: 6 }, (_, i) => i < n ? {
        sessionNo: i + 1, buyIn: 100, topUps: 2, topUpChips: 40, hands: 3, nightKey: '20261101',
      } : null), ...options.room };
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const fs = {
      doc: (_db, ...parts) => parts.join('/'), serverTimestamp: () => 'SERVER_TIME',
      getDoc: async (path) => {
        reads.push(path);
        await gate;
        const isNight = path.includes('/nights/');
        return { exists: () => true, data: () => isNight
          ? { buyIn: 10, cashOut: 20, topUps: 1, hands: 2, lastEntry: 'old' }
          : { bank: 50, tableRoomId: options.skip ? null : 'R', sessionNo: Number(path.slice(-1)) + 1,
            topUps: 4, topUpChips: 80, handsPlayed: 7 } };
      },
      writeBatch: () => ({ set: (path, data) => writes.push({ path, data }),
        update: (path, data) => writes.push({ path, data }),
        commit: async () => { commits++; if (options.error) throw options.error; } }),
    };
    const pending = hostCloseAllBatch({ db: {}, fs }, { hostUid: 'H', roomId: 'R', room, displayNameOf: () => '玩家甲' });
    // 所有帳戶與 nights 都必須在第一筆讀取完成前送出。
    assert.equal(reads.length, room.status === 'closed' ? 0 : n * 2);
    release();
    return { pending, writes, reads, commits: () => commits };
  }
  it('六席（含零籌碼）只提交一次；帳本、帳戶與累計 nights 內容正確', async () => {
    const f = await fixture(); await f.pending;
    assert.equal(f.commits(), 1); assert.equal(f.writes.length, 19);
    const r = f.writes[0].data;
    assert.equal(r.status, 'closed'); assert.equal(r.rev, 6); assert.equal(r.chipTotal, 0);
    assert.deepEqual(r.seatUids, Array(6).fill('')); assert.deepEqual(r.stacks, Array(6).fill(0));
    assert.deepEqual(r.sess, Array(6).fill(null));
    for (let i = 0; i < 6; i++) {
      const [ledger, player, night] = f.writes.slice(1 + i * 3, 4 + i * 3);
      assert.equal(ledger.path, `pokerPlayers/u${i}/ledger/R_${i + 1}_cashout`);
      assert.equal(ledger.data.amount, i * 100); assert.equal(ledger.data.by, 'H');
      assert.equal(ledger.data.seat, i); assert.equal(ledger.data.at, 'SERVER_TIME');
      assert.equal(player.data.bank, 50 + i * 100); assert.equal(player.data.total, player.data.bank);
      assert.equal(player.data.tableRoomId, null); assert.equal(player.data.inPlay, 0);
      assert.equal(player.data.topUps, 6); assert.equal(player.data.topUpChips, 120);
      assert.equal(player.data.handsPlayed, 10);
      assert.equal(night.data.buyIn, 150); assert.equal(night.data.cashOut, 20 + i * 100);
      assert.equal(night.data.net, i * 100 - 130); assert.equal(night.data.topUps, 3);
      assert.equal(night.data.hands, 5); assert.equal(night.data.name, '玩家甲');
    }
  });
  it('仍佔座但帳戶無綁定：禁止漏寫 Rules 必要帳本', async () => {
    const f = await fixture(4, { skip: true });
    await assert.rejects(f.pending, /玩家帳戶與座位帳不同步/);
    assert.equal(f.commits(), 0);
  });
  it('已關桌重試不讀取也不提交', async () => {
    const f = await fixture(0, { room: { status: 'closed' } });
    assert.deepEqual(await f.pending, { skipped: true }); assert.equal(f.commits(), 0);
  });
  it('permission-denied 與網路錯誤均交由呼叫端處理，不自行重複入帳', async () => {
    for (const code of ['permission-denied', 'unavailable']) {
      const error = Object.assign(new Error(code), { code });
      const f = await fixture(4, { error });
      await assert.rejects(f.pending, (e) => e === error); assert.equal(f.commits(), 1);
    }
  });
});
