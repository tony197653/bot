/**
 * Firebase 初始化：SDK 10.14.1、8 秒逾時、setLogLevel('silent')、emulator 開關。
 */
import {
  FIREBASE_CONFIG,
  EMU_FIREBASE_CONFIG,
  EMU_PORTS,
  isEmuMode,
} from './firebase-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';
const TIMEOUT_MS = 8000;

/** @type {Promise<{app:any,auth:any,db:any,fs:any,authApi:any,emu:boolean}>|null} */
let loadPromise = null;

function withTimeout(ms, label) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(Object.assign(new Error(`${label} timeout`), { code: 'timeout' })), ms);
  });
}

/**
 * @returns {Promise<{app:any,auth:any,db:any,fs:any,authApi:any,emu:boolean}>}
 */
export function initFirebase() {
  if (loadPromise) return loadPromise;
  const emu = isEmuMode();
  const config = emu ? EMU_FIREBASE_CONFIG : FIREBASE_CONFIG;

  loadPromise = (async () => {
    const [appMod, authMod, fsMod] = await Promise.race([
      Promise.all([
        import(`${SDK}/firebase-app.js`),
        import(`${SDK}/firebase-auth.js`),
        import(`${SDK}/firebase-firestore.js`),
      ]),
      withTimeout(TIMEOUT_MS, 'Firebase SDK'),
    ]);

    if (typeof fsMod.setLogLevel === 'function') {
      fsMod.setLogLevel('silent');
    }

    const { initializeApp, getApps, getApp } = appMod;
    const app = getApps().length ? getApp() : initializeApp(config);
    const auth = authMod.getAuth(app);
    const db = fsMod.initializeFirestore(app, { ignoreUndefinedProperties: true });

    if (emu) {
      if (authMod.connectAuthEmulator) {
        try {
          authMod.connectAuthEmulator(
            auth,
            `http://127.0.0.1:${EMU_PORTS.auth}`,
            { disableWarnings: true },
          );
        } catch {
          /* already connected */
        }
      }
      if (fsMod.connectFirestoreEmulator) {
        try {
          fsMod.connectFirestoreEmulator(db, '127.0.0.1', EMU_PORTS.firestore, {
            mockUserToken: false,
          });
        } catch {
          /* already connected */
        }
      }
    }

    return { app, auth, db, fs: fsMod, authApi: authMod, emu };
  })().catch((err) => {
    loadPromise = null;
    throw err;
  });

  return loadPromise;
}

export function _resetFirebase() {
  loadPromise = null;
}

export { isEmuMode, FIREBASE_CONFIG, EMU_FIREBASE_CONFIG, EMU_PORTS };
