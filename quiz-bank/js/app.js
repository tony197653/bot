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
import { startQuiz, getActiveQuiz } from './quiz.js';
import { showResult } from './result.js';
import {
  saveAttempt,
  flushPending,
  progressKey,
} from './stats.js';
import { bindLightbox } from './lightbox.js';

const PRODUCT = '考題網';
const SUMMARY_PREFIX = '考題網';

/** @type {null|(()=>void)} */
let resultDestroy = null;
/** @type {object|null} */
let lastSession = null;

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
  const main = mount();
  if (!main) return;
  const iab = detectInAppBrowser();
  main.innerHTML = `<div class="page login">
    <h1>${PRODUCT}</h1>
    <p class="lead">參考書題目練習與錯題整理</p>
    ${ev?.error ? `<p class="err" role="alert">${ev.error.message || ev.error}</p>` : ''}
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

async function submitReport(payload) {
  const user = getUser();
  if (!user) return;
  const { initFirebase } = await import('./fb.js');
  const { db, fs } = await initFirebase();
  const id = `${payload.qid}__${user.uid}`;
  await fs.setDoc(fs.doc(db, 'reports', id), {
    qid: payload.qid,
    uid: user.uid,
    reason: payload.reason,
    note: payload.note || '',
    status: 'open',
    at: fs.serverTimestamp(),
  });
}

function beginQuiz(scope) {
  const user = getUser();
  const main = mount();
  if (!main || !user) return;
  resultDestroy?.();
  resultDestroy = null;
  lastSession = scope;
  document.body.dataset.view = 'quiz';
  startQuiz({
    title: scope.title || PRODUCT,
    questions: scope.questions,
    groups: scope.groups || [],
    mode: scope.mode || 'instant',
    shuffle: scope.shuffle !== false,
    mount: main,
    progressKey: progressKey(user.uid),
    onReport: submitReport,
    onLeave: () => navigate('#/'),
    onFinish: (result) => finishQuiz(result, scope),
  });
}

async function finishQuiz(result, scope) {
  const user = getUser();
  const main = mount();
  if (!main || !user) return;
  navigate('#/result');
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
  else wrongBookDelta = save.wrongBookDelta || 0;

  const view = showResult({
    mount: main,
    result: { ...result, title: scope.title || result.title },
    summaryPrefix: `${SUMMARY_PREFIX}・${scope.title || '練習'}`,
    wrongBookDelta,
    cloudStatus,
    onRetryWrong: () => {
      const wrongQs = result.questions.filter((q, n) => result.answers[n] !== q.answer);
      beginQuiz({
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
      beginQuiz({
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
  bindLightbox(main);
}

async function renderRoute(route) {
  const user = getUser();
  const main = mount();
  if (!main) return;
  if (!user) {
    renderLogin({ status: 'signed-out' });
    return;
  }
  getActiveQuiz()?.destroy?.();
  resultDestroy?.();
  resultDestroy = null;

  const ctx = {
    user,
    navigate,
    toast,
    isAdmin: isAdmin(),
    startScope: (scope) => {
      lastSession = scope;
      navigate('#/quiz');
      beginQuiz(scope);
    },
  };

  setNav(route === '/' ? 'home' : route.replace(/^\//, ''), isAdmin());

  if (route === '/' || route === '/home') await renderHome(main, ctx);
  else if (route === '/wrong') await renderWrongBook(main, ctx);
  else if (route === '/units') await renderUnits(main, ctx);
  else if (route === '/import') await renderImport(main, ctx);
  else if (route === '/quiz' && lastSession) beginQuiz(lastSession);
  else if (route === '/result') {
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

async function boot() {
  bindLightbox(document.body);
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
    if (ev.status === 'signed-in' && ev.user) {
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

  window.addEventListener('hashchange', () => renderRoute(parseRoute()));
  await initAuth();
  if (getUser()) await renderRoute(parseRoute());
}

boot();

export { navigate, toast, PRODUCT };
