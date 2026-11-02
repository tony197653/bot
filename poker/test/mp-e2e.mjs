/**
 * Multiplayer Playwright against Auth+Firestore emulators (demo-poker).
 * Never talks to production. Lobby top-bar checks at 360/390/1280; other flows at 390/1280.
 *
 * Run via: node firebase/run-mp-e2e.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, deleteDoc, Timestamp } from 'firebase/firestore';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const REPO = join(ROOT, '..');
const ART = existsSync('/opt/cursor/artifacts')
  ? '/opt/cursor/artifacts'
  : join(ROOT, 'test-artifacts');
mkdirSync(ART, { recursive: true });

/** Backdate room.updatedAt + host presence (rules-bypass; emulator only). */
async function emuBackdateHostGone(roomId, hostUid, msAgo = 11 * 60_000) {
  const rules = readFileSync(join(ROOT, 'firebase/firestore.rules'), 'utf8');
  const { getDoc } = await import('firebase/firestore');
  const env = await initializeTestEnvironment({
    projectId: 'demo-poker',
    firestore: { host: '127.0.0.1', port: 8195, rules },
  });
  const ago = Timestamp.fromMillis(Date.now() - msAgo);
  try {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      // Resolve real Firebase hostUid from room (QA string uid ≠ auth.uid)
      let uid = hostUid;
      try {
        const snap = await getDoc(doc(db, 'pokerRooms', roomId));
        if (snap.exists() && snap.data()?.hostUid) uid = snap.data().hostUid;
      } catch {
        /* keep arg */
      }
      await updateDoc(doc(db, 'pokerRooms', roomId), { updatedAt: ago });
      await setDoc(doc(db, 'pokerRooms', roomId, 'presence', uid), {
        beat: ago,
        vis: false,
      });
    });
  } finally {
    await env.cleanup();
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

function startStatic() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let path = decodeURIComponent(req.url.split('?')[0]);
      let file;
      if (path.startsWith('/lib/')) {
        file = join(REPO, path.replace(/^\//, ''));
      } else if (path.startsWith('/poker/')) {
        file = join(ROOT, path.replace(/^\/poker\/?/, '') || 'index.html');
      } else if (path === '/' || path === '/poker') {
        file = join(ROOT, 'index.html');
      } else {
        file = join(ROOT, path.replace(/^\//, ''));
      }
      if (!existsSync(file) || !file.startsWith(REPO)) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
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

async function makePlayer(browser, base, name, uid, viewport) {
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    isMobile: viewport.width < 700,
    hasTouch: viewport.width < 700,
  });
  await ctx.route('**/*', blockProd);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 200));
  });
  await page.goto(`${base}/poker/?emu=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.__qaSignIn === 'function', null, {
    timeout: 20000,
  });
  await page.evaluate(([u, n]) => window.__qaSignIn(u, n), [uid, name]);
  await page.waitForSelector('.mp-lobby, .mp-shell', { timeout: 20000 });
  return { ctx, page, name, uid, errors };
}

async function createAndShare(host) {
  await host.page.click('[data-act="create"]');
  await host.page.waitForSelector('form, .mp-create', { timeout: 8000 });
  await host.page.click('button[type="submit"]');
  await host.page.waitForSelector('.mp-url', { timeout: 20000 });
  const url = (await host.page.innerText('.mp-url')).trim();
  const parsed = new URL(url);
  const roomId = parsed.searchParams.get('r') || '';
  let code = parsed.searchParams.get('room') || '';
  if (!code) {
    const body = await host.page.innerText('body');
    // L7: 3-digit codes (legacy 6-digit still matched as fallback)
    code =
      (body.match(/\b(\d{3})\b/) || body.match(/(\d{3}\s?\d{3})/) || [])[1]?.replace(
        /\s/g,
        '',
      ) || '';
  }
  code = String(code).replace(/\D/g, '').slice(0, 3);
  if (!roomId) throw new Error(`createAndShare missing roomId from url=${url}`);
  if (code.length !== 3) throw new Error(`createAndShare bad code=${code} url=${url}`);
  await host.page.click('[data-act="enter"]');
  await host.page.waitForSelector('#app:not(.hidden), #seats', { timeout: 20000 });
  return { roomId, code, url };
}

async function joinViaLink(browser, base, name, uid, viewport, roomId, code) {
  const path = `/poker/?emu=1&room=${encodeURIComponent(code)}&r=${encodeURIComponent(roomId)}`;
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    isMobile: viewport.width < 700,
    hasTouch: viewport.width < 700,
  });
  await ctx.route('**/*', blockProd);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.__qaSignIn === 'function', null, {
    timeout: 20000,
  });
  await page.evaluate(([u, n]) => window.__qaSignIn(u, n), [uid, name]);
  await page.waitForSelector('#seats, .mp-lobby, .mp-ended', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2500);
  // Deep-link may land in lobby with continue card — enter table
  const cont = page.locator('[data-act="continue"], [data-act="enter"]');
  if (await cont.count()) {
    await cont.first().click().catch(() => {});
    await page.waitForTimeout(2000);
  }
  await page.waitForSelector('#seats', { timeout: 15000 }).catch(() => {});
  return { ctx, page, name, uid, errors };
}

async function sitIfNeeded(page) {
  for (let i = 0; i < 8; i++) {
    // Already seated: empty-seat hit targets only render for spectators
    if (!(await page.locator('.mp-empty-seat').count())) {
      if (await page.locator('#mpLeave, #mpFold, #mpStart, #mpCheck, #mpCall').count()) {
        return true;
      }
    }
    const seatedHint = await page.locator('#mpLeave, button:has-text("離座")').count();
    if (seatedHint) return true;

    const seatBtn = page.locator('.mp-empty-seat').first();
    if (await seatBtn.count()) {
      // Prefer a single DOM click — avoids double-sit "座位已被佔用" races
      const clicked = await page
        .evaluate(() => {
          const el = document.querySelector('.mp-empty-seat');
          if (!el) return false;
          el.click();
          return true;
        })
        .catch(() => false);
      if (!clicked) await seatBtn.click({ force: true }).catch(() => {});
    }
    await page.waitForTimeout(1400);
  }
  return (
    !(await page.locator('.mp-empty-seat').count()) ||
    !!(await page.locator('#mpLeave, #mpFold, #mpStart').count())
  );
}

async function startHand(host) {
  for (let i = 0; i < 8; i++) {
    // Wait until host UI shows 2+ seated (開始第一手（N人）)
    const start = host.page.locator('#mpStart');
    if (await start.count()) {
      const label = await start.innerText().catch(() => '');
      const n = Number((label.match(/（(\d+)人）/) || [])[1] || 0);
      if (n >= 2 || !/人/.test(label)) {
        await start.click();
        await host.page.waitForTimeout(3500);
        if (await host.page.locator('#mpFold, #mpCheck, #mpCall').count()) return true;
      }
    }
    await host.page.waitForTimeout(800);
  }
  return !!(await host.page.locator('#mpFold, #mpCheck, #mpCall').count());
}

/** After reload+sign-in, ensure we are on the table (auto-resume or continue). */
async function ensureOnTable(page) {
  for (let i = 0; i < 6; i++) {
    if (await page.locator('#seats, #mpFold, #mpLeave, #mpStart').count()) return true;
    const cont = page.locator('[data-act="continue"], [data-act="enter"]');
    if (await cont.count()) {
      await cont.first().click().catch(() => {});
    }
    await page.waitForTimeout(1000);
  }
  return !!(await page.locator('#seats').count());
}

async function runFoldWin(browser, base, viewport, label) {
  const host = await makePlayer(browser, base, '阿明', `hostfw${label}`, viewport);
  const { roomId, code } = await createAndShare(host);
  const guest = await joinViaLink(
    browser,
    base,
    '大雄',
    `guestfw${label}`,
    viewport,
    roomId,
    code,
  );
  const sat = await sitIfNeeded(guest.page);
  await host.page.waitForTimeout(1000);
  const started = await startHand(host);

  let folded = false;
  for (let i = 0; i < 20; i++) {
    const fold = host.page.locator('#mpFold:not([disabled])');
    const gFold = guest.page.locator('#mpFold:not([disabled])');
    if (await fold.count()) {
      await fold.click();
      folded = true;
    } else if (await gFold.count()) {
      await gFold.click();
      folded = true;
    }
    await host.page.waitForTimeout(700);
    const body = await host.page.innerText('body');
    if (/手結束|準備中|開始下一手|開始第一手|贏得|離座/.test(body) && folded) break;
  }
  await host.page.screenshot({ path: join(ART, `mp-${label}-foldwin.png`), fullPage: true });
  await guest.page.screenshot({
    path: join(ART, `mp-${label}-foldwin-guest.png`),
    fullPage: true,
  });
  const body = await host.page.innerText('body');
  const okPhase =
    /手結束|準備中|開始|贏得|蓋牌|過牌|跟注|離座|亮牌/.test(body) && (folded || started);
  const errs = [...host.errors, ...guest.errors].filter(
    (e) =>
      !/favicon|Fonts|net::ERR_FAILED|AbortError|Failed to load|座位已被佔用/i.test(e),
  );
  await host.ctx.close();
  await guest.ctx.close();
  return { ok: sat && okPhase && errs.length === 0, errs, roomId, okPhase, sat, started, folded };
}

async function runShowdown(browser, base, viewport, label) {
  const host = await makePlayer(browser, base, '靜香', `hostsd${label}`, viewport);
  const { roomId, code } = await createAndShare(host);
  const guest = await joinViaLink(
    browser,
    base,
    '小夫',
    `guestsd${label}`,
    viewport,
    roomId,
    code,
  );
  await sitIfNeeded(guest.page);
  await startHand(host);

  let sawShow = false;
  for (let i = 0; i < 50; i++) {
    for (const p of [host, guest]) {
      const check = p.page.locator('#mpCheck:not([disabled])');
      const call = p.page.locator('#mpCall:not([disabled])');
      const show = p.page.locator('#mpShow');
      const muck = p.page.locator('#mpMuck');
      if (await show.count()) {
        sawShow = true;
        await show.click();
        await p.page.waitForTimeout(400);
      } else if (await muck.count()) {
        sawShow = true;
        await muck.click();
        await p.page.waitForTimeout(400);
      } else if (await check.count()) {
        await check.click();
        await p.page.waitForTimeout(500);
      } else if (await call.count()) {
        await call.click();
        await p.page.waitForTimeout(500);
      }
    }
    const t = await host.page.innerText('body');
    if (/開始下一手|開始第一手|手結束|準備中/.test(t) && i > 4) break;
    await host.page.waitForTimeout(350);
  }
  // Allow host auto-muck (5s) + hold if still on showdown
  await host.page.waitForTimeout(6500);
  await host.page.screenshot({ path: join(ART, `mp-${label}-showdown.png`), fullPage: true });
  const hasShowOrNext = await host.page.evaluate(() => {
    const t = document.body.innerText;
    return /亮牌|不亮|開始下一手|手結束|準備中|開始第一手/.test(t);
  });
  await host.ctx.close();
  await guest.ctx.close();
  return { ok: hasShowOrNext || sawShow, hasShowOrNext, sawShow, roomId };
}

/** Lobby →「同一支手機輪流玩」→ full solo hand (not ?solo=1). */
async function runSoloFromLobby(browser, base, viewport, label) {
  const p = await makePlayer(browser, base, '宜靜', `solo${label}`, viewport);
  // BD §2.1: solo lives in ⋯ menu
  await p.page.click('#mpMenuBtn');
  await p.page.waitForSelector('#mpMenu.on [data-act="solo"]', { timeout: 5000 });
  await p.page.click('#mpMenu [data-act="solo"]');
  await p.page.waitForSelector('#lobbyScreen.is-on', { timeout: 10000 });
  const appHidden = await p.page.evaluate(() =>
    document.getElementById('app')?.classList.contains('hidden'),
  );
  if (appHidden) {
    await p.ctx.close();
    return { ok: false, reason: '#app still hidden after openSolo' };
  }
  await p.page.click('#btnStart');
  await p.page.waitForSelector('#passScreen.is-on', { timeout: 20000 });
  // Play one full hand via pass / check-call / next
  let steps = 0;
  while (steps++ < 100) {
    if (await p.page.locator('#passScreen.is-on').count()) {
      await p.page.click('#btnPassOk');
      await p.page.waitForTimeout(300);
      continue;
    }
    if (await p.page.locator('#btnHandOff').count()) {
      await p.page.click('#btnHandOff');
      await p.page.waitForTimeout(300);
      continue;
    }
    if (await p.page.locator('#btnNext').count()) {
      await p.page.screenshot({
        path: join(ART, `mp-solo-lobby-${label}-handover.png`),
        fullPage: true,
      });
      break;
    }
    const show = p.page.locator('#btnShowBoth');
    const muck = p.page.locator('#btnMuck');
    const check = p.page.locator('#btnCheck');
    const call = p.page.locator('#btnCall');
    const fold = p.page.locator('#btnFold');
    if (await show.count()) await show.click();
    else if (await muck.count()) await muck.click();
    else if (await check.count()) await check.click();
    else if (await call.count()) await call.click();
    else if (await fold.count()) await fold.click();
    await p.page.waitForTimeout(450);
  }
  const body = await p.page.innerText('body');
  const sawTable = await p.page.evaluate(() => {
    const app = document.getElementById('app');
    return !!app && !app.classList.contains('hidden');
  });
  const okHand = /下一手|手結束|亮牌|不亮|過牌|跟注|蓋牌|贏得/.test(body);
  await p.page.screenshot({
    path: join(ART, `mp-solo-lobby-${label}.png`),
    fullPage: true,
  });
  const errs = p.errors.filter(
    (e) => !/favicon|Fonts|net::ERR_FAILED|AbortError|Failed to load/i.test(e),
  );
  await p.ctx.close();
  return { ok: !appHidden && sawTable && okHand && errs.length === 0, sawTable, okHand, errs };
}

/** Non-host refresh mid-hand then call; host refresh must not spam PERMISSION_DENIED. */
async function runIntentRefresh(browser, base, viewport, label) {
  const host = await makePlayer(browser, base, '阿明', `hostir${label}`, viewport);
  const { roomId, code } = await createAndShare(host);
  const guest = await joinViaLink(
    browser,
    base,
    '大雄',
    `guestir${label}`,
    viewport,
    roomId,
    code,
  );
  const sat = await sitIfNeeded(guest.page);
  await host.page.waitForTimeout(1500);
  const started = await startHand(host);
  // Let guest act once if possible so an intent doc exists
  for (let i = 0; i < 10; i++) {
    const gCall = guest.page.locator(
      '#mpCall:not([disabled]), #mpCheck:not([disabled]), #mpFold:not([disabled])',
    );
    const hCall = host.page.locator(
      '#mpCall:not([disabled]), #mpCheck:not([disabled]), #mpFold:not([disabled])',
    );
    if (await gCall.count()) {
      await gCall.first().click();
      await guest.page.waitForTimeout(800);
      break;
    }
    if (await hCall.count()) {
      await hCall.first().click();
      await host.page.waitForTimeout(800);
    } else {
      await host.page.waitForTimeout(500);
    }
  }
  // Guest refresh mid-hand — keep deep-link query so room resume works
  const guestUrl = guest.page.url();
  await guest.page.goto(guestUrl, { waitUntil: 'domcontentloaded' });
  await guest.page.waitForFunction(() => typeof window.__qaSignIn === 'function', null, {
    timeout: 20000,
  });
  await guest.page.evaluate(
    ([u, n]) => window.__qaSignIn(u, n),
    [`guestir${label}`, '大雄'],
  );
  await ensureOnTable(guest.page);
  await guest.page.waitForTimeout(2000);
  guest.errors.length = 0;
  // Try call/check/fold after refresh
  let acted = false;
  for (let i = 0; i < 20; i++) {
    const btn = guest.page.locator(
      '#mpCall:not([disabled]), #mpCheck:not([disabled]), #mpFold:not([disabled])',
    );
    if (await btn.count()) {
      await btn.first().click();
      acted = true;
      await guest.page.waitForTimeout(1200);
      break;
    }
    // Host may need to act first to pass the turn
    const hBtn = host.page.locator(
      '#mpCall:not([disabled]), #mpCheck:not([disabled]), #mpFold:not([disabled])',
    );
    if (await hBtn.count()) {
      await hBtn.first().click();
      await host.page.waitForTimeout(800);
    } else {
      await guest.page.waitForTimeout(600);
    }
  }
  const guestDenied = guest.errors.some((e) => /PERMISSION_DENIED|permission-denied/i.test(e));
  // Host refresh — should not flood PERMISSION_DENIED on own intents
  host.errors.length = 0;
  const hostUrl = host.page.url();
  await host.page.goto(hostUrl, { waitUntil: 'domcontentloaded' });
  await host.page.waitForFunction(() => typeof window.__qaSignIn === 'function', null, {
    timeout: 20000,
  });
  await host.page.evaluate(
    ([u, n]) => window.__qaSignIn(u, n),
    [`hostir${label}`, '阿明'],
  );
  await ensureOnTable(host.page);
  await host.page.waitForTimeout(3000);
  // Host may void + reshuffle; wait and optionally act
  for (let i = 0; i < 10; i++) {
    const hBtn = host.page.locator(
      '#mpCall:not([disabled]), #mpCheck:not([disabled]), #mpFold:not([disabled]), #mpStart',
    );
    if (await hBtn.count()) {
      await hBtn.first().click();
      await host.page.waitForTimeout(900);
    } else break;
  }
  const hostDenied = host.errors.filter((e) =>
    /PERMISSION_DENIED|permission-denied/i.test(e),
  );
  await host.page.screenshot({
    path: join(ART, `mp-${label}-intent-refresh.png`),
    fullPage: true,
  });
  await host.ctx.close();
  await guest.ctx.close();
  return {
    ok: sat && started && acted && !guestDenied && hostDenied.length === 0,
    acted,
    sat,
    started,
    guestDenied,
    hostDeniedCount: hostDenied.length,
  };
}

/** #23 Host leaves to lobby → 我的牌桌 → back in seat with stack intact. */
async function runHostLobbyContinue(browser, base, viewport, label) {
  const host = await makePlayer(browser, base, '阿明', `hostlc${label}`, viewport);
  const { roomId } = await createAndShare(host);
  await host.page.waitForTimeout(1500);
  const before = await host.page.evaluate(() => {
    const chips = document.querySelector('#heroChips, .ch.st')?.textContent || '';
    const body = document.body.innerText;
    return { chips, seated: /離座|開始第一手|開始下一手|蓋牌/.test(body) };
  });
  // #mpBtnLeaveLobby must be reachable (soft leave) at 390 and 1280
  const leaveBtn = host.page.locator('#mpBtnLeaveLobby');
  await leaveBtn.waitFor({ state: 'visible', timeout: 15000 });
  const leaveBox = await leaveBtn.boundingBox();
  const vp = host.page.viewportSize();
  if (
    !leaveBox ||
    leaveBox.y + leaveBox.height > (vp?.height || 0) + 1 ||
    leaveBox.x + leaveBox.width > (vp?.width || 0) + 1 ||
    leaveBox.y < 0
  ) {
    await host.ctx.close();
    return {
      ok: false,
      roomId,
      before,
      reason: '#mpBtnLeaveLobby not fully in viewport',
      leaveBox,
      vp,
    };
  }
  await leaveBtn.click();
  await host.page.waitForSelector('.mp-lobby', { timeout: 15000 });
  await host.page.waitForTimeout(800);
  const lobby = await host.page.evaluate(async () => {
    const info =
      typeof window.__qaRefreshRescue === 'function'
        ? await window.__qaRefreshRescue()
        : {};
    const mine = window.__qaMineSnapshot?.() || {};
    const t = document.body.innerText;
    return {
      ...info,
      ...mine,
      hasMyTable: /我的牌桌/.test(t),
      hasRescue: /房主失聯/.test(t),
      isHostCard: /房主/.test(mine.tag || '') && /回到牌桌/.test(mine.act || ''),
      createHidden: mine.hasCreate === false,
      text: t.slice(0, 400),
    };
  });
  await host.page.screenshot({
    path: join(ART, `mp-${label}-host-lobby-continue.png`),
    fullPage: true,
  });
  if (!lobby.hasMyTable || lobby.hasRescue || !lobby.isHostCard || !lobby.createHidden) {
    await host.ctx.close();
    return {
      ok: false,
      roomId,
      lobby,
      before,
      reason: 'lobby missing host card / showed 房主失聯 / create still visible',
    };
  }
  await host.page.click('.mp-my[data-act="continue"]');
  await host.page.waitForFunction(
    () => {
      const app = document.getElementById('app');
      const seats = document.getElementById('seats');
      return (
        !!seats &&
        app &&
        !app.classList.contains('hidden') &&
        (!!document.getElementById('mpLeave') ||
          !!document.getElementById('mpStart') ||
          /離座|開始第一手|開始下一手|觀戰/.test(document.body.innerText))
      );
    },
    null,
    { timeout: 20000 },
  );
  await host.page.waitForTimeout(1500);
  const after = await host.page.evaluate(() => {
    const chips = document.querySelector('#heroChips, .ch.st')?.textContent || '';
    const body = document.body.innerText;
    return {
      chips,
      seated: /離座|開始第一手|開始下一手|蓋牌|觀戰/.test(body),
      onTable: !!document.getElementById('seats'),
    };
  });
  await host.page.screenshot({
    path: join(ART, `mp-${label}-host-lobby-back.png`),
    fullPage: true,
  });
  await host.ctx.close();
  const stackOk =
    !before.chips || !after.chips || before.chips === after.chips || /2[,.]?000/.test(after.chips);
  return {
    ok:
      before.seated &&
      lobby.hasMyTable &&
      !lobby.hasRescue &&
      lobby.hostLoop === true &&
      after.onTable &&
      after.seated &&
      stackOk,
    roomId,
    before,
    lobby,
    after,
    stackOk,
  };
}

/** #23/#host: simulated ≥10m stale → still no「房主失聯」 for self. */
async function runHostNoSelfRescue(browser, base, viewport, label) {
  const hostUid = `hostnsr${label}`;
  const host = await makePlayer(browser, base, '阿明', hostUid, viewport);
  const { roomId } = await createAndShare(host);
  await host.page.waitForTimeout(1000);
  await host.page.evaluate(() => window.__qaLeaveToLobby());
  await host.page.waitForSelector('.mp-lobby', { timeout: 15000 });
  await emuBackdateHostGone(roomId, hostUid, 11 * 60_000);
  const info = await host.page.evaluate(async () => {
    const r = await window.__qaRefreshRescue();
    const t = document.body.innerText;
    return {
      ...r,
      hasMyTable: /我的牌桌/.test(t),
      hasRescueGone: /房主失聯/.test(t),
    };
  });
  await host.page.screenshot({
    path: join(ART, `mp-${label}-host-no-self-rescue.png`),
    fullPage: true,
  });
  await host.ctx.close();
  return {
    ok: info.hasMyTable && !info.hasRescueGone && info.hostLoop === true,
    roomId,
    info,
  };
}

/** Close a room + expire its code (emulator rules-bypass). */
async function emuCloseRoom(roomId, code) {
  const rules = readFileSync(join(ROOT, 'firebase/firestore.rules'), 'utf8');
  const env = await initializeTestEnvironment({
    projectId: 'demo-poker',
    firestore: { host: '127.0.0.1', port: 8195, rules },
  });
  try {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await updateDoc(doc(db, 'pokerRooms', roomId), {
        status: 'closed',
        closedBy: 'auto',
        closedAt: Timestamp.now(),
      });
      if (code) {
        await setDoc(
          doc(db, 'pokerCodes', String(code).padStart(3, '0')),
          {
            roomId,
            hostUid: 'closed',
            createdAt: Timestamp.now(),
            expiresAt: Timestamp.fromMillis(Date.now() - 1000),
          },
          { merge: true },
        );
      }
    });
  } finally {
    await env.cleanup();
  }
}

/** Ensure a 3-digit code doc is absent (for #27 bad-code path). */
async function emuDeleteCode(code) {
  const rules = readFileSync(join(ROOT, 'firebase/firestore.rules'), 'utf8');
  const env = await initializeTestEnvironment({
    projectId: 'demo-poker',
    firestore: { host: '127.0.0.1', port: 8195, rules },
  });
  try {
      await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await deleteDoc(doc(db, 'pokerCodes', String(code).padStart(3, '0'))).catch(() => {});
    });
  } finally {
    await env.cleanup();
  }
}

/** #27 + BD B-boxes: type 3 cells, paste share link, bad → error status. */
async function runJoinCode3(browser, base, viewport, label) {
  const host = await makePlayer(browser, base, '阿明', `hostj3${label}`, viewport);
  const { roomId, code, url } = await createAndShare(host);
  const digits = String(code).replace(/\D/g, '').slice(0, 3);
  const badCode = String((Number(digits) + 500) % 1000).padStart(3, '0');
  await emuDeleteCode(badCode);

  const guest = await makePlayer(browser, base, '大雄', `guestj3${label}`, viewport);
  await guest.page.waitForSelector('#mpJoinCode', { timeout: 15000 });
  // Structure: 3 visible cells + hidden input
  const boxes = await guest.page.evaluate(() => ({
    cells: document.querySelectorAll('.mp-cell').length,
    max: document.getElementById('mpJoinCode')?.getAttribute('maxlength') || '',
    hasFb: !!document.getElementById('mpJoinWrap'),
  }));
  // Bad code via typing into hidden input
  await guest.page.focus('#mpJoinCode');
  await guest.page.keyboard.type(badCode, { delay: 40 });
  await guest.page.waitForTimeout(2200);
  const bad = await guest.page.evaluate(() => ({
    status: document.getElementById('mpJoinStatus')?.textContent || '',
    state: document.getElementById('mpJoinWrap')?.dataset?.s || '',
    val: document.getElementById('mpJoinCode')?.value || '',
  }));
  // Clear and paste a share link (BD paste rule)
  await guest.page.evaluate(() => {
    const input = document.getElementById('mpJoinCode');
    input.readOnly = false;
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await guest.page.focus('#mpJoinCode');
  await guest.page.evaluate(async (link) => {
    const input = document.getElementById('mpJoinCode');
    const dt = new DataTransfer();
    dt.setData('text/plain', link);
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  }, url);
  await guest.page.waitForSelector('#seats', { timeout: 20000 }).catch(() => {});
  await guest.page.waitForTimeout(1500);
  const onTable = await guest.page.evaluate(() => {
    const app = document.getElementById('app');
    return !!document.getElementById('seats') && app && !app.classList.contains('hidden');
  });
  await guest.page.screenshot({
    path: join(ART, `mp-${label}-join3.png`),
    fullPage: true,
  });
  await host.ctx.close();
  await guest.ctx.close();
  const badOk =
    /不存在|找不到|請再確認|牌桌已結束/.test(bad.status) &&
    bad.state === 'error' &&
    boxes.cells === 3 &&
    boxes.max === '3';
  return {
    ok: digits.length === 3 && badOk && onTable,
    roomId,
    code: digits,
    boxes,
    bad,
    onTable,
  };
}

/** #28: open tables list; seat counts live; close removes; code reuse; mismatched r. */
async function runOpenTablesList(browser, base, viewport, label) {
  const h1 = await makePlayer(browser, base, '阿明', `h1list${label}`, viewport);
  const t1 = await createAndShare(h1);
  const h2 = await makePlayer(browser, base, '大雄', `h2list${label}`, viewport);
  const t2 = await createAndShare(h2);
  const h3 = await makePlayer(browser, base, '靜香', `h3list${label}`, viewport);
  const t3 = await createAndShare(h3);

  const viewer = await makePlayer(browser, base, '小夫', `viewlist${label}`, viewport);
  await viewer.page.waitForSelector('#mpOpenList, #mpOpenEmpty', { timeout: 15000 });
  await viewer.page.waitForFunction(
    (ids) => {
      const rows = [...document.querySelectorAll('.mp-open .mp-row[data-act="open-table"]')];
      return ids.every((id) => rows.some((r) => r.getAttribute('data-rid') === id));
    },
    [t1.roomId, t2.roomId, t3.roomId],
    { timeout: 15000 },
  ).catch(() => {});
  await viewer.page.waitForTimeout(1500);

  const before = await viewer.page.evaluate((ids) => {
    const rows = [...document.querySelectorAll('.mp-open .mp-row[data-act="open-table"]')];
    const byId = Object.fromEntries(
      rows.map((r) => [r.getAttribute('data-rid'), (r.textContent || '').replace(/\s+/g, ' ')]),
    );
    const boxes = Object.fromEntries(
      rows.map((r) => {
        const id = r.getAttribute('data-rid');
        const b = r.getBoundingClientRect();
        return [id, { top: b.top, height: b.height, width: b.width, left: b.left }];
      }),
    );
    return {
      n: rows.length,
      hasTitle: /可加入的牌桌/.test(document.body.innerText),
      hasGoldBtn: !!document.querySelector('.mp-btn-primary'),
      hasThreeCells: document.querySelectorAll('.mp-cell').length === 3,
      ids: rows.map((r) => r.getAttribute('data-rid')),
      our: ids.filter((id) => rows.some((r) => r.getAttribute('data-rid') === id)).length,
      seats: ids.map((id) => {
        const t = byId[id] || '';
        const m = t.match(/(\d)\s*\/\s*6/);
        return m ? Number(m[1]) : null;
      }),
      boxes,
    };
  }, [t1.roomId, t2.roomId, t3.roomId]);

  await viewer.page.screenshot({
    path: join(ART, `mp-${label}-open-list.png`),
    fullPage: true,
  });

  // Live seat count: guest sits at t2
  const sitter = await joinViaLink(
    browser,
    base,
    '小強',
    `sitlist${label}`,
    viewport,
    t2.roomId,
    t2.code,
  );
  const sat = await sitIfNeeded(sitter.page);
  await viewer.page.waitForTimeout(2500);
  const afterSit = await viewer.page.evaluate((id) => {
    const row = document.querySelector(`.mp-open .mp-row[data-rid="${id}"]`);
    const t = (row?.textContent || '').replace(/\s+/g, ' ');
    const m = t.match(/(\d)\s*\/\s*6/);
    const b = row?.getBoundingClientRect();
    return {
      text: t,
      seated: m ? Number(m[1]) : null,
      box: b ? { top: b.top, height: b.height, width: b.width, left: b.left } : null,
    };
  }, t2.roomId);
  // Row may reorder by updatedAt; assert the row's own size is stable (no height jump)
  const noLayoutShift =
    before.boxes[t2.roomId] &&
    afterSit.box &&
    Math.abs(before.boxes[t2.roomId].height - afterSit.box.height) < 1.5 &&
    Math.abs(before.boxes[t2.roomId].width - afterSit.box.width) < 1.5;

  // Close t1 → disappears from list; code free for reuse
  await emuCloseRoom(t1.roomId, t1.code);
  // Clear hostRoomId so a reuse create can proceed if needed
  {
    const rules = readFileSync(join(ROOT, 'firebase/firestore.rules'), 'utf8');
    const env = await initializeTestEnvironment({
      projectId: 'demo-poker',
      firestore: { host: '127.0.0.1', port: 8195, rules },
    });
    try {
      await env.withSecurityRulesDisabled(async (ctx) => {
        const db = ctx.firestore();
        await updateDoc(doc(db, 'pokerPlayers', `h1list${label}`), {
          hostRoomId: null,
          tableRoomId: null,
          inPlay: 0,
        }).catch(() => {});
      });
    } finally {
      await env.cleanup();
    }
  }
  await viewer.page.waitForFunction(
    (id) => !document.querySelector(`.mp-open .mp-row[data-rid="${id}"]`),
    t1.roomId,
    { timeout: 15000 },
  ).catch(() => {});
  const afterClose = await viewer.page.evaluate((id) => ({
    n: document.querySelectorAll('.mp-open .mp-row[data-act="open-table"]').length,
    stillHas: !!document.querySelector(`.mp-open .mp-row[data-rid="${id}"]`),
  }), t1.roomId);

  // Code reuse: force Math.random toward t1.code and create
  const reuser = await makePlayer(browser, base, '宜靜', `reuse${label}`, viewport);
  await reuser.page.waitForSelector('[data-act="create"]', { timeout: 15000 });
  await reuser.page.evaluate((want) => {
    const n = Number(want);
    window.__qaOrigRandom = Math.random;
    Math.random = () => (n + 0.05) / 1000;
  }, Number(t1.code));
  await reuser.page.click('[data-act="create"]');
  await reuser.page.waitForSelector('form, .mp-create', { timeout: 8000 });
  await reuser.page.click('button[type="submit"]');
  await reuser.page.waitForSelector('.mp-url', { timeout: 20000 });
  const reuseUrl = (await reuser.page.innerText('.mp-url')).trim();
  const reuseCode = new URL(reuseUrl).searchParams.get('room') || '';
  const reuseRoomId = new URL(reuseUrl).searchParams.get('r') || '';
  await reuser.page.evaluate(() => {
    if (window.__qaOrigRandom) Math.random = window.__qaOrigRandom;
  });
  const codeReused = reuseCode === t1.code && reuseRoomId && reuseRoomId !== t1.roomId;

  // Mismatched r deep link → 牌桌已結束
  const staleCtx = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
  });
  await staleCtx.route('**/*', blockProd);
  const stalePage = await staleCtx.newPage();
  await stalePage.goto(
    `${base}/poker/?emu=1&room=${encodeURIComponent(t2.code)}&r=rOLDFAKEID`,
    { waitUntil: 'domcontentloaded' },
  );
  await stalePage.waitForFunction(() => typeof window.__qaSignIn === 'function', null, {
    timeout: 20000,
  });
  await stalePage.evaluate(([u, n]) => window.__qaSignIn(u, n), [`stale${label}`, '聰實']);
  await stalePage.waitForTimeout(3500);
  const ended = await stalePage.evaluate(() => /牌桌已結束/.test(document.body.innerText));
  await stalePage.screenshot({
    path: join(ART, `mp-${label}-stale-link.png`),
    fullPage: true,
  });
  await staleCtx.close();

  await h1.ctx.close();
  await h2.ctx.close();
  await h3.ctx.close();
  await viewer.ctx.close();
  await sitter.ctx.close();
  await reuser.ctx.close();

  const seatsLive =
    sat &&
    afterSit.seated != null &&
    before.seats[1] != null &&
    afterSit.seated > before.seats[1];

  return {
    ok:
      before.our >= 3 &&
      before.hasTitle &&
      before.hasThreeCells &&
      seatsLive &&
      noLayoutShift &&
      !afterClose.stillHas &&
      codeReused &&
      ended,
    before,
    afterSit,
    afterClose,
    seatsLive,
    noLayoutShift,
    sat,
    reuse: { reuseCode, reuseRoomId, codeReused },
    ended,
    rooms: [t1.roomId, t2.roomId, t3.roomId],
    codes: [t1.code, t2.code, t3.code],
  };
}

/** §2.1/§2.2: host / guest / settle cards + away toast (f7e147a 50px top bar). */
async function runMineCardStates(browser, base, viewport, label) {
  const hostUid = `hostmc${label}`;
  const guestUid = `guestmc${label}`;
  const host = await makePlayer(browser, base, '阿明', hostUid, viewport);
  // Idle lobby: 「在大廳」+ menu items (no primary continue/settle); core CTAs visible
  const idle = await host.page.evaluate(() => {
    const top = document.querySelector('.mp-lobby .mp-top');
    const r = top?.getBoundingClientRect();
    const stl = document.getElementById('mpStl');
    const creates = [...document.querySelectorAll('.mp-btn-primary[data-act="create"]')];
    const visibleCreate = creates.find((el) => getComputedStyle(el).display !== 'none');
    const emptyCta = document.getElementById('mpBtnCreateE');
    const join = document.getElementById('mpJoinCode');
    return {
      top: window.__qaTopStatus?.() || '',
      h: r ? Math.round(r.height) : 0,
      stlTag: stl?.tagName || '',
      stlClickable: !!(stl && (stl.closest('button') || stl.getAttribute('role') === 'button')),
      hasCreate: creates.length > 0,
      createVisible: !!visibleCreate,
      emptyCta: !!(emptyCta && !emptyCta.hidden && getComputedStyle(emptyCta).display !== 'none'),
      isEmpty: document.querySelector('.mp-lobby')?.classList.contains('is-empty') === true,
      hasJoin: !!join,
      menu: window.__qaOpenMenu?.() || [],
    };
  });
  await host.page.evaluate(() => document.getElementById('mpMenuBtn')?.click());
  await host.page.screenshot({
    path: join(ART, `mp-${label}-lobby-empty-r5.png`),
    fullPage: true,
  });
  const { roomId, code } = await createAndShare(host);
  await host.page.evaluate(() => window.__qaLeaveToLobby());
  await host.page.waitForSelector('.mp-mine.is-host, .mp-mine', { timeout: 15000 });
  const hostCard = await host.page.evaluate(() => window.__qaMineSnapshot());
  const h1 = hostCard.height;

  // Guest seated → 入座中 + create shows + 先離開 notify
  const guest = await joinViaLink(browser, base, '大雄', guestUid, viewport, roomId, code);
  await sitIfNeeded(guest.page);
  await guest.page.waitForTimeout(1200);
  await guest.page.evaluate(() => window.__qaLeaveToLobby());
  await guest.page.waitForSelector('.mp-lobby', { timeout: 15000 });
  await guest.page.waitForTimeout(800);
  const guestCard = await guest.page.evaluate(() => ({
    ...window.__qaMineSnapshot(),
    top: window.__qaTopStatus?.() || '',
  }));
  const guestMenu = await guest.page.evaluate(() => window.__qaOpenMenu?.() || []);
  await guest.page.evaluate(() => document.getElementById('mpMenuBtn')?.click());
  await guest.page.click('.mp-btn-primary[data-act="create"]');
  await guest.page.waitForTimeout(400);
  const leaveHint = await guest.page.evaluate(() => {
    const n = document.getElementById('mpNtc');
    const a = document.getElementById('mpNtcA');
    return {
      on: n?.classList.contains('on'),
      title: document.getElementById('mpNtcT')?.textContent || '',
      desc: document.getElementById('mpNtcD')?.textContent || '',
      attn: document.querySelector('.mp-mine')?.classList.contains('mp-attn'),
      role: n?.getAttribute('role') || '',
      sticky: n?.dataset.sticky === '1',
      action: a?.textContent || '',
      actionShown: !!(a && !a.hidden),
    };
  });
  await guest.page.screenshot({
    path: join(ART, `mp-${label}-mine-guest.png`),
    fullPage: true,
  });
  await guest.page.evaluate(() => window.__qaHideNotify?.());

  // Snapshot host while table still open (closing for settle would flip host → 待結帳)
  const hostAgain = await host.page.evaluate(() => ({
    ...window.__qaMineSnapshot(),
    top: window.__qaTopStatus?.() || '',
  }));
  const hostMenu = await host.page.evaluate(() => window.__qaOpenMenu?.() || []);
  await host.page.evaluate(() => document.getElementById('mpMenuBtn')?.click());
  const topBar = await host.page.evaluate(() => {
    const top = document.querySelector('.mp-lobby .mp-top');
    if (!top) return null;
    const r = top.getBoundingClientRect();
    const foot = document.querySelector('.mp-foot');
    const footLinks = [...document.querySelectorAll('.mp-foot [data-act="solo"], .mp-foot [data-act="signout"]')];
    return {
      h: Math.round(r.height),
      hasTotal: /總計/.test(document.body.innerText),
      footHidden: !foot || getComputedStyle(foot).display === 'none',
      footHasLegacy: footLinks.length > 0,
      hasMenu: !!document.getElementById('mpMenuBtn'),
      menuIsM7: document.getElementById('mpMenuBtn')?.classList.contains('m7') === true,
    };
  });

  // Settle: close room → guest sees 結帳離開
  await emuCloseRoom(roomId, code);
  await guest.page.evaluate(async () => {
    await window.__qaRefreshRescue?.();
  });
  await guest.page.waitForTimeout(1200);
  const settleCard = await guest.page.evaluate(() => ({
    ...window.__qaMineSnapshot(),
    top: window.__qaTopStatus?.() || '',
  }));
  const settleMenu = await guest.page.evaluate(() => window.__qaOpenMenu?.() || []);
  await guest.page.evaluate(() => document.getElementById('mpMenuBtn')?.click());
  await guest.page.screenshot({
    path: join(ART, `mp-${label}-mine-settle.png`),
    fullPage: true,
  });

  // Away toast + top status 「已自動離座」
  const toast = await guest.page.evaluate(() => {
    window.__qaShowAwayToast?.();
    const n = document.getElementById('mpNtc');
    const a = document.getElementById('mpNtcA');
    return {
      on: n?.classList.contains('on'),
      title: document.getElementById('mpNtcT')?.textContent || '',
      role: n?.getAttribute('role'),
      style: getComputedStyle(n).transitionProperty || '',
      top: window.__qaTopStatus?.() || '',
      sticky: n?.dataset.sticky === '1',
      action: a?.textContent || '',
      actionShown: !!(a && !a.hidden),
    };
  });
  await guest.page.screenshot({
    path: join(ART, `mp-${label}-away-toast.png`),
    fullPage: true,
  });

  await host.ctx.close();
  await guest.ctx.close();

  const hostOk =
    hostCard.hasMine &&
    /房主/.test(hostCard.tag) &&
    /回到牌桌/.test(hostCard.act) &&
    !hostCard.hasCreate &&
    !/房主失聯/.test(hostCard.text) &&
    hostAgain.top === '我是房主' &&
    hostMenu.some((t) => /回到牌桌/.test(t)) &&
    hostMenu.some((t) => t === '戰績') &&
    hostMenu.some((t) => /同一支手機輪流玩/.test(t)) &&
    hostMenu.some((t) => t === '登出');
  const guestOk =
    guestCard.hasMine &&
    /入座中/.test(guestCard.tag) &&
    guestCard.hasCreate &&
    guestCard.top === '已入座' &&
    guestMenu.some((t) => /回到牌桌/.test(t)) &&
    leaveHint.on &&
    /先離開/.test(leaveHint.title) &&
    leaveHint.role === 'status' &&
    leaveHint.sticky &&
    leaveHint.actionShown &&
    /回到這一桌/.test(leaveHint.action);
  const settleOk =
    settleCard.hasMine &&
    settleCard.dataK === 'settle' &&
    /結帳離開/.test(settleCard.act) &&
    settleCard.hasCreate &&
    settleCard.top === '待結帳' &&
    settleMenu.some((t) => /結帳離開/.test(t));
  const toastOk =
    toast.on &&
    /自動離座/.test(toast.title) &&
    toast.role === 'status' &&
    toast.top === '已自動離座' &&
    toast.sticky &&
    toast.actionShown &&
    /知道了/.test(toast.action);
  const heightOk =
    h1 > 0 &&
    Math.abs((guestCard.height || 0) - (settleCard.height || 0)) < 8;
  const barOk =
    topBar &&
    topBar.h === 50 &&
    topBar.footHidden &&
    !topBar.footHasLegacy &&
    !topBar.hasTotal &&
    topBar.hasMenu &&
    topBar.menuIsM7;
  const idleOk =
    idle.top === '在大廳' &&
    idle.h === 50 &&
    idle.stlTag === 'SPAN' &&
    !idle.stlClickable &&
    idle.hasCreate &&
    idle.createVisible &&
    (!idle.isEmpty || idle.emptyCta) &&
    idle.hasJoin &&
    idle.menu.some((t) => t === '戰績') &&
    idle.menu.some((t) => t === '設定') &&
    idle.menu.some((t) => /同一支手機輪流玩/.test(t)) &&
    idle.menu.some((t) => t === '登出') &&
    !idle.menu.some((t) => /回到牌桌|結帳離開/.test(t));

  return {
    ok: idleOk && hostOk && guestOk && settleOk && toastOk && heightOk && barOk,
    idle,
    idleOk,
    hostCard,
    guestCard,
    settleCard,
    leaveHint,
    toast,
    heightOk,
    hostAgain,
    hostMenu,
    guestMenu,
    settleMenu,
    topBar,
  };
}

/** Non-host: after host gone ≥10m (simulated), lobby shows 結帳離開. */
async function runGuestRescueStaleHost(browser, base, viewport, label) {
  const hostUid = `hostgr${label}`;
  const guestUid = `guestgr${label}`;
  const host = await makePlayer(browser, base, '阿明', hostUid, viewport);
  const { roomId, code } = await createAndShare(host);
  const guest = await joinViaLink(
    browser,
    base,
    '大雄',
    guestUid,
    viewport,
    roomId,
    code,
  );
  const sat = await sitIfNeeded(guest.page);
  await guest.page.waitForTimeout(1500);
  // Soft-leave BEFORE killing host so guest is not auto-promoted to host
  await guest.page.evaluate(() => window.__qaLeaveToLobby());
  await guest.page.waitForSelector('.mp-lobby', { timeout: 15000 });
  await host.ctx.close();
  // Backdate twice — host teardown can race a last heartbeat write
  await emuBackdateHostGone(roomId, hostUid, 11 * 60_000);
  await guest.page.waitForTimeout(400);
  await emuBackdateHostGone(roomId, hostUid, 12 * 60_000);
  await guest.page.waitForTimeout(500);
  const info = await guest.page.evaluate(async () => {
    const r = await window.__qaRefreshRescue();
    const mine = window.__qaMineSnapshot?.() || {};
    const t = document.body.innerText;
    return {
      ...r,
      ...mine,
      hasRescue: /結帳離開/.test(mine.act || t) || /已收桌/.test(mine.tag || t),
      hasContinue: /回到牌桌/.test(mine.act || '') && mine.dataK !== 'settle',
      text: t.slice(0, 500),
    };
  });
  await guest.page.screenshot({
    path: join(ART, `mp-${label}-guest-rescue-stale.png`),
    fullPage: true,
  });
  await guest.ctx.close();
  return {
    ok: sat && info.hasRescue && !info.hasContinue && info.rescueOk === true,
    roomId,
    sat,
    info,
  };
}

async function main() {
  const { server, base } = await startStatic();
  const browser = await chromium.launch({
    headless: true,
    executablePath: existsSync('/usr/bin/google-chrome')
      ? '/usr/bin/google-chrome'
      : undefined,
  });
  const results = [];
  const ONLY = new Set(
    (process.env.MP_E2E_ONLY || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const want = (name) => !ONLY.size || [...ONLY].some((k) => name.includes(k));
  const push = async (name, fn) => {
    if (!want(name)) return;
    results.push({ name, ...(await fn()) });
  };
  try {
    for (const vp of [
      { width: 390, height: 844, label: '390' },
      { width: 1280, height: 800, label: '1280' },
    ]) {
      await push(`foldwin-${vp.label}`, () => runFoldWin(browser, base, vp, vp.label));
      await push(`showdown-${vp.label}`, () => runShowdown(browser, base, vp, vp.label));
      await push(`solo-lobby-${vp.label}`, () => runSoloFromLobby(browser, base, vp, vp.label));
      await push(`intent-refresh-${vp.label}`, () =>
        runIntentRefresh(browser, base, vp, vp.label),
      );
      await push(`host-lobby-continue-${vp.label}`, () =>
        runHostLobbyContinue(browser, base, vp, vp.label),
      );
      await push(`host-no-self-rescue-${vp.label}`, () =>
        runHostNoSelfRescue(browser, base, vp, vp.label),
      );
      await push(`guest-rescue-stale-${vp.label}`, () =>
        runGuestRescueStaleHost(browser, base, vp, vp.label),
      );
      await push(`mine-card-states-${vp.label}`, () =>
        runMineCardStates(browser, base, vp, vp.label),
      );
      await push(`join3-${vp.label}`, () => runJoinCode3(browser, base, vp, vp.label));
      await push(`open-list-${vp.label}`, () =>
        runOpenTablesList(browser, base, vp, vp.label),
      );
    }
    // Top-bar / status / menu: also verify at 360 (with 390/1280 covered above)
    await push('mine-card-states-360', () =>
      runMineCardStates(browser, base, { width: 360, height: 780 }, '360'),
    );
  } finally {
    await browser.close();
    server.close();
  }
  writeFileSync(join(ART, 'mp-e2e-results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => r.ok === false);
  console.log(JSON.stringify(results, null, 2));
  if (failed.length) {
    console.error('FAIL', failed.map((f) => f.name));
    process.exit(1);
  }
  console.log('mp-e2e OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
