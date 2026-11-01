/**
 * 同步情境（mock Firestore，不碰正式專案）
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUIZ_ROOT = process.env.STAY_QUIZ_ROOT || join(__dirname, '../stay-quiz');

const logic = await import(pathToFileURL(join(QUIZ_ROOT, 'logic.js')).href);
const { CLOUD_CACHE_KEY, PENDING_KEY, MIGRATED_KEY, STORAGE_KEY } = logic;

const syncMod = await import(pathToFileURL(join(QUIZ_ROOT, 'sync.js')).href);
const { loadBest, submitScore, __resetSyncForTests, __injectFirestoreForTests } = syncMod;

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
    connectFirestoreEmulator: () => {},
    _get: () => doc,
    _set: (v) => {
      doc = v;
    },
  };
}

const mem = new Map();
function installStorage() {
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
}
function clearAll() {
  mem.clear();
}
function setLocalBest(score, player, at = Date.now()) {
  mem.set(STORAGE_KEY, JSON.stringify({ best: { score, player, at } }));
}
function getLocalBest() {
  const raw = mem.get(STORAGE_KEY);
  return raw ? JSON.parse(raw).best : null;
}
function getPending() {
  const raw = mem.get(PENDING_KEY);
  return raw ? JSON.parse(raw) : null;
}
function migrated() {
  const raw = mem.get(MIGRATED_KEY);
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

describe('sync scenarios (mock)', () => {
  let fs;
  let lastDisplay;

  beforeEach(() => {
    installStorage();
    clearAll();
    __resetSyncForTests();
    fs = createMockFs();
    __injectFirestoreForTests(fs);
    lastDisplay = null;
  });

  function hooks() {
    return {
      getLocalBest,
      setLocalBest: (s, p, at) => setLocalBest(s, p, at),
      onDisplay: (b) => {
        lastDisplay = b;
      },
    };
  }

  it('1: A 寫 60 → B 看見 60+名', async () => {
    await loadBest(hooks());
    setLocalBest(60, '羽蕎');
    await submitScore(60, '羽蕎');
    assert.equal(fs._get().score, 60);
    assert.equal(fs._get().player, '羽蕎');
    clearAll();
    __resetSyncForTests();
    __injectFirestoreForTests(fs);
    await loadBest(hooks());
    assert.equal(lastDisplay.score, 60);
    assert.equal(lastDisplay.player, '羽蕎');
  });

  it('2: 同分換玩家名', async () => {
    fs._set({ score: 60, player: '羽蕎', at: 1 });
    await loadBest(hooks());
    setLocalBest(60, 'Stay');
    await submitScore(60, 'Stay');
    assert.equal(fs._get().player, 'Stay');
  });

  it('3: 較低分不改雲端', async () => {
    fs._set({ score: 80, player: '容亘', at: 1 });
    await loadBest(hooks());
    setLocalBest(50, '羽蕎');
    await submitScore(50, '羽蕎');
    assert.equal(fs._get().score, 80);
    assert.equal(fs._get().player, '容亘');
  });

  it('4: 離線新高 → pending；恢復後上傳', async () => {
    __resetSyncForTests();
    __injectFirestoreForTests({
      doc: () => ({}),
      getDoc: async () => {
        throw Object.assign(new Error('offline'), { code: 'unavailable' });
      },
      runTransaction: async () => {
        throw Object.assign(new Error('offline'), { code: 'unavailable' });
      },
      serverTimestamp: () => ({}),
    });
    await loadBest(hooks());
    setLocalBest(90, '羽蕎');
    await submitScore(90, '羽蕎');
    assert.equal(getPending()?.score, 90);

    const good = createMockFs();
    const pending = getPending();
    const local = getLocalBest();
    clearAll();
    mem.set(PENDING_KEY, JSON.stringify(pending));
    mem.set(STORAGE_KEY, JSON.stringify({ best: local }));
    mem.set(MIGRATED_KEY, JSON.stringify('1'));
    __resetSyncForTests();
    __injectFirestoreForTests(good);
    await loadBest(hooks());
    assert.equal(good._get()?.score, 90);
    assert.equal(getPending(), null);
  });

  it('5: 本地舊分 > 雲端 → 遷移一次', async () => {
    fs._set({ score: 40, player: 'Stay', at: 1 });
    setLocalBest(70, '羽蕎', 1);
    await loadBest(hooks());
    assert.equal(fs._get().score, 70);
    assert.equal(migrated(), '1');
  });

  it('6: 本地 70 羽蕎 vs 雲端 70 容亘 → 雲端保留容亘', async () => {
    fs._set({ score: 70, player: '容亘', at: 1 });
    setLocalBest(70, '羽蕎', 2);
    await loadBest(hooks());
    assert.equal(fs._get().player, '容亘');
  });

  it('7: pending 70 羽蕎，雲端已 70 Stay → pending 刪、雲端不變', async () => {
    fs._set({ score: 70, player: 'Stay', at: 5 });
    mem.set(PENDING_KEY, JSON.stringify({ score: 70, player: '羽蕎', at: 1 }));
    mem.set(MIGRATED_KEY, JSON.stringify('1'));
    await loadBest(hooks());
    assert.equal(fs._get().player, 'Stay');
    assert.equal(getPending(), null);
  });

  it('8: 0 分不建雲端文件', async () => {
    await loadBest(hooks());
    setLocalBest(0, '羽蕎');
    await submitScore(0, '羽蕎');
    assert.equal(fs._get(), null);
    assert.equal(getPending(), null);
  });
});
