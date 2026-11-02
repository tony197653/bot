/**
 * Heartbeats + host takeover (§6.6 / §6.7).
 */

import { recordWrite } from './quota.js';

const PLAYER_BEAT_MS = 30_000;
const HOST_IDLE_BEAT_MS = 10_000;
const TAKEOVER_AFTER_MS = 30_000;
const TAKEOVER_STAGGER_MS = 3_000;

/**
 * @param {{ db:any, fs:any }} fb
 * @param {string} roomId
 * @param {string} uid
 * @param {{ isHost: () => boolean, lastRoomWriteAt: () => number }} opts
 */
export function startPresence(fb, roomId, uid, opts) {
  const { db, fs } = fb;
  const ref = fs.doc(db, 'pokerRooms', roomId, 'presence', uid);
  let stopped = false;
  let timer = null;

  async function beat(vis) {
    if (stopped) return;
    if (opts.isHost()) {
      const idle = Date.now() - (opts.lastRoomWriteAt() || 0);
      if (idle < HOST_IDLE_BEAT_MS) return;
    }
    try {
      await fs.setDoc(ref, { beat: fs.serverTimestamp(), vis: !!vis });
      recordWrite();
    } catch {
      /* ignore transient */
    }
  }

  const onVis = () => {
    const vis = document.visibilityState === 'visible';
    beat(vis);
  };

  document.addEventListener('visibilitychange', onVis);
  beat(document.visibilityState === 'visible');
  timer = setInterval(() => {
    if (document.visibilityState === 'visible') beat(true);
  }, PLAYER_BEAT_MS);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    },
    beatNow: () => beat(document.visibilityState === 'visible'),
  };
}

/**
 * Listen presence collection (host only).
 */
export function listenPresence(fb, roomId, onMap) {
  const { db, fs } = fb;
  return fs.onSnapshot(fs.collection(db, 'pokerRooms', roomId, 'presence'), (snap) => {
    /** @type {Record<string,{beatMs:number,vis:boolean}>} */
    const map = {};
    snap.forEach((d) => {
      const data = d.data();
      map[d.id] = {
        beatMs: data.beat?.toMillis?.() ?? 0,
        vis: !!data.vis,
      };
    });
    onMap(map);
  });
}

/**
 * Rank seats for takeover: earliest seatedAt among non-away seated players.
 * @returns {string[]} uids in order
 */
export function takeoverOrder(room) {
  const seatedAt = room.pub?.seatedAt || [0, 0, 0, 0, 0, 0];
  const away = room.pub?.away || {};
  /** @type {{uid:string,at:number}[]} */
  const rows = [];
  for (let i = 0; i < 6; i++) {
    const uid = room.seatUids[i];
    if (!uid || uid === room.hostUid) continue;
    if (away[i] || away[String(i)]) continue;
    rows.push({ uid, at: seatedAt[i] || 0 });
  }
  rows.sort((a, b) => a.at - b.at || a.uid.localeCompare(b.uid));
  return rows.map((r) => r.uid);
}

/**
 * Client-side takeover attempt when room snapshot stale > 30s.
 * @param {{ db:any, fs:any }} fb
 * @param {object} room
 * @param {string} myUid
 * @param {number} lastRecvAt local Date.now when snapshot received
 * @param {(pub:object)=>object} buildVoidPub
 */
export async function maybeTakeover(fb, room, myUid, lastRecvAt, buildVoidPub) {
  if (document.visibilityState !== 'visible') return false;
  if (room.hostUid === myUid) return false;
  if (!room.seatUids.includes(myUid)) return false;
  if (Date.now() - lastRecvAt < TAKEOVER_AFTER_MS) return false;

  const order = takeoverOrder(room);
  const rank = order.indexOf(myUid);
  if (rank < 0) return false;
  // Stagger: k-th waits k*3s after the 30s mark
  const waitUntil = lastRecvAt + TAKEOVER_AFTER_MS + rank * TAKEOVER_STAGGER_MS;
  if (Date.now() < waitUntil) return false;

  const { db, fs } = fb;
  const ref = fs.doc(db, 'pokerRooms', room.id);
  try {
    await fs.runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error('gone');
      const r = snap.data();
      if (r.hostUid === myUid) return;
      if (r.status !== 'open') throw new Error('closed');
      if (!r.seatUids.includes(myUid)) throw new Error('not seated');
      const pub = buildVoidPub
        ? buildVoidPub(r.pub)
        : {
            ...r.pub,
            phase: 'hand_over',
            voided: true,
            board: [],
            actor: null,
            pots: [],
            winners: null,
          };
      tx.update(ref, {
        rev: r.rev + 1,
        updatedAt: fs.serverTimestamp(),
        hostUid: myUid,
        hostSince: fs.serverTimestamp(),
        pub,
        deadlineAt: null,
        lastMoneyEvent: r.lastMoneyEvent,
        stacks: r.stacks,
        chipTotal: r.chipTotal,
        sess: r.sess,
        seatUids: r.seatUids,
      });
    });
    recordWrite();
    return true;
  } catch {
    return false;
  }
}

export const PRESENCE_MS = {
  PLAYER_BEAT_MS,
  HOST_IDLE_BEAT_MS,
  TAKEOVER_AFTER_MS,
  TAKEOVER_STAGGER_MS,
};
