/**
 * 考題網 SPA：hash 路由、登入、導覽、作答與結算（v1.4.1）。
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
import { renderHome } from './views.js';
import { renderImport } from './import.js';
import { startQuiz, getActiveQuiz, isQuizActive, requestLeave } from './quiz.js';
import { showResult } from './result.js';
import { escHtml } from './render.js';
import {
  saveAttemptWithTimeout,
  flushPending,
  enqueueAttempt,
  listPending,
  progressKey,
  clearProgress,
  saveLastResult,
  loadLastResult,
  clearLastResult,
} from './stats.js';
import { bindLightboxOnce } from './lightbox.js';
import { formatRoundSummary, taipeiStamp } from './summary.js';
import { ERR, zhFromError, errCode } from './errors.js';

const PRODUCT = '考題網';
/** 作答／匯入中登入過期：不踢出畫面 */
let sessionExpired = false;

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
/** finishQuiz 換頁／上傳進行中：/result 路由不可 flush 空佇列誤判成功 */
let finishInFlight = false;

const mount = () => document.getElementById('app-main');
const toastEl = () => document.getElementById('app-toast');

/**
 * @param {string} msg
 * @param {{ onRetry?: () => void, retryLabel?: string, ms?: number }} [opts]
 */
function toast(msg, opts) {
  const el = toastEl();
  if (!el) return;
  el.replaceChildren();
  const text = document.createElement('span');
  text.className = 'toast-msg';
  text.textContent = msg;
  el.appendChild(text);
  const hasRetry = typeof opts?.onRetry === 'function';
  if (hasRetry) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn b2 toast-act';
    btn.textContent = opts.retryLabel || '重試';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('on');
      opts.onRetry();
    });
    el.appendChild(btn);
    el.classList.add('has-act');
  } else {
    el.classList.remove('has-act');
  }
  el.classList.add('on');
  clearTimeout(el._t);
  const ms = opts?.ms ?? (hasRetry ? 5000 : 2200);
  el._t = setTimeout(() => el.classList.remove('on'), ms);
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

/** v1.4：舊網址一律 replace 回首頁 */
function isLegacyRoute(route) {
  return (
    route === '/mine' ||
    route === '/wrong' ||
    route === '/fav' ||
    route === '/favorites' ||
    route === '/units' ||
    route === '/units/'
  );
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
  // 學生桌機導覽只剩「首頁」時整排不顯示（§3 A）
  const deskNav = document.querySelector('[data-desk-nav]');
  if (deskNav) {
    deskNav.hidden = !admin;
    deskNav.setAttribute('aria-hidden', admin ? 'false' : 'true');
  }
  document.body.classList.toggle('is-admin', !!admin);
  document.body.classList.toggle('is-student', !admin);
}

function renderLogin(ev) {
  document.body.classList.add('signed-out');
  document.body.classList.remove('signed-in');
  const main = mount();
  if (!main) return;
  const iab = detectInAppBrowser();
  const errMsg = ev?.error?.message ? escHtml(ev.error.message) : '';
  const denied = ev?.status === 'denied';
  main.innerHTML = `<div class="page login">
    <h1>${PRODUCT}</h1>
    <p class="lead">參考書轉數位考題・只有家人能用</p>
    ${ev?.error ? `<p class="err" role="alert">${errMsg}</p>` : ''}
    ${
      ev?.status === 'in-app-browser'
        ? `<p class="warn on iab-warn" role="status">請用 Safari／Chrome 開啟此網站。</p>
           <button type="button" class="btn b2" id="copy-url">複製網址</button>`
        : `<button type="button" class="btn b1" id="btn-login"${ev?.status === 'loading' ? ' disabled' : ''}>${
            denied ? '換一個帳號登入' : '用 Google 登入'
          }</button>`
    }
  </div>`;
  main.querySelector('#btn-login')?.addEventListener('click', () => signIn());
  main.querySelector('#copy-url')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      toast('已複製，請貼到 Safari／Chrome');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = location.href;
      document.body.appendChild(ta);
      ta.select();
      toast(ERR.clipboard);
      ta.remove();
    }
  });
}

function dismissToast() {
  const el = toastEl();
  if (!el) return;
  el.classList.remove('on');
  clearTimeout(el._t);
}

function showSessionExpiredBanner() {
  sessionExpired = true;
  // 同時只留這一則：收掉 toast，避免蓋住「重新登入」
  dismissToast();
  let bar = document.getElementById('session-expired-banner');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'session-expired-banner';
    bar.className = 'session-expired-banner';
    bar.setAttribute('role', 'alert');
    document.body.appendChild(bar);
  }
  bar.innerHTML = `<p>${escHtml(ERR.sessionExpiredResult)}</p>
    <button type="button" class="btn b1" id="btn-relogin">重新登入</button>`;
  bar.querySelector('#btn-relogin')?.addEventListener('click', () => signIn());
}

function clearSessionExpiredBanner() {
  sessionExpired = false;
  document.getElementById('session-expired-banner')?.remove();
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
  try {
    const { initFirebase } = await import('./fb.js');
    const { db, fs } = await initFirebase();
    const id = `${payload.qid}__${user.uid}`;
    const ref = fs.doc(db, 'reports', id);
    const existing = await fs.getDoc(ref);
    if (existing.exists()) {
      const st = existing.data()?.status;
      if (st === 'open' || st === 'done') return;
    }
    await fs.setDoc(ref, {
      qid: payload.qid,
      uid: user.uid,
      reason: payload.reason,
      note: payload.note || '',
      status: 'open',
      at: fs.serverTimestamp(),
    });
  } catch {
    throw new Error('回報失敗，請稍後再試');
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

function paintResultView({ result, scope, summaryText, cloudStatus }) {
  const user = getUser();
  const main = mount();
  if (!main || !user) return;
  document.body.dataset.view = 'result';
  lastSession = scope;
  const view = showResult({
    mount: main,
    result: { ...result, title: scope?.title || result.title },
    getSummaryText: () => summaryText,
    cloudStatus,
    onReport: submitReport,
    onRetryWrong: () => {
      const wrongQs = result.questions.filter((q, n) => result.answers[n] !== q.answer);
      clearLastResult(user.uid);
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
    onRestart: () => {
      clearLastResult(user.uid);
      startScope({
        ...scope,
        questions: lastSession?.questions || result.questions,
        groups: lastSession?.groups || [],
      });
    },
    onHome: () => {
      clearLastResult(user.uid);
      navigate('#/');
    },
    onRetryCloud: async () => {
      const retryAgain = () => {
        const btn = main?.querySelector('[data-act="retry-cloud"]');
        btn?.click();
      };
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        toast(ERR.network, { onRetry: retryAgain });
        return;
      }
      const r = await flushPending(user.uid);
      if (r.flushed > 0 && r.failed === 0) {
        applyCloudOk(user.uid);
        toast('已存到雲端');
      } else if (r.failed > 0) {
        const last = r.errors?.[0];
        const code = errCode(last);
        if (code === 'permission-denied' || /permission-denied/i.test(String(last?.message || ''))) {
          showSessionExpiredBanner();
        } else {
          toast(zhFromError(last, 'network'), { onRetry: retryAgain });
        }
      } else if (!listPending(user.uid).length) {
        applyCloudOk(user.uid);
        toast('已存到雲端');
      } else {
        toast(ERR.network, { onRetry: retryAgain });
      }
    },
    onRelogin: () => signIn(),
  });
  resultDestroy = () => view.destroy();
}

function applyCloudOk(uid) {
  const snap = loadLastResult(uid);
  if (snap) {
    snap.cloudStatus = 'ok';
    saveLastResult(uid, snap);
  }
  const main = mount();
  main?.querySelector('.cloud-warn')?.remove();
  clearProgress(uid);
}

async function finishQuiz(result, scope) {
  const user = getUser();
  const main = mount();
  if (!main || !user) return;

  quizStarted = false;
  activeQuizScope = null;
  pendingQuiz = null;

  const summaryText = formatRoundSummary({
    scope,
    result,
    bookTitle: scope.bookTitle,
    unitName: scope.unitName,
    round: scope.round,
  });
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

  const payload = enqueueAttempt(user.uid, result, meta);
  saveLastResult(user.uid, {
    result: { ...result, title: scope.title || result.title },
    scope,
    summaryText,
    cloudStatus: 'pending',
    attemptId: payload.attemptId,
    savedAt: payload.savedAt,
  });

  finishInFlight = true;
  quizNavigating = true;
  history.replaceState(null, '', '#/result');
  location.replace('#/result');
  paintResultView({
    result,
    scope,
    summaryText,
    cloudStatus: 'pending',
  });
  quizNavigating = false;

  try {
    await saveAttemptWithTimeout(
      user.uid,
      result,
      meta,
      8000,
      { onSuccess: () => applyCloudOk(user.uid) },
      payload,
    );
  } finally {
    finishInFlight = false;
  }
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

async function renderRoute(route) {
  const user = getUser();
  const main = mount();
  if (!main) return;
  if (!user) {
    renderLogin({ status: 'signed-out' });
    return;
  }

  if (isLegacyRoute(route)) {
    location.replace('#/');
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
  };

  setNav(route === '/' ? 'home' : route.replace(/^\//, ''), isAdmin());

  if (route === '/' || route === '/home') await renderHome(main, ctx);
  else if (route === '/import') await renderImport(main, ctx);
  else if (route === '/quiz') {
    if (pendingQuiz) {
      beginQuiz(pendingQuiz);
      pendingQuiz = null;
    } else if (!quizStarted) {
      const raw = localStorage.getItem(progressKey(user.uid));
      if (raw) await resumeProgress();
      else {
        main.innerHTML = `<div class="page"><p class="e1">${ERR.quizNone}</p>
          <div class="empty-next"><a class="btn b1" href="#/">回首頁</a></div></div>`;
      }
    }
  } else if (route === '/result') {
    if (resultDestroy) return;
    const snap = loadLastResult(user.uid);
    if (snap?.result?.questions?.length) {
      const status = snap.cloudStatus || 'ok';
      paintResultView({
        result: snap.result,
        scope: snap.scope || lastSession || {},
        summaryText: snap.summaryText || '',
        cloudStatus: status,
      });
      if (status === 'pending' && !finishInFlight) {
        flushPending(user.uid).then((r) => {
          if (r.flushed > 0 && r.failed === 0) {
            applyCloudOk(user.uid);
          }
        });
      }
      return;
    }
    document.body.dataset.view = '';
    main.innerHTML = `<div class="page"><p class="e1">${ERR.resultGone}</p>
      <div class="empty-next">
        <a class="btn b1" href="#/">回首頁</a>
      </div></div>`;
  } else {
    main.innerHTML = `<div class="page"><p class="e1">${ERR.notFoundPage}</p>
      <div class="empty-next"><a class="btn b1" href="#/">回首頁</a></div></div>`;
  }
}

function drawerItems() {
  const drawer = document.getElementById('app-drawer');
  if (!drawer) return [];
  return [...drawer.querySelectorAll('a[href],button:not([disabled])')].filter(
    (el) => getComputedStyle(el).display !== 'none',
  );
}

function toggleDrawer(open) {
  document.body.classList.toggle('drawer-open', open);
  const drawer = document.getElementById('app-drawer');
  const backdrop = document.querySelector('.drawer-backdrop');
  const btn = document.querySelector('[data-drawer-toggle]');
  const main = document.getElementById('app-main');
  drawer?.setAttribute('aria-hidden', open ? 'false' : 'true');
  if (drawer) {
    if (open) drawer.removeAttribute('inert');
    else drawer.setAttribute('inert', '');
  }
  if (backdrop) {
    backdrop.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (open) backdrop.removeAttribute('inert');
    else backdrop.setAttribute('inert', '');
  }
  // 打開時主內容 inert；頂部列保留 M6 可關。Tab 由 keydown 鎖在抽屜內。
  if (main) {
    if (open) main.setAttribute('inert', '');
    else main.removeAttribute('inert');
  }
  if (btn) {
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.setAttribute('aria-label', open ? '關閉選單' : '開啟選單');
  }
}

/** M6：方向鍵／Home／End／Esc；Tab 鎖在抽屜內，Esc 關閉後回觸發鈕 */
function bindM6Drawer() {
  const btn = document.querySelector('[data-drawer-toggle]');
  const drawer = document.getElementById('app-drawer');
  if (!btn || !drawer) return;

  const isOpen = () => document.body.classList.contains('drawer-open');
  const show = (focusIdx = 0) => {
    toggleDrawer(true);
    const items = drawerItems();
    if (!items.length) return;
    const i = focusIdx < 0 ? items.length - 1 : Math.min(focusIdx, items.length - 1);
    items[i].focus({ preventScroll: true });
  };
  const hide = (restore) => {
    if (!isOpen()) return;
    toggleDrawer(false);
    if (restore) btn.focus({ preventScroll: true });
  };

  btn.addEventListener('click', () => {
    if (isOpen()) hide(true);
    else show(0);
  });
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      show(0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      show(-1);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (!isOpen()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      hide(true);
      return;
    }
    const items = drawerItems();
    if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    let j = null;
    if (e.key === 'ArrowDown') j = i < 0 ? 0 : (i + 1) % items.length;
    else if (e.key === 'ArrowUp') j = i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = items.length - 1;
    else if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) j = i <= 0 ? items.length - 1 : i - 1;
      else j = i < 0 || i >= items.length - 1 ? 0 : i + 1;
    }
    if (j !== null) {
      e.preventDefault();
      items[j].focus({ preventScroll: true });
    }
  });
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

function isDesktopNav() {
  return typeof matchMedia === 'function' && matchMedia('(min-width:900px)').matches;
}

function setUserMenuOpen(open) {
  const btn = document.getElementById('nav-avatar');
  const menu = document.getElementById('nav-user-menu');
  if (!btn || !menu) return;
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) menu.removeAttribute('hidden');
  else menu.setAttribute('hidden', '');
}

function paintNavUser(user) {
  const avatar = document.getElementById('nav-avatar');
  if (!avatar || !user) return;
  const name = user.name || user.displayName || user.email || '帳號';
  const letter = (user.name || user.displayName || user.email || '?').trim().charAt(0) || '?';
  const letterEl = avatar.querySelector('.nav-avatar-letter');
  const nameEl = avatar.querySelector('.nav-avatar-name');
  if (letterEl) letterEl.textContent = letter;
  if (nameEl) nameEl.textContent = name;
  avatar.title = name;
  avatar.setAttribute('aria-label', `${name} 帳號選單`);
}

async function boot() {
  bindLightboxOnce(document);
  toggleDrawer(false);
  setUserMenuOpen(false);
  bindM6Drawer();
  const doSignOut = () => {
    setUserMenuOpen(false);
    toggleDrawer(false);
    signOut();
  };
  document.getElementById('btn-signout')?.addEventListener('click', doSignOut);
  document.getElementById('btn-signout-menu')?.addEventListener('click', doSignOut);
  document.getElementById('nav-avatar')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isDesktopNav()) {
      const open = document.getElementById('nav-avatar')?.getAttribute('aria-expanded') === 'true';
      setUserMenuOpen(!open);
      toggleDrawer(false);
    } else {
      setUserMenuOpen(false);
      const open = document.body.classList.contains('drawer-open');
      toggleDrawer(!open);
    }
  });
  document.addEventListener('click', (e) => {
    const root = document.querySelector('.nav-user');
    if (root && !root.contains(e.target)) setUserMenuOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setUserMenuOpen(false);
  });
  document.querySelector('.drawer-backdrop')?.addEventListener('click', () => toggleDrawer(false));
  document.getElementById('app-drawer')?.addEventListener('click', (e) => {
    if (e.target.matches('a,[data-route]')) toggleDrawer(false);
  });
  document.querySelectorAll('[data-route]').forEach((a) => {
    a.addEventListener('click', () => {
      toggleDrawer(false);
      setUserMenuOpen(false);
    });
  });

  onUser(async (ev) => {
    const signedIn = ev.status === 'signed-in' && ev.user;
    document.body.classList.toggle('signed-out', !signedIn);
    document.body.classList.toggle('signed-in', !!signedIn);

    if (signedIn) {
      clearSessionExpiredBanner();
      await flushPending(ev.user.uid);
      paintNavUser(ev.user);
      setNav(parseRoute() === '/' ? 'home' : parseRoute().replace(/^\//, ''), isAdmin());
      await renderRoute(parseRoute());
    } else if (
      ev.status === 'signed-out' &&
      (quizStarted || parseRoute() === '/import' || parseRoute() === '/quiz' || parseRoute() === '/result')
    ) {
      showSessionExpiredBanner();
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

export { navigate, toast, PRODUCT, startScope, formatRoundSummary, taipeiStamp };
