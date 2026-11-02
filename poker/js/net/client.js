/**
 * Non-host client: intents, local countdown, pub-diff animation queue (§6.4–6.5).
 */

import { recordWrite } from './quota.js';
import { MP_FX } from '../ui/fx-mp.js';

/**
 * @param {{ db:any, fs:any }} fb
 * @param {string} roomId
 * @param {string} uid
 */
export function createIntentSender(fb, roomId, uid) {
  const { db, fs } = fb;
  const ref = fs.doc(db, 'pokerRooms', roomId, 'intents', uid);
  let seq = 0;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let resendTimer = null;
  let pending = null;
  let resendCount = 0;

  async function write(payload) {
    seq += 1;
    await fs.setDoc(ref, {
      ...payload,
      seq,
      at: fs.serverTimestamp(),
    });
    recordWrite();
  }

  /**
   * @param {{ type:string, amount?:number, seat?:number, handNo:number, turn:number }} action
   * @param {{ onPending?: (ms:number)=>void, onFail?: ()=>void, onClear?: ()=>void }} hooks
   */
  async function send(action, hooks = {}) {
    clearResend();
    pending = { ...action };
    resendCount = 0;
    await write(pending);
    const t0 = Date.now();
    const labelAt = t0 + MP_FX.pendingLabelAfterMs;
    const resendAt = t0 + MP_FX.pendingResendAfterMs;

    const tick = () => {
      if (!pending) return;
      const now = Date.now();
      if (now >= labelAt) hooks.onPending?.(now - t0);
      if (now >= resendAt && resendCount < 2) {
        resendCount += 1;
        write({ ...pending }).catch(() => {});
        resendTimer = setTimeout(tick, MP_FX.pendingResendAfterMs);
        return;
      }
      if (now >= resendAt && resendCount >= 2) {
        hooks.onFail?.();
        pending = null;
        return;
      }
      resendTimer = setTimeout(tick, 250);
    };
    resendTimer = setTimeout(tick, 250);

    return {
      clear(actionSeq) {
        if (pending && actionSeq != null && actionSeq > pending.turn) {
          pending = null;
          clearResend();
          hooks.onClear?.();
        }
      },
    };
  }

  function clearResend() {
    if (resendTimer) clearTimeout(resendTimer);
    resendTimer = null;
  }

  return { send, clearResend };
}

/**
 * Local countdown from host deadline (§6.4).
 * remaining = (deadlineAt − hostClockAt) − (now − recvAt)
 */
export function remainingMs(deadlineAt, hostClockAt, recvAt, now = Date.now()) {
  if (deadlineAt == null || hostClockAt == null || recvAt == null) return null;
  const budget = deadlineAt - hostClockAt;
  const elapsed = now - recvAt;
  return Math.max(0, budget - elapsed);
}

/**
 * Diff two pubs → animation events.
 * @param {object|null} prev
 * @param {object} next
 * @param {{ late?: boolean, wasHidden?: boolean, reconnected?: boolean }} flags
 */
export function diffPubEvents(prev, next, flags = {}) {
  if (!prev || flags.reconnected || flags.wasHidden) {
    return { skip: true, events: [{ type: 'snap', pub: next }] };
  }
  const seqJump =
    (next.actionSeq ?? 0) - (prev.actionSeq ?? 0) > MP_FX.skipIfSeqJumpOver;
  if (seqJump || flags.late) {
    return { skip: true, events: [{ type: 'snap', pub: next }] };
  }

  /** @type {object[]} */
  const events = [];
  if ((next.handNo ?? 0) > (prev.handNo ?? 0)) {
    events.push({ type: 'deal', pub: next });
  }
  if (next.hostUid && prev.hostUid && next.hostUid !== prev.hostUid) {
    events.push({ type: 'hostChange', from: prev.hostUid, to: next.hostUid, voided: !!next.voided });
  }
  for (let i = 0; i < 6; i++) {
    const a = prev.seats?.[i];
    const b = next.seats?.[i];
    if (!a && b) events.push({ type: 'seatIn', seat: i, player: b });
    if (a && !b) events.push({ type: 'seatOut', seat: i, player: a });
    const aw0 = !!(prev.away?.[i] || prev.away?.[String(i)]);
    const aw1 = !!(next.away?.[i] || next.away?.[String(i)]);
    if (aw0 !== aw1) events.push({ type: 'away', seat: i, away: aw1 });
  }
  if (next.lastAction && next.actionSeq !== prev.actionSeq) {
    events.push({ type: 'action', action: next.lastAction, pub: next });
  }
  // top-up: stacks 0→2000 with topUps+1
  // (host sets lastMoneyEvent type topup — clients can also watch stacks)
  if (next.lastMoneyEvent?.type === 'topup' && next.lastMoneyEvent?.id !== prev.lastMoneyEvent?.id) {
    events.push({ type: 'topUp', seat: next.lastMoneyEvent.seat, amount: next.lastMoneyEvent.amount });
  }
  if (next.lastMoneyEvent?.type === 'cashout' && next.lastMoneyEvent?.id !== prev.lastMoneyEvent?.id) {
    events.push({ type: 'cashout', seat: next.lastMoneyEvent.seat, amount: next.lastMoneyEvent.amount });
  }
  return { skip: false, events };
}

export function createAnimQueue(onEvent) {
  /** @type {object[]} */
  let q = [];
  let busy = false;

  async function pump() {
    if (busy) return;
    busy = true;
    while (q.length) {
      if (q.length > MP_FX.skipIfQueueOver) {
        const last = q[q.length - 1];
        q = [];
        await onEvent({ type: 'snap', pub: last.pub || last });
        break;
      }
      const ev = q.shift();
      await onEvent(ev);
    }
    busy = false;
  }

  return {
    push(events, { skip } = {}) {
      if (skip) {
        q = [];
        onEvent(events[0] || { type: 'snap' });
        return;
      }
      q.push(...events);
      pump();
    },
    clear() {
      q = [];
    },
  };
}

export function listenHole(fb, roomId, uid, onCards) {
  const { db, fs } = fb;
  return fs.onSnapshot(
    fs.doc(db, 'pokerRooms', roomId, 'hole', uid),
    (snap) => {
      if (!snap.exists()) {
        onCards(null);
        return;
      }
      onCards(snap.data());
    },
  );
}
