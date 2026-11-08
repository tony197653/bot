/**
 * ONE e2e (宗良 quota): 6 players → sit → start → 攤牌.
 * PR client + PR rules; demo-poker emulator only (blockProd aborts tony-poker).
 * Main 9ac534c join denial path is covered by rules #compat 方案A tests.
 *
 * Host loop skips work when document.visibilityState !== 'visible'. With 6
 * Playwright pages only the front tab stays visible — force the host context
 * to report visible so SIT intents are processed.
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

/**
 * Keep hostLoop + presence beats alive across Playwright multi-tab.
 * Without this, background tabs go hidden → host writes stall → §6.7 takeover
 * (seen as 房主 moving off 阿明) and #mpStart lands on another page.
 */
const ALWAYS_VISIBLE = () => {
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
    /* already defined */
  }
};

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

const VP = { width: 390, height: 844 };
const NAMES = ['阿明', '大雄', '靜香', '小夫', '宜靜', '技安'];

async function makeHost(browser, base, name, uid) {
  const ctx = await browser.newContext({
    viewport: VP,
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  });
  await ctx.addInitScript(ALWAYS_VISIBLE);
  await ctx.route('**/*', blockProd);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/poker/?emu=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.__qaSignIn === 'function', null, {
    timeout: 20000,
  });
  await page.evaluate(([u, n]) => window.__qaSignIn(u, n), [uid, name]);
  await page.waitForSelector('.mp-lobby, .mp-shell', { timeout: 20000 });
  return { ctx, page, name, uid, errors };
}

async function createAndShare(host) {
  await host.page.locator('.mp-btn-primary[data-act="create"]:visible').first().click();
  await host.page.waitForSelector('form, .mp-create', { timeout: 8000 });
  await host.page.click('button[type="submit"]');
  await host.page.waitForSelector('.mp-url', { timeout: 20000 });
  const url = (await host.page.innerText('.mp-url')).trim();
  const parsed = new URL(url);
  const roomId = parsed.searchParams.get('r') || '';
  let code = parsed.searchParams.get('room') || '';
  code = String(code).replace(/\D/g, '').slice(0, 3);
  if (!roomId || code.length !== 3) throw new Error(`bad share ${url}`);
  await host.page.click('[data-act="enter"]');
  // asHostSit seats host — wait for 離座, not merely #seats (may stay hidden)
  await host.page.waitForSelector('#mpLeave, #seats .seat, #mpStart', { timeout: 25000 });
  await host.page.waitForTimeout(800);
  return { roomId, code, url };
}

async function joinViaLink(browser, base, name, uid, roomId, code) {
  const path = `/poker/?emu=1&room=${encodeURIComponent(code)}&r=${encodeURIComponent(roomId)}`;
  const ctx = await browser.newContext({
    viewport: VP,
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  });
  await ctx.addInitScript(ALWAYS_VISIBLE);
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
  const cont = page.locator('[data-act="continue"], [data-act="enter"]');
  if (await cont.count()) {
    await cont.first().click().catch(() => {});
    await page.waitForTimeout(2000);
  }
  // Retry join if still on join/lobby with code error
  for (let i = 0; i < 3; i++) {
    if (await page.locator('#seats .mp-empty-seat, #mpLeave, #mpStart').count()) break;
    const joinBtn = page.locator('[data-act="join"], button:has-text("加入")');
    if (await joinBtn.count()) {
      await joinBtn.first().click().catch(() => {});
      await page.waitForTimeout(2000);
    } else break;
  }
  await page.waitForSelector('#seats, #mpLeave', { timeout: 15000 }).catch(() => {});
  return { ctx, page, name, uid, errors };
}

/** Occupied seats as seen by a seated host (felt others + self via 離座). */
async function occupiedFromHost(hostPage) {
  return hostPage.evaluate(() => {
    const others = document.querySelectorAll('#seats .seat:not(.mp-empty-seat)').length;
    const me = document.getElementById('mpLeave') ? 1 : 0;
    const start = document.getElementById('mpStart')?.innerText || '';
    const fromBtn = Number((start.match(/（(\d+)人）/) || [])[1] || 0);
    return Math.max(others + me, fromBtn);
  });
}

async function guestDiag(page) {
  return page.evaluate(() => ({
    empty: document.querySelectorAll('.mp-empty-seat').length,
    leave: !!document.getElementById('mpLeave'),
    seats: !!document.getElementById('seats'),
    appHidden: !!document.getElementById('app')?.classList.contains('hidden'),
    snip: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 180),
  }));
}

async function sitGuest(guestPage, hostPage, expectN) {
  for (let i = 0; i < 20; i++) {
    if (await guestPage.locator('#mpLeave').count()) return true;
    const n = await occupiedFromHost(hostPage);
    if (n >= expectN) return true;

    await guestPage.bringToFront().catch(() => {});
    const empty = await guestPage.locator('.mp-empty-seat').count();
    if (empty) {
      await guestPage
        .evaluate(() => document.querySelector('.mp-empty-seat')?.click())
        .catch(() => {});
    }
    // Yield to host so hostLoop processes SIT (visibility forced on host ctx)
    await hostPage.bringToFront().catch(() => {});
    await hostPage.waitForTimeout(1100);
    const n2 = await occupiedFromHost(hostPage);
    if (n2 >= expectN) return true;
  }
  return (
    !!(await guestPage.locator('#mpLeave').count()) ||
    (await occupiedFromHost(hostPage)) >= expectN
  );
}

async function anyInHand(players) {
  for (const p of players) {
    if (await p.page.locator('#mpFold, #mpCheck, #mpCall').count()) return true;
  }
  return false;
}

/** Current host may have changed via §6.7 takeover — #mpStart is on that page. */
async function findStartPage(players) {
  for (const p of players) {
    if (await p.page.locator('#mpStart').count()) return p;
  }
  return null;
}

/** @returns {{ ok: boolean, host: typeof players[0] }} */
async function startHand(players) {
  let hostP = players[0];
  for (let i = 0; i < 50; i++) {
    const starter = (await findStartPage(players)) || hostP;
    hostP = starter;
    await starter.page.bringToFront();
    const start = starter.page.locator('#mpStart');
    if (await start.count()) {
      const label = await start.innerText().catch(() => '');
      const n = Number((label.match(/（(\d+)人）/) || [])[1] || 0);
      if (n >= 2 || !/人/.test(label)) {
        await start.click({ force: true }).catch(() => {});
        for (let w = 0; w < 20; w++) {
          const cur = (await findStartPage(players)) || starter;
          hostP = cur;
          await cur.page.bringToFront();
          await cur.page.waitForTimeout(700);
          if (await anyInHand(players)) return { ok: true, host: cur };
          if (await cur.page.locator('#mpStart').count()) {
            await cur.page.locator('#mpStart').click({ force: true }).catch(() => {});
          }
        }
      }
    }
    await hostP.page.waitForTimeout(500);
  }
  return { ok: await anyInHand(players), host: hostP };
}

async function playToShowdown(players, hostP) {
  let sawShow = false;
  const warm = hostP || players[0];
  for (let i = 0; i < 120; i++) {
    let acted = false;
    for (const p of players) {
      await p.page.bringToFront().catch(() => {});
      if (await p.page.locator('#mpShow').count()) {
        sawShow = true;
        await p.page.locator('#mpShow').click();
        acted = true;
        await warm.page.bringToFront().catch(() => {});
        await p.page.waitForTimeout(400);
        break;
      }
      if (await p.page.locator('#mpMuck').count()) {
        sawShow = true;
        await p.page.locator('#mpMuck').click();
        acted = true;
        await warm.page.bringToFront().catch(() => {});
        await p.page.waitForTimeout(400);
        break;
      }
      if (await p.page.locator('#mpCheck:not([disabled])').count()) {
        await p.page.locator('#mpCheck:not([disabled])').click();
        acted = true;
        await warm.page.bringToFront().catch(() => {});
        await p.page.waitForTimeout(500);
        break;
      }
      if (await p.page.locator('#mpCall:not([disabled])').count()) {
        await p.page.locator('#mpCall:not([disabled])').click();
        acted = true;
        await warm.page.bringToFront().catch(() => {});
        await p.page.waitForTimeout(500);
        break;
      }
    }
    await warm.page.bringToFront().catch(() => {});
    const t = await warm.page.innerText('body');
    if (/開始下一手|開始第一手|手結束|準備中/.test(t) && i > 4) {
      return { done: true, sawShow, ticks: i };
    }
    if (!acted) await warm.page.waitForTimeout(400);
  }
  await warm.page.waitForTimeout(6500);
  const t = await warm.page.innerText('body');
  const hasShowOrNext = /亮牌|不亮|開始下一手|手結束|準備中|開始第一手/.test(t);
  return { done: hasShowOrNext || sawShow, sawShow, hasShowOrNext, ticks: 120 };
}

async function main() {
  const { server, base } = await startStatic();
  const browser = await chromium.launch({
    headless: true,
    executablePath: existsSync('/usr/bin/google-chrome')
      ? '/usr/bin/google-chrome'
      : undefined,
  });
  const result = { name: 'e2e-6p-showdown', ok: false };
  try {
    const host = await makeHost(browser, base, NAMES[0], 'host6psd');
    const { roomId, code } = await createAndShare(host);
    result.roomId = roomId;
    result.code = code;

    await host.page.bringToFront();
    // Ensure host seated (asHostSit usually already did this)
    if (!(await host.page.locator('#mpLeave').count())) {
      await host.page
        .evaluate(() => document.querySelector('.mp-empty-seat')?.click())
        .catch(() => {});
      await host.page.waitForTimeout(1500);
    }
    result.hostSat = !!(await host.page.locator('#mpLeave').count());
    result.seatedAfterHost = await occupiedFromHost(host.page);

    const guests = [];
    const guestDiags = [];
    for (let i = 1; i < 6; i++) {
      await host.page.bringToFront();
      await host.page.waitForTimeout(700);
      const g = await joinViaLink(browser, base, NAMES[i], `g6psd${i}`, roomId, code);
      guestDiags.push(await guestDiag(g.page));
      await host.page.bringToFront();
      await host.page.waitForTimeout(500);
      const expect = i + 1;
      const sat = await sitGuest(g.page, host.page, expect);
      guests.push({ ...g, sat });
      await host.page.bringToFront();
      let n = await occupiedFromHost(host.page);
      for (let w = 0; w < 20 && n < expect; w++) {
        await g.page.bringToFront().catch(() => {});
        await g.page
          .evaluate(() => document.querySelector('.mp-empty-seat')?.click())
          .catch(() => {});
        await host.page.bringToFront();
        await host.page.waitForTimeout(800);
        n = await occupiedFromHost(host.page);
      }
      guests[guests.length - 1].sat = sat || n >= expect;
    }

    result.guestSat = guests.map((g) => g.sat);
    result.guestDiags = guestDiags;
    result.allSat = result.hostSat && guests.every((g) => g.sat);
    const players = [host, ...guests];

    await host.page.bringToFront();
    let seatedN = 0;
    for (let w = 0; w < 30; w++) {
      seatedN = await occupiedFromHost(host.page);
      if (seatedN >= 6) break;
      await host.page.waitForTimeout(500);
    }
    result.seatedN = seatedN;

    const starter = await findStartPage(players);
    result.startOn = starter?.name || null;
    const startRes =
      seatedN >= 6 ? await startHand(players) : { ok: false, host: host };
    result.started = startRes.ok;
    result.hostAfterStart = startRes.host?.name || null;
    const hand = startRes.ok
      ? await playToShowdown(players, startRes.host)
      : { done: false };
    result.hand = hand;

    await (startRes.host?.page || host.page).screenshot({
      path: join(ART, 'mp-e2e-6p-showdown.png'),
      fullPage: true,
    });

    const errs = players
      .flatMap((p) => p.errors)
      .filter(
        (e) =>
          !/favicon|Fonts|net::ERR_FAILED|AbortError|Failed to load|座位已被佔用/i.test(e),
      );
    result.errs = errs.slice(0, 8);
    result.ok =
      startRes.ok &&
      hand.done &&
      !!hand.sawShow &&
      result.seatedN >= 6 &&
      errs.length === 0;
    for (const p of players) await p.ctx.close();
  } finally {
    await browser.close();
    server.close();
  }
  writeFileSync(join(ART, 'mp-e2e-6p-showdown-results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error('FAIL e2e-6p-showdown');
    process.exit(1);
  }
  console.log('e2e-6p-showdown OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
