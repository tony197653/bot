import {
  STORAGE_KEY,
  commentFor,
  createCountdown,
  normalizeBest,
  potentialPoints,
  prepareRound,
  scoreFor,
  shouldUpdateBest,
  taiwanDate,
  TimerState,
} from './logic.js';

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

function updateTimerUi() {
  const rem = timer.remainingMs;
  const total = (data?.seconds ?? 15) * 1000;
  const pct = timer.state === TimerState.IDLE ? 100 : (rem / total) * 100;
  el.timerBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;

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
    el.timerLabel.textContent = `剩 ${timer.displaySeconds()} 秒`;
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
    el.clipBar.style.width = `${(cur / dur) * 100}%`;
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
      tag.textContent = '✓ 正解';
    } else if (!timedOut && !skipped && title === picked) {
      btn.classList.add('is-wrong');
      tag.hidden = false;
      tag.textContent = '× 你的答案';
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
  el.playHint.classList.add('hidden');

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

  const p = a.play();
  if (p && typeof p.then === 'function') {
    return p.then(() => {
      setPlayingUi(true);
      blockedAutoplay = false;
    }).catch((err) => {
      setPlayingUi(false);
      if (err && err.name === 'NotAllowedError') {
        blockedAutoplay = true;
        el.btnPlay.classList.add('is-blocked');
        el.playHint.classList.remove('hidden');
        return;
      }
      onAudioError();
    });
  }
  setPlayingUi(true);
  return Promise.resolve();
}

function onAudioError() {
  if (!autoRetryUsed && !answered) {
    autoRetryUsed = true;
    const item = currentItem();
    el.audio.src = item.question.audio + `?retry=${Date.now()}`;
    el.audio.load();
    el.audio.play().catch(() => showAudioFail());
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
  el.btnNext.disabled = true;
  el.footerHint.classList.remove('hidden');
  el.footerHint.textContent = '選一個答案吧';
  el.audioError.classList.add('hidden');
  el.btnPlay.classList.remove('is-blocked', 'is-playing');
  el.playHint.classList.add('hidden');
  el.btnReplay.disabled = true;
  el.btnReplay.textContent = '重播';

  const item = currentItem();
  el.quizPlayer.textContent = `玩家：${player}`;
  el.quizScore.textContent = `總分 ${totalScore}`;
  el.quizIndex.textContent = `第 ${qIndex + 1} 題／共 10 題`;
  el.quizProgress.style.width = `${((qIndex) / 10) * 100}%`;
  updateListenHint('play');
  renderOptions(false);
  updateTimerUi();
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
  if (!firstSoundHeard && playPhase === 'first') {
    firstSoundHeard = true;
    timer.start();
    el.btnReplay.disabled = false;
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
  el.quizScore.textContent = `總分 ${totalScore}`;
  el.quizProgress.style.width = `${((qIndex + 1) / 10) * 100}%`;

  let msg;
  if (skipped) {
    msg = `這題跳過了，正確歌名是 ${correctTitle}`;
  } else if (timedOut) {
    msg = `時間到！本題 0 分　正確歌名：${correctTitle}`;
  } else if (correct) {
    msg = `答對了！＋${points} 分`;
  } else {
    msg = `差一點！本題 0 分　正確歌名：${correctTitle}`;
  }
  el.fbText.textContent = msg;
  el.btnMv.href = item.question.youtube;
  el.feedbackCard.classList.remove('hidden');

  el.btnNext.textContent = qIndex >= 9 ? '看結果' : '下一題 →';
  el.btnNext.classList.remove('hidden');
  el.btnNext.disabled = true;
  nextArmedAt = performance.now() + 400;
  setTimeout(() => {
    if (answered) el.btnNext.disabled = false;
  }, 400);
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
    row.innerHTML =
      `<span>${i + 1}</span>` +
      `<span class="song" title="${escapeHtml(a.title)}">${escapeHtml(a.title)}</span>` +
      `<span class="mark ${markClass}" aria-label="${markLabel}">${mark}</span>` +
      `<span class="meta">${listenCell}</span>` +
      `<span class="meta">${a.points}分</span>` +
      `<a href="${a.youtube}" target="_blank" rel="noopener">MV</a>`;
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
}

function showResume() {
  el.resumeMask.classList.remove('hidden');
  el.resumeMask.hidden = false;
}

/* —— 事件 —— */
el.btnPlay.addEventListener('click', () => {
  if (answered && playPhase !== 'feedback') return;
  const a = el.audio;
  if (blockedAutoplay) {
    // 第一次手動播放＝已聽 1
    listens = 1;
    playCurrent({ fromStart: true });
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
    // 從頭播：算重播（回饋除外）
    if (!answered) {
      listens += 1;
      updateListenHint('play');
      if (timer.state === TimerState.RUNNING) timer.pause('replay');
      inReplaySegment = true;
      playPhase = 'replay';
      playCurrent({ fromStart: true, asReplay: true });
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
  hideResume();
  const bgPaused = timer.state === TimerState.PAUSED && timer.pauseReason === 'background';

  // 續播音樂（同一使用者手勢內同步 play，重取 iOS 播放權）
  if (wasPlayingBeforeHide || timer.state === TimerState.IDLE) {
    if (inReplaySegment && !answered) {
      playCurrent({ fromStart: false, asReplay: true });
    } else {
      playCurrent({ fromStart: false });
    }
  }

  // 背景造成的倒數暫停：恢復；若離開前正在重播，倒數維持暫停到重播結束
  if (bgPaused && !inReplaySegment) {
    timer.resume();
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
    if (timer.state === TimerState.PAUSED && timer.pauseReason === 'replay') {
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
    wasPlayingBeforeHide = !el.audio.paused && !el.audio.ended;
    if (!el.audio.paused) el.audio.pause();
    const onQuizAnswering = el.quiz.classList.contains('is-active') && !answered;
    if (onQuizAnswering) {
      if (timer.state === TimerState.RUNNING) {
        timer.pause('background');
      }
      // 載入中／重播暫停回來也要按「繼續」
      showResume();
      updateTimerUi();
    }
    // 回饋／開始／結果：只暫停音樂，不顯示繼續
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

// 測試／截圖輔助（僅供 Playwright／除錯）
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
  /** 模擬第一次發聲（倒數開始） */
  forceFirstSound() {
    if (!firstSoundHeard) {
      playPhase = 'first';
      onFirstSound();
    }
  },
  /** 把剩餘毫秒設成指定值（未開始則先 start） */
  injectRemaining(ms) {
    if (timer.state === TimerState.IDLE) {
      playPhase = 'first';
      onFirstSound();
    }
    timer._injectRemaining(ms);
    updateTimerUi();
  },
  /** 測試用：強制計時中並設剩餘（清掉重播／背景暫停） */
  forceRunning(ms) {
    inReplaySegment = false;
    if (timer.state === TimerState.IDLE) {
      playPhase = 'first';
      onFirstSound();
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
  hideResumeMask: hideResume,
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
