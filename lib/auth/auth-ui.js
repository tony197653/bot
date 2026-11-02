/**
 * Optional auth UI widgets — styles via CSS variables only (§8).
 * Expected vars: --auth-bg, --auth-ink, --auth-accent, --auth-btn, --auth-btn-ink, --auth-mute, --auth-warn
 */

import { signIn, detectInAppBrowser } from './auth.js';

/**
 * @param {HTMLElement} root
 * @param {{ status: string, user: any, error: any }} state
 * @param {{ onRetry?: () => void, brand?: string }} [opts]
 */
export function renderAuthUi(root, state, opts = {}) {
  if (!root) return;
  const brand = opts.brand || '';
  const { status, user, error } = state;

  if (status === 'in-app-browser') {
    const info = detectInAppBrowser();
    root.innerHTML = `
      <div class="auth-card auth-iab" role="dialog" aria-labelledby="authIabTitle">
        <h2 id="authIabTitle">請用瀏覽器開啟</h2>
        <p class="auth-msg">Google 登入無法在 App 內建瀏覽器使用。請改用 Safari 或 Chrome。</p>
        <button type="button" class="auth-btn auth-b1" data-act="open-browser">用瀏覽器開啟</button>
        <button type="button" class="auth-btn auth-b2" data-act="copy-url">複製網址</button>
        <p class="auth-hint" data-hint hidden></p>
      </div>`;
    wireIab(root, info);
    return;
  }

  if (status === 'loading') {
    root.innerHTML = `
      <div class="auth-card auth-loading">
        ${brand ? `<div class="auth-brand">${esc(brand)}</div>` : ''}
        <div class="auth-spin" aria-hidden="true"></div>
        <p>正在登入 Google…</p>
        <button type="button" class="auth-link hidden" data-act="retry">再按一次</button>
      </div>`;
    const btn = root.querySelector('[data-act="retry"]');
    setTimeout(() => btn?.classList.remove('hidden'), 15000);
    btn?.addEventListener('click', () => (opts.onRetry || signIn)());
    return;
  }

  if (status === 'error') {
    const isiOS =
      typeof navigator !== 'undefined' && /iPhone|iPad|iPod/i.test(navigator.userAgent);
    const standalone =
      (typeof navigator !== 'undefined' &&
        /** @type {any} */ (navigator).standalone) ||
      (typeof matchMedia === 'function' &&
        matchMedia('(display-mode: standalone)').matches);
    root.innerHTML = `
      <div class="auth-card auth-error" role="alertdialog">
        <h2>登入沒有完成</h2>
        <p class="auth-msg">${esc(error?.message || '請再試一次')}</p>
        <button type="button" class="auth-btn auth-b1" data-act="retry">重試</button>
        ${
          isiOS && standalone
            ? `<button type="button" class="auth-link" data-act="safari">用 Safari 開啟</button>
               <p class="auth-hint">提醒：Safari 和主畫面版的登入狀態不共用，兩邊要各登入一次。</p>`
            : ''
        }
      </div>`;
    root.querySelector('[data-act="retry"]')?.addEventListener('click', () =>
      (opts.onRetry || signIn)(),
    );
    root.querySelector('[data-act="safari"]')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(location.href);
      } catch {
        /* ignore */
      }
      const h = root.querySelector('.auth-hint');
      if (h) h.textContent = '網址已複製。請用 Safari 開啟後再登入一次。';
    });
    return;
  }

  if (status === 'signed-in' && user) {
    root.innerHTML = `
      <div class="auth-card auth-ok">
        <img class="auth-av" src="${esc(user.photoURL || '')}" alt="" width="48" height="48"
          onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'auth-av-fallback',textContent:'${esc((user.displayName||'?')[0])}' }))">
        <p>${esc(user.displayName)}</p>
      </div>`;
    return;
  }

  // signed-out / offline default
  root.innerHTML = `
    <div class="auth-card auth-out">
      ${brand ? `<h1 class="auth-brand">${esc(brand)}</h1>` : ''}
      ${status === 'offline' ? `<p class="auth-warn">離線資料</p>` : ''}
      <button type="button" class="auth-btn auth-b1" data-act="signin">用 Google 帳號登入</button>
    </div>`;
  root.querySelector('[data-act="signin"]')?.addEventListener('click', () =>
    (opts.onRetry || signIn)(),
  );
}

function wireIab(root, info) {
  root.querySelector('[data-act="open-browser"]')?.addEventListener('click', () => {
    const href = info?.reopenUrl || location.href;
    const isAndroid = /Android/i.test(navigator.userAgent || '');
    if (isAndroid) {
      const intent = `intent://${href.replace(/^https?:\/\//, '')}#Intent;scheme=https;package=com.android.chrome;end`;
      location.href = intent;
      return;
    }
    navigator.clipboard?.writeText(href).catch(() => {});
    const h = root.querySelector('[data-hint]');
    if (h) {
      h.hidden = false;
      h.textContent = '網址已複製。請點右上角 ⋯ → 在瀏覽器開啟';
    }
  });
  root.querySelector('[data-act="copy-url"]')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
    } catch {
      /* ignore */
    }
    const h = root.querySelector('[data-hint]');
    if (h) {
      h.hidden = false;
      h.textContent = '已複製';
    }
  });
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Minimal CSS the host can inject or duplicate. */
export const AUTH_UI_CSS = `
.auth-card{max-width:420px;margin:0 auto;padding:28px 20px;text-align:center;color:var(--auth-ink,var(--ink,#f3ead2));background:var(--auth-bg,transparent)}
.auth-brand{font-family:var(--tf,serif);font-size:28px;font-weight:700;margin-bottom:20px}
.auth-btn{display:block;width:100%;min-height:48px;margin:10px 0;border-radius:12px;font-weight:700}
.auth-b1{background:var(--auth-btn,#1a1a1a);color:var(--auth-btn-ink,#fff)}
.auth-b2{background:transparent;border:1.5px solid var(--auth-ink,#f3ead2);color:var(--auth-ink,#f3ead2)}
.auth-link{margin-top:14px;color:var(--auth-mute,#c9bf9f);text-decoration:underline;font-size:14px}
.auth-msg,.auth-hint{font-size:14px;color:var(--auth-mute,#c9bf9f);margin:12px 0;line-height:1.5}
.auth-warn{color:var(--auth-warn,#ff4d3a);font-size:13px}
.auth-spin{width:36px;height:36px;margin:20px auto;border:3px solid #fff3;border-top-color:var(--auth-accent,#e6bf5a);border-radius:50%;animation:authSpin 0.8s linear infinite}
@keyframes authSpin{to{transform:rotate(360deg)}}
.auth-av{border-radius:50%;object-fit:cover}
.auth-av-fallback{display:inline-flex;width:48px;height:48px;border-radius:50%;align-items:center;justify-content:center;background:#33463a;font-weight:700}
.hidden{display:none!important}
`;
