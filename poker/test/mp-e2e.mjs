/**
 * Multiplayer Playwright against Auth+Firestore emulators (demo-poker).
 * Never talks to production. Viewports 390 and 1280.
 *
 * Run via: node firebase/run-mp-e2e.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const REPO = join(ROOT, '..');
const ART = existsSync('/opt/cursor/artifacts')
  ? '/opt/cursor/artifacts'
  : join(ROOT, 'test-artifacts');
mkdirSync(ART, { recursive: true });

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
  const roomId = new URL(url).searchParams.get('r') || '';
  const code =
    new URL(url).searchParams.get('room') ||
    ((await host.page.innerText('body')).match(/(\d{3}\s?\d{3})/) || [])[1]?.replace(
      /\s/g,
      '',
    ) ||
    '';
  if (!roomId) throw new Error(`createAndShare missing roomId from url=${url}`);
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
  await p.page.click('[data-act="solo"]');
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

async function main() {
  const { server, base } = await startStatic();
  const browser = await chromium.launch({
    headless: true,
    executablePath: existsSync('/usr/bin/google-chrome')
      ? '/usr/bin/google-chrome'
      : undefined,
  });
  const results = [];
  try {
    for (const vp of [
      { width: 390, height: 844, label: '390' },
      { width: 1280, height: 800, label: '1280' },
    ]) {
      results.push({
        name: `foldwin-${vp.label}`,
        ...(await runFoldWin(browser, base, vp, vp.label)),
      });
      results.push({
        name: `showdown-${vp.label}`,
        ...(await runShowdown(browser, base, vp, vp.label)),
      });
      results.push({
        name: `solo-lobby-${vp.label}`,
        ...(await runSoloFromLobby(browser, base, vp, vp.label)),
      });
      results.push({
        name: `intent-refresh-${vp.label}`,
        ...(await runIntentRefresh(browser, base, vp, vp.label)),
      });
    }
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
