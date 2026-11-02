/**
 * 收藏夾（§5.7）：users/{uid}/favorites/{qid}
 * 上限 500；與錯題本獨立；進站讀一次放記憶體。
 */
import { ERR } from './errors.js';

export const FAV_LIMIT = 500;

/** @typedef {{ qid:string, bookId:string, subject:string, unitCode:string, addedAt:number|null }} FavRow */

/** @type {Map<string, FavRow>} */
let cache = new Map();
/** @type {string|null} */
let cacheUid = null;
/** @type {Promise<Map<string, FavRow>>|null} */
let loadPromise = null;

async function ensureFb() {
  const { initFirebase } = await import('./fb.js');
  return initFirebase();
}

/**
 * @param {string} uid
 * @param {boolean} [force]
 * @returns {Promise<FavRow[]>}
 */
export async function loadFavorites(uid, force = false) {
  if (!uid) return [];
  if (!force && cacheUid === uid && loadPromise == null) {
    return [...cache.values()].sort(sortFav);
  }
  if (!force && cacheUid === uid && loadPromise) {
    await loadPromise;
    return [...cache.values()].sort(sortFav);
  }
  loadPromise = (async () => {
    const { db, fs } = await ensureFb();
    const q = fs.query(
      fs.collection(db, 'users', uid, 'favorites'),
      fs.orderBy('addedAt', 'desc'),
    );
    const snap = await fs.getDocs(q);
    const next = new Map();
    snap.forEach((d) => {
      const data = d.data() || {};
      next.set(d.id, {
        qid: d.id,
        bookId: String(data.bookId || ''),
        subject: String(data.subject || ''),
        unitCode: String(data.unitCode || ''),
        addedAt: data.addedAt?.toMillis?.() ?? (typeof data.addedAt === 'number' ? data.addedAt : null),
      });
    });
    cache = next;
    cacheUid = uid;
    return cache;
  })();
  try {
    await loadPromise;
  } finally {
    loadPromise = null;
  }
  return [...cache.values()].sort(sortFav);
}

function sortFav(a, b) {
  const sa = a.subject.localeCompare(b.subject);
  if (sa) return sa;
  const ua = a.unitCode.localeCompare(b.unitCode);
  if (ua) return ua;
  return (b.addedAt || 0) - (a.addedAt || 0);
}

export function favCount() {
  return cache.size;
}

export function isFavoriteOn(qid) {
  return cache.has(qid);
}

export function listFavoriteIds() {
  return [...cache.keys()];
}

/**
 * @param {string} uid
 * @param {{ qid:string, bookId?:string, subject?:string, unitCode?:string }} q
 * @returns {Promise<'on'|'off'|'full'|'error'>}
 */
export async function toggleFavorite(uid, q) {
  const qid = q?.qid;
  if (!uid || !qid) return 'error';
  const wasOn = cache.has(qid);
  if (!wasOn && cache.size >= FAV_LIMIT) return 'full';

  // 樂觀更新
  if (wasOn) cache.delete(qid);
  else {
    cache.set(qid, {
      qid,
      bookId: String(q.bookId || ''),
      subject: String(q.subject || ''),
      unitCode: String(q.unitCode || ''),
      addedAt: Date.now(),
    });
  }

  try {
    const { db, fs } = await ensureFb();
    const ref = fs.doc(db, 'users', uid, 'favorites', qid);
    if (wasOn) {
      await fs.deleteDoc(ref);
      return 'off';
    }
    await fs.setDoc(ref, {
      bookId: String(q.bookId || ''),
      subject: String(q.subject || ''),
      unitCode: String(q.unitCode || ''),
      addedAt: fs.serverTimestamp(),
    });
    return 'on';
  } catch (err) {
    // 失敗退回
    if (wasOn) {
      cache.set(qid, {
        qid,
        bookId: String(q.bookId || ''),
        subject: String(q.subject || ''),
        unitCode: String(q.unitCode || ''),
        addedAt: Date.now(),
      });
    } else {
      cache.delete(qid);
    }
    console.error(err);
    throw err;
  }
}

/**
 * 延遲刪除（5 秒復原視窗）。立即從快取拿掉；逾時才真刪。
 * @returns {{ undo:()=>void, commit:()=>Promise<boolean>, cancel:()=>void }}
 */
export function scheduleFavoriteRemove(uid, row, ms = 5000) {
  const qid = row.qid;
  cache.delete(qid);
  let done = false;
  let timer = setTimeout(() => {
    commit();
  }, ms);

  async function commit() {
    if (done) return true;
    done = true;
    clearTimeout(timer);
    try {
      const { db, fs } = await ensureFb();
      await fs.deleteDoc(fs.doc(db, 'users', uid, 'favorites', qid));
      return true;
    } catch (err) {
      console.error(err);
      cache.set(qid, row);
      throw err;
    }
  }

  function undo() {
    if (done) return;
    done = true;
    clearTimeout(timer);
    cache.set(qid, row);
  }

  function cancel() {
    clearTimeout(timer);
  }

  return { undo, commit, cancel };
}

/** 背景清除讀不到的題 */
export async function pruneMissingFavorites(uid, missingQids) {
  if (!uid || !missingQids?.length) return;
  const { db, fs } = await ensureFb();
  for (const qid of missingQids) {
    cache.delete(qid);
    try {
      await fs.deleteDoc(fs.doc(db, 'users', uid, 'favorites', qid));
    } catch {
      /* ignore */
    }
  }
}

/**
 * 傳給 startQuiz 的 favorite 介面
 * @param {string} uid
 * @param {{ toast?:(msg:string, opts?:object)=>void, navigate?:(hash:string)=>void, requestLeave?:()=>Promise<boolean>|boolean, onChange?:()=>void }} hooks
 */
export function makeFavoriteApi(uid, hooks = {}) {
  let writing = false;
  return {
    isOn(qid) {
      return isFavoriteOn(qid);
    },
    async toggle(qOrId) {
      if (writing) return isFavoriteOn(typeof qOrId === 'string' ? qOrId : qOrId?.qid);
      const q =
        typeof qOrId === 'string'
          ? { qid: qOrId, bookId: '', subject: '', unitCode: '' }
          : qOrId;
      const qid = q?.qid;
      if (!qid) return false;
      const before = isFavoriteOn(qid);
      writing = true;
      try {
        const result = await toggleFavorite(uid, q);
        if (result === 'full') {
          hooks.toast?.(ERR.favFull, {
            retryLabel: '前往收藏夾',
            onRetry: async () => {
              if (hooks.requestLeave) {
                const ok = await hooks.requestLeave();
                if (!ok) return;
              }
              hooks.navigate?.('#/fav');
            },
            ms: 6000,
          });
          return false;
        }
        if (result === 'on') hooks.toast?.('已收藏');
        else if (result === 'off') hooks.toast?.('已取消收藏');
        hooks.onChange?.();
        return result === 'on';
      } catch (err) {
        const code = String(err?.code || '');
        if (/permission-denied/i.test(code + err?.message)) {
          hooks.toast?.(ERR.favDenied);
        } else {
          // before=true → 試著取消；before=false → 試著收藏
          hooks.toast?.(before ? ERR.favRemoveFail : ERR.favAddFail);
        }
        hooks.onChange?.();
        return isFavoriteOn(qid);
      } finally {
        writing = false;
      }
    },
  };
}

export function clearFavoritesCache() {
  cache = new Map();
  cacheUid = null;
  loadPromise = null;
}

export { ERR as favErrors };
