/**
 * Dynamic Firebase JS SDK 10.14.1 loader (gstatic CDN).
 * One app per page; 8s timeout → reject so callers can go offline.
 */

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';
const DEFAULT_TIMEOUT_MS = 8000;

/** @type {Promise<{ app: any, auth: any, db: any, fs: any, authApi: any }>|null} */
let loadPromise = null;

/**
 * @param {number} ms
 * @param {string} label
 */
function withTimeout(ms, label) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms);
  });
}

/**
 * @param {object} firebaseConfig
 * @param {{ timeoutMs?: number }} [opts]
 */
export function loadFirebase(firebaseConfig, opts = {}) {
  if (loadPromise) return loadPromise;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  loadPromise = (async () => {
    const [appMod, authMod, fsMod] = await Promise.race([
      Promise.all([
        import(`${SDK}/firebase-app.js`),
        import(`${SDK}/firebase-auth.js`),
        import(`${SDK}/firebase-firestore.js`),
      ]),
      withTimeout(timeoutMs, 'Firebase SDK'),
    ]);

    const { initializeApp, getApps, getApp } = appMod;
    const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
    const auth = authMod.getAuth(app);
    // Memory-only cache (no IndexedDB persistence) — §6.1 / §12 #6
    const db = fsMod.initializeFirestore(app);
    return {
      app,
      auth,
      db,
      fs: fsMod,
      authApi: authMod,
    };
  })().catch((err) => {
    loadPromise = null;
    throw err;
  });

  return loadPromise;
}

/** Reset (tests only). */
export function _resetLoadFirebase() {
  loadPromise = null;
}
