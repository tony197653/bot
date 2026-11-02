/**
 * Local write quota fuse — America/Los_Angeles midnight reset (§6.6).
 * Only the host machine enforces 6000 warn / 8000 stop-new-hand.
 */

import { LS_PREFIX } from './firebase-config.js';

const KEY = `${LS_PREFIX}.quota`;
const WARN_AT = 6000;
const STOP_AT = 8000;

function pacificDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
  }).format(d);
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { date: pacificDate(), writes: 0 };
    const o = JSON.parse(raw);
    const date = pacificDate();
    if (o.date !== date) return { date, writes: 0 };
    return { date, writes: o.writes | 0 };
  } catch {
    return { date: pacificDate(), writes: 0 };
  }
}

function save(q) {
  try {
    localStorage.setItem(KEY, JSON.stringify(q));
  } catch {
    /* ignore */
  }
}

export function recordWrite() {
  const q = load();
  q.writes += 1;
  save(q);
  return q.writes;
}

export function getWriteCount() {
  return load().writes;
}

/** Host-only gates. Non-host: never block. */
export function hostShouldWarn(isHost) {
  return !!isHost && getWriteCount() >= WARN_AT;
}

export function hostMustStopNewHand(isHost) {
  return !!isHost && getWriteCount() >= STOP_AT;
}

/** Taipei wall-clock string for next LA midnight reset (e.g. "15:00" or "16:00"). */
export function resetTimeTaipeiLabel(now = new Date()) {
  // Find next America/Los_Angeles midnight, format in Asia/Taipei as HH:mm
  const laDate = pacificDate(now);
  // Approximate: parse LA date, add 1 day at 00:00 LA
  const guess = new Date(`${laDate}T12:00:00Z`);
  for (let i = 0; i < 48; i++) {
    const t = new Date(guess.getTime() + i * 3600e3);
    if (pacificDate(t) !== laDate) {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Taipei',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(t);
    }
  }
  return '16:00';
}

export const QUOTA = { WARN_AT, STOP_AT };
