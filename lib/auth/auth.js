/**
 * Reusable Google sign-in module — poker-unaware (§8).
 * Persistence: browserLocalPersistence. Offline: localStorage cache.
 */

import { loadFirebase } from '../firebase/load.js';

/** @typedef {{ uid: string, displayName: string, photoURL: string|null }} AuthUser */
/** @typedef {'signed-out'|'loading'|'signed-in'|'error'|'offline'|'in-app-browser'} AuthStatus */
/** @typedef {{ status: AuthStatus, user: AuthUser|null, error: {code:string,message:string}|null, fromCache?: boolean }} AuthEvent */

/** @type {null | { app:any, auth:any, db:any, fs:any, authApi:any }} */
let fb = null;
/** @type {AuthUser|null} */
let currentUser = null;
/** @type {AuthStatus} */
let currentStatus = 'loading';
/** @type {Set<(e: AuthEvent) => void>} */
const listeners = new Set();
/** @type {(() => void)|null} */
let unsubAuth = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let touchTimer = null;

/** @type {{
 *  firebaseConfig: object,
 *  usersCollection: string,
 *  storageKey: string,
 *  touchIntervalMs: number,
 *  timeoutMs: number,
 *  mode: 'popup'|'redirect'|'auto',
 *  sameDomainAuth: boolean,
 * }} */
let cfg = {
  firebaseConfig: {},
  usersCollection: 'users',
  storageKey: 'auth.v1',
  touchIntervalMs: 6 * 3600e3,
  timeoutMs: 8000,
  mode: 'auto',
  sameDomainAuth: true,
};

const ZH = {
  'auth/popup-blocked': '登入視窗被擋住了，請允許彈出視窗後再試一次',
  'auth/popup-closed-by-user': '',
  'auth/network-request-failed': '網路不穩，請稍後再試',
  'auth/cancelled-popup-request': '登入已取消',
  default: '登入沒有完成，請再試一次',
};

function emit(partial) {
  const ev = {
    status: currentStatus,
    user: currentUser,
    error: null,
    ...partial,
  };
  currentStatus = ev.status;
  if ('user' in partial) currentUser = partial.user ?? null;
  for (const fn of listeners) {
    try {
      fn(ev);
    } catch {
      /* ignore listener errors */
    }
  }
}

function cacheKey() {
  return `${cfg.storageKey}.user`;
}

function readCache() {
  try {
    const raw = localStorage.getItem(cacheKey());
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o?.uid || typeof o.displayName !== 'string') return null;
    return {
      uid: o.uid,
      displayName: o.displayName,
      photoURL: o.photoURL ?? null,
    };
  } catch {
    return null;
  }
}

function writeCache(user) {
  try {
    localStorage.setItem(
      cacheKey(),
      JSON.stringify({ ...user, at: Date.now() }),
    );
  } catch {
    /* ignore */
  }
}

function clearCache() {
  try {
    localStorage.removeItem(cacheKey());
  } catch {
    /* ignore */
  }
}

/**
 * Detect LINE / Facebook / Instagram / Android WebView in-app browsers.
 * @returns {null | { app: string, reopenUrl: string }}
 */
export function detectInAppBrowser() {
  if (typeof navigator === 'undefined') return null;
  const ua = navigator.userAgent || '';
  const url = typeof location !== 'undefined' ? location.href : '';
  let app = null;
  if (/Line\//i.test(ua)) app = 'line';
  else if (/FBAN|FBAV|FB_IAB/i.test(ua)) app = 'facebook';
  else if (/Instagram/i.test(ua)) app = 'instagram';
  else if (/; wv\)/i.test(ua)) app = 'other';
  if (!app) return null;

  let reopenUrl = url;
  if (app === 'line') {
    try {
      const u = new URL(url);
      u.searchParams.set('openExternalBrowser', '1');
      reopenUrl = u.toString();
    } catch {
      reopenUrl = url.includes('?')
        ? `${url}&openExternalBrowser=1`
        : `${url}?openExternalBrowser=1`;
    }
  }
  return { app, reopenUrl };
}

function isStandalone() {
  return (
    (typeof navigator !== 'undefined' &&
      /** @type {any} */ (navigator).standalone === true) ||
    (typeof matchMedia === 'function' &&
      matchMedia('(display-mode: standalone)').matches)
  );
}

function sameDomainOk() {
  if (!cfg.sameDomainAuth) return false;
  try {
    const authHost = new URL(`https://${cfg.firebaseConfig.authDomain}`).host;
    return typeof location !== 'undefined' && location.host === authHost;
  } catch {
    return false;
  }
}

function resolveMode() {
  if (cfg.mode === 'popup' || cfg.mode === 'redirect') return cfg.mode;
  // auto
  if (isStandalone() && sameDomainOk()) return 'redirect';
  return 'popup';
}

function zhError(code) {
  return ZH[code] || ZH.default;
}

function toUser(fbUser) {
  return {
    uid: fbUser.uid,
    displayName: fbUser.displayName || '玩家',
    photoURL: fbUser.photoURL || null,
  };
}

async function upsertProfile(user) {
  if (!fb) return;
  const { db, fs } = fb;
  const ref = fs.doc(db, cfg.usersCollection, user.uid);
  const snap = await fs.getDoc(ref);
  const now = fs.serverTimestamp();
  if (!snap.exists()) {
    await fs.setDoc(ref, {
      displayName: user.displayName,
      photoURL: user.photoURL,
      createdAt: now,
      lastSeen: now,
    });
    return;
  }
  const data = snap.data();
  const patch = {};
  if (data.displayName !== user.displayName) patch.displayName = user.displayName;
  if ((data.photoURL || null) !== user.photoURL) patch.photoURL = user.photoURL;
  const last = data.lastSeen?.toMillis?.() ?? 0;
  if (Date.now() - last > cfg.touchIntervalMs) patch.lastSeen = now;
  if (Object.keys(patch).length) await fs.updateDoc(ref, patch);
}

/**
 * @param {object} options
 */
export async function initAuth(options) {
  if (!options?.firebaseConfig) throw new Error('firebaseConfig required');
  cfg = { ...cfg, ...options };

  const iab = detectInAppBrowser();
  if (iab) {
    if (iab.app === 'line') {
      try {
        const u = new URL(location.href);
        if (u.searchParams.get('openExternalBrowser') !== '1') {
          location.replace(iab.reopenUrl);
          return;
        }
      } catch {
        /* fall through to 1-e */
      }
    }
    currentStatus = 'in-app-browser';
    currentUser = readCache();
    emit({
      status: 'in-app-browser',
      user: currentUser,
      error: null,
      fromCache: !!currentUser,
    });
    return;
  }

  const cached = readCache();
  if (cached) {
    currentUser = cached;
    currentStatus = 'signed-in';
    emit({ status: 'signed-in', user: cached, error: null, fromCache: true });
  } else {
    emit({ status: 'loading', user: null, error: null });
  }

  try {
    fb = await loadFirebase(cfg.firebaseConfig, { timeoutMs: cfg.timeoutMs });
    const { auth, authApi } = fb;
    await authApi.setPersistence(auth, authApi.browserLocalPersistence);

    // Finish redirect result if any
    try {
      const result = await authApi.getRedirectResult(auth);
      if (result?.user) {
        const u = toUser(result.user);
        writeCache(u);
        await upsertProfile(u);
      }
    } catch (e) {
      const code = e?.code || 'error';
      if (code !== 'auth/popup-closed-by-user') {
        emit({
          status: 'error',
          user: currentUser,
          error: { code, message: zhError(code) },
        });
      }
    }

    if (unsubAuth) unsubAuth();
    unsubAuth = authApi.onAuthStateChanged(auth, async (fbUser) => {
      if (!fbUser) {
        currentUser = null;
        emit({ status: 'signed-out', user: null, error: null });
        return;
      }
      const u = toUser(fbUser);
      writeCache(u);
      emit({ status: 'signed-in', user: u, error: null, fromCache: false });
      try {
        await upsertProfile(u);
      } catch {
        /* profile write best-effort */
      }
    });
  } catch (e) {
    currentStatus = 'offline';
    emit({
      status: 'offline',
      user: currentUser,
      error: {
        code: 'offline',
        message: '連不上 Firebase，先用離線資料',
      },
      fromCache: !!currentUser,
    });
  }
}

export function onUser(fn) {
  listeners.add(fn);
  fn({
    status: currentStatus,
    user: currentUser,
    error: null,
    fromCache: currentStatus === 'signed-in' && !!currentUser,
  });
  return () => listeners.delete(fn);
}

export function getUser() {
  return currentUser;
}

export async function signIn() {
  if (currentStatus === 'in-app-browser') {
    emit({
      status: 'in-app-browser',
      user: currentUser,
      error: { code: 'in-app', message: '請用瀏覽器開啟後再登入' },
    });
    return;
  }
  if (!fb) {
    emit({
      status: 'offline',
      user: currentUser,
      error: { code: 'offline', message: '連不上網路，無法登入' },
    });
    return;
  }
  emit({ status: 'loading', user: currentUser, error: null });
  const { auth, authApi } = fb;
  const provider = new authApi.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  let mode = resolveMode();

  try {
    if (mode === 'redirect') {
      await authApi.signInWithRedirect(auth, provider);
      return;
    }
    const cred = await authApi.signInWithPopup(auth, provider);
    const u = toUser(cred.user);
    writeCache(u);
    await upsertProfile(u);
    emit({ status: 'signed-in', user: u, error: null });
  } catch (e) {
    const code = e?.code || 'error';
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
      emit({ status: 'signed-out', user: null, error: null });
      return;
    }
    if (code === 'auth/popup-blocked' && sameDomainOk()) {
      try {
        await authApi.signInWithRedirect(auth, provider);
        return;
      } catch (e2) {
        const c2 = e2?.code || code;
        emit({
          status: 'error',
          user: currentUser,
          error: { code: c2, message: zhError(c2) },
        });
        return;
      }
    }
    emit({
      status: 'error',
      user: currentUser,
      error: { code, message: zhError(code) },
    });
  }
}

export async function signOut() {
  clearCache();
  currentUser = null;
  if (fb) {
    try {
      await fb.authApi.signOut(fb.auth);
    } catch {
      /* ignore */
    }
  }
  emit({ status: 'signed-out', user: null, error: null });
}

export function getFirebase() {
  if (!fb) return null;
  return { app: fb.app, auth: fb.auth, db: fb.db, fs: fb.fs };
}

/** @returns {typeof cfg} */
export function _getAuthConfig() {
  return cfg;
}
