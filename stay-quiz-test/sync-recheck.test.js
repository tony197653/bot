/**
 * 複驗修正：403 重讀雲端；徽章占位不推擠再玩一次
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUIZ_ROOT = process.env.STAY_QUIZ_ROOT || join(__dirname, '../stay-quiz');

const { STORAGE_KEY, PENDING_KEY, MIGRATED_KEY } = await import(
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

/** 模擬「讀到舊值後 commit 被 403」再 getDoc 讀到新雲端 */
function createPermissionDeniedFs(initial, afterDeny) {
  let doc = initial;
  let denyNextSet = false;
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
      const snapData = doc ? { score: doc.score, player: doc.player, at: doc.at } : null;
      const tx = {
        get: async () => ({
          exists: () => !!snapData,
          data: () => snapData,
        }),
        set: () => {
          if (denyNextSet) {
            const err = Object.assign(new Error('evaluation error'), {
              code: 'permission-denied',
            });
            throw err;
          }
          // shouldn't reach if denied
        },
      };
      try {
        return await fn(tx);
      } catch (e) {
        if (e && e.code === 'permission-denied') {
          // 他機已寫入更高分
          doc = afterDeny;
          throw e;
        }
        throw e;
      }
    },
    armDenyOnWrite() {
      denyNextSet = true;
    },
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

describe('recheck: permission-denied recovery', () => {
  let lastDisplay;
  let consoleErrors;

  beforeEach(() => {
    mem.clear();
    installStorage();
    __resetSyncForTests();
    lastDisplay = null;
    consoleErrors = [];
    const orig = console.error;
    console.error = (...args) => {
      consoleErrors.push(args);
      orig.apply(console, args);
    };
  });

  function hooks() {
    return {
      getLocalBest: () => {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw).best : null;
      },
      setLocalBest: () => {},
      onDisplay: (b) => {
        lastDisplay = b;
      },
    };
  }

  it('submitScore 403 後重讀雲端並刷新，無 console.error', async () => {
    const fs = createPermissionDeniedFs(
      { score: 50, player: 'Stay', at: 1 },
      { score: 80, player: '容亘', at: 2 },
    );
    __injectFirestoreForTests(fs);
    await loadBest(hooks());
    assert.equal(lastDisplay.score, 50);
    mem.set(STORAGE_KEY, JSON.stringify({ best: { score: 70, player: '羽蕎', at: Date.now() } }));
    fs.armDenyOnWrite();
    await submitScore(70, '羽蕎');
    assert.equal(getCloudCache()?.score, 80);
    assert.equal(getCloudCache()?.player, '容亘');
    assert.equal(lastDisplay.score, 80);
    assert.equal(lastDisplay.player, '容亘');
    assert.equal(consoleErrors.length, 0);
  });

  it('flushPending 403 後重讀雲端、清 pending、無 console.error', async () => {
    const fs = createPermissionDeniedFs(
      { score: 50, player: 'Stay', at: 1 },
      { score: 90, player: '容亘', at: 9 },
    );
    __injectFirestoreForTests(fs);
    mem.set(PENDING_KEY, JSON.stringify({ score: 70, player: '羽蕎', at: 1 }));
    mem.set(MIGRATED_KEY, JSON.stringify('1'));
    fs.armDenyOnWrite();
    // loadBest → flushPending
    await loadBest(hooks());
    assert.equal(getPendingRecord(), null);
    assert.equal(getCloudCache()?.score, 90);
    assert.equal(lastDisplay.player, '容亘');
    assert.equal(consoleErrors.length, 0);
  });
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2',
};

function startServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      let path = decodeURIComponent(url.pathname);
      if (path === '/') path = '/index.html';
      const file = join(QUIZ_ROOT, path.replace(/^\//, ''));
      if (!file.startsWith(QUIZ_ROOT) || !existsSync(file) || statSync(file).isDirectory()) {
        res.writeHead(404);
        res.end('missing');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

describe('recheck: badge slot does not shift btnAgain', () => {
  it('online / offline / 500：初始與同步後 btnAgain top 不變', async () => {
    const { server, base } = await startServer();
    const browser = await chromium.launch({
      headless: true,
      args: ['--autoplay-policy=no-user-gesture-required'],
    });
    try {
      for (const mode of ['online', 'offline', '500']) {
        const context = await browser.newContext({ viewport: { width: 390, height: 800 } });
        // 永不打正式 Firestore
        if (mode === 'offline') {
          await context.route('**/*gstatic.com/**', (r) => r.abort());
          await context.route('**/*firebase*/**', (r) => r.abort());
          await context.route('**/*googleapis.com/**', (r) => r.abort());
        } else if (mode === '500') {
          await context.route('**/*googleapis.com/**', (r) =>
            r.fulfill({ status: 500, body: 'err' }),
          );
        } else {
          // online：SDK 可載，但 Firestore API 立即失敗（模擬短暫錯誤，不寫正式庫）
          await context.route('**/*googleapis.com/**', (r) => r.abort());
          await context.route('**/*firebaseio.com/**', (r) => r.abort());
        }
        const page = await context.newPage();
        await page.goto(`${base}/index.html?test=1`, { waitUntil: 'load' });
        await page.waitForFunction(
          () => document.querySelector('.btn-player') && !document.querySelector('.btn-player').disabled,
        );
        // 等可能的 CDN import 逾時／停用（offline）
        if (mode !== 'online') await page.waitForTimeout(500);
        await page.evaluate(() => {
          localStorage.setItem(
            'stayQuiz.v2',
            JSON.stringify({ best: { score: 50, player: 'Stay', at: Date.now() - 1000 } }),
          );
        });
        await page.reload({ waitUntil: 'load' });
        await page.waitForFunction(
          () => document.querySelector('.btn-player') && !document.querySelector('.btn-player').disabled,
        );
        await page.click('.btn-player[data-player="羽蕎"]');
        await page.waitForSelector('#screen-quiz.is-active');
        for (let i = 0; i < 10; i++) {
          await page.evaluate(() => {
            window.__stayQuiz.forceFirstSound();
            window.__stayQuiz.pickCorrect();
          });
          await page.waitForSelector('#btnNext:not([disabled]):not(.hidden)');
          await page.click('#btnNext');
        }
        await page.waitForSelector('#screen-result.is-active');
        const top0 = await page.evaluate(() => document.getElementById('btnAgain').getBoundingClientRect().top);
        // online／500：交易快速失敗；offline：可能等 import／tx 逾時
        await page.waitForTimeout(mode === 'offline' ? 5500 : 1200);
        const top1 = await page.evaluate(() => document.getElementById('btnAgain').getBoundingClientRect().top);
        assert.ok(Math.abs(top0 - top1) < 1, `${mode}: btnAgain moved ${top0} -> ${top1}`);
        await context.close();
      }
    } finally {
      await browser.close();
      server.close();
    }
  });
});
