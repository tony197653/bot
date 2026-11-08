/**
 * Lobby self-rescue eligibility (§6.10 / rules hostGone).
 * Never offers 「房主失聯」 when the viewer is the host — they use 「回到牌桌」.
 */

export const RESCUE_AFTER_MS = 10 * 60_000;

/**
 * @param {{
 *   uid: string,
 *   room: null | { status?: string, hostUid?: string, updatedAtMs?: number },
 *   hostBeatMs?: number | null,
 *   now?: number,
 * }} args
 * @returns {{ ok: boolean, reason: 'closed'|'gone'|null }}
 */
export function decideRescue({ uid, room, hostBeatMs = null, now = Date.now() }) {
  if (!room) return { ok: true, reason: 'gone' };
  if (room.status === 'closed') return { ok: true, reason: 'closed' };
  // Host sitting in lobby is still the host — never self-rescue as「房主失聯」
  if (room.hostUid && room.hostUid === uid) {
    return { ok: false, reason: null };
  }
  const updatedMs = Number(room.updatedAtMs) || 0;
  const roomStale = now - updatedMs >= RESCUE_AFTER_MS;
  const presenceStale =
    hostBeatMs == null || now - Number(hostBeatMs) >= RESCUE_AFTER_MS;
  // Match firestore.rules hostGone: room AND host heartbeat both stale
  if (roomStale && presenceStale) return { ok: true, reason: 'gone' };
  return { ok: false, reason: null };
}
