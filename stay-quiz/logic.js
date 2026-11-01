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

const RESULT_COMMENTS = {
  0: '滾',
  10: '不送慢走',
  20: '你還好嗎？',
  30: '加油',
  40: '再練習五下就OK了',
  50: 'Hello，準Stay',
  60: 'Stay小隊長',
  70: '還得是你！優秀',
  80: 'Stay大隊長',
  90: 'You got an A.',
  100: '這就是真愛',
};

/**
 * 成績評語：分數以 10 為階（非整十則向下取整到最近 10）。
 * @param {number} score
 * @returns {string}
 */
export function commentFor(score) {
  const n = Number(score);
  const clamped = Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
  const key = Math.floor(clamped / 10) * 10;
  return RESULT_COMMENTS[key] ?? RESULT_COMMENTS[0];
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
 * 最高分：新分數 ≥ 舊分（或尚無紀錄）才更新；同分可換玩家名。
 * 第一輪含 0 分也算新紀錄。
 * @param {number} score
 * @param {{score: number, player: string, at?: string|number}|null} best
 */
export function shouldUpdateBest(score, best) {
  if (!best || typeof best.score !== 'number') return true;
  return score >= best.score;
}

/**
 * 雲端寫入條件（對局結束）：缺雲端或新分 ≥ 雲端分。
 * @param {number} score
 * @param {number|null|undefined} cloudScore
 */
export function shouldWriteCloudRoundEnd(score, cloudScore) {
  if (score === 0) return false;
  if (cloudScore == null || typeof cloudScore !== 'number') return true;
  return score >= cloudScore;
}

/**
 * 雲端寫入條件（遷移）：缺雲端或本地分 > 雲端分（嚴格）。
 * @param {number} localScore
 * @param {number|null|undefined} cloudScore
 */
export function shouldWriteCloudMigration(localScore, cloudScore) {
  if (localScore === 0) return false;
  if (cloudScore == null || typeof cloudScore !== 'number') return true;
  return localScore > cloudScore;
}

/**
 * 雲端寫入條件（pending 重傳）：缺雲端或 pending > 雲端（嚴格）。
 * @param {number} pendingScore
 * @param {number|null|undefined} cloudScore
 */
export function shouldWriteCloudPending(pendingScore, cloudScore) {
  if (pendingScore === 0) return false;
  if (cloudScore == null || typeof cloudScore !== 'number') return true;
  return pendingScore > cloudScore;
}

/** 0 分不上傳雲端、不存 pending */
export function shouldSkipCloudUpload(score) {
  return score === 0;
}

/**
 * 把 best.at 轉成可比較的毫秒（數字原樣；YYYY-MM-DD 當台北日開始）。
 * @param {unknown} at
 */
export function bestAtMillis(at) {
  if (typeof at === 'number' && Number.isFinite(at)) return at;
  if (typeof at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(at)) {
    const ms = Date.parse(`${at}T00:00:00+08:00`);
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
}

/**
 * 顯示用最高分：在 cloud／local／pending 中取最高分；同分取最新 at。
 * @param  {...({score:number,player:string,at?:string|number}|null|undefined)} candidates
 * @returns {{score:number,player:string,at:string|number}|null}
 */
export function pickDisplayBest(...candidates) {
  /** @type {{score:number,player:string,at:string|number}|null} */
  let win = null;
  for (const c of candidates) {
    if (!c || typeof c.score !== 'number' || typeof c.player !== 'string') continue;
    if (!win) {
      win = c;
      continue;
    }
    if (c.score > win.score) {
      win = c;
      continue;
    }
    if (c.score === win.score && bestAtMillis(c.at) >= bestAtMillis(win.at)) {
      win = c;
    }
  }
  return win;
}

/**
 * 驗證 localStorage 讀出的 best 形狀。
 * @param {unknown} value
 * @param {string[]} players
 * @returns {{score: number, player: string, at: string|number}|null}
 */
export function normalizeBest(value, players) {
  if (!value || typeof value !== 'object') return null;
  const best = /** @type {any} */ (value).best ?? value;
  if (!best || typeof best !== 'object') return null;
  const score = best.score;
  const player = best.player;
  if (!Number.isInteger(score) || score < 0 || score > 100) return null;
  if (typeof player !== 'string' || !players.includes(player)) return null;
  /** @type {string|number} */
  let at = '';
  if (typeof best.at === 'number' && Number.isFinite(best.at)) at = best.at;
  else if (typeof best.at === 'string') at = best.at;
  return { score, player, at };
}

export const STORAGE_KEY = 'stayQuiz.v2';
export const CLOUD_CACHE_KEY = 'stayQuiz.v2.cloud';
export const PENDING_KEY = 'stayQuiz.v2.pending';
export const MIGRATED_KEY = 'stayQuiz.v2.migrated';

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
 * QA #1：按「繼續」後是否應恢復倒數。
 * 背景暫停後，若音訊並非「正在播放的重播」，一律 resume。
 * （重播中使用者已暫停 → inReplaySegment 仍為 true，但音訊沒在播 → 必須 resume）
 * @param {{ pauseReason: string|null, inReplaySegment: boolean, audioPlaying: boolean }} s
 */
export function shouldResumeCountdownAfterContinue(s) {
  if (s.pauseReason !== 'background') return false;
  if (s.inReplaySegment && s.audioPlaying) return false;
  return true;
}

/**
 * QA #1：重播片段 ended 時，哪些 pauseReason 應恢復倒數。
 * @param {string|null} pauseReason
 */
export function shouldResumeCountdownOnReplayEnded(pauseReason) {
  return pauseReason === 'replay' || pauseReason === 'background';
}

/**
 * QA #2：第一次發聲前，播放鍵應停用（載入中不可連按）。
 * @param {{ firstSoundHeard: boolean, loadFailed: boolean, blockedAutoplay: boolean }} s
 */
export function isPlayButtonDisabledWhileLoading(s) {
  if (s.loadFailed || s.blockedAutoplay) return false;
  return !s.firstSoundHeard;
}

/**
 * QA #2：是否應把這次從頭播放算成「重播」（已聽 +1）。
 * 第一次發聲前不計重播。
 * @param {{ firstSoundHeard: boolean, answered: boolean }} s
 */
export function shouldCountPlayFromStartAsReplay(s) {
  return s.firstSoundHeard && !s.answered;
}

/**
 * QA #2：play() 被中斷（AbortError）不應走音檔失敗／自動重試。
 * @param {{ name?: string }|null|undefined} err
 */
export function isBenignPlayAbort(err) {
  return !!(err && err.name === 'AbortError');
}

/**
 * QA #3：頁面隱藏時不可自動重試 play（避免遮罩下偷播＋倒數偷跑）。
 * @param {{ pageHidden: boolean }} s
 */
export function shouldAutoRetryAudio(s) {
  return !s.pageHidden;
}

/**
 * QA #3：隱藏期間若收到 playing，應立刻暫停且不啟動倒數。
 * @param {{ pageHidden: boolean, resumeVisible: boolean, firstSoundHeard: boolean }} s
 */
export function shouldSuppressPlayingWhileHidden(s) {
  return (s.pageHidden || s.resumeVisible) && !s.firstSoundHeard;
}

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
