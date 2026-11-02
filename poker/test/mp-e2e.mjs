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
  await page.waitForTimeout(3000);
  return { ctx, page, name, uid, errors };
}

async function sitIfNeeded(page) {
  const seatBtn = page.locator('.mp-empty-seat').first();
  if (await seatBtn.count()) {
    await seatBtn.click();
    await page.waitForTimeout(2000);
  }
}

async function startHand(host) {
  const start = host.page.locator('#mpStart');
  if (await start.count()) {
    await start.click();
    await host.page.waitForTimeout(3500);
  }
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
  await sitIfNeeded(guest.page);
  await startHand(host);

  for (let i = 0; i < 16; i++) {
    const fold = host.page.locator('#mpFold:not([disabled])');
    const gFold = guest.page.locator('#mpFold:not([disabled])');
    if (await fold.count()) await fold.click();
    else if (await gFold.count()) await gFold.click();
    await host.page.waitForTimeout(700);
    const body = await host.page.innerText('body');
    if (/手結束|準備中|開始下一手|開始第一手|贏得/.test(body) && i > 1) break;
  }
  await host.page.screenshot({ path: join(ART, `mp-${label}-foldwin.png`), fullPage: true });
  await guest.page.screenshot({
    path: join(ART, `mp-${label}-foldwin-guest.png`),
    fullPage: true,
  });
  const body = await host.page.innerText('body');
  const okPhase = /手結束|準備中|開始|贏得|蓋牌/.test(body);
  const errs = [...host.errors, ...guest.errors].filter(
    (e) => !/favicon|Fonts|net::ERR_FAILED|AbortError|Failed to load/i.test(e),
  );
  await host.ctx.close();
  await guest.ctx.close();
  return { ok: okPhase && errs.length === 0, errs, roomId, okPhase };
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

async function runSoloInert(browser, base) {
  const host = await makePlayer(browser, base, '宜靜', 'solotest', {
    width: 390,
    height: 844,
  });
  await host.page.click('[data-act="solo"]');
  await host.page.waitForTimeout(1000);
  const lobby = host.page.locator('#lobbyScreen');
  const state = await lobby.evaluate((el) => ({
    inert: el.inert,
    ariaHidden: el.getAttribute('aria-hidden'),
    hasHidden: el.classList.contains('hidden'),
    pointerEvents: getComputedStyle(el).pointerEvents,
  }));
  // After openSolo, lobby must be interactive
  const ok = state.inert !== true && state.ariaHidden !== 'true' && !state.hasHidden;
  await host.page.screenshot({ path: join(ART, 'mp-solo-inert.png'), fullPage: true });
  await host.ctx.close();
  return { ok, ...state };
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
    }
    results.push({ name: 'solo-inert', ...(await runSoloInert(browser, base)) });
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
