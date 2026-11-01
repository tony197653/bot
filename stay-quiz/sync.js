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
const IMPORT_TIMEOUT_MS = 8000;

/** @type {any} */
let db = null;
/** @type {any} */
let fsApi = null;
let syncEnabled = false;
let busy = false;
/** CDN 失敗後本工作階段不再嘗試同步、不存 pending */
let syncDisabledThisSession = false;

/** 無 localStorage 時的記憶體雲端快取（#2） */
/** @type {{score:number,player:string,at:number}|null} */
let memCloud = null;
/** @type {{score:number,player:string,at:number}|null} */
let memPending = null;

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

function parseCloudShape(v) {
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
export function getCloudCache() {
  const fromLs = parseCloudShape(lsGet(CLOUD_CACHE_KEY));
  if (fromLs) {
    memCloud = fromLs;
    return fromLs;
  }
  return memCloud;
}

/**
 * @returns {{score:number,player:string,at:number}|null}
 */
export function getPendingRecord() {
  const fromLs = parseCloudShape(lsGet(PENDING_KEY));
  if (fromLs) {
    memPending = fromLs;
    return fromLs;
  }
  return memPending;
}

function writeCloudCache(score, player, atMs) {
  memCloud = { score, player, at: atMs };
  lsSet(CLOUD_CACHE_KEY, memCloud);
}

function clearCloudCache() {
  memCloud = null;
  lsRemove(CLOUD_CACHE_KEY);
}

function writePending(score, player) {
  if (shouldSkipCloudUpload(score)) return;
  const prev = getPendingRecord();
  if (prev && score < prev.score) return;
  memPending = { score, player, at: Date.now() };
  lsSet(PENDING_KEY, memPending);
}

function clearPending() {
  memPending = null;
  lsRemove(PENDING_KEY);
}

function refreshDisplay() {
  if (!hooks) return;
  const local = hooks.getLocalBest();
  const cloud = getCloudCache();
  const pending = getPendingRecord();
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

function isLocalHostname() {
  if (typeof location === 'undefined') return false;
  const h = location.hostname;
  return h === 'localhost' || h === '127.0.0.1';
}

function bestRef() {
  return fsApi.doc(db, 'stayQuiz', 'best');
}

/**
 * @param {{score:number,player:string}} rec
 */
function successWrapUp(rec) {
  writeCloudCache(rec.score, rec.player, Date.now());
  const pending = getPendingRecord();
  if (pending && pending.score <= rec.score) {
    clearPending();
  }
  refreshDisplay();
}

/**
 * @param {{score:number,player:string,at:number}|null} cloud
 */
function applySkippedCloud(cloud) {
  if (cloud) writeCloudCache(cloud.score, cloud.player, cloud.at);
  refreshDisplay();
}

async function ensureFirebase() {
  if (syncDisabledThisSession) return false;
  if (db && fsApi) {
    syncEnabled = true;
    return true;
  }
  try {
    const appMod = await withTimeout(
      import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js'),
      IMPORT_TIMEOUT_MS,
    );
    const fireMod = await withTimeout(
      import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js'),
      IMPORT_TIMEOUT_MS,
    );
    if (typeof fireMod.setLogLevel === 'function') {
      fireMod.setLogLevel('silent');
    }
    const app = appMod.initializeApp(FIREBASE_CONFIG);
    db = fireMod.getFirestore(app);
    fsApi = {
      doc: fireMod.doc,
      getDoc: fireMod.getDoc,
      runTransaction: fireMod.runTransaction,
      serverTimestamp: fireMod.serverTimestamp,
      connectFirestoreEmulator: fireMod.connectFirestoreEmulator,
    };
    // 測試掛勾僅限 localhost／127.0.0.1（#5a）
    let emu = null;
    if (isLocalHostname()) {
      if (typeof window !== 'undefined' && window.__STAY_FIRESTORE_EMULATOR__) {
        emu = window.__STAY_FIRESTORE_EMULATOR__;
      } else if (
        typeof location !== 'undefined' &&
        new URLSearchParams(location.search).get('emulator') === '1'
      ) {
        emu = { host: '127.0.0.1', port: 8080 };
      }
    }
    if (emu && fsApi.connectFirestoreEmulator) {
      fsApi.connectFirestoreEmulator(db, emu.host || '127.0.0.1', emu.port || 8080, {
        mockUserToken: undefined,
      });
    }
    syncEnabled = true;
  } catch {
    syncEnabled = false;
    syncDisabledThisSession = true;
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

function cloudFromSnapData(d) {
  if (!d) return null;
  const score = d.score;
  const player = d.player;
  if (!Number.isInteger(score) || !PLAYERS.includes(player)) return null;
  let at = Date.now();
  if (d.at && typeof d.at.toMillis === 'function') at = d.at.toMillis();
  else if (typeof d.at === 'number') at = d.at;
  return { score, player, at };
}

/**
 * @param {number} score
 * @param {string} player
 * @param {'round'|'migration'|'pending'} mode
 * @returns {Promise<{result:'wrote'|'skipped', cloud:{score:number,player:string,at:number}|null}>}
 */
async function runCloudWrite(score, player, mode) {
  return fsApi.runTransaction(db, async (tx) => {
    const ref = bestRef();
    const snap = await tx.get(ref);
    const cloud = snap.exists() ? cloudFromSnapData(snap.data()) : null;
    const cloudScore = cloud ? cloud.score : null;
    let ok = false;
    if (mode === 'round') ok = shouldWriteCloudRoundEnd(score, cloudScore);
    else if (mode === 'migration') ok = shouldWriteCloudMigration(score, cloudScore);
    else ok = shouldWriteCloudPending(score, cloudScore);
    if (!ok) return { result: 'skipped', cloud };
    tx.set(ref, {
      score,
      player,
      at: fsApi.serverTimestamp(),
    });
    return { result: 'wrote', cloud: { score, player, at: Date.now() } };
  });
}

async function migrateOnce() {
  if (lsGet(MIGRATED_KEY) === '1' || lsGet(MIGRATED_KEY) === 1) return;
  // 無 localStorage 時用 mem 標記避免每開必遷（仍盡力 lsSet）
  if (memMigrated) return;
  if (!hooks) return;
  const local = hooks.getLocalBest();
  if (!local || !PLAYERS.includes(local.player) || local.score === 0) {
    markMigrated();
    return;
  }
  if (!syncEnabled) return;
  try {
    const outcome = await withTimeout(runCloudWrite(local.score, local.player, 'migration'), TX_TIMEOUT_MS);
    if (outcome.result === 'wrote') successWrapUp({ score: local.score, player: local.player });
    else applySkippedCloud(outcome.cloud);
    markMigrated();
  } catch (err) {
    if (isPermissionDenied(err)) {
      console.error(err);
      markMigrated();
      return;
    }
    // 網路失敗：不標記，下次再開再試
  }
}

let memMigrated = false;
function markMigrated() {
  memMigrated = true;
  lsSet(MIGRATED_KEY, '1');
}

async function flushPending() {
  const pending = getPendingRecord();
  if (!pending || !syncEnabled) return;
  try {
    const outcome = await withTimeout(
      runCloudWrite(pending.score, pending.player, 'pending'),
      TX_TIMEOUT_MS,
    );
    if (outcome.result === 'wrote') {
      successWrapUp({ score: pending.score, player: pending.player });
    } else {
      // no-need：仍刪 pending，並把讀到的雲端寫入快取（#1）
      applySkippedCloud(outcome.cloud);
      clearPending();
    }
  } catch (err) {
    if (isPermissionDenied(err)) {
      console.error(err);
      clearPending();
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
  refreshDisplay();

  if (busy) return;
  busy = true;
  try {
    const ok = await ensureFirebase();
    if (!ok) {
      // CDN 失敗：靜默停用；用既有快取／本地顯示（#5c 不為此存 pending）
      refreshDisplay();
      return;
    }

    try {
      const cloud = await withTimeout(fetchCloudBest(), GET_TIMEOUT_MS);
      if (cloud === 'missing') {
        // #3：文件不存在＝清快取（雲端 0）
        clearCloudCache();
        refreshDisplay();
      } else if (cloud) {
        writeCloudCache(cloud.score, cloud.player, cloud.at);
        refreshDisplay();
      }
    } catch {
      refreshDisplay();
    }

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
  refreshDisplay();

  if (shouldSkipCloudUpload(score)) return;
  if (!PLAYERS.includes(player)) return;

  if (syncDisabledThisSession) {
    refreshDisplay();
    return;
  }

  const ok = await ensureFirebase();
  if (!ok) {
    // #5c：CDN 失敗本 session 靜默停用，不存 pending（開頁 migration 可補 local>cloud）
    refreshDisplay();
    return;
  }

  if (busy) {
    // 同步已啟用但忙碌：保留 pending 供 §7 重傳
    writePending(score, player);
    refreshDisplay();
    return;
  }

  busy = true;
  const txPromise = runCloudWrite(score, player, 'round');
  try {
    const outcome = await withTimeout(txPromise, TX_TIMEOUT_MS);
    if (outcome.result === 'wrote') successWrapUp({ score, player });
    else applySkippedCloud(outcome.cloud);
  } catch (err) {
    if (isPermissionDenied(err)) {
      console.error(err);
    } else {
      writePending(score, player);
      refreshDisplay();
      txPromise
        .then((outcome) => {
          if (outcome.result === 'wrote') successWrapUp({ score, player });
          else applySkippedCloud(outcome.cloud);
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
    if (busy || syncDisabledThisSession) return;
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
  syncDisabledThisSession = false;
  busy = false;
  hooks = null;
  memCloud = null;
  memPending = null;
  memMigrated = false;
}

/** 測試用：注入 mock Firestore（勿連正式環境）；傳 null＝模擬 CDN 失敗停用 */
export function __injectFirestoreForTests(api) {
  if (!api) {
    db = null;
    fsApi = null;
    syncEnabled = false;
    syncDisabledThisSession = true;
    return;
  }
  db = { __mock: true };
  fsApi = api;
  syncEnabled = true;
  syncDisabledThisSession = false;
}
