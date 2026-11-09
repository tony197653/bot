/**
 * Close-result → 回大廳 must leave a CLEAN lobby (no 我的牌桌／已收桌／結帳離開).
 * Closing settles chips into bank (idempotent); never double-credit.
 *
 * Source contracts always run. Emulator Playwright runs when FIRESTORE_EMULATOR_HOST is set.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import {
  doc,
  updateDoc,
  getDoc,
  Timestamp,
  collection,
  getDocs,
} from 'firebase/firestore';

// Emulator target (defaults = shared demo-poker on 8195/9099). Override for a private emulator:
// POKER_EMU_PROJECT=demo-xxx POKER_EMU_FS_PORT=8395 POKER_EMU_AUTH_PORT=9399
const EMU_PROJECT = process.env.POKER_EMU_PROJECT || 'demo-poker';
const EMU_FS_PORT = Number(process.env.POKER_EMU_FS_PORT || 8195);
const EMU_AUTH_PORT = Number(process.env.POKER_EMU_AUTH_PORT || 9099);
function emuServe(file) {
  const body = readFileSync(file);
  if (!file.endsWith('js/net/firebase-config.js')) return body;
  return String(body)
    .replace("projectId: 'demo-poker'", `projectId: '${EMU_PROJECT}'`)
    .replace('auth: 9099, firestore: 8195', `auth: ${EMU_AUTH_PORT}, firestore: ${EMU_FS_PORT}`);
}


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
    assert.match(app, /silentlySettleClosedBinding/);
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

    const show = app.slice(
      app.indexOf('function showCloseResultCard'),
      app.indexOf('function showHostAloneLeaveDialog'),
    );
    assert.match(show, /dismissCloseResultToLobby/);
    assert.match(show, /dismissCloseResultToStats/);
    assert.doesNotMatch(show, /autoResumeTried\s*=\s*false/);
  });

  it('closed snapshot 不在非 table 畫面重開結果卡；已 dismiss 的 room 也跳過', () => {
    const app = read('js/ui/mp-app.js');
    const closed = app.slice(
      app.indexOf("if (r.status === 'closed')"),
      app.indexOf("if (r.status === 'closed')") + 2800,
    );
    assert.match(closed, /closeResultDismissedFor/);
    assert.match(closed, /screen !== 'table'/);
    assert.match(closed, /showCloseResultCard/);
    assert.match(closed, /silentlySettleClosedBinding/);
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

  it('closed 桌改靜默結帳，不得再設 rescueReason closed／結帳離開卡', () => {
    const app = read('js/ui/mp-app.js');
    const led = read('js/net/ledger.js');
    assert.match(led, /export async function settleClosedRoomBinding/);
    assert.match(app, /silentlySettleClosedBinding/);
    assert.match(app, /settleClosedRoomBinding/);
    const refresh = app.slice(
      app.indexOf('async function maybeRefreshRescue'),
      app.indexOf('async function maybeRefreshRescue') + 2200,
    );
    assert.match(refresh, /silentlySettleClosedBinding/);
    assert.doesNotMatch(refresh, /rescueReason = 'closed'/);
    const silent = app.slice(
      app.indexOf('async function silentlySettleClosedBinding'),
      app.indexOf('async function silentlySettleClosedBinding') + 2200,
    );
    assert.match(silent, /hostRoomId:\s*null/);
    assert.match(silent, /status === 'closed'/);
  });

  it('lobby closed-pointer 不得無條件 paint()（防無限重繪）', () => {
    const app = read('js/ui/mp-app.js');
    // Throttled lobby follow-up after maybeRefreshRescue (bind change / ~30s)
    assert.match(app, /lobbyIdleCheckNeeded/);
    const start = app.indexOf('lobbyIdleCheckNeeded() && !lobbyIdleCheckInflight');
    assert.ok(start > 0, 'lobby idle check gate');
    const block = app.slice(start, start + 2800);
    assert.match(block, /maybeRefreshRescue\(/);
    assert.match(block, /settledChanged/);
    assert.match(block, /lobbyBindKey/);
    assert.match(block, /changed \|\| settledChanged/);
    // Must re-read after maybeAutoCloseIdleRoom (stale open snapshot)
    assert.match(block, /didClose/);
    // No bare unconditional re-paint on closed pointer
    assert.doesNotMatch(
      block,
      /status === 'closed'[\s\S]{0,200}if \(screen === 'lobby'\) paint\(\);/,
    );
    assert.doesNotMatch(app, /return prev !== rescueOk \|\| true/);
  });

  it('doJoin 成功／失敗都在 finally 清掉 joining', () => {
    const app = read('js/ui/mp-app.js');
    const fn = app.slice(
      app.indexOf('async function doJoin'),
      app.indexOf('async function doJoin') + 1600,
    );
    assert.match(fn, /finally\s*\{/);
    assert.match(fn, /joining\s*=\s*false/);
    // success must not return before finally — finally wraps the try
    const finallyAt = fn.indexOf('finally');
    const joiningFalseAt = fn.indexOf('joining = false', finallyAt);
    assert.ok(finallyAt > 0 && joiningFalseAt > finallyAt);
  });

  it('close-result 金額可升級、不會被後到的 0 蓋掉；closed 仍可 paint lobby', () => {
    const app = read('js/ui/mp-app.js');
    const show = app.slice(
      app.indexOf('function showCloseResultCard'),
      app.indexOf('function showCloseResultCard') + 1800,
    );
    assert.match(show, /closeResultChipsShown/);
    assert.match(show, /n > closeResultChipsShown/);
    assert.match(app, /pendingCloseReturnChips/);
    assert.match(app, /lastKnownSelfTableChips/);
    assert.match(app, /lobbyClosedSynced/);
    const closed = app.slice(
      app.indexOf("if (r.status === 'closed')"),
      app.indexOf("if (r.status === 'closed')") + 2200,
    );
    assert.match(closed, /lobbyClosedSynced/);
    assert.match(closed, /screen !== 'lobby'[\s\S]*paint\(\)/);
    // Soft-detach removed — ‹ 大廳 uses confirm leave
    assert.match(app, /showLeaveTableConfirm/);
    assert.doesNotMatch(app, /Soft detach/);
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
      res.end(emuServe(file));
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

async function withRulesDisabled(fn) {
  const rules = readFileSync(join(ROOT, 'firebase/firestore.rules'), 'utf8');
  const env = await initializeTestEnvironment({
    projectId: EMU_PROJECT,
    firestore: { host: '127.0.0.1', port: EMU_FS_PORT, rules },
  });
  try {
    let out;
    await env.withSecurityRulesDisabled(async (ctx) => {
      out = await fn(ctx);
    });
    return out;
  } finally {
    await env.cleanup();
  }
}

async function forceCloseRoom(roomId) {
  await withRulesDisabled(async (ctx) => {
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
}

async function readPlayerDocForRoomHost(roomId) {
  return withRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const room = await getDoc(doc(db, 'pokerRooms', roomId));
    const hostUid = room.data()?.hostUid;
    assert.ok(hostUid, 'hostUid');
    const p = await getDoc(doc(db, 'pokerPlayers', hostUid));
    const led = await getDocs(collection(db, 'pokerPlayers', hostUid, 'ledger'));
    return {
      uid: hostUid,
      player: p.data(),
      ledgerN: led.size,
      cashouts: led.docs.filter((d) => d.data()?.type === 'cashout').length,
    };
  });
}

const emuDescribe = HAS_EMU ? describe : describe.skip;

emuDescribe('收桌 → 回大廳 clean lobby（emulator）', () => {
  it('auto-close → 回大廳：無我的牌桌／結帳離開；bank 正確；再結一次不雙重入帳', async () => {
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
      await page.evaluate(() => window.__qaSignIn('hostCleanLob', '謝宗良'));
      await page.waitForSelector('.mp-lobby, [data-act="create"]', { timeout: 20000 });

      await page.locator('.mp-btn-primary[data-act="create"]:visible').first().click();
      await page.waitForSelector('form, .mp-create', { timeout: 8000 });
      await page.click('button[type="submit"]');
      await page.waitForSelector('.mp-url', { timeout: 20000 });
      const url = (await page.innerText('.mp-url')).trim();
      const roomId = new URL(url).searchParams.get('r');
      assert.ok(roomId);
      await page.click('[data-act="enter"]');
      await page.waitForSelector('#mpLeave, #seats .seat, #mpStart', { timeout: 25000 });

      const before = await readPlayerDocForRoomHost(roomId);
      const stack = await withRulesDisabled(async (c) => {
        const db = c.firestore();
        const r = (await getDoc(doc(db, 'pokerRooms', roomId))).data();
        const seat = r.seatUids.indexOf(before.uid);
        return seat >= 0 ? Number(r.stacks[seat]) || 0 : Number(before.player?.inPlay) || 0;
      });
      const bankBefore = Number(before.player?.bank) || 0;
      const inPlayBefore = Number(before.player?.inPlay) || 0;
      const totalBefore = bankBefore + inPlayBefore;
      const cashoutsBefore = before.cashouts;

      await forceCloseRoom(roomId);
      await page.waitForSelector('#mpCloseResult', { timeout: 15000 });
      assert.match(await page.innerText('#mpCloseResult'), /牌桌已收桌/);

      await page.click('#mpCloseLobby');
      await page.waitForFunction(() => !document.getElementById('mpCloseResult'), null, {
        timeout: 10000,
      });
      await page.waitForSelector('.mp-lobby', { timeout: 15000 });
      await page.evaluate(() => window.__qaResetPaintCount?.());
      await page.waitForTimeout(2500);
      const paints = await page.evaluate(
        () => Number(window.__qaPaintCount) || 0,
      );
      // Steady lobby must not spin (was ~35–85/s). Allow a few async follow-ups.
      assert.ok(paints < 25, `lobby paint count bounded, got ${paints}`);

      const text = await page.innerText('body');
      assert.equal(/我的牌桌/.test(text), false, 'no 我的牌桌 after auto-close');
      assert.equal(/結帳離開/.test(text), false, 'no 結帳離開 after auto-close');
      assert.equal(/已收桌/.test(text), false, 'no 已收桌 after auto-close');
      assert.equal(/回到牌桌/.test(text), false, 'no 回到牌桌 after auto-close');

      const after = await readPlayerDocForRoomHost(roomId);
      assert.equal(after.player?.tableRoomId ?? null, null);
      assert.equal(Number(after.player?.inPlay) || 0, 0);
      const bankAfter = Number(after.player?.bank) || 0;
      assert.equal(bankAfter, totalBefore, `bank ${bankAfter} === totalBefore ${totalBefore}`);
      assert.ok(
        after.cashouts >= cashoutsBefore + (stack > 0 || inPlayBefore > 0 ? 1 : 0) ||
          after.cashouts === cashoutsBefore + 1 ||
          bankAfter === totalBefore,
        'cashout ledger written or balance already correct',
      );

      // Idempotent: dismiss path / refresh must not double-credit
      await page.evaluate(async () => {
        await window.__qaRefreshRescue?.();
      });
      await page.waitForTimeout(500);
      const again = await readPlayerDocForRoomHost(roomId);
      assert.equal(Number(again.player?.bank) || 0, bankAfter, 'no double credit');
      assert.equal(again.cashouts, after.cashouts, 'no extra cashout ledger');

      // Stats → 回大廳 stays clean
      const statsOpen = await page.evaluate(() => {
        const el =
          document.querySelector('.mp-lobby [data-act="stats"]') ||
          document.querySelector('[data-act="stats"]');
        if (!el) return false;
        el.click();
        return true;
      });
      assert.ok(statsOpen);
      await page.waitForSelector('.mp-stats, .mp-shell.mp-stats', { timeout: 15000 });
      await page.locator('.mp-stats [data-act="back"]').first().click();
      await page.waitForSelector('.mp-lobby', { timeout: 15000 });
      const t2 = await page.innerText('body');
      assert.equal(/我的牌桌|結帳離開|已收桌|回到牌桌/.test(t2), false);

      await ctx.close();
    } finally {
      await browser.close();
      server.close();
    }
  });

  it('manual 收桌：對話框金額＝實際帶回；回大廳 clean', async () => {
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
      page.on('dialog', (d) => d.accept());
      await page.goto(`${base}/poker/?emu=1`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => typeof window.__qaSignIn === 'function', null, {
        timeout: 20000,
      });
      await page.evaluate(() => window.__qaSignIn('hostManualClose', '謝宗良'));
      await page.waitForSelector('.mp-lobby, [data-act="create"]', { timeout: 20000 });

      await page.locator('.mp-btn-primary[data-act="create"]:visible').first().click();
      await page.waitForSelector('form, .mp-create', { timeout: 8000 });
      await page.click('button[type="submit"]');
      await page.waitForSelector('.mp-url', { timeout: 20000 });
      const roomId = new URL((await page.innerText('.mp-url')).trim()).searchParams.get('r');
      assert.ok(roomId);
      await page.click('[data-act="enter"]');
      await page.waitForSelector('#mpLeave, #seats .seat, #mpStart', { timeout: 25000 });

      const before = await readPlayerDocForRoomHost(roomId);
      const totalBefore =
        (Number(before.player?.bank) || 0) + (Number(before.player?.inPlay) || 0);

      const stackBefore = await withRulesDisabled(async (c) => {
        const db = c.firestore();
        const r = (await getDoc(doc(db, 'pokerRooms', roomId))).data();
        const seat = r.seatUids.indexOf(before.uid);
        return seat >= 0 ? Number(r.stacks[seat]) || 0 : Number(before.player?.inPlay) || 0;
      });
      assert.ok(stackBefore > 0, `expected seated stack, got ${stackBefore}`);

      // Open ⋯ menu → 收桌
      await page.evaluate(() => {
        document.getElementById('btnMenu')?.click();
        document.getElementById('mpBtnCloseRoom')?.click();
      });
      await page.click('#mpCloseConfirmOk');
      await page.waitForSelector('#mpCloseResult', { timeout: 20000 });
      await page.waitForSelector('#mpCloseResult[data-state="done"]', { timeout: 20000 });
      const dialogText = await page.innerText('#mpCloseResult');
      assert.match(
        dialogText,
        new RegExp(`牌桌已收桌，你帶回 ${stackBefore.toLocaleString('en-US')}`),
        `dialog must show returned ${stackBefore}, got: ${dialogText}`,
      );
      assert.doesNotMatch(dialogText, /你帶回 0 籌碼/);

      await page.click('#mpCloseLobby');
      await page.waitForSelector('.mp-lobby', { timeout: 15000 });
      await page.waitForTimeout(1000);

      const text = await page.innerText('body');
      assert.equal(/我的牌桌|結帳離開|已收桌|回到牌桌/.test(text), false, 'clean lobby');

      const after = await readPlayerDocForRoomHost(roomId);
      assert.equal(after.player?.tableRoomId ?? null, null);
      assert.equal(Number(after.player?.inPlay) || 0, 0);
      assert.equal(Number(after.player?.bank) || 0, totalBefore);

      await ctx.close();
    } finally {
      await browser.close();
      server.close();
    }
  });

  it('‹ 大廳 confirm：host／guest 離開後 clean lobby（無我的牌桌）', async () => {
    const { server, base } = await startStatic();
    const browser = await chromium.launch({
      headless: true,
      executablePath: existsSync('/usr/bin/google-chrome')
        ? '/usr/bin/google-chrome'
        : undefined,
      args: ['--no-sandbox'],
    });
    const alwaysVis = () => {
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
    };
    try {
      const hostCtx = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      await hostCtx.addInitScript(alwaysVis);
      await hostCtx.route('**/*', blockProd);
      const host = await hostCtx.newPage();
      host.on('dialog', (d) => d.accept());
      await host.goto(`${base}/poker/?emu=1`, { waitUntil: 'domcontentloaded' });
      await host.waitForFunction(() => typeof window.__qaSignIn === 'function', null, {
        timeout: 20000,
      });
      await host.evaluate(() => window.__qaSignIn('hostLeaveConf', '房主'));
      await host.waitForSelector('.mp-lobby', { timeout: 20000 });
      await host.locator('.mp-btn-primary[data-act="create"]:visible').first().click();
      await host.waitForSelector('form, .mp-create', { timeout: 8000 });
      await host.click('button[type="submit"]');
      await host.waitForSelector('.mp-url', { timeout: 20000 });
      const share = (await host.innerText('.mp-url')).trim();
      const roomId = new URL(share).searchParams.get('r');
      assert.ok(roomId, '單桌房間存在');
      await host.click('[data-act="enter"]');
      await host.waitForSelector('#mpLeave, #seats .seat, #mpStart', { timeout: 25000 });

      const guestCtx = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      await guestCtx.addInitScript(alwaysVis);
      await guestCtx.route('**/*', blockProd);
      const guest = await guestCtx.newPage();
      await guest.goto(`${base}/poker/?emu=1`, { waitUntil: 'domcontentloaded' });
      await guest.waitForFunction(() => typeof window.__qaSignIn === 'function', null, {
        timeout: 20000,
      });
      await guest.evaluate(() => window.__qaSignIn('guestLeaveConf', '訪客'));
      await guest.waitForSelector('.mp-lobby', { timeout: 20000 });
      await guest.locator('[data-act="open-table"]:visible, .mp-btn-primary[data-act="create"]:visible').first().click();
      await guest.waitForSelector('#btnBackLobby:not([hidden]), #seats, #mpLeave', {
        timeout: 20000,
      });
      for (let attempt = 0; attempt < 3 && !(await guest.locator('#mpLeave').count()); attempt++) {
        await guest
          .evaluate(() => document.querySelector('.mp-empty-seat')?.click())
          .catch(() => {});
        await guest.waitForSelector('#mpBuyinPicker [data-confirm]', { timeout: 5000 }).catch(() => {});
        await guest.evaluate(() => document.querySelector('#mpBuyinPicker [data-confirm]')?.click()).catch(() => {});
        await guest.waitForSelector('#mpLeave', { timeout: 8000 }).catch(() => {});
      }
      assert.ok(await guest.locator('#mpLeave').count(), 'guest seated');

      // Guest cancel confirm → stay at table
      await guest.evaluate(() => window.__qaShowLeaveConfirm?.());
      await guest.waitForSelector('#mpLeaveConfirm:not([hidden])', { timeout: 5000 });
      await guest.evaluate(() => window.__qaLeaveConfirmClick?.('cancel'));
      await guest.waitForSelector('#mpLeaveConfirm[hidden], #mpLeave', { timeout: 5000 });
      assert.ok(await guest.locator('#mpLeave').count(), 'guest still at table after cancel');

      const guestBefore = await withRulesDisabled(async (c) => {
        const db = c.firestore();
        const r = (await getDoc(doc(db, 'pokerRooms', roomId))).data();
        const uid = (r.seatUids || []).find((u) => u && u !== r.hostUid);
        assert.ok(uid, 'guest uid');
        const p = (await getDoc(doc(db, 'pokerPlayers', uid))).data();
        return {
          uid,
          total: (Number(p.bank) || 0) + (Number(p.inPlay) || 0),
        };
      });

      // Guest confirm leave → clean lobby, no 我的牌桌
      await guest.evaluate(() => window.__qaLeaveToLobby?.());
      await guest.waitForSelector('.mp-lobby', { timeout: 25000 });
      await guest.waitForTimeout(800);
      const guestText = await guest.innerText('body');
      assert.equal(
        /我的牌桌|回到牌桌|入座中|結帳離開|已收桌/.test(guestText),
        false,
        `guest lobby must be clean, got: ${guestText.slice(0, 200)}`,
      );
      const guestAfter = await withRulesDisabled(async (c) => {
        const db = c.firestore();
        const p = (await getDoc(doc(db, 'pokerPlayers', guestBefore.uid))).data();
        return {
          tableRoomId: p.tableRoomId ?? null,
          inPlay: Number(p.inPlay) || 0,
          bank: Number(p.bank) || 0,
        };
      });
      assert.equal(guestAfter.tableRoomId, null);
      assert.equal(guestAfter.inPlay, 0);
      assert.equal(guestAfter.bank, guestBefore.total);

      await guestCtx.close();

      // Host confirm leave (= 收桌) → clean lobby
      const beforeH = await readPlayerDocForRoomHost(roomId);
      const totalH =
        (Number(beforeH.player?.bank) || 0) + (Number(beforeH.player?.inPlay) || 0);
      await host.evaluate(() => window.__qaLeaveToLobby?.());
      await host.waitForSelector('.mp-lobby', { timeout: 25000 });
      await host.waitForTimeout(800);
      const hostText = await host.innerText('body');
      assert.equal(
        /我的牌桌|回到牌桌|入座中|結帳離開|已收桌/.test(hostText),
        false,
        'host lobby clean after confirm leave',
      );
      const afterH = await readPlayerDocForRoomHost(roomId);
      assert.equal(afterH.player?.tableRoomId ?? null, null);
      assert.equal(Number(afterH.player?.inPlay) || 0, 0);
      assert.equal(Number(afterH.player?.bank) || 0, totalH);

      await hostCtx.close();
    } finally {
      await browser.close();
      server.close();
    }
  });

  it('單桌入口 → 回大廳 → 再次由單桌入口加入（joining 不得卡在加入中）', async () => {
    const { server, base } = await startStatic();
    const browser = await chromium.launch({
      headless: true,
      executablePath: existsSync('/usr/bin/google-chrome')
        ? '/usr/bin/google-chrome'
        : undefined,
      args: ['--no-sandbox'],
    });
    const alwaysVis = () => {
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
    };
    try {
      const hostCtx = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      await hostCtx.addInitScript(alwaysVis);
      await hostCtx.route('**/*', blockProd);
      const host = await hostCtx.newPage();
      await host.goto(`${base}/poker/?emu=1`, { waitUntil: 'domcontentloaded' });
      await host.waitForFunction(() => typeof window.__qaSignIn === 'function', null, {
        timeout: 20000,
      });
      await host.evaluate(() => window.__qaSignIn('hostJoin2', '房主'));
      await host.waitForSelector('.mp-lobby', { timeout: 20000 });
      await host.locator('.mp-btn-primary[data-act="create"]:visible').first().click();
      await host.waitForSelector('form, .mp-create', { timeout: 8000 });
      await host.click('button[type="submit"]');
      await host.waitForSelector('.mp-url', { timeout: 20000 });
      const share = (await host.innerText('.mp-url')).trim();
      const roomId = new URL(share).searchParams.get('r');
      assert.ok(roomId, '單桌房間存在');
      await host.click('[data-act="enter"]');
      await host.waitForSelector('#mpLeave, #seats .seat, #mpStart', { timeout: 25000 });

      const guestCtx = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      await guestCtx.addInitScript(alwaysVis);
      await guestCtx.route('**/*', blockProd);
      const guest = await guestCtx.newPage();
      await guest.goto(`${base}/poker/?emu=1`, { waitUntil: 'domcontentloaded' });
      await guest.waitForFunction(() => typeof window.__qaSignIn === 'function', null, {
        timeout: 20000,
      });
      await guest.evaluate(() => window.__qaSignIn('guestJoin2', '訪客'));
      await guest.waitForSelector('.mp-lobby', { timeout: 20000 });

      // 由唯一牌桌入口加入；清單尚未返回時，開新牌桌也會加入 000。
      const tableEntry = () => guest.locator('[data-act="open-table"]:visible, .mp-btn-primary[data-act="create"]:visible').first();
      await tableEntry().click();
      await guest.waitForFunction(() => window.__qaCloseResultState?.()?.screen === 'table', null, {
        timeout: 20000,
      });
      assert.equal(
        await guest.evaluate(() => window.__qaJoining?.() === true),
        false,
        'joining cleared after first join',
      );

      // Soft leave to lobby without reload
      await guest.evaluate(() => window.__qaLeaveToLobby?.());
      await guest.waitForSelector('.mp-lobby', { timeout: 15000 });
      await guest.waitForTimeout(400);
      const stuck = await guest.evaluate(() => {
        const t = document.body.innerText;
        return {
          joining: window.__qaJoining?.() === true,
          statusJoining: /加入中/.test(t),
        };
      });
      assert.equal(stuck.joining, false, 'joining false on lobby');
      assert.equal(stuck.statusJoining, false, 'UI not stuck on 加入中');

      // 不重新載入，同一個 000 牌桌仍可再次進入。
      await tableEntry().click();
      await guest.waitForSelector('#btnBackLobby:not([hidden]), #seats, #mpLeave', {
        timeout: 20000,
      });
      assert.equal(
        await guest.evaluate(() => window.__qaJoining?.() === true),
        false,
        'joining cleared after second join',
      );
      assert.equal(
        await guest.evaluate(() => window.__qaCloseResultState?.()?.screen === 'table'),
        true,
        'second join reached table',
      );

      await guestCtx.close();
      await hostCtx.close();
    } finally {
      await browser.close();
      server.close();
    }
  });
});
