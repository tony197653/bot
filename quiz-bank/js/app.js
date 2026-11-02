/**
 * 考題網 SPA：hash 路由、登入、導覽、作答與結算。
 */
import {
  initAuth,
  onUser,
  signIn,
  signOut,
  detectInAppBrowser,
  isAdmin,
  getUser,
} from './auth.js';
import { renderHome, renderWrongBook, renderUnits } from './views.js';
import { renderImport } from './import.js';
import { startQuiz, getActiveQuiz, isQuizActive, requestLeave } from './quiz.js';
import { showResult } from './result.js';
import { escHtml } from './render.js';
import {
  saveAttempt,
  flushPending,
  progressKey,
  clearProgress,
  updateQstatManualOut,
} from './stats.js';
import { bindLightboxOnce } from './lightbox.js';
import { formatRoundSummary, taipeiStamp } from './summary.js';

const PRODUCT = '考題網';

/** @type {null|(()=>void)} */
let resultDestroy = null;
/** @type {object|null} */
let lastSession = null;
/** @type {object|null} */
let pendingQuiz = null;
/** @type {object|null} */
let activeQuizScope = null;
let quizStarted = false;
let quizNavigating = false;
let restoringHash = false;

const mount = () => document.getElementById('app-main');
const toastEl = () => document.getElementById('app-toast');

function toast(msg) {
  const el = toastEl();
  if (!el) return;
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('on'), 2200);
}

function navigate(hash) {
  if (hash.startsWith('#')) location.hash = hash;
  else location.hash = `#/${hash}`;
}

function parseRoute() {
  const h = (location.hash || '#/').replace(/^#/, '') || '/';
  const path = h.startsWith('/') ? h : `/${h}`;
  return path.split('?')[0];
}

function scopeKey(scope) {
  if (!scope?.questions?.length) return '';
  return scope.questions.map((q) => q.id).join('|');
}

function sameQuizSession(a, b) {
  if (!a || !b) return false;
  return scopeKey(a) === scopeKey(b) && a.mode === b.mode;
}

function setNav(route, admin) {
  document.querySelectorAll('[data-route]').forEach((a) => {
    const on = a.dataset.route === route || (route === '/' && a.dataset.route === 'home');
    a.classList.toggle('on', on);
    a.setAttribute('aria-current', on ? 'page' : 'false');
  });
  document.querySelectorAll('[data-admin-only]').forEach((el) => {
    el.hidden = !admin;
  });
}

function renderLogin(ev) {
  document.body.classList.add('signed-out');
  document.body.classList.remove('signed-in');
  const main = mount();
  if (!main) return;
  const iab = detectInAppBrowser();
  const errMsg = ev?.error?.message ? escHtml(ev.error.message) : '';
  const errEmail = ev?.error?.email ? escHtml(ev.error.email) : '';
  main.innerHTML = `<div class="page login">
    <h1>${PRODUCT}</h1>
    <p class="lead">參考書題目練習與錯題整理</p>
    ${ev?.error ? `<p class="err" role="alert">${errMsg}${errEmail ? `（${errEmail}）` : ''}</p>` : ''}
    ${
      ev?.status === 'in-app-browser'
        ? `<p class="warn">請用 Safari／Chrome 開啟此網站。</p>
           <button type="button" class="btn b2" id="copy-url">複製網址</button>`
        : `<button type="button" class="btn b1" id="btn-login"${ev?.status === 'loading' ? ' disabled' : ''}>用 Google 登入</button>`
    }
  </div>`;
  main.querySelector('#btn-login')?.addEventListener('click', () => signIn());
  main.querySelector('#copy-url')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      toast('已複製，請貼到 Safari／Chrome');
    } catch {
      toast('無法自動複製，請手動複製網址');
    }
  });
}

async function fetchQuestionsByQids(qids) {
  const { initFirebase } = await import('./fb.js');
  const { db, fs } = await initFirebase();
  const questions = [];
  for (let i = 0; i < qids.length; i += 30) {
    const chunk = qids.slice(i, i + 30);
    const q = fs.query(
      fs.collection(db, 'questions'),
      fs.where('review.status', '==', 'checked'),
      fs.where(fs.documentId(), 'in', chunk),
    );
    const snap = await fs.getDocs(q);
    snap.forEach((d) => questions.push(d.data()));
  }
  const order = Object.fromEntries(qids.map((id, idx) => [id, idx]));
  questions.sort((a, b) => (order[a.id] ?? 0) - (order[b.id] ?? 0));
  const groupIds = [...new Set(questions.map((x) => x.groupId).filter(Boolean))];
  const groups = [];
  for (const gid of groupIds) {
    const gSnap = await fs.getDoc(fs.doc(db, 'groups', gid));
    if (gSnap.exists()) groups.push(gSnap.data());
  }
  return { questions, groups };
}

async function submitReport(payload) {
  const user = getUser();
  if (!user) return;
  const { initFirebase } = await import('./fb.js');
  const { db, fs } = await initFirebase();
  const id = `${payload.qid}__${user.uid}`;
  const ref = fs.doc(db, 'reports', id);
  const existing = await fs.getDoc(ref);
  if (existing.exists()) {
    const st = existing.data()?.status;
    if (st === 'open' || st === 'done') return;
  }
  try {
    await fs.setDoc(ref, {
      qid: payload.qid,
      uid: user.uid,
      reason: payload.reason,
      note: payload.note || '',
      status: 'open',
      at: fs.serverTimestamp(),
    });
  } catch (e) {
    throw new Error(e?.message || '回報失敗，請稍後再試');
  }
}

async function getReportedIdsForUser() {
  const user = getUser();
  if (!user) return [];
  const { initFirebase } = await import('./fb.js');
  const { db, fs } = await initFirebase();
  const q = fs.query(fs.collection(db, 'reports'), fs.where('uid', '==', user.uid));
  const snap = await fs.getDocs(q);
  return snap.docs.map((d) => d.data()?.qid).filter(Boolean);
}

function beginQuiz(scope) {
  const user = getUser();
  const main = mount();
  if (!main || !user || !scope?.questions?.length) return;

  if (quizStarted && isQuizActive() && sameQuizSession(scope, activeQuizScope)) {
    return;
  }

  resultDestroy?.();
  resultDestroy = null;
  getActiveQuiz()?.destroy?.();

  lastSession = scope;
  activeQuizScope = scope;
  quizStarted = true;
  document.body.dataset.view = 'quiz';

  startQuiz({
    title: scope.title || PRODUCT,
    questions: scope.questions,
    groups: scope.groups || [],
    mode: scope.mode || 'instant',
    shuffle: scope.shuffle !== false,
    mount: main,
    scope,
    progressKey: progressKey(user.uid),
    skipLightboxBind: true,
    clearProgressOnFinish: false,
    initialAnswers: scope.initialAnswers,
    initialIndex: scope.initialIndex,
    reportedIds: scope.reportedIds,
    getReportedIds: getReportedIdsForUser,
    onReport: submitReport,
    onLeave: () => {
      quizStarted = false;
      activeQuizScope = null;
      navigate('#/');
    },
    onFinish: (result) => finishQuiz(result, scope),
  });
}

async function finishQuiz(result, scope) {
  const user = getUser();
  const main = mount();
  if (!main || !user) return;

  quizStarted = false;
  activeQuizScope = null;
  pendingQuiz = null;
  quizNavigating = true;
  history.replaceState(null, '', '#/result');
  location.replace('#/result');

  let cloudStatus = 'ok';
  let wrongBookDelta = 0;
  const meta = {
    scope: {
      type: scope.type || 'round',
      bookId: scope.bookId,
      unitCode: scope.unitCode,
      round: scope.round,
    },
    mode: result.mode,
    questions: result.questions,
  };
  const save = await saveAttempt(user.uid, result, meta);
  if (!save.ok) cloudStatus = 'pending';
  else {
    wrongBookDelta = save.wrongBookDelta || 0;
    clearProgress(user.uid);
  }

  const summaryText = formatRoundSummary({
    scope,
    result,
    bookTitle: scope.bookTitle,
    unitName: scope.unitName,
    round: scope.round,
  });

  const view = showResult({
    mount: main,
    result: { ...result, title: scope.title || result.title },
    getSummaryText: () => summaryText,
    wrongBookDelta,
    cloudStatus,
    onReport: submitReport,
    onRetryWrong: () => {
      const wrongQs = result.questions.filter((q, n) => result.answers[n] !== q.answer);
      startScope({
        ...scope,
        type: 'retry',
        mode: 'instant',
        shuffle: true,
        questions: wrongQs.length ? wrongQs : result.questions,
        groups: scope.groups,
        title: wrongQs.length ? '再練錯題' : scope.title,
      });
    },
    onRestart: () =>
      startScope({
        ...scope,
        questions: lastSession?.questions || result.questions,
        groups: lastSession?.groups || [],
      }),
    onHome: () => navigate('#/'),
    onRetryCloud: async () => {
      const r = await flushPending(user.uid);
      toast(r.failed ? '仍無法寫入，請稍後再試' : '已存到雲端');
    },
  });
  resultDestroy = () => view.destroy();
  quizNavigating = false;
}

function startScope(scope) {
  lastSession = scope;
  pendingQuiz = scope;
  activeQuizScope = scope;
  const route = parseRoute();
  if (route === '/quiz' && !quizNavigating) {
    beginQuiz(scope);
    pendingQuiz = null;
  } else {
    navigate('#/quiz');
  }
}

export async function resumeProgress() {
  const user = getUser();
  if (!user) return;
  let prog;
  try {
    prog = JSON.parse(localStorage.getItem(progressKey(user.uid)) || 'null');
  } catch {
    prog = null;
  }
  if (!prog?.qids?.length) {
    toast('沒有可繼續的進度');
    return;
  }
  try {
    const { questions, groups } = await fetchQuestionsByQids(prog.qids);
    if (!questions.length) {
      toast('找不到進度中的題目');
      return;
    }
    const scope = {
      ...(prog.scope || {}),
      mode: prog.mode || 'instant',
      shuffle: false,
      questions,
      groups,
      initialAnswers: prog.answers,
      initialIndex: prog.idx,
      title: prog.scope?.title || '繼續練習',
    };
    startScope(scope);
  } catch {
    toast('無法載入進度，請稍後再試');
  }
}

/** @type {HTMLDialogElement|null} */
let wrongDetailDlg = null;

async function openWrongDetail(qid) {
  const user = getUser();
  if (!user || !qid) return;
  try {
    const { initFirebase } = await import('./fb.js');
    const { db, fs } = await initFirebase();
    const qSnap = await fs.getDoc(fs.doc(db, 'questions', qid));
    if (!qSnap.exists()) {
      toast('找不到這題');
      return;
    }
    const q = qSnap.data();
    const statSnap = await fs.getDoc(fs.doc(db, 'users', user.uid, 'qstats', qid));
    const stat = statSnap.exists() ? statSnap.data() : null;
    const L = 'ABCD';
    const lastA = stat?.lastAnswer;
    const lastLabel =
      typeof lastA === 'number' && lastA >= 0
        ? `(${L[lastA]}) ${escHtml(q.options[lastA])}`
        : '（未記錄）';

    if (!wrongDetailDlg) {
      wrongDetailDlg = document.createElement('dialog');
      wrongDetailDlg.className = 'wrong-detail-dlg';
      document.body.appendChild(wrongDetailDlg);
    }
    wrongDetailDlg.innerHTML = `
      <form method="dialog">
        <h2>錯題詳情</h2>
        <p class="meta">${escHtml(q.unitCode || '')} ${escHtml(q.unit || '')}</p>
        <div class="wd-stem">${escHtml(q.stem).replace(/\n/g, '<br>')}</div>
        <p><strong>上次作答：</strong>${lastLabel}</p>
        <p><strong>正確答案：</strong>(${L[q.answer]}) ${escHtml(q.options[q.answer])}</p>
        <div class="wd-ex">${escHtml(q.explain || '').replace(/\n/g, '<br>')}</div>
        <div class="leave-actions">
          <button type="button" class="btn b5" data-wd-remove>移出錯題本</button>
          <button type="submit" class="btn b2" value="close">關閉</button>
        </div>
      </form>`;
    wrongDetailDlg.querySelector('[data-wd-remove]')?.addEventListener('click', async () => {
      const ok = window.confirm('移出後不會再出現，除非又答錯。確定移出？');
      if (!ok) return;
      try {
        await updateQstatManualOut(user.uid, qid);
        toast('已移出錯題本');
        wrongDetailDlg?.close();
        const route = parseRoute();
        if (route === '/wrong') await renderRoute(route);
      } catch {
        toast('無法移出，請稍後再試');
      }
    });
    if (typeof wrongDetailDlg.showModal === 'function') wrongDetailDlg.showModal();
  } catch {
    toast('載入失敗');
  }
}

async function renderRoute(route) {
  const user = getUser();
  const main = mount();
  if (!main) return;
  if (!user) {
    renderLogin({ status: 'signed-out' });
    return;
  }

  if (route === '/quiz' && quizStarted && isQuizActive()) {
    return;
  }

  if (route !== '/quiz') {
    getActiveQuiz()?.destroy?.();
    quizStarted = false;
    activeQuizScope = null;
  }

  if (route !== '/quiz' && route !== '/result') {
    resultDestroy?.();
    resultDestroy = null;
  }

  const ctx = {
    user,
    navigate,
    toast,
    isAdmin: isAdmin(),
    startScope,
    resumeProgress,
    openWrongDetail,
  };

  setNav(route === '/' ? 'home' : route.replace(/^\//, ''), isAdmin());

  if (route === '/' || route === '/home') await renderHome(main, ctx);
  else if (route === '/wrong') await renderWrongBook(main, ctx);
  else if (route === '/units') await renderUnits(main, ctx);
  else if (route === '/import') await renderImport(main, ctx);
  else if (route === '/quiz') {
    if (pendingQuiz) {
      beginQuiz(pendingQuiz);
      pendingQuiz = null;
    } else if (!quizStarted) {
      const raw = localStorage.getItem(progressKey(user.uid));
      if (raw) await resumeProgress();
      else navigate('#/');
    }
  } else if (route === '/result') {
    if (resultDestroy) return;
    main.innerHTML = `<p class="e1">請從首頁開始練習。</p><button type="button" class="btn b1" data-home>回首頁</button>`;
    main.querySelector('[data-home]')?.addEventListener('click', () => navigate('#/'));
  } else {
    main.innerHTML = `<p class="e2">找不到頁面</p>`;
  }
}

function toggleDrawer(open) {
  document.body.classList.toggle('drawer-open', open);
  document.getElementById('app-drawer')?.setAttribute('aria-hidden', open ? 'false' : 'true');
}

function onHashChange() {
  if (restoringHash) {
    restoringHash = false;
    return;
  }
  const route = parseRoute();
  if (isQuizActive() && quizStarted && route !== '/quiz') {
    restoringHash = true;
    history.pushState(null, '', '#/quiz');
    requestLeave((left) => {
      restoringHash = false;
      if (left) {
        quizStarted = false;
        activeQuizScope = null;
        renderRoute(route);
      }
    });
    return;
  }
  renderRoute(route);
}

async function boot() {
  bindLightboxOnce(document);
  document.getElementById('btn-signout')?.addEventListener('click', () => signOut());
  document.querySelector('[data-drawer-toggle]')?.addEventListener('click', () => {
    toggleDrawer(!document.body.classList.contains('drawer-open'));
  });
  document.getElementById('app-drawer')?.addEventListener('click', (e) => {
    if (e.target.matches('.drawer-backdrop')) toggleDrawer(false);
  });
  document.querySelectorAll('[data-route]').forEach((a) => {
    a.addEventListener('click', () => toggleDrawer(false));
  });

  onUser(async (ev) => {
    const signedIn = ev.status === 'signed-in' && ev.user;
    document.body.classList.toggle('signed-out', !signedIn);
    document.body.classList.toggle('signed-in', !!signedIn);

    if (signedIn) {
      await flushPending(ev.user.uid);
      const avatar = document.getElementById('nav-avatar');
      if (avatar) {
        avatar.textContent = ev.user.name?.[0] || ev.user.email?.[0] || '?';
        avatar.title = ev.user.displayName || ev.user.email;
      }
      await renderRoute(parseRoute());
    } else if (ev.status === 'in-app-browser' || ev.status === 'denied' || ev.status === 'signed-out') {
      renderLogin(ev);
    } else if (ev.status === 'loading') {
      renderLogin(ev);
    }
  });

  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('popstate', onHashChange);
  await initAuth();
  if (getUser()) await renderRoute(parseRoute());
}

boot();

export { navigate, toast, PRODUCT, startScope, openWrongDetail, formatRoundSummary, taipeiStamp };
