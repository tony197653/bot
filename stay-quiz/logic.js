/**
 * STAY 猜歌測驗 — 純邏輯（計分／倒數／干擾／最高分）
 * 瀏覽器與 Node 單元測試共用。
 */

/** @param {number} listens @param {boolean} correct */
export function scoreFor(listens, correct) {
  if (!correct) return 0;
  const n = Math.max(1, listens | 0);
  if (n <= 1) return 10;
  if (n === 2) return 9;
  return 8;
}

/** @param {number} listens */
export function potentialPoints(listens) {
  return scoreFor(Math.max(1, listens | 0), true);
}

/**
 * @param {number} score
 * @returns {string}
 */
export function commentFor(score) {
  if (score >= 100) return '滿分！你就是最強 STAY';
  if (score >= 80) return '超強！真正的 STAY';
  if (score >= 50) return '很棒！再多聽幾次 MV';
  return '一起去補 MV 吧！';
}

/**
 * Fisher–Yates；可注入 RNG（回傳 [0,1)）。
 * @template T
 * @param {T[]} arr
 * @param {() => number} [rng]
 * @returns {T[]}
 */
export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

/**
 * 從干擾池抽 count 個，排除 exclude 清單。
 * @param {string[]} pool
 * @param {number} count
 * @param {string[]} [exclude]
 * @param {() => number} [rng]
 * @returns {string[]}
 */
export function sampleDistractors(pool, count, exclude = [], rng = Math.random) {
  const ban = new Set(exclude);
  const candidates = pool.filter((t) => !ban.has(t));
  if (candidates.length < count) {
    throw new Error(`干擾池不足：需要 ${count}，可用 ${candidates.length}`);
  }
  return shuffle(candidates, rng).slice(0, count);
}

/**
 * 組一題的 4 個選項（1 正解 + 3 干擾），順序隨機。
 * @param {{title: string}} question
 * @param {string[]} distractorPool
 * @param {string[]} [prevDistractors]
 * @param {() => number} [rng]
 */
export function buildChoices(question, distractorPool, prevDistractors = [], rng = Math.random) {
  const distractors = sampleDistractors(distractorPool, 3, prevDistractors, rng);
  const choices = shuffle([question.title, ...distractors], rng);
  return { choices, distractors };
}

/**
 * 洗題並為每題抽選項。
 * @param {object} data questions.json
 * @param {() => number} [rng]
 */
export function prepareRound(data, rng = Math.random) {
  const order = shuffle(data.questions, rng);
  /** @type {{question: object, choices: string[], distractors: string[]}[]} */
  const items = [];
  let prev = [];
  for (const q of order) {
    const built = buildChoices(q, data.distractors, prev, rng);
    items.push({ question: q, choices: built.choices, distractors: built.distractors });
    prev = built.distractors;
  }
  return items;
}

/**
 * 最高分：僅當新分數嚴格大於舊分（或尚無紀錄）才更新。
 * 第一輪含 0 分也算新紀錄。
 * @param {number} score
 * @param {{score: number, player: string, at?: string}|null} best
 */
export function shouldUpdateBest(score, best) {
  if (!best || typeof best.score !== 'number') return true;
  return score > best.score;
}

/**
 * 驗證 localStorage 讀出的 best 形狀。
 * @param {unknown} value
 * @param {string[]} players
 * @returns {{score: number, player: string, at: string}|null}
 */
export function normalizeBest(value, players) {
  if (!value || typeof value !== 'object') return null;
  const best = /** @type {any} */ (value).best ?? value;
  if (!best || typeof best !== 'object') return null;
  const score = best.score;
  const player = best.player;
  if (!Number.isInteger(score) || score < 0 || score > 100) return null;
  if (typeof player !== 'string' || !players.includes(player)) return null;
  const at = typeof best.at === 'string' ? best.at : '';
  return { score, player, at };
}

export const STORAGE_KEY = 'stayQuiz.v2';

/**
 * 台灣時間 YYYY-MM-DD
 * @param {Date} [d]
 */
export function taiwanDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** 倒數狀態 */
export const TimerState = {
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  ENDED: 'ended',
};

/**
 * 15 秒倒數狀態機（以剩餘毫秒記錄）。
 * @param {{durationMs?: number, now?: () => number}} [opts]
 */
export function createCountdown(opts = {}) {
  const durationMs = opts.durationMs ?? 15000;
  const now = opts.now ?? (() => performance.now());

  let state = TimerState.IDLE;
  let remainingMs = durationMs;
  let lastTick = 0;
  /** @type {'replay'|'background'|null} */
  let pauseReason = null;

  function sync() {
    if (state !== TimerState.RUNNING) return remainingMs;
    const t = now();
    remainingMs = Math.max(0, remainingMs - (t - lastTick));
    lastTick = t;
    if (remainingMs <= 0) {
      remainingMs = 0;
      state = TimerState.ENDED;
      pauseReason = null;
    }
    return remainingMs;
  }

  return {
    get state() {
      sync();
      return state;
    },
    get remainingMs() {
      return sync();
    },
    get pauseReason() {
      return pauseReason;
    },
    get isUrgent() {
      return sync() <= 5000 && state !== TimerState.IDLE && state !== TimerState.ENDED
        ? true
        : sync() <= 5000 && (state === TimerState.RUNNING || state === TimerState.PAUSED);
    },
    reset() {
      state = TimerState.IDLE;
      remainingMs = durationMs;
      lastTick = 0;
      pauseReason = null;
    },
    /** 第一次發聲：未開始 → 計時中 */
    start() {
      if (state !== TimerState.IDLE) return false;
      state = TimerState.RUNNING;
      remainingMs = durationMs;
      lastTick = now();
      pauseReason = null;
      return true;
    },
    /**
     * @param {'replay'|'background'} reason
     */
    pause(reason) {
      sync();
      if (state !== TimerState.RUNNING) return false;
      state = TimerState.PAUSED;
      pauseReason = reason;
      return true;
    },
    resume() {
      sync();
      if (state !== TimerState.PAUSED) return false;
      state = TimerState.RUNNING;
      lastTick = now();
      pauseReason = null;
      return true;
    },
    stop() {
      sync();
      if (state === TimerState.ENDED) return false;
      state = TimerState.ENDED;
      pauseReason = null;
      return true;
    },
    displaySeconds() {
      return Math.ceil(sync() / 1000);
    },
    /** 測試用：直接設定剩餘毫秒（不改狀態） */
    _injectRemaining(ms) {
      remainingMs = Math.max(0, ms);
      if (state === TimerState.RUNNING) lastTick = now();
      if (remainingMs === 0) {
        state = TimerState.ENDED;
        pauseReason = null;
      }
    },
  };
}
