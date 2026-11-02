/**
 * 作答模組（模板介面 startQuiz）。一題一頁、當場對／模考、泡泡、鍵盤。
 * 不可寫死書名／科目／專有名詞；不可直接查詢雲端。
 */
import {
  renderMath,
  escHtml,
  groupPassageHtml,
  setAccordionOpen,
  stemHtml,
  optionsHtml,
  feedbackHtml,
  ICON,
} from './render.js';
import { bindLightbox } from './lightbox.js';

const RM = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** @type {null | ReturnType<typeof createSession>} */
let session = null;

/**
 * @param {{
 *  title: string,
 *  questions: object[],
 *  groups?: object[],
 *  mode?: 'instant'|'exam',
 *  shuffle?: boolean,
 *  mount: HTMLElement,
 *  onFinish: (result: object) => void,
 *  onLeave?: () => void,
 *  onReport?: (payload: {qid:string, reason:string, note:string}) => Promise<void>|void,
 *  progressKey?: string|null,
 *  scope?: object|null,
 *  outMs?: number,
 *  initialAnswers?: number[],
 *  initialIndex?: number,
 *  reportedIds?: string[],
 *  getReportedIds?: () => Promise<string[]>,
 *  clearProgressOnFinish?: boolean,
 *  skipLightboxBind?: boolean,
 * }} opts
 */
export function startQuiz(opts) {
  if (!opts?.mount || !Array.isArray(opts.questions) || !opts.questions.length) {
    throw new Error('startQuiz: questions and mount required');
  }
  if (session) session.destroy();
  session = createSession(opts);
  session.begin();
  return session;
}

export function isQuizActive() {
  return session != null;
}

/**
 * @param {(left: boolean) => void} [cb] true＝已離開；false＝取消
 */
export function requestLeave(cb) {
  if (!session?.askLeave) {
    cb?.(true);
    return;
  }
  session.askLeave(cb);
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** 打亂時題組整組移動 */
function orderQuestions(questions, _groups, shuffle) {
  if (!shuffle) return questions.slice();
  const byGroup = new Map();
  for (const q of questions) {
    if (q.groupId) {
      if (!byGroup.has(q.groupId)) byGroup.set(q.groupId, []);
      byGroup.get(q.groupId).push(q);
    }
  }
  const blocks = [];
  const seenG = new Set();
  for (const q of questions) {
    if (q.groupId) {
      if (seenG.has(q.groupId)) continue;
      seenG.add(q.groupId);
      blocks.push(byGroup.get(q.groupId));
    } else {
      blocks.push([q]);
    }
  }
  shuffleInPlace(blocks);
  return blocks.flat();
}

function createSession(opts) {
  const mode = opts.mode === 'exam' ? 'exam' : 'instant';
  const groupsMap = Object.fromEntries((opts.groups || []).map((g) => [g.groupId, g]));
  const qs = orderQuestions(opts.questions, opts.groups || [], !!opts.shuffle);
  const answers = qs.map(() => -1);
  if (Array.isArray(opts.initialAnswers) && opts.initialAnswers.length === qs.length) {
    opts.initialAnswers.forEach((a, n) => {
      answers[n] = typeof a === 'number' ? a : -1;
    });
  }
  const reported = new Set(opts.reportedIds || []);
  let i =
    typeof opts.initialIndex === 'number'
      ? Math.min(Math.max(0, opts.initialIndex), qs.length - 1)
      : 0;
  let busy = false;
  let confirming = false;
  let startedAt = Date.now();
  let destroyed = false;
  const outMs = opts.outMs ?? 200;
  const mount = opts.mount;
  const clearOnFinish = opts.clearProgressOnFinish === true;

  const root = document.createElement('div');
  root.className = 'quiz-root';
  root.innerHTML = `
    <header class="top quiz-top"><div class="top-in">
      <button type="button" class="btn b5 leave" data-act="leave" aria-label="離開">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span>離開</span>
      </button>
      <p class="title" data-el="title"></p>
      <p class="count" data-el="count"></p>
    </div>
    <div class="prog" data-el="prog" aria-hidden="true"><i></i></div></header>
    <main class="wrap quiz-wrap">
      <nav class="strip bub-strip" data-el="strip" aria-label="題目進度"></nav>
      <div class="stage" data-el="stage"></div>
    </main>
    <footer class="bar" data-el="bar">
      <p class="warn" data-el="warn" role="status"></p>
      <div class="bar-in">
        <button type="button" class="btn b2 prev" data-act="prev"><span>上一題</span></button>
        <button type="button" class="btn b5 skip" data-act="skip" hidden>略過</button>
        <button type="button" class="btn b2 submit" data-act="submit"><span>交卷</span></button>
        <button type="button" class="btn b1 next" data-act="next"><span class="nx-t">下一題</span></button>
      </div>
    </footer>
    <div class="toast" data-el="toast" role="status" aria-live="polite"></div>
    <dialog class="leave-dlg" data-el="leaveDlg">
      <form method="dialog" class="leave-form">
        <h2>離開練習？</h2>
        <p>這回還沒交卷，要離開嗎？進度會留在這台裝置。</p>
        <div class="leave-actions">
          <button type="submit" class="btn b2" value="cancel">取消</button>
          <button type="submit" class="btn b1" value="leave">離開</button>
        </div>
      </form>
    </dialog>
    <dialog class="report-dlg" data-el="reportDlg">
      <form method="dialog" class="report-form">
        <h2>回報題目有誤</h2>
        <label>原因
          <select name="reason">
            <option value="answer">答案錯</option>
            <option value="typo">題目打錯</option>
            <option value="figure">圖有問題</option>
            <option value="other">其他</option>
          </select>
        </label>
        <label>補充說明（選填）
          <input name="note" maxlength="200" placeholder="一句話說明…">
        </label>
        <div class="report-actions">
          <button type="submit" class="btn b1" value="ok">送出</button>
          <button type="submit" class="btn b2" value="cancel">取消</button>
        </div>
      </form>
    </dialog>`;
  mount.innerHTML = '';
  mount.appendChild(root);
  if (!opts.skipLightboxBind) bindLightbox(root);

  const $ = (sel) => root.querySelector(sel);
  const titleEl = $('[data-el="title"]');
  const countEl = $('[data-el="count"]');
  const progEl = $('[data-el="prog"]');
  const stripEl = $('[data-el="strip"]');
  const stageEl = $('[data-el="stage"]');
  const warnEl = $('[data-el="warn"]');
  const toastEl = $('[data-el="toast"]');
  const reportDlg = $('[data-el="reportDlg"]');
  const leaveDlg = $('[data-el="leaveDlg"]');

  titleEl.textContent = opts.title || '';

  /** @type {((left:boolean)=>void)|null} */
  let leaveCb = null;

  function saveProgress() {
    if (!opts.progressKey) return;
    const payload = {
      scope: opts.scope || null,
      mode,
      qids: qs.map((q) => q.id),
      answers,
      idx: i,
      startedAt,
    };
    try {
      localStorage.setItem(opts.progressKey, JSON.stringify(payload));
    } catch {
      /* memory only */
    }
  }

  function clearProgress() {
    if (!opts.progressKey) return;
    try {
      localStorage.removeItem(opts.progressKey);
    } catch {
      /* ignore */
    }
  }

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => toastEl.classList.remove('on'), 2200);
  }

  function strip() {
    const many = qs.length > 12;
    stripEl.classList.toggle('strip-scroll', many);
    stripEl.innerHTML = qs
      .map((q, n) => {
        const a = answers[n];
        let st = '';
        if (mode === 'instant' && a >= 0) st = a === q.answer ? 'ok' : 'bad';
        else if (mode === 'exam' && a >= 0) st = 'done';
        const lab = `第 ${n + 1} 題${st === 'ok' ? '，答對' : st === 'bad' ? '，答錯' : a >= 0 ? '，已作答' : '，未作答'}${n === i ? '，目前這題' : ''}`;
        return `<button type="button" class="bub ${st}${n === i ? ' now' : ''}" data-n="${n}" aria-label="${lab}"${n === i ? ' aria-current="step"' : ''}>
          <span class="bub-d"><span class="bub-n">${n + 1}</span>${
            st === 'ok' || st === 'bad' ? `<span class="bub-m">${ICON[st]}</span>` : ''
          }</span></button>`;
      })
      .join('');
    const done = answers.filter((a) => a >= 0).length;
    progEl?.style.setProperty('--p', String(done / qs.length));
    countEl.innerHTML = `<b>${i + 1}</b><span> / ${qs.length}</span>`;
    const now = stripEl.querySelector('.bub.now');
    if (now && many) {
      now.scrollIntoView({ inline: 'center', block: 'nearest', behavior: RM() ? 'auto' : 'smooth' });
    }
  }

  function bar() {
    const a = answers[i];
    const last = i === qs.length - 1;
    const unanswered = answers.filter((x) => x < 0).length;
    const prev = root.querySelector('[data-act="prev"]');
    const next = root.querySelector('[data-act="next"]');
    const skip = root.querySelector('[data-act="skip"]');
    const submit = root.querySelector('[data-act="submit"]');
    prev.disabled = i === 0;
    const needAnswer = mode === 'instant' && a < 0;
    next.disabled = needAnswer;
    next.querySelector('.nx-t').textContent = last
      ? confirming
        ? '確定交卷'
        : '看結果'
      : '下一題';
    skip.hidden = !(mode === 'instant' && a < 0);
    skip.textContent = last ? '略過，看結果' : '略過';
    submit.querySelector('span').textContent = confirming ? '確定交卷' : '交卷';
    if (confirming && unanswered) {
      warnEl.textContent = `還有 ${unanswered} 題沒寫。確定要交卷嗎？沒寫的題目會算錯。`;
      warnEl.classList.add('on');
    } else {
      warnEl.classList.remove('on');
    }
  }

  function cardHtml(n) {
    const q = qs[n];
    const a = answers[n];
    const revealed = mode === 'instant' && a >= 0;
    const group = q.groupId ? groupsMap[q.groupId] : null;
    return `<article class="qcard${revealed ? ' revealed' : ''}" data-el="card">
      <div class="qmeta"><span class="qno">第 <b>${n + 1}</b> 題</span>
        ${q.unitCode ? `<span class="tag">${escHtml(q.unitCode)}${q.unit ? ' ' + escHtml(q.unit) : ''}</span>` : ''}
        ${q.level ? `<span class="tag">${escHtml(q.level)}</span>` : ''}
      </div>
      ${groupPassageHtml(group, { collapsed: true })}
      ${stemHtml(q)}
      ${optionsHtml(q, a >= 0 ? a : null, { revealed, mode })}
      <div class="fb-slot" data-el="fb" aria-live="polite">${
        revealed ? feedbackHtml(q, a, { onReport: !!opts.onReport, reported: reported.has(q.id) }) : ''
      }</div>
    </article>`;
  }

  function paint(enter, dir = 1) {
    stageEl.innerHTML = cardHtml(i);
    strip();
    bar();
    const card = stageEl.querySelector('[data-el="card"]');
    renderMath(card);
    if (enter && !RM() && card) {
      card.style.setProperty('--dir', String(dir));
      card.classList.add('entering', 'in');
      void card.offsetWidth;
      requestAnimationFrame(() => {
        card.classList.remove('entering');
        setTimeout(() => card.classList.remove('in'), 900);
      });
    }
    saveProgress();
  }

  function go(n, focusStem) {
    if (n < 0 || n >= qs.length || n === i || busy) return;
    confirming = false;
    const dir = n > i ? 1 : -1;
    const done = () => {
      i = n;
      paint(true, dir);
      window.scrollTo({ top: 0, behavior: RM() ? 'auto' : 'smooth' });
      if (focusStem) stageEl.querySelector('.stem')?.focus({ preventScroll: true });
    };
    const card = stageEl.querySelector('[data-el="card"]');
    if (RM() || !card) {
      done();
      return;
    }
    busy = true;
    card.style.setProperty('--dir', String(dir));
    card.classList.add('leaving');
    setTimeout(() => {
      busy = false;
      done();
    }, outMs);
  }

  function pick(k) {
    const q = qs[i];
    if (busy) return;
    if (mode === 'instant' && answers[i] >= 0) return;
    answers[i] = k;
    confirming = false;
    if (mode === 'exam') {
      paint(false);
      return;
    }
    const card = stageEl.querySelector('[data-el="card"]');
    card?.classList.add('revealed', 'fresh');
    const optsEl = stageEl.querySelectorAll('.opt');
    optsEl.forEach((b, j) => {
      let cls = 'opt';
      if (j === k) cls += ' chosen';
      if (j === q.answer) cls += ' ok';
      if (j === k && k !== q.answer) cls += ' bad';
      if (j !== k && j !== q.answer) cls += ' dim';
      b.className = cls;
      b.setAttribute('aria-disabled', 'true');
      b.querySelector('.mk').innerHTML = j === q.answer ? ICON.ok : j === k ? ICON.bad : '';
    });
    const fb = stageEl.querySelector('[data-el="fb"]');
    if (fb) {
      fb.innerHTML = feedbackHtml(q, k, {
        onReport: !!opts.onReport,
        reported: reported.has(q.id),
      });
      renderMath(fb);
    }
    strip();
    bar();
    setTimeout(() => card?.classList.remove('fresh'), 1200);
    saveProgress();
  }

  function buildResult() {
    const total = qs.length;
    const correct = qs.reduce((n, q, idx) => n + (answers[idx] === q.answer ? 1 : 0), 0);
    const score = Math.round((correct / total) * 100);
    const endedAt = Date.now();
    /** @type {Record<string,{unitCode:string,unit:string,subject:string,correct:number,total:number}>} */
    const byUnitMap = {};
    qs.forEach((q, idx) => {
      const code = q.unitCode || 'UNKNOWN';
      if (!byUnitMap[code]) {
        byUnitMap[code] = {
          unitCode: code,
          unit: q.unit || code,
          subject: q.subject || '',
          correct: 0,
          total: 0,
        };
      }
      byUnitMap[code].total++;
      if (answers[idx] === q.answer) byUnitMap[code].correct++;
    });
    return {
      qids: qs.map((q) => q.id),
      answers: answers.slice(),
      correct,
      total,
      score,
      startedAt,
      endedAt,
      byUnit: Object.values(byUnitMap),
      questions: qs,
      groups: opts.groups || [],
      mode,
      title: opts.title || '',
    };
  }

  function finish() {
    if (clearOnFinish) clearProgress();
    const result = buildResult();
    destroy(true);
    opts.onFinish(result);
  }

  function submit() {
    const unanswered = answers.filter((a) => a < 0).length;
    if (unanswered && !confirming) {
      confirming = true;
      bar();
      return;
    }
    finish();
  }

  function next() {
    if (mode === 'instant' && answers[i] < 0) return;
    if (i === qs.length - 1) submit();
    else go(i + 1);
  }

  function skip() {
    if (i === qs.length - 1) submit();
    else go(i + 1);
  }

  function confirmLeave() {
    saveProgress();
    destroy(true);
    opts.onLeave?.();
    leaveCb?.(true);
    leaveCb = null;
  }

  function showLeaveDialog(cb) {
    leaveCb = cb || null;
    if (typeof leaveDlg.showModal === 'function') leaveDlg.showModal();
    else confirmLeave();
  }

  function onLeaveSubmit(e) {
    const val = e.submitter?.value;
    if (val === 'leave') confirmLeave();
    else {
      leaveCb?.(false);
      leaveCb = null;
    }
  }

  async function doReport(reason, note) {
    const q = qs[i];
    if (!opts.onReport || reported.has(q.id)) return;
    const btn = stageEl.querySelector('.report');
    try {
      await opts.onReport({ qid: q.id, reason, note });
      reported.add(q.id);
      toast('已回報，謝謝');
      if (btn) {
        btn.disabled = true;
        btn.textContent = '已回報';
      }
    } catch (err) {
      toast(err?.message || '回報失敗，請稍後再試');
      if (btn) btn.disabled = false;
    }
  }

  function onClick(e) {
    const t = e.target.closest('button, a');
    if (!t || !root.contains(t)) return;
    if (t.matches('.opt') && t.dataset.k != null) {
      pick(+t.dataset.k);
      return;
    }
    if (t.matches('.bub') && t.dataset.n != null) {
      go(+t.dataset.n, true);
      return;
    }
    if (t.matches('.acc-b')) {
      const item = t.closest('.acc-i');
      const open = !item.classList.contains('open');
      setAccordionOpen(item, open);
      const label = t.querySelector('.t');
      if (label && !t.classList.contains('group-toggle')) {
        label.textContent = open ? '收起詳解' : '看詳解';
      }
      return;
    }
    if (t.matches('.report')) {
      if (typeof reportDlg.showModal === 'function') reportDlg.showModal();
      return;
    }
    const act = t.dataset.act;
    if (act === 'prev') go(i - 1);
    else if (act === 'next') next();
    else if (act === 'skip') skip();
    else if (act === 'submit') submit();
    else if (act === 'leave') showLeaveDialog();
  }

  function onKey(e) {
    if (destroyed) return;
    if (e.target.closest('input, textarea, select, dialog') || e.metaKey || e.ctrlKey || e.altKey) {
      return;
    }
    const k = e.key;
    const m =
      '1234'.indexOf(k) > -1
        ? '1234'.indexOf(k)
        : 'abcd'.indexOf(k.toLowerCase());
    if (k.length === 1 && m > -1 && (mode === 'exam' || answers[i] < 0)) {
      e.preventDefault();
      pick(m);
      return;
    }
    if (k === 'Enter' && !e.target.closest('button, a')) {
      if (mode === 'exam' || answers[i] >= 0) {
        e.preventDefault();
        next();
      }
      return;
    }
    if (k === 'ArrowRight') go(i + 1);
    else if (k === 'ArrowLeft') go(i - 1);
  }

  function onReportSubmit(e) {
    const val = e.submitter?.value;
    if (val === 'ok') {
      const fd = new FormData(e.target);
      doReport(String(fd.get('reason') || 'other'), String(fd.get('note') || '').slice(0, 200));
    }
  }

  function onBeforeUnload(e) {
    if (answers.some((a) => a >= 0)) {
      e.preventDefault();
      e.returnValue = '';
    }
  }

  async function begin() {
    if (typeof opts.getReportedIds === 'function') {
      try {
        const ids = await opts.getReportedIds();
        if (Array.isArray(ids)) ids.forEach((id) => reported.add(id));
      } catch {
        /* ignore prefetch errors */
      }
    }
    document.body.dataset.view = 'quiz';
    paint(true, 1);
  }

  function destroy(clearSession = true) {
    if (destroyed) return;
    destroyed = true;
    root.removeEventListener('click', onClick);
    document.removeEventListener('keydown', onKey);
    reportDlg?.removeEventListener('submit', onReportSubmit);
    leaveDlg?.removeEventListener('submit', onLeaveSubmit);
    window.removeEventListener('beforeunload', onBeforeUnload);
    if (clearSession && session === api) session = null;
  }

  root.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);
  reportDlg?.addEventListener('submit', onReportSubmit);
  leaveDlg?.addEventListener('submit', onLeaveSubmit);
  window.addEventListener('beforeunload', onBeforeUnload);

  const api = {
    begin,
    destroy,
    clearProgress,
    getIndex: () => i,
    getAnswers: () => answers.slice(),
    toast,
    askLeave(cb) {
      showLeaveDialog(cb);
    },
  };
  return api;
}

export function getActiveQuiz() {
  return session;
}
