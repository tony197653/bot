/**
 * QA #31 第一次驗收修正：skipped 回寫快取、memCloud、missing 清快取、CDN 不存 pending
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUIZ_ROOT = process.env.STAY_QUIZ_ROOT || join(__dirname, '../stay-quiz');

const { STORAGE_KEY, CLOUD_CACHE_KEY, PENDING_KEY, isNewRecordBadge } = await import(
  pathToFileURL(join(QUIZ_ROOT, 'logic.js')).href
);
const {
  loadBest,
  submitScore,
  getCloudCache,
  getPendingRecord,
  __resetSyncForTests,
  __injectFirestoreForTests,
} = await import(pathToFileURL(join(QUIZ_ROOT, 'sync.js')).href);

function createMockFs(seed = null) {
  let doc = seed;
  return {
    doc: () => ({ path: 'stayQuiz/best' }),
    getDoc: async () => ({
      exists: () => !!doc,
      data: () =>
        doc
          ? { score: doc.score, player: doc.player, at: { toMillis: () => doc.at } }
          : null,
    }),
    serverTimestamp: () => ({ __server: true }),
    runTransaction: async (_db, fn) => {
      const tx = {
        get: async () => ({
          exists: () => !!doc,
          data: () => (doc ? { score: doc.score, player: doc.player, at: doc.at } : null),
        }),
        set: (_ref, data) => {
          doc = { score: data.score, player: data.player, at: Date.now() };
        },
      };
      return fn(tx);
    },
    _get: () => doc,
    _set: (v) => {
      doc = v;
    },
  };
}

const mem = new Map();
function installStorage(ok = true) {
  globalThis.localStorage = {
    getItem: (k) => {
      if (!ok) throw new Error('blocked');
      return mem.has(k) ? mem.get(k) : null;
    },
    setItem: (k, v) => {
      if (!ok) throw new Error('blocked');
      mem.set(k, String(v));
    },
    removeItem: (k) => {
      if (!ok) throw new Error('blocked');
      mem.delete(k);
    },
  };
}

describe('QA sync fixes', () => {
  let fs;
  let lastDisplay;

  beforeEach(() => {
    mem.clear();
    installStorage(true);
    __resetSyncForTests();
    fs = createMockFs();
    __injectFirestoreForTests(fs);
    lastDisplay = null;
  });

  function hooks() {
    return {
      getLocalBest: () => {
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          return raw ? JSON.parse(raw).best : null;
        } catch {
          return null;
        }
      },
      setLocalBest: () => {},
      onDisplay: (b) => {
        lastDisplay = b;
      },
    };
  }

  it('#1 skipped 時把 transaction 讀到的雲端寫入快取並刷新', async () => {
    fs._set({ score: 60, player: '容亘', at: 1 });
    await loadBest(hooks());
    assert.equal(lastDisplay.score, 60);
    // 雲端被他機改成 90，本機未重整
    fs._set({ score: 90, player: '容亘', at: 2 });
    mem.set(STORAGE_KEY, JSON.stringify({ best: { score: 80, player: '羽蕎', at: Date.now() } }));
    await submitScore(80, '羽蕎');
    assert.equal(fs._get().score, 90);
    assert.equal(getCloudCache().score, 90);
    assert.equal(lastDisplay.score, 90);
    assert.equal(lastDisplay.player, '容亘');
    assert.equal(isNewRecordBadge(80, '羽蕎', lastDisplay), false);
  });

  it('#1 flushPending skipped 亦回寫雲端快取並刪 pending', async () => {
    fs._set({ score: 70, player: 'Stay', at: 5 });
    mem.set(PENDING_KEY, JSON.stringify({ score: 70, player: '羽蕎', at: 1 }));
    mem.set('stayQuiz.v2.migrated', JSON.stringify('1'));
    await loadBest(hooks());
    assert.equal(fs._get().player, 'Stay');
    assert.equal(getPendingRecord(), null);
    assert.equal(getCloudCache().player, 'Stay');
    assert.equal(lastDisplay.player, 'Stay');
  });

  it('#2 無 localStorage 仍顯示 memCloud', async () => {
    fs._set({ score: 60, player: '容亘', at: 1 });
    installStorage(false);
    __resetSyncForTests();
    __injectFirestoreForTests(fs);
    await loadBest(hooks());
    assert.equal(getCloudCache()?.score, 60);
    assert.equal(lastDisplay?.score, 60);
    assert.equal(lastDisplay?.player, '容亘');
  });

  it('#2 無儲存寫入雲端 70 後畫面可顯示', async () => {
    installStorage(false);
    __resetSyncForTests();
    __injectFirestoreForTests(fs);
    await loadBest(hooks());
    await submitScore(70, '羽蕎');
    assert.equal(fs._get()?.score, 70);
    assert.equal(lastDisplay?.score, 70);
    assert.equal(lastDisplay?.player, '羽蕎');
  });

  it('#3 missing 時清掉雲端快取', async () => {
    fs._set({ score: 88, player: 'Stay', at: 1 });
    await loadBest(hooks());
    assert.equal(getCloudCache()?.score, 88);
    fs._set(null);
    __resetSyncForTests();
    __injectFirestoreForTests(fs);
    // 模擬仍有舊 LS 快取
    installStorage(true);
    mem.set(CLOUD_CACHE_KEY, JSON.stringify({ score: 88, player: 'Stay', at: 1 }));
    await loadBest(hooks());
    assert.equal(getCloudCache(), null);
  });

  it('#5c CDN 失敗不存 pending', async () => {
    __resetSyncForTests();
    // 不 inject → ensureFirebase 會嘗試 CDN 並失敗（Node 無瀏覽器 CDN）
    await loadBest(hooks());
    mem.set(STORAGE_KEY, JSON.stringify({ best: { score: 80, player: '羽蕎', at: 1 } }));
    await submitScore(80, '羽蕎');
    assert.equal(getPendingRecord(), null);
  });

  it('isNewRecordBadge 孤立條件：雲端更高不標、同分本人標、同分他人不標', () => {
    assert.equal(isNewRecordBadge(80, '羽蕎', { score: 90, player: '容亘' }), false);
    assert.equal(isNewRecordBadge(60, '羽蕎', { score: 60, player: '羽蕎' }), true);
    assert.equal(isNewRecordBadge(60, '羽蕎', { score: 60, player: 'Stay' }), false);
    assert.equal(isNewRecordBadge(0, '羽蕎', null), true);
  });
});
