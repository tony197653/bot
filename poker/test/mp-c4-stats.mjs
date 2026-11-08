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
const ART = '/workspace/pr49c-r4';
mkdirSync(ART, { recursive: true });

/** Backdate room.updatedAt + host presence (rules-bypass; emulator only). */
async function emuBackdateHostGone(roomId, hostUid, msAgo = 11 * 60_000) {
  const rules = readFileSync(join(ROOT, 'firebase/firestore.r6-test.rules'), 'utf8');
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
    if (m.type() === 'error' || /stats/i.test(m.text())) errors.push(m.type()+': '+m.text().slice(0, 400));
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
  // Prefer visible CTA (empty-state #mpBtnCreateE may stay in DOM under [hidden])
  await host.page.locator('.mp-btn-primary[data-act="create"]:visible').first().click();
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


const T0 = Date.now() - 60_000;
const R = {};
async function adminRead(fn) {
  const rules = readFileSync(join(ROOT, 'firebase/firestore.r6-test.rules'), 'utf8');
  const env = await initializeTestEnvironment({ projectId: 'demo-poker', firestore: { host: '127.0.0.1', port: 8195, rules } });
  try { let out; await env.withSecurityRulesDisabled(async (ctx) => { out = await fn(ctx.firestore()); }); return out; } finally { await env.cleanup(); }
}
async function statsSnap(roomId) {
  const fsm = await import('firebase/firestore');
  return adminRead(async (db) => {
    const room = (await fsm.getDoc(fsm.doc(db, 'pokerRooms', roomId))).data() || {};
    const users = await fsm.getDocs(fsm.collection(db, 'pokerStats'));
    const out = { hostUid: room.hostUid, status: room.status, pendingKeys: Object.keys(room.statsPending || room.pendingStats || {}), users: {} };
    for (const u of users.docs) {
      const hands = await fsm.getDocs(fsm.collection(db, 'pokerStats', u.id, 'hands'));
      const keys = hands.docs.map((d) => d.id);
      out.users[u.id] = { hands: keys.length, unique: new Set(keys).size, agg: u.data() };
    }
    return out;
  });
}
const lsPending = (p) => p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('pokerStats.pending')).map((k) => [k, (localStorage.getItem(k) || '').length]));
async function playOne(players) {
  let acted = false;
  for (let i = 0; i < 80; i++) {
    for (const p of players) {
      const pg = p.page;
      for (const sel of ['#mpCheck', '#mpCall', '#mpFold']) {
        const bt = pg.locator(`${sel}:visible:not([disabled])`);
        if (await bt.count().catch(() => 0)) { await bt.first().click().catch(() => {}); acted = true; R.clicks = R.clicks || {}; R.clicks[sel] = (R.clicks[sel] || 0) + 1; break; }
      }
    }
    await players[0].page.waitForTimeout(600);
    const inHand = await players[0].page.evaluate(() => window.__qaIsHandInProgress?.()).catch(() => true);
    if (acted && !inHand) return true;
  }
  return false;
}
async function regressRaise(players) {
  const out = {};
  for (let i = 0; i < 20 && !out.done; i++) {
    for (const p of players) {
      const pg = p.page; const rb = pg.locator('#mpRaise:visible:not([disabled])');
      if (!(await rb.count())) continue;
      await rb.click(); await pg.waitForTimeout(500);
      out.panel = await pg.locator('#raisePanel:visible').count();
      const v0 = await pg.locator('#raiseOut').innerText().catch(() => '');
      await pg.click('#raisePlus').catch((e) => (out.plusErr = String(e)));
      const v1 = await pg.locator('#raiseOut').innerText().catch(() => '');
      await pg.click('#raiseMinus').catch((e) => (out.minusErr = String(e)));
      const v2 = await pg.locator('#raiseOut').innerText().catch(() => '');
      out.plusMinus = [v0, v1, v2];
      await pg.locator('#raiseRange').fill(String(await pg.locator('#raiseRange').getAttribute('max'))).catch((e) => (out.sliderErr = String(e)));
      out.sliderMax = await pg.locator('#raiseOut').innerText().catch(() => '');
      const presets = pg.locator('#presets button');
      out.presets = await presets.allInnerTexts().catch(() => []);
      if (out.presets.length) { await presets.first().click(); out.presetVal = await pg.locator('#raiseOut').innerText().catch(() => ''); }
      await pg.screenshot({ path: join(ART, 'reg-raise-panel.png') });
      await pg.click('#raiseCancel'); await pg.waitForTimeout(400);
      out.cancelClosed = !(await pg.locator('#raisePanel:visible').count());
      await rb.click(); await pg.waitForTimeout(400);
      const allin = pg.locator('#presets button:has-text("全下"), #presets button:has-text("All")');
      out.allinBtn = await allin.count();
      if (out.allinBtn) await allin.first().click(); else await pg.locator('#raiseRange').fill(String(await pg.locator('#raiseRange').getAttribute('max')));
      out.allinVal = await pg.locator('#raiseOut').innerText().catch(() => '');
      await pg.click('#raiseCancel'); await pg.waitForTimeout(400);
      out.allinCancelled = !(await pg.locator('#raisePanel:visible').count());
      await rb.click(); await pg.waitForTimeout(400);
      await pg.locator('#presets button').first().click();
      out.confirmVal = await pg.locator('#raiseOut').innerText().catch(() => '');
      await pg.click('#raiseConfirm'); await pg.waitForTimeout(1200);
      out.confirmClosed = !(await pg.locator('#raisePanel:visible').count());
      await pg.screenshot({ path: join(ART, 'reg-after-allin.png') });
      out.done = true; break;
    }
    if (!out.done) await players[0].page.waitForTimeout(600);
  }
  return out;
}
async function idle10(page) {
  await page.evaluate(() => window.__qaResetPaintCount?.());
  let reads = 0; const h = (r) => { if (/8195/.test(r.url())) reads++; }; page.on('request', h);
  await page.waitForTimeout(10_000); page.off('request', h);
  return { repaints: await page.evaluate(() => window.__qaPaintCount ?? null), emuRequests: reads };
}
async function withStats(browser, base, name, uid, vp) {
  const p = await makePlayer(browser, base, name, uid, vp);
  return p;
}
async function main() {
  const { server, base } = await startStatic();
  const browser = await chromium.launch({ headless: true });
  const origNew = browser.newContext.bind(browser);
  browser.newContext = async (o) => { const c = await origNew(o); await c.addInitScript((t) => { window.__qaStats = { enabled: true, startedAt: t }; }, T0); return c; };
  const vp = { width: 390, height: 844 };
  try {
    const host = await makePlayer(browser, base, '阿明', 'c4host', vp);
    const { roomId, code } = await createAndShare(host);
    const g1 = await joinViaLink(browser, base, '大雄', 'c4g1', vp, roomId, code);
    await sitIfNeeded(g1.page); await host.page.waitForTimeout(1500);
    await startHand(host); await playOne([host, g1]); await host.page.waitForTimeout(3000);
    const g = g1.page; const txt = () => g.locator('#psHost').innerText().then((t) => t.replace(/\n/g, ' | ')).catch(() => '');
    R.idleTable = await idle10(g);
    await g.locator('#seats .av[data-ps-uid]').first().click(); await g.waitForTimeout(2000);
    R.online = await txt();
    R.idleOverlay = await idle10(g);
    await g.click('[data-ps="back"]'); await g.waitForTimeout(500);
    await g1.ctx.setOffline(true); await g.waitForTimeout(500);
    await g.locator('#seats .av[data-ps-uid]').first().click(); await g.waitForTimeout(6000);
    R.offlineCached = await txt(); await g.screenshot({ path: join(ART, 'phone-offline-cached.png') });
    await g.click('[data-ps="back"]'); await g.waitForTimeout(500);
    await g.click('#heroAv'); await g.waitForTimeout(6000);
    R.offlineNoCache = await txt(); await g.screenshot({ path: join(ART, 'phone-offline-nocache.png') });
    await g1.ctx.setOffline(false); await g.waitForTimeout(1500);
    await g.click('[data-ps="retry"]').catch(() => {}); await g.waitForTimeout(3000);
    R.afterRetry = await txt();
    await g.click('[data-ps="back"]').catch(() => {}); await g.waitForTimeout(500);
    // closed-table fallback
    await g.locator('#seats .av[data-ps-uid]').first().click(); await g.waitForTimeout(1500);
    for (let i = 0; i < 5; i++) { if (!(await host.page.evaluate(() => window.__qaIsHandInProgress()))) break; await playOne([host, g1]); }
    await host.page.evaluate(() => { document.getElementById('btnMenu')?.click(); document.getElementById('mpBtnCloseRoom')?.click(); });
    await host.page.waitForTimeout(500); await host.page.click('#mpCloseConfirmOk');
    await g.waitForTimeout(4000);
    await g.screenshot({ path: join(ART, 'phone-closed-while-open.png') });
    await g.evaluate(() => document.querySelector('[data-ps="back"]')?.click()); await g.waitForTimeout(800);
    R.afterClosedBack = { lobby: await g.locator('.mp-lobby').count(), toast: await g.locator('#mpToast').innerText().catch(() => ''), closeCard: await g.locator('#mpCloseResult:visible').count() };
    await g.screenshot({ path: join(ART, 'phone-closed-fallback.png') });
    if (R.afterClosedBack.closeCard) { await g.click('#mpCloseLobby').catch(() => {}); await g.waitForTimeout(1500); }
    R.idleLobby = await idle10(g);
    R.errors = [...g1.errors].filter((e) => !/400|Failed to load|offline|ERR_INTERNET/i.test(e)).slice(0, 5);
  } catch (e) { R.fatal = String(e.stack || e); }
  writeFileSync(join(ART, 'r6-result.json'), JSON.stringify(R, null, 1));
  console.log(JSON.stringify(R, null, 1));
  await browser.close(); server.close();
}
main();
