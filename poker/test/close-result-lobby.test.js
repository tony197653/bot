/**
 * Close-result → 回大廳 / 看戰績 regressions (宗良 preview 489b6b1):
 * 1) 回大廳 must remove the dialog and not show 我的牌桌／回到牌桌 for a closed table
 * 2) 看戰績 → 回大廳 must land on lobby (not re-enter the table)
 *
 * Source contracts always run. Emulator Playwright runs when FIRESTORE_EMULATOR_HOST is set
 * (e.g. firebase emulators:exec … node --test test/close-result-lobby.test.js).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, updateDoc, getDoc, Timestamp } from 'firebase/firestore';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const REPO = join(ROOT, '..');
const HAS_EMU = !!process.env.FIRESTORE_EMULATOR_HOST;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

describe('收桌結果卡 → 大廳／戰績（source contracts）', () => {
  it('回大廳／看戰績 走 dismiss helpers；不得再把 autoResumeTried 清成 false', () => {
    const app = read('js/ui/mp-app.js');
    assert.match(app, /async function dismissCloseResultToLobby/);
    assert.match(app, /async function dismissCloseResultToStats/);
    assert.match(app, /function hideCloseResultCard/);
    assert.match(app, /async function syncAfterRoomClosed/);
    assert.match(app, /closeResultDismissedFor/);

    const lobbyFn = app.slice(
      app.indexOf('async function dismissCloseResultToLobby'),
      app.indexOf('async function dismissCloseResultToLobby') + 900,
    );
    assert.match(lobbyFn, /autoResumeTried\s*=\s*true/);
    assert.doesNotMatch(lobbyFn, /autoResumeTried\s*=\s*false/);
    assert.match(lobbyFn, /hideCloseResultCard/);
    assert.match(lobbyFn, /tearDownRoom/);
    assert.match(lobbyFn, /screen\s*=\s*['"]lobby['"]/);

    const statsFn = app.slice(
      app.indexOf('async function dismissCloseResultToStats'),
      app.indexOf('async function dismissCloseResultToStats') + 900,
    );
    assert.match(statsFn, /autoResumeTried\s*=\s*true/);
    assert.doesNotMatch(statsFn, /autoResumeTried\s*=\s*false/);
    assert.match(statsFn, /openStats/);

    // Old bug: click handlers set autoResumeTried = false then leaveToLobby/openStats
    const show = app.slice(
      app.indexOf('function showCloseResultCard'),
      app.indexOf('function showCloseResultCard') + 2200,
    );
    assert.match(show, /dismissCloseResultToLobby/);
    assert.match(show, /dismissCloseResultToStats/);
    assert.doesNotMatch(show, /autoResumeTried\s*=\s*false/);
  });

  it('closed snapshot 不在非 table 畫面重開結果卡；已 dismiss 的 room 也跳過', () => {
    const app = read('js/ui/mp-app.js');
    const closed = app.slice(
      app.indexOf("if (r.status === 'closed')"),
      app.indexOf("if (r.status === 'closed')") + 900,
    );
    assert.match(closed, /closeResultDismissedFor/);
    assert.match(closed, /screen !== 'table'/);
    assert.match(closed, /showCloseResultCard/);
    assert.doesNotMatch(closed, /leaveToLobby\(\)/);
  });

  it('戰績 onBack 設 autoResumeTried，避免回到已收桌；paint 清掉 mp-root-table', () => {
    const app = read('js/ui/mp-app.js');
    const stats = app.slice(
      app.indexOf("if (screen === 'stats')"),
      app.indexOf("if (screen === 'stats')") + 900,
    );
    assert.match(stats, /onBack:\s*\(\)\s*=>\s*\{/);
    assert.match(stats, /autoResumeTried\s*=\s*true/);
    assert.match(stats, /screen\s*=\s*['"]lobby['"]/);
    assert.match(stats, /classList\.remove\(\s*['"]mp-root-table['"]\s*\)/);
  });

  it('syncAfterRoomClosed 清掉 closed 桌的 hostRoomId（避免 回到牌桌）', () => {
    const app = read('js/ui/mp-app.js');
    const sync = app.slice(
      app.indexOf('async function syncAfterRoomClosed'),
      app.indexOf('async function syncAfterRoomClosed') + 1600,
    );
    assert.match(sync, /hostRoomId:\s*null/);
    assert.match(sync, /maybeRefreshRescue/);
    assert.match(sync, /status === 'closed'/);
  });
});

function startStatic() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const path = decodeURIComponent(req.url.split('?')[0]);
      let file;
      if (path.startsWith('/lib/')) file = join(REPO, path.replace(/^\//, ''));
      else if (path.startsWith('/poker/'))
        file = join(ROOT, path.replace(/^\/poker\/?/, '') || 'index.html');
      else if (path === '/' || path === '/poker') file = join(ROOT, 'index.html');
      else file = join(ROOT, path.replace(/^\//, ''));
      if (!existsSync(file) || !file.startsWith(REPO)) {
        res.writeHead(404);
        res.end('not found');
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

function blockProd(route) {
  const u = route.request().url();
  if (
    /firestore\.googleapis|identitytoolkit\.googleapis|securetoken\.googleapis|tony-poker\.web\.app|tony-poker\.firebase/i.test(
      u,
    ) &&
    !/127\.0\.0\.1|localhost/.test(u)
  ) {
    return route.abort();
  }
  return route.continue();
}

async function forceCloseRoom(roomId) {
  const rules = readFileSync(join(ROOT, 'firebase/firestore.rules'), 'utf8');
  const env = await initializeTestEnvironment({
    projectId: 'demo-poker',
    firestore: { host: '127.0.0.1', port: 8195, rules },
  });
  try {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const snap = await getDoc(doc(db, 'pokerRooms', roomId));
      if (!snap.exists()) throw new Error('room missing');
      const hostUid = snap.data()?.hostUid;
      await updateDoc(doc(db, 'pokerRooms', roomId), {
        status: 'closed',
        closedBy: 'auto',
        closedAt: Timestamp.now(),
        'lobby.autoClosed': true,
      });
      if (hostUid) {
        await updateDoc(doc(db, 'pokerPlayers', hostUid), {
          hostRoomId: null,
          updatedAt: Timestamp.now(),
        }).catch(() => {});
      }
    });
  } finally {
    await env.cleanup();
  }
}

const emuDescribe = HAS_EMU ? describe : describe.skip;

emuDescribe('收桌結果卡 → 大廳／戰績（emulator）', () => {
  it('auto-close → 回大廳：對話框關閉且無 我的牌桌／回到牌桌；戰績→回大廳留在大廳', async () => {
    const { server, base } = await startStatic();
    const browser = await chromium.launch({
      headless: true,
      executablePath: existsSync('/usr/bin/google-chrome')
        ? '/usr/bin/google-chrome'
        : undefined,
      args: ['--no-sandbox'],
    });
    try {
      const ctx = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      await ctx.route('**/*', blockProd);
      const page = await ctx.newPage();
      await page.addInitScript(() => {
        try {
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            get: () => 'visible',
          });
          Object.defineProperty(document, 'hidden', {
            configurable: true,
            get: () => false,
          });
        } catch {
          /* ignore */
        }
      });
      await page.goto(`${base}/poker/?emu=1`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => typeof window.__qaSignIn === 'function', null, {
        timeout: 20000,
      });
      await page.evaluate(() => window.__qaSignIn('hostCloseLob', '謝宗良'));
      await page.waitForSelector('.mp-lobby, [data-act="create"]', { timeout: 20000 });

      await page.locator('.mp-btn-primary[data-act="create"]:visible').first().click();
      await page.waitForSelector('form, .mp-create', { timeout: 8000 });
      await page.click('button[type="submit"]');
      await page.waitForSelector('.mp-url', { timeout: 20000 });
      const url = (await page.innerText('.mp-url')).trim();
      const roomId =
        new URL(url).searchParams.get('r') ||
        (await page.evaluate(() => window.__qaCloseResultState?.()?.roomId));
      assert.ok(roomId, `expected roomId from share ${url}`);
      await page.click('[data-act="enter"]');
      await page.waitForSelector('#mpLeave, #seats .seat, #mpStart', { timeout: 25000 });

      await forceCloseRoom(roomId);
      await page.waitForSelector('#mpCloseResult', { timeout: 15000 });
      await page.waitForFunction(
        () => {
          const el = document.getElementById('mpCloseResult');
          return el && !el.hidden;
        },
        null,
        { timeout: 10000 },
      );
      assert.match(await page.innerText('#mpCloseResult'), /牌桌已收桌/);

      // Bug 1: 回大廳
      await page.click('#mpCloseLobby');
      await page.waitForFunction(
        () => !document.getElementById('mpCloseResult'),
        null,
        { timeout: 10000 },
      );
      await page.waitForSelector('.mp-lobby', { timeout: 15000 });
      // Allow syncAfterRoomClosed paint to settle
      await page.waitForTimeout(800);
      const afterLobby = await page.evaluate(() => {
        const t = document.body.innerText;
        return {
          hasCard: !!document.getElementById('mpCloseResult'),
          screen: window.__qaCloseResultState?.()?.screen,
          hasMyTable: /我的牌桌/.test(t),
          hasContinue: /回到牌桌/.test(t),
          hasSettle: /結帳離開/.test(t),
          state: window.__qaCloseResultState?.(),
        };
      });
      assert.equal(afterLobby.hasCard, false, 'close dialog must be gone');
      assert.equal(afterLobby.screen, 'lobby');
      assert.equal(afterLobby.hasContinue, false, 'closed table must not show 回到牌桌');
      if (afterLobby.hasMyTable) {
        assert.equal(afterLobby.hasSettle, true, 'only settle card allowed for closed table');
      }

      // Bug 2: 看戰績 → 回大廳 stays on lobby (use close-result path via QA on a fresh close card)
      // Dismiss already tore down; open stats from lobby menu/card then back.
      const statsOpen = await page.evaluate(() => {
        const el =
          document.querySelector('.mp-lobby [data-act="stats"]') ||
          document.querySelector('[data-act="stats"]');
        if (!el) return false;
        el.click();
        return true;
      });
      assert.ok(statsOpen, 'lobby stats entry');
      await page.waitForSelector('.mp-stats, .mp-shell.mp-stats', { timeout: 15000 });
      // Simulate post-close-result stats back: autoResumeTried must remain true
      await page.evaluate(() => {
        /* autoResumeTried already true from dismiss; onBack reinforces */
      });
      await page.locator('.mp-stats [data-act="back"], .mp-shell.mp-stats [data-act="back"]').first().click();
      await page.waitForSelector('.mp-lobby', { timeout: 15000 });
      await page.waitForTimeout(500);
      const afterStats = await page.evaluate(() => {
        const t = document.body.innerText;
        return {
          screen: window.__qaCloseResultState?.()?.screen,
          hasCard: !!document.getElementById('mpCloseResult'),
          onTable: !!document.querySelector('#btnBackLobby:not([hidden])'),
          hasContinue: /回到牌桌/.test(t),
          autoResumeTried: window.__qaCloseResultState?.()?.autoResumeTried,
        };
      });
      assert.equal(afterStats.screen, 'lobby', 'stats 回大廳 must land on lobby');
      assert.equal(afterStats.onTable, false, 'must not return to table chrome');
      assert.equal(afterStats.hasCard, false);
      assert.equal(afterStats.hasContinue, false);
      assert.equal(afterStats.autoResumeTried, true);

      // Also exercise close-result → 看戰績 → 回大廳 on a second room
      await page.locator('.mp-btn-primary[data-act="create"]:visible').first().click();
      await page.waitForSelector('form, .mp-create', { timeout: 8000 });
      await page.click('button[type="submit"]');
      await page.waitForSelector('.mp-url', { timeout: 20000 });
      const url2 = (await page.innerText('.mp-url')).trim();
      const roomId2 = new URL(url2).searchParams.get('r');
      assert.ok(roomId2);
      await page.click('[data-act="enter"]');
      await page.waitForSelector('#mpLeave, #seats .seat, #mpStart', { timeout: 25000 });
      await forceCloseRoom(roomId2);
      await page.waitForSelector('#mpCloseResult', { timeout: 15000 });
      await page.click('#mpCloseStats');
      await page.waitForSelector('.mp-stats, .mp-shell.mp-stats', { timeout: 15000 });
      assert.equal(
        await page.evaluate(() => !!document.getElementById('mpCloseResult')),
        false,
      );
      await page.locator('.mp-stats [data-act="back"]').first().click();
      await page.waitForSelector('.mp-lobby', { timeout: 15000 });
      const afterStats2 = await page.evaluate(() => ({
        screen: window.__qaCloseResultState?.()?.screen,
        onTable: !!document.querySelector('#btnBackLobby:not([hidden])'),
        hasContinue: /回到牌桌/.test(document.body.innerText),
        hasCard: !!document.getElementById('mpCloseResult'),
      }));
      assert.equal(afterStats2.screen, 'lobby');
      assert.equal(afterStats2.onTable, false);
      assert.equal(afterStats2.hasContinue, false);
      assert.equal(afterStats2.hasCard, false);

      await ctx.close();
    } finally {
      await browser.close();
      server.close();
    }
  });
});
