import {
  STORAGE_KEY,
  commentFor,
  createCountdown,
  isBenignPlayAbort,
  isPlayButtonDisabledWhileLoading,
  normalizeBest,
  potentialPoints,
  prepareRound,
  scoreFor,
  shouldAutoRetryAudio,
  shouldCountPlayFromStartAsReplay,
  shouldResumeCountdownAfterContinue,
  shouldResumeCountdownOnReplayEnded,
  shouldSuppressPlayingWhileHidden,
  shouldUpdateBest,
  taiwanDate,
  TimerState,
} from './logic.js';

const TEST_MODE = new URLSearchParams(location.search).get('test') === '1';

const LETTERS = ['A', 'B', 'C', 'D'];

/** @type {any} */
let data = null;
/** @type {{question: any, choices: string[], distractors: string[]}[]} */
let round = [];
let player = '';
let qIndex = 0;
let totalScore = 0;
/** @type {any[]} */
let answers = [];
let listens = 1;
/** 'first' | 'replay' | 'feedback' | null */
let playPhase = null;
let answered = false;
let nextArmedAt = 0;
/** @type {ReturnType<typeof createCountdown>} */
let timer = createCountdown({ durationMs: 15000 });
let timerUi = null;
let wasPlayingBeforeHide = false;
let blobCache = new Map();
let autoRetryUsed = false;
let loadFailed = false;
let blockedAutoplay = false;
/** 本輪播放是否已觸發過 playing（第一次聽） */
let firstSoundHeard = false;
/** 目前這段重播是否仍算「重播中」（含暫停後續播） */
let inReplaySegment = false;
/** prefers-reduced-motion：倒數條每秒跳一格 */
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let lastTimerDisplaySec = -1;
/** 顯示「繼續」前的焦點（N4） */
let focusBeforeResume = null;

/** 是否處於背景中斷：讀 document.hidden，或作答中的「繼續」遮罩仍開著 */
function isInterrupted() {
  return document.hidden || !el.resumeMask.hidden;
}

const el = {
  start: document.getElementById('screen-start'),
  quiz: document.getElementById('screen-quiz'),
  result: document.getElementById('screen-result'),
  playerBtns: document.getElementById('playerBtns'),
  startHigh: document.getElementById('startHigh'),
  loadError: document.getElementById('loadError'),
  audio: /** @type {HTMLAudioElement} */ (document.getElementById('audio')),
  quizPlayer: document.getElementById('quizPlayer'),
  quizScore: document.getElementById('quizScore'),
  quizIndex: document.getElementById('quizIndex'),
  quizProgress: document.getElementById('quizProgress'),
  timerRow: document.getElementById('timerRow'),
  timerBar: document.getElementById('timerBar'),
  timerLabel: document.getElementById('timerLabel'),
  btnPlay: document.getElementById('btnPlay'),
  btnReplay: document.getElementById('btnReplay'),
  playHint: document.getElementById('playHint'),
  clipBar: document.getElementById('clipBar'),
  clipCur: document.getElementById('clipCur'),
  clipDur: document.getElementById('clipDur'),
  listenHint: document.getElementById('listenHint'),
  audioError: document.getElementById('audioError'),
  btnRetryAudio: document.getElementById('btnRetryAudio'),
  btnSkipQ: document.getElementById('btnSkipQ'),
  options: document.getElementById('options'),
  feedbackCard: document.getElementById('feedbackCard'),
  fbText: document.getElementById('fbText'),
  btnMv: /** @type {HTMLAnchorElement} */ (document.getElementById('btnMv')),
  footerHint: document.getElementById('footerHint'),
  btnNext: document.getElementById('btnNext'),
  resultScore: document.getElementById('resultScore'),
  resultComment: document.getElementById('resultComment'),
  newRecord: document.getElementById('newRecord'),
  resultHigh: document.getElementById('resultHigh'),
  reviewList: document.getElementById('reviewList'),
  btnAgain: document.getElementById('btnAgain'),
  resumeMask: document.getElementById('resumeMask'),
  btnResume: document.getElementById('btnResume'),
};

function showScreen(name) {
  for (const [key, node] of Object.entries({ start: el.start, quiz: el.quiz, result: el.result })) {
    const on = key === name;
    node.classList.toggle('is-active', on);
    node.hidden = !on;
    if (on) node.classList.add('fade-in');
  }
}

function readBest() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return normalizeBest(JSON.parse(raw), data.players);
  } catch {
    return null;
  }
}

function writeBest(score, who) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ best: { score, player: who, at: taiwanDate() } }),
    );
    return true;
  } catch {
    return false;
  }
}

function formatHigh(best) {
  if (!best) return '還沒有紀錄';
  return `最高分 ${best.score} 分（${best.player}）`;
}

function storageAvailable() {
  try {
    const k = '__stay_probe__';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

function refreshStartHigh() {
  if (!storageAvailable()) {
    el.startHigh.classList.add('hidden');
    return;
  }
  el.startHigh.classList.remove('hidden');
  el.startHigh.textContent = formatHigh(readBest());
}

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function currentItem() {
  return round[qIndex];
}

function audioSrcFor(q) {
  const cached = blobCache.get(q.id);
  return cached || q.audio;
}

function stopAudio() {
  const a = el.audio;
  a.pause();
  try {
    a.currentTime = 0;
  } catch { /* ignore */ }
  el.btnPlay.classList.remove('is-playing');
}

function setPlayingUi(playing) {
  el.btnPlay.classList.toggle('is-playing', playing);
}

function updateListenHint(mode) {
  if (mode === 'feedback') {
    el.listenHint.textContent = `共聽 ${listens} 次`;
    return;
  }
  el.listenHint.textContent = `已聽 ${listens} 次・本題可得 ${potentialPoints(listens)} 分`;
}

function timerBarPct(rem, total) {
  if (timer.state === TimerState.IDLE) return 100;
  if (reduceMotion) {
    const sec = Math.max(0, Math.ceil(rem / 1000));
    const totalSec = Math.round(total / 1000);
    return totalSec ? (sec / totalSec) * 100 : 0;
  }
  return (rem / total) * 100;
}

function updateTimerUi() {
  const rem = timer.remainingMs;
  const total = (data?.seconds ?? 15) * 1000;
  const sec = timer.displaySeconds();
  // 減少動態：寬度只在秒數變化時更新（每秒一格）
  if (!reduceMotion || sec !== lastTimerDisplaySec || timer.state === TimerState.IDLE || timer.state === TimerState.ENDED) {
    lastTimerDisplaySec = sec;
    const pct = timerBarPct(rem, total);
    el.timerBar.style.transform = `scaleX(${Math.max(0, Math.min(1, pct / 100))})`;
  }

  const urgent = rem <= 5000 && timer.state !== TimerState.IDLE && timer.state !== TimerState.ENDED;
  el.timerRow.classList.toggle('is-urgent', urgent);
  el.timerRow.classList.toggle('is-paused', timer.state === TimerState.PAUSED);

  if (timer.state === TimerState.IDLE) {
    el.timerLabel.textContent = `剩 ${data?.seconds ?? 15} 秒`;
  } else if (timer.state === TimerState.ENDED) {
    el.timerLabel.textContent = '已停止';
  } else if (timer.state === TimerState.PAUSED && timer.pauseReason === 'replay') {
    el.timerLabel.textContent = '重播中，倒數暫停';
  } else {
    el.timerLabel.textContent = `剩 ${sec} 秒`;
  }
}

function syncPlayEnabled() {
  const disable = isPlayButtonDisabledWhileLoading({
    firstSoundHeard,
    loadFailed,
    blockedAutoplay,
  });
  el.btnPlay.disabled = disable && !answered;
  el.btnPlay.classList.toggle('is-loading', disable && !blockedAutoplay && !loadFailed && !answered);
  if (disable && !blockedAutoplay && !loadFailed && !answered) {
    el.playHint.textContent = '載入中';
    el.playHint.classList.remove('hidden');
  } else if (!blockedAutoplay) {
    el.playHint.classList.add('hidden');
  }
}

function startTimerUi() {
  stopTimerUi();
  timerUi = setInterval(() => {
    updateTimerUi();
    updateClipProgress();
    if (timer.state === TimerState.ENDED && !answered) {
      onTimeout();
    }
  }, 100);
}

function stopTimerUi() {
  if (timerUi) {
    clearInterval(timerUi);
    timerUi = null;
  }
}

function updateClipProgress() {
  const a = el.audio;
  const dur = a.duration;
  const cur = a.currentTime || 0;
  if (Number.isFinite(dur) && dur > 0) {
    el.clipBar.style.transform = `scaleX(${Math.max(0, Math.min(1, cur / dur))})`;
    el.clipDur.textContent = fmtTime(dur);
  }
  el.clipCur.textContent = fmtTime(cur);
}

function renderOptions(locked = false) {
  const item = currentItem();
  el.options.innerHTML = '';
  item.choices.forEach((title, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'opt';
    btn.dataset.title = title;
    btn.disabled = locked || answered;
    btn.innerHTML =
      `<span class="opt-letter">${LETTERS[i]}</span>` +
      `<span class="opt-title">${escapeHtml(title)}</span>` +
      `<span class="opt-tag" hidden></span>`;
    btn.addEventListener('click', () => onPick(title));
    el.options.appendChild(btn);
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function markOptions(picked, correctTitle, timedOut, skipped) {
  for (const btn of el.options.querySelectorAll('.opt')) {
    const title = btn.dataset.title;
    const tag = btn.querySelector('.opt-tag');
    btn.disabled = true;
    if (title === correctTitle) {
      btn.classList.add('is-correct');
      tag.hidden = false;
      tag.innerHTML = '<span aria-hidden="true">✓</span> 正解';
    } else if (!timedOut && !skipped && title === picked) {
      btn.classList.add('is-wrong');
      tag.hidden = false;
      tag.innerHTML = '<span aria-hidden="true">×</span> 你的答案';
    } else {
      btn.classList.add('is-dim');
    }
  }
}

async function prefetchNext() {
  const next = round[qIndex + 1];
  if (!next) return;
  if (blobCache.has(next.question.id)) return;
  try {
    const res = await fetch(next.question.audio);
    if (!res.ok) return;
    const blob = await res.blob();
    blobCache.set(next.question.id, URL.createObjectURL(blob));
  } catch { /* ignore */ }
}

/**
 * 同步 play（必須在使用者手勢內呼叫，不可 await 之後才 play）。
 * @returns {Promise<void>}
 */
function playCurrent({ fromStart = false, asReplay = false, asFeedback = false } = {}) {
  const item = currentItem();
  const a = el.audio;
  const src = audioSrcFor(item.question);
  loadFailed = false;
  el.audioError.classList.add('hidden');
  el.btnPlay.classList.remove('is-blocked');

  if (asFeedback) {
    playPhase = 'feedback';
  } else if (asReplay) {
    playPhase = 'replay';
    inReplaySegment = true;
  } else if (playPhase !== 'first' && !firstSoundHeard) {
    playPhase = 'first';
  }

  if (a.getAttribute('src') !== src && a.src !== new URL(src, location.href).href) {
    a.src = src;
  } else if (!a.src) {
    a.src = src;
  }

  if (fromStart) {
    try {
      a.currentTime = 0;
    } catch { /* ignore */ }
  }

  syncPlayEnabled();

  const p = a.play();
  if (p && typeof p.then === 'function') {
    return p.then(() => {
      setPlayingUi(true);
      blockedAutoplay = false;
      syncPlayEnabled();
    }).catch((err) => {
      setPlayingUi(false);
      if (isBenignPlayAbort(err)) {
        // 載入中連按／切背景造成的中斷：不重試、不誤計
        return;
      }
      if (err && err.name === 'NotAllowedError') {
        blockedAutoplay = true;
        el.btnPlay.classList.add('is-blocked');
        el.btnPlay.disabled = false;
        el.playHint.textContent = '點我播放';
        el.playHint.classList.remove('hidden');
        el.btnPlay.classList.remove('is-loading');
        return;
      }
      onAudioError();
    });
  }
  setPlayingUi(true);
  return Promise.resolve();
}

function onAudioError() {
  if (!autoRetryUsed && !answered && shouldAutoRetryAudio({ pageHidden: isInterrupted() })) {
    autoRetryUsed = true;
    const item = currentItem();
    el.audio.src = item.question.audio + `?retry=${Date.now()}`;
    el.audio.load();
    el.audio.play().catch((err) => {
      if (isBenignPlayAbort(err)) return;
      showAudioFail();
    });
    return;
  }
  // 隱藏／遮罩中：不自動重試，也不立刻跳失敗（等回來再處理）
  if (isInterrupted()) {
    return;
  }
  showAudioFail();
}

function showAudioFail() {
  loadFailed = true;
  setPlayingUi(false);
  // 重播載入失敗：倒數恢復
  if (inReplaySegment && timer.state === TimerState.PAUSED && timer.pauseReason === 'replay') {
    inReplaySegment = false;
    timer.resume();
    updateTimerUi();
  }
  el.audioError.classList.remove('hidden');
  // 作答中才顯示跳過；回饋不再顯示
  el.btnSkipQ.classList.toggle('hidden', answered);
}

function beginQuestion(syncPlay) {
  answered = false;
  listens = 1;
  playPhase = 'first';
  firstSoundHeard = false;
  inReplaySegment = false;
  autoRetryUsed = false;
  loadFailed = false;
  blockedAutoplay = false;
  timer = createCountdown({ durationMs: (data.seconds || 15) * 1000 });
  el.feedbackCard.classList.add('hidden');
  el.btnNext.classList.add('hidden');
  el.quiz.classList.remove('is-feedback');
  el.btnNext.disabled = true;
  el.footerHint.classList.remove('hidden');
  el.footerHint.textContent = '選一個答案吧';
  el.audioError.classList.add('hidden');
  el.btnPlay.classList.remove('is-blocked', 'is-playing');
  el.btnReplay.disabled = true;
  el.btnReplay.textContent = '重播';
  el.btnReplay.removeAttribute('aria-label');
  lastTimerDisplaySec = -1;

  const item = currentItem();
  el.quizPlayer.textContent = `玩家：${player}`;
  el.quizScore.textContent = `總分 ${totalScore}`;
  el.quizIndex.textContent = `第 ${qIndex + 1} 題／共 10 題`;
  el.quizProgress.style.transform = `scaleX(${qIndex / 10})`;
  updateListenHint('play');
  renderOptions(false);
  updateTimerUi();
  syncPlayEnabled();
  startTimerUi();

  // 設定 src 並同步 play（iOS）
  el.audio.removeAttribute('src');
  el.audio.src = audioSrcFor(item.question);
  if (syncPlay) {
    playCurrent({ fromStart: true, asReplay: false });
  }
  prefetchNext();
}

function onFirstSound() {
  if (answered) return;
  if (playPhase === 'feedback') return;
  if (
    shouldSuppressPlayingWhileHidden({
      pageHidden: document.hidden,
      resumeVisible: !el.resumeMask.hidden,
      firstSoundHeard,
    })
  ) {
    // QA #3：遮罩／背景期間尚未發聲 → 立刻暫停，倒數保持 idle
    try {
      el.audio.pause();
    } catch { /* ignore */ }
    setPlayingUi(false);
    return;
  }
  if (!firstSoundHeard && playPhase === 'first') {
    firstSoundHeard = true;
    timer.start();
    el.btnReplay.disabled = false;
    syncPlayEnabled();
    updateTimerUi();
  }
}

function onPick(title) {
  if (answered) return;
  if (el.resumeMask.classList.contains('hidden') === false && !el.resumeMask.hidden) return;
  finishQuestion({ picked: title, timedOut: false, skipped: false });
}

function onTimeout() {
  if (answered) return;
  finishQuestion({ picked: null, timedOut: true, skipped: false });
}

function finishQuestion({ picked, timedOut, skipped }) {
  if (answered) return;
  answered = true;
  timer.stop();
  stopAudio();
  updateTimerUi();

  const item = currentItem();
  const correctTitle = item.question.title;
  const correct = !timedOut && !skipped && picked === correctTitle;
  const points = scoreFor(listens, correct);
  totalScore += points;

  answers.push({
    id: item.question.id,
    title: correctTitle,
    youtube: item.question.youtube,
    picked,
    correct,
    timedOut,
    skipped,
    listens: skipped ? null : listens,
    points,
  });

  markOptions(picked, correctTitle, timedOut, skipped);
  updateListenHint('feedback');
  el.footerHint.classList.add('hidden');
  el.btnReplay.textContent = '再聽一次';
  el.btnReplay.disabled = false;
  el.btnPlay.disabled = false;
  el.btnPlay.classList.remove('is-loading');
  el.quizScore.textContent = `總分 ${totalScore}`;
  el.quizProgress.style.transform = `scaleX(${(qIndex + 1) / 10})`;

  if (skipped) {
    // N9：標籤與歌名各 nowrap，只允許在兩者之間斷行
    el.fbText.innerHTML =
      `這題跳過了，<span class="nowrap">正確歌名是</span> ` +
      `<span class="nowrap">${escapeHtml(correctTitle)}</span>`;
  } else if (timedOut) {
    el.fbText.innerHTML =
      `時間到！本題 0 分　<span class="nowrap">正確歌名：</span>` +
      `<span class="nowrap">${escapeHtml(correctTitle)}</span>`;
  } else if (correct) {
    el.fbText.textContent = `答對了！＋${points} 分`;
  } else {
    el.fbText.innerHTML =
      `差一點！本題 0 分　<span class="nowrap">正確歌名：</span>` +
      `<span class="nowrap">${escapeHtml(correctTitle)}</span>`;
  }
  el.btnMv.href = item.question.youtube;
  el.feedbackCard.classList.remove('hidden');

  el.btnNext.textContent = qIndex >= 9 ? '看結果' : '下一題 →';
  el.btnNext.classList.remove('hidden');
  el.quiz.classList.add('is-feedback');
  el.btnNext.disabled = true;
  nextArmedAt = performance.now() + 400;
  setTimeout(() => {
    if (answered) el.btnNext.disabled = false;
  }, 400);

  // N3：窄螢幕 sticky 下一題不蓋住回饋／正解
  queueMicrotask(() => {
    try {
      el.feedbackCard.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch { /* ignore */ }
  });
}

function goNext() {
  if (performance.now() < nextArmedAt) return;
  stopAudio();
  if (qIndex >= 9) {
    showResult();
    return;
  }
  qIndex += 1;
  beginQuestion(true);
}

function showResult() {
  stopTimerUi();
  stopAudio();
  showScreen('result');

  el.resultScore.textContent = `${totalScore}／100`;
  el.resultComment.textContent = commentFor(totalScore);

  let isNew = false;
  if (storageAvailable()) {
    const best = readBest();
    if (shouldUpdateBest(totalScore, best)) {
      writeBest(totalScore, player);
      isNew = true;
    }
    el.resultHigh.classList.remove('hidden');
    el.resultHigh.textContent = formatHigh(readBest());
    el.newRecord.classList.toggle('hidden', !isNew);
  } else {
    el.resultHigh.classList.add('hidden');
    el.newRecord.classList.add('hidden');
  }

  el.reviewList.innerHTML = '';
  answers.forEach((a, i) => {
    const row = document.createElement('div');
    row.className = 'review-row';
    let mark = '×';
    let markClass = 'bad';
    let markLabel = '錯';
    if (a.skipped) {
      mark = '跳過';
      markLabel = '跳過';
    } else if (a.timedOut) {
      mark = '逾時';
      markLabel = '逾時';
    } else if (a.correct) {
      mark = '✓';
      markClass = 'ok';
      markLabel = '對';
    }
    const listenCell = a.skipped ? '—' : `${a.listens}次`;
    const markText =
      a.skipped ? '跳過' : a.timedOut ? '逾時' : a.correct ? '答對' : '答錯';
    row.setAttribute('role', 'listitem');
    row.innerHTML =
      `<div class="review-title"><span class="num">${i + 1}</span>` +
      `<span class="song" title="${escapeHtml(a.title)}">${escapeHtml(a.title)}</span></div>` +
      `<div class="review-meta">` +
      `<span class="mark ${markClass}"><span class="vh">${markText}</span><span aria-hidden="true">${mark}</span></span>` +
      `<span class="meta">${listenCell}</span>` +
      `<span class="meta">${a.points}分</span>` +
      `<a class="mv-link" href="${a.youtube}" target="_blank" rel="noopener" aria-label="看${escapeHtml(a.title)} MV">MV</a>` +
      `</div>`;
    el.reviewList.appendChild(row);
  });
}

function startRound(who, gesture) {
  player = who;
  round = prepareRound(data);
  qIndex = 0;
  totalScore = 0;
  answers = [];
  blobCache.forEach((u) => URL.revokeObjectURL(u));
  blobCache.clear();
  hideResume();
  showScreen('quiz');
  beginQuestion(!!gesture);
}

function hideResume() {
  el.resumeMask.classList.add('hidden');
  el.resumeMask.hidden = true;
  el.quiz.removeAttribute('inert');
  el.resumeMask.removeAttribute('aria-modal');
  // N4／S1：還原焦點；若先前在 BODY／html 或無法還原 → #btnPlay
  const restore = focusBeforeResume;
  focusBeforeResume = null;
  queueMicrotask(() => {
    const usable =
      restore &&
      restore instanceof HTMLElement &&
      document.contains(restore) &&
      typeof restore.focus === 'function' &&
      !restore.disabled &&
      restore !== document.body &&
      restore !== document.documentElement;
    const target = usable ? restore : el.btnPlay;
    try {
      target.focus();
    } catch { /* ignore */ }
  });
}

function showResume() {
  focusBeforeResume = document.activeElement;
  el.resumeMask.classList.remove('hidden');
  el.resumeMask.hidden = false;
  el.resumeMask.setAttribute('role', 'dialog');
  el.resumeMask.setAttribute('aria-modal', 'true');
  el.resumeMask.setAttribute('aria-label', '繼續測驗');
  el.quiz.setAttribute('inert', '');
  // 焦點移到「繼續」，避免 Tab 進到遮罩下方
  queueMicrotask(() => el.btnResume.focus());
}

/* —— 事件 —— */
el.btnPlay.addEventListener('click', () => {
  if (!el.resumeMask.hidden) return;
  if (answered && playPhase !== 'feedback') return;
  const a = el.audio;
  if (blockedAutoplay) {
    // 第一次手動播放＝已聽 1
    listens = 1;
    playCurrent({ fromStart: true });
    return;
  }
  // QA #2：第一次發聲前不可操作（disabled）；雙保險
  if (
    isPlayButtonDisabledWhileLoading({ firstSoundHeard, loadFailed, blockedAutoplay }) &&
    !answered
  ) {
    return;
  }
  if (!a.paused && !a.ended) {
    a.pause();
    setPlayingUi(false);
    // 第一次聽：倒數不停
    // 重播中：暫停 → 倒數恢復
    if (inReplaySegment && !answered) {
      if (timer.state === TimerState.PAUSED && timer.pauseReason === 'replay') {
        timer.resume();
        updateTimerUi();
      }
    }
    return;
  }
  // 暫停後續播或播完再播
  if (a.ended || a.currentTime === 0 || a.currentTime >= (a.duration || 0) - 0.05) {
    if (!answered) {
      // QA #2：第一次發聲前不算重播
      if (shouldCountPlayFromStartAsReplay({ firstSoundHeard, answered })) {
        listens += 1;
        updateListenHint('play');
        if (timer.state === TimerState.RUNNING) timer.pause('replay');
        inReplaySegment = true;
        playPhase = 'replay';
        playCurrent({ fromStart: true, asReplay: true });
      } else {
        playCurrent({ fromStart: true, asReplay: false });
      }
    } else {
      playCurrent({ fromStart: true, asFeedback: true });
    }
    return;
  }
  // 暫停後續播（同一段）
  if (!answered && inReplaySegment) {
    // 定案 A：倒數再暫停
    if (timer.state === TimerState.RUNNING) timer.pause('replay');
    updateTimerUi();
  }
  playCurrent({ fromStart: false, asReplay: inReplaySegment && !answered, asFeedback: answered });
});

el.btnReplay.addEventListener('click', () => {
  if (el.btnReplay.disabled) return;
  if (answered) {
    // 再聽一次：不影響分數
    playCurrent({ fromStart: true, asFeedback: true });
    return;
  }
  if (timer.state === TimerState.IDLE) return;
  listens += 1;
  updateListenHint('play');
  if (timer.state === TimerState.RUNNING) timer.pause('replay');
  else if (timer.state === TimerState.PAUSED && timer.pauseReason === 'replay') {
    // 已在重播暫停中，維持
  }
  inReplaySegment = true;
  updateTimerUi();
  playCurrent({ fromStart: true, asReplay: true });
});

el.btnNext.addEventListener('click', () => goNext());
el.btnAgain.addEventListener('click', () => {
  stopAudio();
  showScreen('start');
  refreshStartHigh();
});
el.btnRetryAudio.addEventListener('click', () => {
  autoRetryUsed = true;
  el.audioError.classList.add('hidden');
  playCurrent({ fromStart: true, asReplay: inReplaySegment && !answered, asFeedback: answered });
});
el.btnSkipQ.addEventListener('click', () => {
  if (answered) return;
  finishQuestion({ picked: null, timedOut: false, skipped: true });
});
el.btnResume.addEventListener('click', () => {
  const shouldResumeAudio = wasPlayingBeforeHide;
  hideResume();
  wasPlayingBeforeHide = false;
  const reason = timer.pauseReason;
  const audioPlaying = !el.audio.paused && !el.audio.ended;

  // 續播音樂（同一使用者手勢內同步 play，重取 iOS 播放權）
  if (shouldResumeAudio || timer.state === TimerState.IDLE) {
    if (inReplaySegment && !answered && shouldResumeAudio) {
      playCurrent({ fromStart: false, asReplay: true });
    } else if (timer.state === TimerState.IDLE && !firstSoundHeard) {
      playCurrent({ fromStart: false });
    } else if (shouldResumeAudio) {
      playCurrent({ fromStart: false, asReplay: inReplaySegment && !answered });
    }
  }

  // QA #1：背景暫停後，若不是「正在播放的重播」就 resume
  if (
    shouldResumeCountdownAfterContinue({
      pauseReason: reason,
      inReplaySegment,
      audioPlaying: shouldResumeAudio || audioPlaying,
    })
  ) {
    timer.resume();
  } else if (inReplaySegment && (shouldResumeAudio || audioPlaying) && timer.state === TimerState.PAUSED) {
    // 維持暫停；確保 reason 記成 replay，方便 ended 時恢復
    if (timer.pauseReason === 'background') {
      timer.resume();
      timer.pause('replay');
    }
  }
  updateTimerUi();
});

el.audio.addEventListener('playing', () => {
  setPlayingUi(true);
  onFirstSound();
  // 重播續播：確保倒數暫停（定案 A）
  if (!answered && inReplaySegment && timer.state === TimerState.RUNNING) {
    timer.pause('replay');
    updateTimerUi();
  }
});
el.audio.addEventListener('pause', () => {
  if (!el.audio.ended) setPlayingUi(false);
});
el.audio.addEventListener('ended', () => {
  setPlayingUi(false);
  if (!answered && inReplaySegment) {
    inReplaySegment = false;
    if (
      timer.state === TimerState.PAUSED &&
      shouldResumeCountdownOnReplayEnded(timer.pauseReason)
    ) {
      timer.resume();
      updateTimerUi();
    }
  }
  updateClipProgress();
});
el.audio.addEventListener('timeupdate', updateClipProgress);
el.audio.addEventListener('loadedmetadata', updateClipProgress);
el.audio.addEventListener('error', () => {
  if (!el.audio.src) return;
  onAudioError();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    // N2：只在遮罩尚未顯示時記錄「離開前是否在播」，避免第二次隱藏覆寫成 false
    if (el.resumeMask.hidden) {
      wasPlayingBeforeHide = !el.audio.paused && !el.audio.ended;
    }
    if (!el.audio.paused) el.audio.pause();
    const onQuizAnswering = el.quiz.classList.contains('is-active') && !answered;
    if (onQuizAnswering) {
      if (timer.state === TimerState.RUNNING) {
        timer.pause('background');
      }
      // 載入中／重播暫停回來也要按「繼續」
      if (el.resumeMask.hidden) showResume();
      updateTimerUi();
    }
    // 回饋／開始／結果：只暫停音樂，不顯示繼續、不留下 sticky 旗標
    return;
  }

  // N1／全畫面 sweep：回到前景且沒有「繼續」遮罩時，中斷狀態結束
  // （回饋／開始／結果切背景不會出遮罩，必須在這裡清乾淨，否則下一題 playing 被抑制）
  if (!el.resumeMask.hidden) {
    // 作答中斷：等使用者按「繼續」
    return;
  }
  // 遮罩未開：不留 pageHidden；wasPlaying 僅在作答遮罩流程使用，此處清掉以免污染
  if (!el.quiz.classList.contains('is-active') || answered) {
    wasPlayingBeforeHide = false;
  }
});

document.addEventListener('keydown', (e) => {
  const tag = (e.target && /** @type {HTMLElement} */ (e.target).tagName) || '';
  const onButton = tag === 'BUTTON' || tag === 'A';
  const resumeVisible = !el.resumeMask.hidden;

  if (resumeVisible) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      el.btnResume.click();
    }
    return;
  }

  if (!el.quiz.classList.contains('is-active')) return;

  if (e.key === ' ' && !onButton) {
    e.preventDefault();
    el.btnPlay.click();
  } else if ((e.key === 'r' || e.key === 'R') && !onButton) {
    e.preventDefault();
    if (!el.btnReplay.disabled) el.btnReplay.click();
  } else if (['1', '2', '3', '4'].includes(e.key) && !answered) {
    const idx = Number(e.key) - 1;
    const btn = el.options.querySelectorAll('.opt')[idx];
    if (btn && !btn.disabled) btn.click();
  } else if (e.key === 'Enter' && !onButton && answered && !el.btnNext.disabled && !el.btnNext.classList.contains('hidden')) {
    e.preventDefault();
    el.btnNext.click();
  }
});

/* 空白鍵在按鈕上：只觸發該按鈕，避免 document 再觸發一次 */
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    const t = e.target;
    if (t instanceof HTMLButtonElement || t instanceof HTMLAnchorElement) {
      // 讓瀏覽器預設啟動按鈕；阻擋冒泡到全域快捷鍵
      e.stopPropagation();
    }
  },
  true,
);

async function boot() {
  try {
    const res = await fetch('data/questions.json');
    if (!res.ok) throw new Error('load');
    data = await res.json();
  } catch {
    el.loadError.classList.remove('hidden');
    return;
  }

  const btns = el.playerBtns.querySelectorAll('.btn-player');
  btns.forEach((btn, i) => {
    const name = data.players[i];
    btn.dataset.player = name;
    btn.textContent = name;
    btn.disabled = false;
    btn.addEventListener('click', () => startRound(name, true));
  });
  refreshStartHigh();
}

boot();

// QA #15：測試 hook 僅在 ?test 時掛上，正式頁面不可作弊
if (TEST_MODE) {
  window.__stayQuiz = {
    get state() {
      return {
        player,
        qIndex,
        totalScore,
        listens,
        answered,
        timerState: timer.state,
        remainingMs: timer.remainingMs,
        pauseReason: timer.pauseReason,
        inReplaySegment,
        firstSoundHeard,
        playPhase,
      };
    },
    scoreFor,
    potentialPoints,
    readBest,
    writeBest,
    startRound,
    forceTimeout: () => onTimeout(),
    forceFirstSound() {
      if (firstSoundHeard) return;
      playPhase = 'first';
      firstSoundHeard = true;
      timer.start();
      el.btnReplay.disabled = false;
      syncPlayEnabled();
      updateTimerUi();
    },
    injectRemaining(ms) {
      if (timer.state === TimerState.IDLE) {
        playPhase = 'first';
        firstSoundHeard = true;
        timer.start();
        syncPlayEnabled();
      }
      timer._injectRemaining(ms);
      updateTimerUi();
    },
    forceRunning(ms) {
      inReplaySegment = false;
      if (timer.state === TimerState.IDLE) {
        playPhase = 'first';
        firstSoundHeard = true;
        timer.start();
        syncPlayEnabled();
      } else if (timer.state === TimerState.PAUSED) {
        timer.resume();
      } else if (timer.state === TimerState.ENDED) {
        timer.reset();
        timer.start();
      }
      timer._injectRemaining(ms);
      updateTimerUi();
    },
    pauseReplay() {
      if (timer.state === TimerState.RUNNING) timer.pause('replay');
      inReplaySegment = true;
      updateTimerUi();
    },
    showResumeMask() {
      if (timer.state === TimerState.RUNNING) timer.pause('background');
      showResume();
      updateTimerUi();
    },
    hideResumeMask() {
      hideResume();
    },
    pickCorrect() {
      const title = currentItem().question.title;
      onPick(title);
    },
    pickWrong() {
      const item = currentItem();
      const wrong = item.choices.find((c) => c !== item.question.title);
      onPick(wrong);
    },
    goResult: showResult,
    updateTimerUi,
  };
}
