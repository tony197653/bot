/** 台灣早上 8 點＝UTC 換日。day key 用 UTC 日期字串 YYYY-MM-DD。 */
export function currentDayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** 下一次重置（下一個 UTC 午夜＝台灣 08:00）的 ISO 字串。 */
export function nextResetAt(now = new Date()): string {
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0),
  );
  return next.toISOString();
}

export const DAILY_LIMIT = 20;
export const BURST_WINDOW_MS = 10_000;
export const BURST_MAX = 3;
export const MAX_Q_LEN = 500;
export const MAX_TOKENS = 800;
export const FIRST_TOKEN_TIMEOUT_MS = 15_000;
