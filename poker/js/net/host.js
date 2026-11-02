/**
 * Host loop: intents → applyAction → write pub/hole; away; seating; money batches (§6.2).
 * Runs on any visible page while this client is host.
 */

import {
  createInitialState,
  applyAction,
  publicState,
  PHASE,
  cardKey,
} from '../engine/index.js';
import { estimateMpDealTotalMs, MP_FX } from '../ui/fx-mp.js';
import { DEAL_FX } from '../ui/fx.js';
import { nightKeyOf, hostCashoutBatch } from './ledger.js';
import { recordWrite, hostMustStopNewHand } from './quota.js';
import { listenPresence } from './presence.js';

/**
 * @param {{ db:any, fs:any }} fb
 * @param {object} opts
 */
export function createHostLoop(fb, opts) {
  const {
    roomId,
    uid,
    getRoom,
    onLocalState,
    displayNameOf,
  } = opts;
  const { db, fs } = fb;

  /** @type {object|null} */
  let engine = null;
  let actionSeq = 0;
  /** @type {Record<string, number>} last seen presence change (local clock) */
  const presenceSeen = {};
  /** @type {Record<string, {beatMs:number,vis:boolean}>} */
  let presenceMap = {};
  /** @type {ReturnType<typeof setInterval>|null} */
  let tickTimer = null;
  /** @type {(() => void)|null} */
  let stopIntentListen = null;
  /** @type {(() => void)|null} */
  let stopPresenceListen = null;
  let lastWriteAt = 0;
  let writeChain = Promise.resolve();
  let pendingFlush = null;
  /** @type {object[]} */
  const sitQueue = [];
  const leaveQueue = [];
  /** @type {Record<number, true>} */
  let away = {};
  let seatedAt = [0, 0, 0, 0, 0, 0];
  let topUpReqs = {};
  let pendingSeats = [];
  let deadlineLocal = null;
  let hostClockAt = null;
  let rejects = {};
  let running = false;

  function ensureEngine(room) {
    if (engine) return engine;
    engine = createInitialState({
      multiplayer: true,
      smallBlind: room.config.sb,
      bigBlind: room.config.bb,
      startingStack: room.config.newPlayerChips,
      actionTimeoutMs: room.config.actionMs,
      topUpAmount: room.config.topUpAmount,
      roomName: room.name,
      timerEnabled: true,
    });
    // Hydrate seats from room stacks / seatUids between hands
    for (let i = 0; i < 6; i++) {
      const u = room.seatUids[i];
      if (!u) continue;
      engine = applyAction(engine, {
        type: 'SEAT',
        seat: i,
        uid: u,
        id: u,
        name: displayNameOf?.(u) || u.slice(0, 8),
        chips: room.stacks[i] || 0,
        isHost: u === room.hostUid,
      });
    }
    seatedAt = room.pub?.seatedAt ? [...room.pub.seatedAt] : seatedAt;
    onLocalState?.(engine);
    return engine;
  }

  function sumStacks(stacks) {
    return stacks.reduce((a, b) => a + b, 0);
  }

  function stacksFromEngine(s) {
    return s.seats.map((p) => (p ? p.chips + (p.bet || 0) : 0));
    // During a hand, stacks snapshot is hand-start; between hands chips are stacks.
  }

  function buildPub(room, extra = {}) {
    const pub = publicState(engine, {
      actionSeq,
      lastAction: extra.lastAction ?? null,
      away: { ...away },
      seatedAt: [...seatedAt],
      hostClockAt,
      pendingSeats: [...pendingSeats],
      topUpReqs: { ...topUpReqs },
      rejects: { ...rejects },
    });
    return pub;
  }

  function queueWrite(patchFn) {
    writeChain = writeChain.then(async () => {
      const room = getRoom();
      if (!room || room.hostUid !== uid) return;
      if (document.visibilityState !== 'visible') return;

      // coalesce 250ms
      await new Promise((r) => {
        pendingFlush = r;
        setTimeout(r, 250);
      });
      if (pendingFlush !== arguments[0] && false) {
        /* noop — simple delay coalesce */
      }

      const latest = getRoom();
      if (!latest || latest.hostUid !== uid) return;

      const between =
        engine.phase === PHASE.LOBBY || engine.phase === PHASE.HAND_OVER;
      // Hand-end stacks: when between hands, sync stacks to engine chips
      let stacks = [...latest.stacks];
      let chipTotal = latest.chipTotal;
      let sess = latest.sess.map((x) => (x ? { ...x } : null));

      if (between) {
        // Update stacks to current chips without changing chipTotal unless money event
        const next = engine.seats.map((p, i) => (p ? p.chips : 0));
        if (sumStacks(next) === chipTotal) stacks = next;
      }

      const pub = buildPub(latest);
      if (sumStacks(stacks) !== chipTotal) {
        console.error('[host] chip mismatch', stacks, chipTotal);
        opts.onChipMismatch?.();
        return;
      }

      const patch = {
        rev: latest.rev + 1,
        updatedAt: fs.serverTimestamp(),
        pub,
        deadlineAt: deadlineLocal,
        stacks,
        chipTotal,
        sess,
        seatUids: latest.seatUids,
        ...(patchFn ? patchFn(latest, { stacks, sess, pub }) : {}),
      };

      await fs.updateDoc(fs.doc(db, 'pokerRooms', roomId), patch);
      lastWriteAt = Date.now();
      recordWrite();
    }).catch((e) => console.warn('[host] write', e));
    return writeChain;
  }

  function applyAndPublish(action, meta = {}) {
    try {
      engine = applyAction(engine, action, { now: Date.now() });
    } catch (e) {
      if (meta.uid) rejects[meta.uid] = String(e.message || e).slice(0, 40);
      return false;
    }
    actionSeq += 1;
    onLocalState?.(engine);
    if (meta.lastAction) {
      queueWrite(() => ({ }));
    } else {
      queueWrite();
    }
    return true;
  }

  async function processIntent(intentUid, data) {
    const room = getRoom();
    if (!room || room.hostUid !== uid) return;
    const type = data.type;
    const handNo = data.handNo;
    const turn = data.turn;

    if (type === 'SIT') {
      const seat = data.seat;
      if (!Number.isInteger(seat)) return;
      sitQueue.push({ uid: intentUid, seat, seq: data.seq });
      drainSitLeave();
      return;
    }
    if (type === 'LEAVE') {
      leaveQueue.push({ uid: intentUid, seq: data.seq });
      drainSitLeave();
      return;
    }
    if (type === 'TOPUP_REQ') {
      const seat = room.seatUids.indexOf(intentUid);
      if (seat >= 0) {
        topUpReqs[seat] = true;
        queueWrite();
      }
      return;
    }
    if (type === 'TOPUP_CANCEL') {
      const seat = room.seatUids.indexOf(intentUid);
      if (seat >= 0) {
        delete topUpReqs[seat];
        queueWrite();
      }
      return;
    }

    // Game actions: require matching handNo + turn
    if (handNo !== engine.handNumber) return;
    if (turn != null && turn !== actionSeq) return;
    const seat = room.seatUids.indexOf(intentUid);
    if (seat < 0 || engine.actor !== seat) return;

    const map = {
      FOLD: { type: 'FOLD', seat },
      CHECK: { type: 'CHECK', seat },
      CALL: { type: 'CALL', seat },
      BET_RAISE: { type: 'BET_RAISE', seat, amount: data.amount },
      ALL_IN: { type: 'ALL_IN', seat },
      SHOW: { type: 'SHOW', seat },
      MUCK: { type: 'MUCK', seat },
    };
    const action = map[type];
    if (!action) return;
    applyAndPublish(action, {
      uid: intentUid,
      lastAction: { seat, type, amount: data.amount ?? null },
    });
    await writeHoles();
  }

  async function writeHoles() {
    const room = getRoom();
    if (!room) return;
    const batch = fs.writeBatch(db);
    let n = 0;
    for (let i = 0; i < 6; i++) {
      const u = room.seatUids[i];
      const p = engine.seats[i];
      if (!u || !p?.hole) continue;
      batch.set(fs.doc(db, 'pokerRooms', roomId, 'hole', u), {
        cards: p.hole.map((c) => cardKey(c)),
        handNo: engine.handNumber,
        updatedAt: fs.serverTimestamp(),
      });
      n++;
    }
    if (n) {
      await batch.commit();
      recordWrite();
    }
  }

  async function drainSitLeave() {
    const room = getRoom();
    if (!room) return;
    const between =
      engine.phase === PHASE.LOBBY || engine.phase === PHASE.HAND_OVER;

    // Leaves during hand → fold first
    for (const item of [...leaveQueue]) {
      const seat = room.seatUids.indexOf(item.uid);
      if (seat < 0) {
        leaveQueue.shift();
        continue;
      }
      if (!between) {
        if (engine.seats[seat] && !engine.seats[seat].folded) {
          applyAndPublish({ type: 'FOLD', seat });
        }
        // wait until hand over
        continue;
      }
      leaveQueue.shift();
      await cashoutSeat(seat, item.uid);
    }

    if (!between) {
      // Mark pending seats for mid-hand sits
      pendingSeats = sitQueue.map((x) => ({ uid: x.uid, seat: x.seat }));
      queueWrite();
      return;
    }

    pendingSeats = [];
    while (sitQueue.length) {
      const item = sitQueue.shift();
      await seatPlayer(item.seat, item.uid);
    }
  }

  async function seatPlayer(seat, playerUid) {
    const room = getRoom();
    if (!room || room.seatUids[seat]) return;
    if (room.seatUids.includes(playerUid)) return;

    const pSnap = await fs.getDoc(fs.doc(db, 'pokerPlayers', playerUid));
    if (!pSnap.exists()) return;
    const p = pSnap.data();
    if (p.tableRoomId !== roomId) return;
    const amount = p.inPlay;
    const ledgerId = `${roomId}_${p.sessionNo}_buyin`;

    const seatUids = [...room.seatUids];
    seatUids[seat] = playerUid;
    const stacks = [...room.stacks];
    stacks[seat] = amount;
    const sess = [...room.sess];
    const startAt = fs.Timestamp.now();
    sess[seat] = {
      uid: playerUid,
      sessionNo: p.sessionNo,
      buyIn: amount,
      topUps: 0,
      topUpChips: 0,
      hands: 0,
      nightKey: nightKeyOf(),
      startAt,
    };
    seatedAt[seat] = Date.now();

    engine = applyAction(engine, {
      type: 'SEAT',
      seat,
      uid: playerUid,
      id: playerUid,
      name: displayNameOf?.(playerUid) || p.displayName || playerUid.slice(0, 8),
      chips: amount,
    });
    actionSeq += 1;
    onLocalState?.(engine);

    await fs.updateDoc(fs.doc(db, 'pokerRooms', roomId), {
      rev: room.rev + 1,
      updatedAt: fs.serverTimestamp(),
      seatUids,
      stacks,
      chipTotal: room.chipTotal + amount,
      sess,
      lastMoneyEvent: {
        uid: playerUid,
        id: ledgerId,
        seat,
        type: 'buyin',
        amount,
      },
      pub: buildPub({ ...room, seatUids }),
      deadlineAt: null,
    });
    lastWriteAt = Date.now();
    recordWrite();
  }

  async function cashoutSeat(seat, playerUid, { handOffTo } = {}) {
    const room = getRoom();
    if (!room) return;
    const sessRow = room.sess[seat];
    if (!sessRow) return;
    const amount = room.stacks[seat];
    const seatUids = [...room.seatUids];
    seatUids[seat] = '';
    const stacks = [...room.stacks];
    stacks[seat] = 0;
    const sess = [...room.sess];
    sess[seat] = null;
    seatedAt[seat] = 0;
    delete away[seat];

    try {
      engine = applyAction(engine, { type: 'UNSEAT', seat });
    } catch {
      /* already empty in engine */
    }
    actionSeq += 1;

    const roomPatch = {
      rev: room.rev + 1,
      seatUids,
      stacks,
      chipTotal: room.chipTotal - amount,
      sess,
      lastMoneyEvent: {
        uid: playerUid,
        id: `${roomId}_${sessRow.sessionNo}_cashout`,
        seat,
        type: 'cashout',
        amount,
      },
      pub: buildPub({ ...room, seatUids }),
      deadlineAt: null,
      ...(handOffTo
        ? { hostUid: handOffTo, hostSince: fs.serverTimestamp() }
        : {}),
    };

    await hostCashoutBatch(fb, {
      hostUid: uid,
      roomId,
      seat,
      uid: playerUid,
      roomPatch,
      sessRow,
      amount,
      playerName: displayNameOf?.(playerUid),
    });
    lastWriteAt = Date.now();
    onLocalState?.(engine);
  }

  async function approveTopUp(seat) {
    const room = getRoom();
    if (!room) return;
    const playerUid = room.seatUids[seat];
    if (!playerUid || room.stacks[seat] !== 0) return;
    const s0 = room.sess[seat];
    const amt = room.config.topUpAmount;
    const n = s0.topUps + 1;
    const id = `${roomId}_${s0.sessionNo}_topup${n}`;
    const stacks = [...room.stacks];
    stacks[seat] = amt;
    const sess = [...room.sess];
    sess[seat] = { ...s0, topUps: n, topUpChips: s0.topUpChips + amt };
    delete topUpReqs[seat];

    engine = applyAction(engine, { type: 'TOP_UP', seat, amount: amt });
    actionSeq += 1;

    const batch = fs.writeBatch(db);
    batch.update(fs.doc(db, 'pokerRooms', roomId), {
      rev: room.rev + 1,
      updatedAt: fs.serverTimestamp(),
      stacks,
      chipTotal: room.chipTotal + amt,
      sess,
      lastMoneyEvent: { uid: playerUid, id, seat, type: 'topup', amount: amt },
      pub: buildPub({ ...room, stacks, sess }),
    });
    batch.set(fs.doc(db, 'pokerPlayers', playerUid, 'ledger', id), {
      type: 'topup',
      amount: amt,
      roomId,
      sessionNo: s0.sessionNo,
      seat,
      buyIn: null,
      topUps: n,
      topUpChips: null,
      hands: null,
      nightKey: null,
      bankAfter: null,
      by: uid,
      at: fs.serverTimestamp(),
    });
    await batch.commit();
    lastWriteAt = Date.now();
    recordWrite();
    onLocalState?.(engine);
  }

  function startHand() {
    if (hostMustStopNewHand(true)) {
      opts.onQuotaStop?.();
      return false;
    }
    const room = getRoom();
    ensureEngine(room);
    // Sync away into engine
    for (let i = 0; i < 6; i++) {
      if (away[i] && engine.seats[i]) {
        engine = applyAction(engine, { type: 'SET_AWAY', seat: i, away: true });
      }
    }
    const ok = applyAndPublish({ type: 'START_HAND' });
    if (!ok) return false;
    // Snapshot stacks at hand start
    const stacks = engine.seats.map((p) => (p ? p.chips : 0));
    writeHoles();
    const n = engine.seats.filter((p) => p && p.hasHole).length;
    const dealMs = estimateMpDealTotalMs(DEAL_FX, n);
    setTimeout(() => {
      hostClockAt = Date.now();
      deadlineLocal = hostClockAt + (room.config.actionMs || 30000);
      engine = applyAction(engine, { type: 'ARM_DEADLINE' }, { now: hostClockAt });
      queueWrite();
    }, dealMs);
    // Persist stacks snapshot
    queueWrite((latest) => ({ stacks, chipTotal: latest.chipTotal }));
    return true;
  }

  function hostAction(action) {
    const room = getRoom();
    const seat = room.seatUids.indexOf(uid);
    applyAndPublish({ ...action, seat }, {
      lastAction: { seat, type: action.type, amount: action.amount ?? null },
    });
    writeHoles();
  }

  function voidHand(stacks) {
    applyAndPublish({ type: 'VOID_HAND', stacks });
    hostClockAt = null;
    deadlineLocal = null;
    setTimeout(() => startHand(), 3000);
  }

  function onTick() {
    if (!running || !engine) return;
    if (document.visibilityState !== 'visible') return;
    const room = getRoom();
    if (!room || room.hostUid !== uid) return;

    // Away detection from presenceSeen
    for (let i = 0; i < 6; i++) {
      const u = room.seatUids[i];
      if (!u) continue;
      const seen = presenceSeen[u] || 0;
      const isAway = Date.now() - seen > 60_000;
      if (isAway && !away[i]) {
        away[i] = true;
        try {
          engine = applyAction(engine, { type: 'SET_AWAY', seat: i, away: true });
        } catch { /* */ }
        queueWrite();
      } else if (!isAway && away[i]) {
        delete away[i];
        try {
          engine = applyAction(engine, { type: 'SET_AWAY', seat: i, away: false });
        } catch { /* */ }
        queueWrite();
      }
    }

    // Timeout
    if (
      deadlineLocal &&
      engine.actor != null &&
      Date.now() > deadlineLocal + 1000
    ) {
      const seat = engine.actor;
      if (away[seat]) {
        // auto check/fold immediately when away on turn
      }
      applyAndPublish({ type: 'TIMEOUT', seat });
      hostClockAt = Date.now();
      deadlineLocal = hostClockAt + (room.config.actionMs || 30000);
      writeHoles();
    }

    drainSitLeave();
  }

  function start() {
    if (running) return;
    running = true;
    const room = getRoom();
    ensureEngine(room);

    stopIntentListen = fs.onSnapshot(
      fs.collection(db, 'pokerRooms', roomId, 'intents'),
      (snap) => {
        snap.docChanges().forEach((ch) => {
          if (ch.type === 'removed') return;
          processIntent(ch.doc.id, ch.doc.data());
        });
      },
    );

    stopPresenceListen = listenPresence(fb, roomId, (map) => {
      presenceMap = map;
      for (const [u, info] of Object.entries(map)) {
        const prev = presenceSeen[u];
        // Track local time of last change of beatMs
        if (prev == null || info.beatMs !== (presenceMap[u]?._lastBeat || 0)) {
          presenceSeen[u] = Date.now();
        }
      }
      // Simpler: any snapshot updates seen time for each uid present
      for (const u of Object.keys(map)) {
        if (!presenceSeen[u]) presenceSeen[u] = Date.now();
      }
      // Update when beat changes
      for (const [u, info] of Object.entries(map)) {
        const key = `_b_${u}`;
        if (presenceSeen[key] !== info.beatMs) {
          presenceSeen[key] = info.beatMs;
          presenceSeen[u] = Date.now();
        }
      }
    });

    tickTimer = setInterval(onTick, 1000);
  }

  function stop() {
    running = false;
    if (tickTimer) clearInterval(tickTimer);
    stopIntentListen?.();
    stopPresenceListen?.();
  }

  return {
    start,
    stop,
    startHand,
    hostAction,
    voidHand,
    approveTopUp,
    cashoutSeat,
    seatPlayer,
    getEngine: () => engine,
    lastRoomWriteAt: () => lastWriteAt,
    getAway: () => ({ ...away }),
    getSeatedAt: () => [...seatedAt],
  };
}
