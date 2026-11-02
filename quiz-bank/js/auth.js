/**
 * Google 登入＋email 允許名單＋內建瀏覽器偵測＋redirect 備援。
 * 改編自 /lib/auth（GitHub Pages：authDomain=*.firebaseapp.com，popup 優先）。
 */
import { initFirebase, isEmuMode } from './fb.js';

/** @typedef {'signed-out'|'loading'|'signed-in'|'error'|'offline'|'in-app-browser'|'denied'} AuthStatus */
/** @typedef {{ uid:string, email:string, displayName:string, photoURL:string|null, role:'admin'|'student', name:string }} QuizUser */

/** @type {any} */
let fb = null;
/** @type {QuizUser|null} */
let currentUser = null;
/** @type {AuthStatus} */
let currentStatus = 'loading';
/** @type {Set<(e:any)=>void>} */
const listeners = new Set();
/** @type {(()=>void)|null} */
let unsubAuth = null;

const STORAGE_KEY = 'quizbank:v1:auth';

const ZH = {
  'auth/popup-blocked': '登入視窗被擋住了，改用重新導向登入…',
  'auth/popup-closed-by-user': '',
  'auth/network-request-failed': '網路不穩，請稍後再試',
  'auth/cancelled-popup-request': '登入已取消',
  denied: '這個帳號不在允許名單裡',
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
      /* ignore */
    }
  }
}

function readCache() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o?.uid || !o?.email || !o?.role) return null;
    return o;
  } catch {
    return null;
  }
}

function writeCache(user) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...user, at: Date.now() }));
  } catch {
    /* ignore */
  }
}

function clearCache() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * 偵測 LINE／Facebook／Instagram／Android WebView。
 * @returns {null|{app:string,reopenUrl:string}}
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

async function checkAllowlist(fbUser) {
  const email = String(fbUser.email || '').toLowerCase();
  if (!email) return null;
  const { db, fs } = fb;
  const snap = await fs.getDoc(fs.doc(db, 'allow', email));
  if (!snap.exists()) return null;
  const data = snap.data();
  if (data.role !== 'admin' && data.role !== 'student') return null;
  return {
    uid: fbUser.uid,
    email,
    displayName: fbUser.displayName || data.name || email,
    photoURL: fbUser.photoURL || null,
    role: data.role,
    name: data.name || '',
  };
}

async function afterSignedIn(fbUser) {
  try {
    const allowed = await checkAllowlist(fbUser);
    if (!allowed) {
      clearCache();
      await fb.authApi.signOut(fb.auth);
      emit({
        status: 'denied',
        user: null,
        error: {
          code: 'denied',
          message: `${ZH.denied}（${String(fbUser.email || '').toLowerCase()}）。請改用允許名單內的 Google 帳號，或請管理者加入。`,
          email: String(fbUser.email || '').toLowerCase(),
        },
      });
      return;
    }
    writeCache(allowed);
    emit({ status: 'signed-in', user: allowed, error: null });
  } catch (e) {
    emit({
      status: 'error',
      user: currentUser,
      error: { code: e?.code || 'error', message: ZH.default },
    });
  }
}

export async function initAuth() {
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
        /* fall through */
      }
    }
    currentStatus = 'in-app-browser';
    emit({ status: 'in-app-browser', user: null, error: null });
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
    fb = await initFirebase();
    const { auth, authApi } = fb;
    await authApi.setPersistence(auth, authApi.browserLocalPersistence);

    try {
      const result = await authApi.getRedirectResult(auth);
      if (result?.user) await afterSignedIn(result.user);
    } catch (e) {
      const code = e?.code || 'error';
      if (code !== 'auth/popup-closed-by-user') {
        emit({
          status: 'error',
          user: currentUser,
          error: { code, message: ZH[code] || ZH.default },
        });
      }
    }

    if (unsubAuth) unsubAuth();
    unsubAuth = authApi.onAuthStateChanged(auth, async (fbUser) => {
      if (!fbUser) {
        if (currentStatus !== 'denied') {
          clearCache();
          emit({ status: 'signed-out', user: null, error: null });
        }
        return;
      }
      await afterSignedIn(fbUser);
    });
  } catch {
    currentStatus = 'offline';
    emit({
      status: 'offline',
      user: currentUser,
      error: { code: 'offline', message: '連不上 Firebase，請檢查網路後重試' },
      fromCache: !!currentUser,
    });
  }
}

export function onUser(fn) {
  listeners.add(fn);
  fn({ status: currentStatus, user: currentUser, error: null });
  return () => listeners.delete(fn);
}

export function getUser() {
  return currentUser;
}

export function isAdmin() {
  return currentUser?.role === 'admin';
}

export async function signIn() {
  if (currentStatus === 'in-app-browser') {
    emit({
      status: 'in-app-browser',
      user: null,
      error: { code: 'in-app', message: '請用 Safari／Chrome 開啟' },
    });
    return;
  }
  if (!fb) {
    try {
      fb = await initFirebase();
    } catch {
      emit({
        status: 'offline',
        user: currentUser,
        error: { code: 'offline', message: '連不上網路，無法登入' },
      });
      return;
    }
  }
  emit({ status: 'loading', user: currentUser, error: null });
  const { auth, authApi } = fb;
  const provider = new authApi.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });

  try {
    const cred = await authApi.signInWithPopup(auth, provider);
    await afterSignedIn(cred.user);
  } catch (e) {
    const code = e?.code || 'error';
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
      emit({ status: 'signed-out', user: null, error: null });
      return;
    }
    // GitHub Pages：popup 被擋或 iOS Safari → redirect 備援
    if (
      code === 'auth/popup-blocked' ||
      code === 'auth/operation-not-supported-in-this-environment' ||
      /iPhone|iPad|iPod/i.test(navigator.userAgent || '')
    ) {
      try {
        await authApi.signInWithRedirect(auth, provider);
        return;
      } catch (e2) {
        const c2 = e2?.code || code;
        emit({
          status: 'error',
          user: currentUser,
          error: { code: c2, message: ZH[c2] || ZH.default },
        });
        return;
      }
    }
    emit({
      status: 'error',
      user: currentUser,
      error: { code, message: ZH[code] || ZH.default },
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
  return fb;
}

/** Emulator QA：email/password 登入並寫入 allow（測試用） */
export async function qaEmuSignIn(email, role = 'student', name = '測試') {
  if (!isEmuMode()) throw new Error('qaEmuSignIn requires ?emulator=1');
  if (!fb) fb = await initFirebase();
  const { auth, authApi, db, fs } = fb;
  const password = 'quiz-bank-test';
  let cred;
  try {
    cred = await authApi.signInWithEmailAndPassword(auth, email, password);
  } catch {
    cred = await authApi.createUserWithEmailAndPassword(auth, email, password);
  }
  // Ensure verified + allow doc (rules require email_verified; emulator may need claims via Admin — use custom token path)
  // For emulator, email_verified is often false by default. Rules tests use authenticatedContext.
  // Browser emulator: we seed allow via privileged REST or rely on rules-disabled seed in e2e.
  try {
    await fs.setDoc(fs.doc(db, 'allow', email.toLowerCase()), { role, name }, { merge: true });
  } catch {
    /* student cannot write allow — seed must be done with admin SDK / rules disabled */
  }
  await afterSignedIn(cred.user);
  return getUser();
}
