/**
 * 匯入草稿：IndexedDB `quizbank-v1` / store `importDraft`（§5.4）。
 * 停頓 1 秒自動存；存入成功的題才從草稿移除（由呼叫端改 state 後再存）。
 */
import { ERR } from './errors.js';

const IDB_NAME = 'quizbank-v1';
const IDB_STORE = 'importDraft';
const IDB_KEY = 'current';
/** 舊版 localStorage 鍵，啟動時遷移一次；對外別名 DRAFT_KEY */
export const DRAFT_KEY = 'quizbank:v1:importDraft';
const LEGACY_LS = DRAFT_KEY;

/** @type {IDBDatabase|null} */
let dbPromiseCache = null;
let idbUnavailable = false;

function openDb() {
  if (idbUnavailable) return Promise.reject(new Error('idb-unavailable'));
  if (dbPromiseCache) return dbPromiseCache;
  if (typeof indexedDB === 'undefined') {
    idbUnavailable = true;
    return Promise.reject(new Error('idb-unavailable'));
  }
  dbPromiseCache = new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(IDB_NAME, 1);
    } catch (e) {
      idbUnavailable = true;
      reject(e);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      idbUnavailable = true;
      reject(req.error || new Error('idb-open-failed'));
    };
  });
  return dbPromiseCache;
}

/**
 * @returns {Promise<object|null>}
 */
export async function readImportDraft() {
  try {
    const db = await openDb();
    const row = await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    if (row) return row;
  } catch {
    /* fall through to legacy */
  }
  try {
    const raw = localStorage.getItem(LEGACY_LS);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    await writeImportDraft(parsed).catch(() => {});
    localStorage.removeItem(LEGACY_LS);
    return parsed;
  } catch {
    return null;
  }
}

/**
 * @param {object|null} data null＝清除
 * @param {(msg:string)=>void} [toast]
 * @returns {Promise<boolean>}
 */
export async function writeImportDraft(data, toast) {
  if (data == null) return clearImportDraft(toast);
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(data, IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    try {
      localStorage.removeItem(LEGACY_LS);
    } catch {
      /* ignore */
    }
    return true;
  } catch {
    toast?.(ERR.storageImportHint);
    return false;
  }
}

/**
 * @param {(msg:string)=>void} [toast]
 */
export async function clearImportDraft(toast) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    toast?.(ERR.storageImportHint);
    return false;
  }
  try {
    localStorage.removeItem(LEGACY_LS);
  } catch {
    /* ignore */
  }
  return true;
}

/**
 * 停頓 ms 後存（預設 1000）。
 * @param {() => object|null} getState
 * @param {(msg:string)=>void} [toast]
 * @param {number} [ms]
 */
export function createDraftAutosave(getState, toast, ms = 1000) {
  let t = 0;
  let pending = null;
  return {
    schedule() {
      clearTimeout(t);
      t = setTimeout(async () => {
        const s = getState();
        pending = writeImportDraft(s, toast);
        await pending;
        pending = null;
      }, ms);
    },
    /** 立刻存（存入前／離開前） */
    async flush() {
      clearTimeout(t);
      if (pending) await pending;
      const s = getState();
      return writeImportDraft(s, toast);
    },
    async clear() {
      clearTimeout(t);
      return clearImportDraft(toast);
    },
  };
}

export function isIdbUnavailable() {
  return idbUnavailable;
}
