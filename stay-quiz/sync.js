/**
 * 跨裝置最高分同步（Firestore）。
 * CDN／網路失敗時靜默關閉，遊戲仍可只用本地。
 */
import {
  CLOUD_CACHE_KEY,
  MIGRATED_KEY,
  PENDING_KEY,
  pickDisplayBest,
  shouldSkipCloudUpload,
  shouldWriteCloudMigration,
  shouldWriteCloudPending,
  shouldWriteCloudRoundEnd,
} from './logic.js';

/** 公開 Web 設定（設計如此；規則限制寫入） */
export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyA7YFBUW7eG9KDEoVinKFgVnfGJcjWJUGM',
  authDomain: 'stay-quiz-tony.firebaseapp.com',
  projectId: 'stay-quiz-tony',
  storageBucket: 'stay-quiz-tony.firebasestorage.app',
  messagingSenderId: '824003028208',
  appId: '1:824003028208:web:17fb8be2ba56f0eabe8e35',
};

const PLAYERS = ['羽蕎', '容亘', 'Stay'];
const GET_TIMEOUT_MS = 3000;
const TX_TIMEOUT_MS = 5000;

/** @type {any} */
let db = null;
/** @type {any} */
let fsApi = null;
let syncEnabled = false;
let busy = false;

/** @type {{ getLocalBest: () => ({score:number,player:string,at?:any}|null), setLocalBest: (s:number,p:string,at:number) => void, onDisplay: (b:{score:number,player:string,at?:any}|null) => void } | null} */
let hooks = null;

function lsGet(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function lsSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function lsRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/**
 * @returns {{score:number,player:string,at:number}|null}
 */
function readCloudCache() {
  const v = lsGet(CLOUD_CACHE_KEY);
  if (!v || typeof v !== 'object') return null;
  const score = /** @type {any} */ (v).score;
  const player = /** @type {any} */ (v).player;
  const at = /** @type {any} */ (v).at;
  if (!Number.isInteger(score) || score < 0 || score > 100) return null;
  if (typeof player !== 'string' || !PLAYERS.includes(player)) return null;
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  return { score, player, at };
}

/**
 * @returns {{score:number,player:string,at:number}|null}
 */
function readPending() {
  const v = lsGet(PENDING_KEY);
  if (!v || typeof v !== 'object') return null;
  const score = /** @type {any} */ (v).score;
  const player = /** @type {any} */ (v).player;
  const at = /** @type {any} */ (v).at;
  if (!Number.isInteger(score) || score < 0 || score > 100) return null;
  if (typeof player !== 'string' || !PLAYERS.includes(player)) return null;
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  return { score, player, at };
}

function writeCloudCache(score, player, atMs) {
  lsSet(CLOUD_CACHE_KEY, { score, player, at: atMs });
}

function writePending(score, player) {
  if (shouldSkipCloudUpload(score)) return;
  const prev = readPending();
  if (prev && score < prev.score) return;
  lsSet(PENDING_KEY, { score, player, at: Date.now() });
}

function refreshDisplay() {
  if (!hooks) return;
  const local = hooks.getLocalBest();
  const cloud = readCloudCache();
  const pending = readPending();
  hooks.onDisplay(pickDisplayBest(cloud, local, pending));
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'timeout' })), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function isPermissionDenied(err) {
  if (!err) return false;
  const code = String(err.code || '');
  if (code === 'permission-denied') return true;
  return /permission-denied/i.test(String(err.message || ''));
}

function bestRef() {
  return fsApi.doc(db, 'stayQuiz', 'best');
}

/**
 * @param {{score:number,player:string}} rec
 */
function successWrapUp(rec) {
  writeCloudCache(rec.score, rec.player, Date.now());
  const pending = readPending();
  if (pending && pending.score <= rec.score) {
    // 雲端已追上或超過 pending → 清掉
    if (pending.score < rec.score || pending.player === rec.player) {
      lsRemove(PENDING_KEY);
    } else if (pending.score === rec.score) {
      // 同分不同人且雲端已是新名：pending 不可再蓋（§7 嚴格 >）→ 刪
      lsRemove(PENDING_KEY);
    }
  }
  refreshDisplay();
}

async function ensureFirebase() {
  if (db && fsApi) {
    syncEnabled = true;
    return true;
  }
  try {
    const appMod = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js');
    const fireMod = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js');
    const app = appMod.initializeApp(FIREBASE_CONFIG);
    db = fireMod.getFirestore(app);
    fsApi = {
      doc: fireMod.doc,
      getDoc: fireMod.getDoc,
      runTransaction: fireMod.runTransaction,
      serverTimestamp: fireMod.serverTimestamp,
      connectFirestoreEmulator: fireMod.connectFirestoreEmulator,
    };
    // 測試：?emulator=1 或 window.__STAY_FIRESTORE_EMULATOR__ = {host,port}
    const emu =
      (typeof window !== 'undefined' && window.__STAY_FIRESTORE_EMULATOR__) ||
      (typeof location !== 'undefined' && new URLSearchParams(location.search).get('emulator') === '1'
        ? { host: '127.0.0.1', port: 8080 }
        : null);
    if (emu && fsApi.connectFirestoreEmulator) {
      fsApi.connectFirestoreEmulator(db, emu.host || '127.0.0.1', emu.port || 8080, { mockUserToken: undefined });
    }
    syncEnabled = true;
  } catch {
    syncEnabled = false;
    db = null;
    fsApi = null;
  }
  return syncEnabled;
}

/**
 * @returns {Promise<{score:number,player:string,at:number}|null|'missing'>}
 */
async function fetchCloudBest() {
  const snap = await fsApi.getDoc(bestRef());
  if (!snap.exists()) return 'missing';
  const d = snap.data();
  const score = d.score;
  const player = d.player;
  let at = Date.now();
  if (d.at && typeof d.at.toMillis === 'function') at = d.at.toMillis();
  else if (typeof d.at === 'number') at = d.at;
  if (!Number.isInteger(score) || !PLAYERS.includes(player)) return 'missing';
  return { score, player, at };
}

/**
 * @param {number} score
 * @param {string} player
 * @param {'round'|'migration'|'pending'} mode
 * @returns {Promise<'wrote'|'skipped'>}
 */
async function runCloudWrite(score, player, mode) {
  return fsApi.runTransaction(db, async (tx) => {
    const ref = bestRef();
    const snap = await tx.get(ref);
    const cloudScore = snap.exists() ? snap.data().score : null;
    let ok = false;
    if (mode === 'round') ok = shouldWriteCloudRoundEnd(score, cloudScore);
    else if (mode === 'migration') ok = shouldWriteCloudMigration(score, cloudScore);
    else ok = shouldWriteCloudPending(score, cloudScore);
    if (!ok) return 'skipped';
    tx.set(ref, {
      score,
      player,
      at: fsApi.serverTimestamp(),
    });
    return 'wrote';
  });
}

async function migrateOnce() {
  if (lsGet(MIGRATED_KEY) === '1' || lsGet(MIGRATED_KEY) === 1) return;
  if (!hooks) return;
  const local = hooks.getLocalBest();
  if (!local || !PLAYERS.includes(local.player) || local.score === 0) {
    lsSet(MIGRATED_KEY, '1');
    return;
  }
  if (!syncEnabled) return;
  try {
    const result = await withTimeout(runCloudWrite(local.score, local.player, 'migration'), TX_TIMEOUT_MS);
    if (result === 'wrote') successWrapUp({ score: local.score, player: local.player });
    lsSet(MIGRATED_KEY, '1');
  } catch (err) {
    if (isPermissionDenied(err)) {
      console.error(err);
      lsSet(MIGRATED_KEY, '1');
      return;
    }
    // 網路失敗：不標記，下次再開再試
  }
}

async function flushPending() {
  const pending = readPending();
  if (!pending || !syncEnabled) return;
  try {
    const result = await withTimeout(runCloudWrite(pending.score, pending.player, 'pending'), TX_TIMEOUT_MS);
    if (result === 'wrote') {
      successWrapUp({ score: pending.score, player: pending.player });
    }
    lsRemove(PENDING_KEY);
  } catch (err) {
    if (isPermissionDenied(err)) {
      console.error(err);
      // 不保留 pending（依 spec permission-denied）
      lsRemove(PENDING_KEY);
      return;
    }
    // 其他失敗：保留 pending
  }
}

/**
 * 頁面開啟：先顯示本地，再拉雲端，再遷移／pending。
 * @param {{ getLocalBest: Function, setLocalBest: Function, onDisplay: Function }} h
 */
export async function loadBest(h) {
  hooks = h;
  // 1) 立即本地
  refreshDisplay();

  if (busy) return;
  busy = true;
  try {
    const ok = await ensureFirebase();
    if (!ok) {
      // CDN 失敗：雲端快取 vs 本地取高
      const cloud = readCloudCache();
      const local = hooks.getLocalBest();
      hooks.onDisplay(pickDisplayBest(cloud, local, readPending()));
      return;
    }

    // 2–3) getDoc + 3s
    try {
      const cloud = await withTimeout(fetchCloudBest(), GET_TIMEOUT_MS);
      if (cloud === 'missing') {
        // 無文件：不寫快取分數；顯示規則仍看本地／pending
        refreshDisplay();
      } else if (cloud) {
        writeCloudCache(cloud.score, cloud.player, cloud.at);
        refreshDisplay();
      }
    } catch {
      // 4) fail：cloud cache vs local（再加 pending）
      refreshDisplay();
    }

    // 5) 遷移 → pending
    await migrateOnce();
    await flushPending();
  } finally {
    busy = false;
  }
}

/**
 * 對局結束提交。
 * @param {number} score
 * @param {string} player
 */
export async function submitScore(score, player) {
  if (!hooks) return;
  // 本地已由 app 寫入；這裡只處理雲端
  refreshDisplay();

  if (shouldSkipCloudUpload(score)) return;
  if (!PLAYERS.includes(player)) return;

  const ok = await ensureFirebase();
  if (!ok) {
    writePending(score, player);
    refreshDisplay();
    return;
  }

  if (busy) {
    // 仍嘗試排入 pending，避免丟掉
    writePending(score, player);
    refreshDisplay();
    return;
  }

  busy = true;
  const txPromise = runCloudWrite(score, player, 'round');
  try {
    const result = await withTimeout(txPromise, TX_TIMEOUT_MS);
    if (result === 'wrote') successWrapUp({ score, player });
    else refreshDisplay();
  } catch (err) {
    if (isPermissionDenied(err)) {
      console.error(err);
    } else {
      writePending(score, player);
      refreshDisplay();
      // 逾時後交易若成功仍 wrap-up
      txPromise
        .then((result) => {
          if (result === 'wrote') successWrapUp({ score, player });
        })
        .catch(() => {});
    }
  } finally {
    busy = false;
  }
}

/** online 時重傳 pending（busy 則跳過） */
export function bindOnlineFlush() {
  if (typeof window === 'undefined') return;
  window.addEventListener('online', () => {
    if (busy) return;
    busy = true;
    flushPending()
      .catch(() => {})
      .finally(() => {
        busy = false;
      });
  });
}

/** 測試用：重設模組狀態 */
export function __resetSyncForTests() {
  db = null;
  fsApi = null;
  syncEnabled = false;
  busy = false;
  hooks = null;
}

/** 測試用：注入 mock Firestore（勿連正式環境） */
export function __injectFirestoreForTests(api) {
  if (!api) {
    db = null;
    fsApi = null;
    syncEnabled = false;
    return;
  }
  db = { __mock: true };
  fsApi = api;
  syncEnabled = true;
}
