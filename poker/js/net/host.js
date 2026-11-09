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
  REVEAL_MS,
  HOLD_MS_SHOWDOWN,
  HOLD_MS_FOLD_WIN,
} from '../engine/index.js';
import { estimateMpDealTotalMs, MP_FX } from '../ui/fx-mp.js';
import { DEAL_FX } from '../ui/fx.js';
import { nightKeyOf, hostCashoutBatch, hostCloseAllBatch } from './ledger.js';
import { recordWrite, hostMustStopNewHand } from './quota.js';
import { listenPresence } from './presence.js';
import {
  hostAloneCloseMs,
  hostAloneSince,
  hostIsOnlySeated,
  buildLobbySummary,
  buildLobbyListing,
  lobbyListingKey,
  upsertLobbyListing,
  deleteLobbyListing,
} from './room.js';
import {
  createMemoryPendingQueue,
  createStatsWriteChain,
  createStatsSession,
} from '../stats/index.js';

import { createHostStatsRuntime } from '../stats/host-runtime.js';

const AWAY_UNSEAT_MS = 30 * 60_000;

export function cashoutStateReady(room, engine, seat, uid) {
  return !!room && !!engine &&
    ['lobby', 'hand_over'].includes(engine.phase) &&
    room.pub?.phase === engine.phase &&
    room.pub?.handNo === engine.handNumber &&
    room.seatUids?.[seat] === uid &&
    room.stacks?.[seat] === engine.seats?.[seat]?.chips &&
    room.stacks.every((chips, i) => chips === (engine.seats?.[i]?.chips || 0)) &&
    room.stacks.reduce((sum, chips) => sum + chips, 0) === room.chipTotal;
}

/**
 * Host timeout gate: use the engine's current per-action deadline only.
 * Stale host-side arms (deadlineLocal not reset after acts) must not fire.
 * @param {object|null|undefined} engine
 * @param {number} [now]
 * @param {number} [graceMs] host lag grace (matches prior onTick +1000)
 */
export function hostShouldTimeout(engine, now = Date.now(), graceMs = 1000) {
  if (!engine || engine.actor == null) return false;
  if (engine.deadline == null) return false;
  return now > engine.deadline + graceMs;
}

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
  let autoClosing = false;
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
  let startingNext = null;
  let closing = false;
  let draining = false;
  /** Personal-stats chain: independent of writeChain; never awaited by game flow. */
  const statsRuntime = createHostStatsRuntime({ ...opts.stats, fs, db, roomId, uid,
    isCurrentHost: () => running && getRoom()?.hostUid === uid &&
      (!opts.getCurrentUid || opts.getCurrentUid() === uid),
  });
  const statsQueue = statsRuntime.queue || createMemoryPendingQueue();
  let lastChipsHandNo = -1;
  const statsWriteChain = createStatsWriteChain({ queue: statsQueue, recovery: statsRuntime.recovery });
  const statsSession = createStatsSession({
    roomId,
    writeChain: statsWriteChain,
  });
  let pendingFlush = null;
  /** @type {object[]} */
  const sitQueue = [];
  const leaveQueue = [];
  /** @type {Record<number, true>} */
  let away = {};
  /** @type {Record<number, number>} local ms when seat became away */
  const awaySince = {};
  let seatedAt = [0, 0, 0, 0, 0, 0];
  /** @type {Record<number, number>} seat → deniedAt ms (M2 #13 / §4.1 6-d) */
  /** Published so whole table sees §2 / M2 #10 exits when host hits 8,000. */
  let quotaStop = false;
  let pendingSeats = [];
  let deadlineLocal = null;
  let hostClockAt = null;
  let rejects = {};
  /** Last pokerLobby fingerprint — skip listing writes when unchanged. */
  let lastLobbyListingKey = '';
  let running = false;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let revealTimer = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let nextHandTimer = null;
  let flushTimer = null;
  const delayedTimers = new Set();
  function delayHost(fn, ms) {
    const timer = setTimeout(() => {
      delayedTimers.delete(timer);
      if (running && !closing && getRoom()?.status !== 'closed') fn();
    }, ms);
    delayedTimers.add(timer);
  }
  let lastHandsBumpHandNo = 0;
  let handsBumpAttempts = 0;
  let pubVoided = false;

  function playerName(uid, fallback) {
    const n = displayNameOf?.(uid);
    if (n && n !== uid && n !== uid.slice(0, 8)) return n;
    if (fallback && fallback !== uid.slice(0, 8)) return fallback;
    return n || fallback || uid.slice(0, 8);
  }

  function ensureEngine(room) {
    if (engine) return engine;
    engine = createInitialState({
      multiplayer: true,
      smallBlind: room.config.sb,
      bigBlind: room.config.bb,
      startingStack: room.config.newPlayerChips,
      actionTimeoutMs: room.config.actionMs,
      roomName: room.name,
      timerEnabled: true,
    });
    // Hydrate seats from room stacks / seatUids
    for (let i = 0; i < 6; i++) {
      const u = room.seatUids[i];
      if (!u) continue;
      const pubSeat = room.pub?.seats?.[i];
      engine = applyAction(engine, {
        type: 'SEAT',
        seat: i,
        uid: u,
        id: u,
        name: playerName(u, pubSeat?.name),
        chips: room.stacks[i] || 0,
        isHost: u === room.hostUid,
      });
    }
    // Resume hand counter from stored pub (QA round-3 D) — do not reset to 0/1
    const storedHand = Number(room.pub?.handNo) || 0;
    if (storedHand > 0) engine.handNumber = storedHand;
    // Stable stats handId: reuse published id across reconnect / host handoff
    statsSession.restoreFromPub(room.pub);
    if (room.pub?.handId) engine.handId = room.pub.handId;
    seatedAt = room.pub?.seatedAt ? [...room.pub.seatedAt] : seatedAt;
    away = { ...(room.pub?.away || {}) };
    quotaStop = !!room.pub?.quotaStop;
    // Drop pending seats that already sat (QA #9)
    pendingSeats = (room.pub?.pendingSeats || []).filter(
      (x) => x?.uid && !room.seatUids.includes(x.uid),
    );
    actionSeq = room.pub?.actionSeq || 0;
    onLocalState?.(engine);

    // Spec §6.8: deck only in host memory — mid-hand refresh/handoff voids then reshuffles
    const phase = room.pub?.phase;
    if (phase && phase !== PHASE.LOBBY && phase !== PHASE.HAND_OVER) {
      delayHost(() => {
        if (!running || !engine) return;
        voidHand([...room.stacks]);
      }, 0);
    }
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
      rejects: { ...rejects },
    });
    if (pubVoided || extra.voided) pub.voided = true;
    if (room.code === '000') {
      pub.hostHadOtherSeats = !!room.pub?.hostHadOtherSeats ||
        room.seatUids.some(u => u && u !== room.hostUid);
      pub.hostAloneSince = hostAloneSince(room, opts.now?.() ?? Date.now());
      if (autoClosing) pub.autoClosed = true;
    }
    if (quotaStop) pub.quotaStop = true;
    return pub;
  }

  function queueWrite(patchFn) {
    writeChain = writeChain.then(async () => {
      const room = getRoom();
      if ((!running && !closing) || !room || room.status === 'closed' || room.hostUid !== uid) return;
      if (document.visibilityState !== 'visible') return;

      // coalesce 250ms
      if (!startingNext) await new Promise((r) => {
        pendingFlush = r;
        flushTimer = setTimeout(() => { flushTimer = null; pendingFlush = null; r(); }, 250);
      });
      if (pendingFlush !== arguments[0] && false) {
        /* noop — simple delay coalesce */
      }

      let latest = getRoom();
      if ((!running && !closing) || !latest || latest.status === 'closed' || latest.hostUid !== uid) return;

      // 手數獨立寫入：保留已結算的 pub、stacks 與所有帳務欄位，避免重建 pub 後走昂貴的規則比較。
      if (engine.phase === PHASE.HAND_OVER &&
          engine.handNumber > lastHandsBumpHandNo &&
          latest.pub?.phase === PHASE.HAND_OVER &&
          latest.pub?.handNo === engine.handNumber) {
        const handNo = engine.handNumber;
        const handsPatch = {
          rev: latest.rev + 1,
          updatedAt: fs.serverTimestamp(),
          sess: latest.sess.map((x, i) => x && latest.seatUids[i] === x.uid
            ? { ...x, hands: (x.hands || 0) + 1 } : x),
        };
        handsBumpAttempts++;
        await fs.updateDoc(fs.doc(db, 'pokerRooms', roomId), handsPatch);
        // 只有伺服器確認成功才放行下一手；拒絕時由既有下一手計時器重試。
        lastHandsBumpHandNo = handNo;
        lastWriteAt = Date.now();
        recordWrite();
        // 不等待房間快照回呼；後續 pub 寫入必須使用這筆已確認的 rev 與 sess。
        latest = { ...latest, ...handsPatch };
      }

      const between =
        engine.phase === PHASE.LOBBY || engine.phase === PHASE.HAND_OVER;
      // Hand-end stacks: when between hands, sync stacks to engine chips
      let stacks = [...latest.stacks];
      let chipTotal = latest.chipTotal;
      let sess = latest.sess.map((x) => (x ? { ...x } : null));

      if (between) {
        // Update stacks to current chips without changing chipTotal unless money event
        const next = engine.seats.map((p) => (p ? p.chips : 0));
        if (sumStacks(next) !== chipTotal) {
          console.error('[host] chip mismatch', next, chipTotal);
          opts.onChipMismatch?.();
          return;
        }
        stacks = next;
      }

      const pub = buildPub(latest);
      if (sumStacks(stacks) !== chipTotal) {
        console.error('[host] chip mismatch', stacks, chipTotal);
        opts.onChipMismatch?.();
        return;
      }

      const phase = pub?.phase || latest.pub?.phase;
      const listStatus =
        phase === 'lobby' || phase === 'hand_over' || !phase ? 'lobby' : 'playing';
      const lobby = buildLobbySummary(
        { ...latest, name: latest.name, config: latest.config, seatUids: latest.seatUids },
        {
          hostName: playerName(latest.hostUid, latest.lobby?.hostName),
          hostPhoto: latest.lobby?.hostPhoto || '',
        },
      );
      const patch = {
        rev: latest.rev + 1,
        updatedAt: fs.serverTimestamp(),
        pub,
        deadlineAt: deadlineLocal,
        stacks,
        chipTotal,
        sess,
        seatUids: latest.seatUids,
        status: listStatus,
        lobby,
        ...(patchFn ? patchFn(latest, { stacks, sess, pub, lobby, listStatus }) : {}),
      };

      await fs.updateDoc(fs.doc(db, 'pokerRooms', roomId), patch);
      lastWriteAt = Date.now();
      recordWrite();
      if (engine.phase === PHASE.HAND_OVER && engine.handNumber !== lastChipsHandNo) lastChipsHandNo = engine.handNumber, void statsRuntime.syncChips?.({ seatUids: patch.seatUids, stacks: patch.stacks });
      await syncLobbyListingDoc({
        ...latest,
        seatUids: patch.seatUids || latest.seatUids,
        status: listStatus,
        lobby,
        code: latest.code,
        name: latest.name,
        hostUid: latest.hostUid,
        config: latest.config,
      }, lobby, listStatus);
    }).catch((e) => console.warn('[host] write', e));
    return writeChain;
  }

  async function syncLobbyListingDoc(roomLike, lobby, listStatus) {
    if (!roomLike || roomLike.hostUid !== uid) return;
    if (listStatus === 'closed' || roomLike.status === 'closed') {
      lastLobbyListingKey = '';
      await deleteLobbyListing({ db, fs }, roomId);
      return;
    }
    const fields = buildLobbyListing(roomLike, lobby, listStatus);
    const key = lobbyListingKey(fields);
    if (key === lastLobbyListingKey) return;
    lastLobbyListingKey = key;
    await upsertLobbyListing({ db, fs }, roomId, fields);
  }

  /** Non-money follow-up: refresh public lobby summary after seat/cashout. */
  async function refreshLobbySummary(roomLike) {
    const latest = roomLike || getRoom();
    if (!latest || latest.hostUid !== uid) return;
    const seatUids = roomLike?.seatUids || latest.seatUids;
    const hostUid = roomLike?.hostUid || latest.hostUid;
    const lobby = buildLobbySummary(
      { ...latest, seatUids, hostUid },
      {
        hostName: playerName(hostUid, latest.lobby?.hostName),
        hostPhoto:
          hostUid === latest.hostUid ? latest.lobby?.hostPhoto || '' : '',
      },
    );
    const listStatus = roomLike?.status || curStatus(latest) || 'lobby';
    try {
      await fs.updateDoc(fs.doc(db, 'pokerRooms', roomId), {
        rev: (latest.rev || 0) + 1,
        updatedAt: fs.serverTimestamp(),
        lobby,
        status: listStatus,
      });
      lastWriteAt = Date.now();
      recordWrite();
      await syncLobbyListingDoc(
        { ...latest, seatUids, hostUid, status: listStatus, lobby },
        lobby,
        listStatus,
      );
    } catch (e) {
      console.warn('[host] lobby refresh', e);
    }
  }

  function curStatus(room) {
    const phase = room?.pub?.phase;
    return phase === 'lobby' || phase === 'hand_over' || !phase
      ? 'lobby'
      : 'playing';
  }

  function clearRevealTimer() {
    if (revealTimer) clearTimeout(revealTimer);
    revealTimer = null;
  }

  function clearNextHandTimer() {
    if (nextHandTimer) clearTimeout(nextHandTimer);
    nextHandTimer = null;
  }

  function scheduleNextHand(ms) {
    if (closing || !running || getRoom()?.status === 'closed') return;
    clearNextHandTimer();
    nextHandTimer = setTimeout(() => {
      nextHandTimer = null;
      if (!running || !engine || getRoom()?.status === 'closed') return;
      if (engine.phase !== PHASE.HAND_OVER || closing) return;
      // 規則只允許「進行中 → hand_over」那一筆改 stacks：結算還沒寫進房間前不開下一手
      const savedPub = getRoom()?.pub;
      if (
        savedPub?.phase !== PHASE.HAND_OVER ||
        savedPub?.handNo !== engine.handNumber ||
        engine.handNumber > lastHandsBumpHandNo
      ) {
        queueWrite();
        scheduleNextHand(1000);
        return;
      }
      if (draining || leaveQueue.length) {
        void drainSitLeave();
        scheduleNextHand(1000);
        return;
      }
      void startHand();
    }, ms);
  }

  function afterEngineChange() {
    onLocalState?.(engine);
    if (!engine) return;
    if (
      engine.phase === PHASE.SHOWDOWN &&
      (engine.showdown?.pending || []).length
    ) {
      clearRevealTimer();
      revealTimer = setTimeout(() => {
        revealTimer = null;
        if (!engine || engine.phase !== PHASE.SHOWDOWN) return;
        applyAndPublish({ type: 'REVEAL_TIMEOUT' });
      }, REVEAL_MS + 30);
      return;
    }
    if (engine.phase === PHASE.HAND_OVER) {
      clearRevealTimer();
      const foldWin = !!engine.lastHandSummary?.foldWin;
      scheduleNextHand(foldWin ? HOLD_MS_FOLD_WIN : HOLD_MS_SHOWDOWN);
      drainSitLeave();
    }
  }

  /** Keep published deadlineAt in sync with engine.deadline (re-armed every act). */
  function syncDeadlineFromEngine() {
    if (!engine) {
      deadlineLocal = null;
      hostClockAt = null;
      return;
    }
    deadlineLocal = engine.deadline ?? null;
    if (deadlineLocal != null) {
      const ms = engine.config?.actionTimeoutMs || 30000;
      hostClockAt = deadlineLocal - ms;
    } else {
      // Deal FX / hand end / between hands — never keep a prior arm
      hostClockAt = null;
    }
  }

  function applyAndPublish(action, meta = {}) {
    const prev = engine;
    try {
      engine = applyAction(engine, action, { now: Date.now() });
    } catch (e) {
      if (meta.uid) rejects[meta.uid] = String(e.message || e).slice(0, 40);
      return false;
    }
    // Stats observe / snapshot: never throw into betting or next-hand path
    try {
      if (action.type === 'VOID_HAND') {
        statsSession.onVoid();
      } else if (action.type === 'START_HAND') {
        statsSession.onHandStarted(engine);
      } else if (action.type === 'TOP_UP') {
        statsSession.onTopUp(action.seat, action.amount);
      } else {
        statsSession.onAction(prev, action, engine);
      }
      // Snapshot only on transition into HAND_OVER (not ACK_HAND / linger).
      if (
        engine.phase === PHASE.HAND_OVER &&
        prev?.phase !== PHASE.HAND_OVER &&
        action.type !== 'VOID_HAND'
      ) {
        // Immutable snapshot + fire-and-forget pending enqueue (not on writeChain)
        statsSession.onHandOver(engine);
      }
    } catch (e) {
      console.warn('[host] stats', e);
    }
    if (action.type === 'VOID_HAND') pubVoided = true;
    else if (action.type === 'START_HAND' || action.type === 'ACK_HAND') {
      pubVoided = false;
    }
    actionSeq += 1;
    syncDeadlineFromEngine();
    afterEngineChange();
    if (meta.lastAction) {
      queueWrite(() => ({ }));
    } else {
      queueWrite();
    }
    return true;
  }

  async function processIntent(intentUid, data) {
    if (closing || !running || getRoom()?.status === 'closed') return;
    const room = getRoom();
    if (!room || room.hostUid !== uid) return;
    if (!engine) ensureEngine(room);
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
    // Show/muck: eligible during SHOWDOWN pending (not actor-gated)
    if (type === 'SHOW' || type === 'MUCK') {
      if (handNo !== engine.handNumber) return;
      if (engine.phase !== PHASE.SHOWDOWN) return;
      const seat = room.seatUids.indexOf(intentUid);
      if (seat < 0) return;
      if (!engine.showdown?.pending?.includes(seat)) return;
      applyAndPublish(
        { type, seat, mode: 'both' },
        { uid: intentUid, lastAction: { seat, type, amount: null } },
      );
      await writeHoles();
      return;
    }

    // Street actions: require matching handNo + turn + actor
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
    if (closing || !running || getRoom()?.status === 'closed' || draining) return;
    draining = true;
    try { await drainSitLeaveInner(); }
    catch (e) { console.warn('[host] drain', e); }
    finally { draining = false; }
  }

  async function drainSitLeaveInner() {
    const room = getRoom();
    if (!room) return;
    const between =
      engine.phase === PHASE.LOBBY || engine.phase === PHASE.HAND_OVER;

    if (engine.phase === PHASE.HAND_OVER && engine.seats.some(p => p && p.chips === 0)) {
      await writeChain;
      const saved = getRoom();
      if (saved?.pub?.phase !== PHASE.HAND_OVER ||
          saved.pub.handNo !== engine.handNumber || lastHandsBumpHandNo < engine.handNumber) return;
      for (let seat = 0; seat < 6; seat++) {
        const playerUid = saved.seatUids[seat];
        if (playerUid && saved.stacks[seat] === 0 && engine.seats[seat]?.chips === 0 &&
            !leaveQueue.some(item => item.uid === playerUid)) leaveQueue.push({ uid: playerUid });
      }
    }

    // Leaves during hand → fold first
    for (const item of [...leaveQueue]) {
      const seat = room.seatUids.indexOf(item.uid);
      if (seat < 0) {
        leaveQueue.shift();
        continue;
      }
      if (!between) {
        if (engine.seats[seat] && !engine.seats[seat].leftHand) {
          // Track leaving on and off turn for VOID settlement.
          applyAndPublish({ type: 'LEAVE_FOLD', seat });
        }
        // wait until hand over
        continue;
      }
      if (closing || !running || getRoom()?.status === 'closed') return;
      const cur = getRoom() || room;
      const handOffTo = item.uid === cur.hostUid
        ? cur.seatUids.find((u, i) => u && u !== item.uid && cur.stacks[i] > 0)
        : undefined;
      if (!await cashoutSeat(seat, item.uid, handOffTo ? { handOffTo } : undefined)) return;
      leaveQueue.splice(leaveQueue.indexOf(item), 1);
    }

    if (!between) {
      // Mark pending seats for mid-hand sits (exclude already seated — QA #9)
      pendingSeats = sitQueue
        .filter((x) => x.uid && !room.seatUids.includes(x.uid))
        .map((x) => ({ uid: x.uid, seat: x.seat }));
      queueWrite();
      return;
    }

    pendingSeats = [];
    while (sitQueue.length) {
      const item = sitQueue.shift();
      if (room.seatUids.includes(item.uid)) continue;
      await seatPlayer(item.seat, item.uid);
    }
  }

  function seatPlayer(seat, playerUid) {
    const pending = writeChain.then(() => seatPlayerInner(seat, playerUid));
    writeChain = pending.catch(() => {});
    return pending;
  }

  async function seatPlayerInner(seat, playerUid) {
    if (closing || !running) return;
    const snap = await fs.getDoc(fs.doc(db, 'pokerRooms', roomId));
    const room = snap.exists() ? snap.data() : null;
    if (!room || room.status === 'closed' || room.hostUid !== uid) return;
    if (!Number.isInteger(seat) || seat < 0 || seat > 5) return;
    if (!room.members?.includes(playerUid)) return;
    if (room.seatUids[seat]) return;
    if (room.seatUids.includes(playerUid)) return;

    const pSnap = await fs.getDoc(fs.doc(db, 'pokerPlayers', playerUid));
    if (!pSnap.exists()) return;
    if (closing || !running || getRoom()?.status === 'closed') return;
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
    const beforeEngine = engine;
    const beforeSeq = actionSeq;
    const beforeSeatedAt = seatedAt[seat];
    seatedAt[seat] = Date.now();

    engine = applyAction(engine, {
      type: 'SEAT',
      seat,
      uid: playerUid,
      id: playerUid,
      name: p.displayName || playerName(playerUid, p.displayName),
      chips: amount,
    });
    actionSeq += 1;
    onLocalState?.(engine);

    const nextRoom = { ...room, seatUids, stacks, sess };
    // Money write must not touch lobby (rules 1000-expr budget); refresh lobby after.
    try {
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
        pub: buildPub(nextRoom),
        deadlineAt: null,
        status: 'lobby',
      });
    } catch (e) {
      engine = beforeEngine;
      actionSeq = beforeSeq;
      seatedAt[seat] = beforeSeatedAt;
      onLocalState?.(engine);
      throw e;
    }
    lastWriteAt = Date.now();
    recordWrite();
    await refreshLobbySummary({ ...nextRoom, rev: room.rev + 1, status: 'lobby' });
  }

  async function cashoutSeat(seat, playerUid, opts = {}) {
    const { handOffTo } = opts;
    await writeChain;
    let room = opts.room;
    if (!room) {
      const snap = await fs.getDoc(fs.doc(db, 'pokerRooms', roomId));
      room = snap.exists() ? snap.data() : null;
    }
    if (!cashoutStateReady(room, engine, seat, playerUid)) return false;
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

    const beforeCashout = engine;
    try {
      engine = applyAction(engine, { type: 'UNSEAT', seat });
    } catch {
      /* already empty in engine */
    }
    actionSeq += 1;

    const nextHost = handOffTo || room.hostUid;
    const nextRoom = {
      ...room,
      seatUids,
      stacks,
      sess,
      hostUid: nextHost,
    };
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
      pub: buildPub(nextRoom),
      deadlineAt: null,
      status: 'lobby',
      ...(handOffTo
        ? { hostUid: handOffTo, hostSince: fs.serverTimestamp() }
        : {}),
    };

    try {
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
    } catch (e) {
      engine = beforeCashout;
      throw e;
    }
    Object.assign(room, roomPatch);
    delete awaySince[seat];
    lastWriteAt = Date.now();
    onLocalState?.(engine);
    if (!closing) await refreshLobbySummary(room);
    return true;
  }

  function startHand() {
    if (startingNext) return startingNext;
    if (engine?.phase !== PHASE.HAND_OVER) return startHandNow();
    clearNextHandTimer();
    const bumpAttemptsAtClick = handsBumpAttempts;
    startingNext = (async () => {
      // 先排空結算，再確保獨立手數寫入成功；失敗最多重試一次。
      await Promise.resolve();
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      pendingFlush?.();
      pendingFlush = null;
      const handNo = engine.handNumber;
      await writeChain;
      if (getRoom()?.pub?.phase !== PHASE.HAND_OVER || getRoom()?.pub?.handNo !== handNo) {
        await queueWrite();
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        if (lastHandsBumpHandNo < handNo || getRoom()?.pub?.phase !== PHASE.HAND_OVER ||
            getRoom()?.pub?.handNo !== handNo) {
          if (handsBumpAttempts - bumpAttemptsAtClick >= 2) break;
          await queueWrite();
        }
        if (!running || closing || getRoom()?.status === 'closed' ||
            engine.phase !== PHASE.HAND_OVER || engine.handNumber !== handNo) return false;
        if (getRoom()?.pub?.phase === PHASE.HAND_OVER &&
            getRoom()?.pub?.handNo === handNo && lastHandsBumpHandNo >= handNo) {
          if (draining || leaveQueue.length) return false;
          engine = applyAction(engine, { type: 'ACK_HAND' }, { now: Date.now() });
          return startHandNow();
        }
      }
      return false;
    })().finally(() => { startingNext = null; });
    return startingNext;
  }

  function startHandNow() {
    if (closing || !running || getRoom()?.status === 'closed') return false;
    if (hostMustStopNewHand(true)) {
      quotaStop = true;
      queueWrite();
      opts.onQuotaStop?.();
      return false;
    }
    const room = getRoom();
    ensureEngine(room);
    clearNextHandTimer();
    clearRevealTimer();
    // Sync away into engine
    for (let i = 0; i < 6; i++) {
      if (away[i] && engine.seats[i]) {
        engine = applyAction(engine, { type: 'SET_AWAY', seat: i, away: true });
      }
    }
    // queueWrite 保留已結算的開局 stacks；進行中不另覆寫存檔點。
    const roomSeats = getRoom()?.seatUids || [];
    try {
      statsSession.onHandStarting(engine, roomSeats);
    } catch (e) {
      console.warn('[host] stats start', e);
    }
    const ok = applyAndPublish({ type: 'START_HAND' });
    if (!ok) return false;
    writeHoles();
    const n = engine.seats.filter((p) => p && p.hasHole).length;
    const dealMs = estimateMpDealTotalMs(DEAL_FX, n);
    delayHost(() => {
      if (closing || !running || getRoom()?.status === 'closed') return;
      const now = Date.now();
      engine = applyAction(engine, { type: 'ARM_DEADLINE' }, { now });
      syncDeadlineFromEngine();
      queueWrite();
    }, dealMs);
    // applyAndPublish 已排入寫入；不可另排舊 stacks，避免延後覆蓋手結束結算。
    return true;
  }

  function hostAction(action) {
    const room = getRoom();
    const seat =
      action.seat != null ? action.seat : room.seatUids.indexOf(uid);
    if (action.type === 'SHOW' || action.type === 'MUCK') {
      if (engine?.phase !== PHASE.SHOWDOWN) return;
      if (!engine.showdown?.pending?.includes(seat)) return;
      applyAndPublish(
        { type: action.type, seat, mode: action.mode || 'both' },
        { lastAction: { seat, type: action.type, amount: null } },
      );
      writeHoles();
      return;
    }
    applyAndPublish(
      { ...action, seat },
      { lastAction: { seat, type: action.type, amount: action.amount ?? null } },
    );
    writeHoles();
  }

  async function prepareClose() {
    closing = true;
    clearNextHandTimer();
    clearRevealTimer();
    await writeChain;
    const saved = getRoom();
    if (!saved) throw new Error('Room missing');
    if (autoClosing && (!hostIsOnlySeated(saved) ||
        ![PHASE.LOBBY, PHASE.HAND_OVER].includes(saved.pub?.phase))) {
      autoClosing = false;
      closing = false;
      throw new Error('牌桌狀態已變更，已取消自動收桌');
    }
    if (![PHASE.LOBBY, PHASE.HAND_OVER].includes(engine.phase)) {
      if (!applyAndPublish({ type: 'VOID_HAND', stacks: saved.stacks })) {
        throw new Error('VOID_HAND failed');
      }
    } else if (pubVoided && saved.pub?.phase !== PHASE.HAND_OVER) {
      // A previous VOID write may have failed; retry publishing without restarting timers.
      queueWrite();
    }
    await writeChain;
    const committed = await fs.getDoc(fs.doc(db, 'pokerRooms', roomId));
    const current = committed.exists() ? committed.data() : null;
    if (current?.status === 'closed') return current;
    if (autoClosing && !hostIsOnlySeated(current)) {
      autoClosing = false;
      closing = false;
      throw new Error('已有其他玩家入座，已取消自動收桌');
    }
    if (!current || current.seatUids.some((u, i) => u &&
      !cashoutStateReady(current, engine, i, u))) throw new Error('Settlement not committed');
    return current;
  }

  async function closeAll(room) {
    const result = await hostCloseAllBatch(fb, { hostUid: uid, roomId, room, displayNameOf });
    if (!result.skipped) recordWrite();
    return result.room || room;
  }

  function voidHand(stacks) {
    applyAndPublish({ type: 'VOID_HAND', stacks });
    hostClockAt = null;
    deadlineLocal = null;
    delayHost(() => startHand(), 3000);
  }

  function onTick() {
    if (!running || !engine || closing) return;
    const room = getRoom();
    if (!room || room.hostUid !== uid) return;

    const now = opts.now?.() ?? Date.now();
    const since = hostAloneSince(room, now);
    if (since !== (room.pub?.hostAloneSince ?? null)) queueWrite();
    if (!autoClosing && since != null && now - since >= hostAloneCloseMs() &&
        [PHASE.LOBBY, PHASE.HAND_OVER].includes(engine.phase) &&
        [PHASE.LOBBY, PHASE.HAND_OVER].includes(room.pub?.phase) && opts.onHostAloneClose) {
      autoClosing = true;
      queueWrite();
      void opts.onHostAloneClose();
      return;
    }
    if (document.visibilityState !== 'visible') return;

    // Away detection from presenceSeen
    for (let i = 0; i < 6; i++) {
      const u = room.seatUids[i];
      if (!u) continue;
      const seen = presenceSeen[u] || 0;
      const isAway = Date.now() - seen > 60_000;
      if (isAway && !away[i]) {
        away[i] = true;
        awaySince[i] = Date.now();
        try {
          engine = applyAction(engine, { type: 'SET_AWAY', seat: i, away: true });
        } catch { /* */ }
        queueWrite();
      } else if (!isAway && away[i]) {
        delete away[i];
        delete awaySince[i];
        try {
          engine = applyAction(engine, { type: 'SET_AWAY', seat: i, away: false });
        } catch { /* */ }
        queueWrite();
      }
    }

    // 附錄 L5：暫離連續 30 分鐘 → 在 LOBBY／HAND_OVER 自動離座結帳
    const between =
      engine.phase === PHASE.LOBBY || engine.phase === PHASE.HAND_OVER;
    if (between) {
      for (let i = 0; i < 6; i++) {
        const u = room.seatUids[i];
        if (!u || !away[i] || !awaySince[i]) continue;
        if (Date.now() - awaySince[i] < AWAY_UNSEAT_MS) continue;
        // Don't auto-cashout self-as-host here without handoff candidate
        if (u === uid) continue;
        cashoutSeat(i, u).catch((e) => console.warn('[host] auto-unseat', e));
        delete away[i];
        delete awaySince[i];
      }
    }

    // Timeout — engine.deadline is re-armed per action; never a stale host arm
    if (hostShouldTimeout(engine)) {
      const seat = engine.actor;
      if (away[seat]) {
        // auto check/fold immediately when away on turn
      }
      applyAndPublish({ type: 'TIMEOUT', seat });
      writeHoles();
    }

    drainSitLeave();
  }

  function start() {
    if (running) return;
    running = true;
    const room = getRoom();
    ensureEngine(room);
    statsRuntime.start();

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
    statsRuntime.stop();
    for (const timer of delayedTimers) clearTimeout(timer);
    delayedTimers.clear();
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    pendingFlush?.();
    pendingFlush = null;
    if (tickTimer) clearInterval(tickTimer);
    clearRevealTimer();
    clearNextHandTimer();
    stopIntentListen?.();
    stopPresenceListen?.();
  }

  return {
    start,
    stop,
    startHand,
    hostAction,
    voidHand,
    cashoutSeat,
    prepareClose,
    closeAll,
    seatPlayer,
    getEngine: () => engine,
    lastRoomWriteAt: () => lastWriteAt,
    getAway: () => ({ ...away }),
    getSeatedAt: () => [...seatedAt],
    /** Phase A test/debug: stats pending queue + session (not for game flow). */
    getStatsSession: () => statsSession,
    getStatsQueue: () => statsQueue,
    getStatsWriteChain: () => statsWriteChain,
  };
}
