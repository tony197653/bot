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
const ART = '/workspace/pr49b-r6';
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
async function playOne(players, regress) {
  for (let i = 0; i < 40; i++) {
    let acted = false;
    for (const p of players) {
      if (!p || p.ctx._closed) continue;
      const pg = p.page;
      for (const sel of regress ? ['#mpCheck', '#mpCall', '#mpFold'] : ['#mpFold', '#mpCheck', '#mpCall']) {
        const b = pg.locator(`${sel}:visible:not([disabled])`);
        if (await b.count().catch(() => 0)) { await b.first().click().catch(() => {}); acted = true; R.clicks = R.clicks || {}; R.clicks[sel] = (R.clicks[sel] || 0) + 1; break; }
      }
    }
    await players[0].page.waitForTimeout(700);
    const t = await players[0].page.innerText('body').catch(() => '');
    if (!acted && /開始下一手|開始第一手|贏得|手結束/.test(t)) return true;
  }
  return false;
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
    // S1 login + hands
    const host = await makePlayer(browser, base, '阿明', 'r6host', vp);
    const { roomId, code } = await createAndShare(host);
    const g1 = await joinViaLink(browser, base, '大雄', 'r6g1', vp, roomId, code);
    const g2 = await joinViaLink(browser, base, '靜香', 'r6g2', vp, roomId, code);
    R.sat = [await sitIfNeeded(g1.page), await sitIfNeeded(g2.page)];
    await host.page.waitForTimeout(1500);
    R.started = await startHand(host);
    // regression probe on whoever acts: presence of controls
    await host.page.screenshot({ path: join(ART, 's1-hand1-host.png') });
    R.controls = await Promise.all([host, g1, g2].map((p) => p.page.evaluate(() => ['#mpFold', '#mpCheck', '#mpCall', '#mpRaise', '#mpLeave'].filter((s) => document.querySelector(s)))));
    R.h1 = await playOne([host, g1, g2], true);
    for (let h = 0; h < 2; h++) { await startHand(host); R['h' + (h + 2)] = await playOne([host, g1, g2], false); }
    await host.page.waitForTimeout(4000);
    R.s1 = await statsSnap(roomId);
    R.s1ls = await lsPending(host.page);
    R.s1warn = host.errors.filter((e) => /stats/i.test(e)).slice(0, 6);
    if (process.env.S1ONLY) throw new Error('S1ONLY stop');
    R.idleHost = await idle10(host.page);
    await host.page.screenshot({ path: join(ART, 's1-after-hands-host.png') });
    // S2 leave seat via 回大廳 dialog: cancel then ok
    const lb = g2.page.locator('button:has-text("回大廳"), [data-act="lobby"]').first(); R.lobbyBtn = await lb.count(); if (R.lobbyBtn) await lb.click().catch(() => {}); await g2.page.waitForTimeout(800); R.leaveShown = await g2.page.evaluate(() => { const el = document.getElementById('mpLeaveConfirm'); return !!(el && !el.hidden) || window.__qaShowLeaveConfirm(); }); R.leaveText = await g2.page.evaluate(() => document.getElementById('mpLeaveConfirm')?.innerText?.slice(0,80) || '');
    await g2.page.screenshot({ path: join(ART, 's2-leave-dialog.png') });
    await g2.page.evaluate(() => window.__qaLeaveConfirmClick('cancel'));
    R.cancelStays = await g2.page.locator('#seats').count();
    await g2.page.evaluate(() => { window.__qaShowLeaveConfirm(); window.__qaLeaveConfirmClick('ok'); });
    await g2.page.waitForSelector('.mp-lobby', { timeout: 15000 }).then(() => (R.g2lobby = true)).catch(() => (R.g2lobby = false));
    await g2.page.screenshot({ path: join(ART, 's2-g2-lobby.png') });
    R.idleLobby = await idle10(g2.page);
    await g2.ctx.close();
    await startHand(host); R.h4 = await playOne([host, g1], false);
    await host.page.waitForTimeout(3000);
    R.s2 = await statsSnap(roomId);
    // S3 host switch
    const hostUid = R.s2.hostUid;
    await host.ctx.close(); host.ctx._closed = true;
    await emuBackdateHostGone(roomId, hostUid, 11 * 60_000);
    let newHost = null;
    for (let i = 0; i < 60; i++) {
      await g1.page.waitForTimeout(1000);
      const s = await adminRead(async (db) => { const f = await import('firebase/firestore'); return (await f.getDoc(f.doc(db, 'pokerRooms', roomId))).data()?.hostUid; });
      if (s && s !== hostUid) { newHost = s; break; }
      if (i === 10) await emuBackdateHostGone(roomId, hostUid, 12 * 60_000);
    }
    R.newHost = newHost;
    await g1.page.screenshot({ path: join(ART, 's3-after-takeover.png') });
    const g3 = await joinViaLink(browser, base, '胖虎', 'r6g3', vp, roomId, code);
    R.g3sat = await sitIfNeeded(g3.page);
    await g1.page.waitForTimeout(1500);
    R.h5start = await startHand(g1); R.h5 = await playOne([g1, g3], false);
    // reconnect resubmit: offline/online on new host
    await g1.ctx.setOffline(true); await g1.page.waitForTimeout(1500); await g1.ctx.setOffline(false);
    await g1.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await g1.page.waitForTimeout(5000);
    R.s3 = await statsSnap(roomId);
    R.s3ls = await lsPending(g1.page);
    R.idleNewHost = await idle10(g1.page);
    await g1.page.screenshot({ path: join(ART, 's3-new-host-final.png') });
    // host close table
    const close = g1.page.locator('#mpBtnCloseRoom');
    R.closeBtn = await close.count();
    R.errors = { g1: g1.errors.slice(0, 10), g3: g3.errors.slice(0, 10), host: host.errors.slice(0, 10) };
    await g3.ctx.close(); await g1.ctx.close();
  } catch (e) { R.fatal = String(e.stack || e); }
  writeFileSync(join(ART, 'r6-result.json'), JSON.stringify(R, null, 1));
  console.log(JSON.stringify(R, null, 1));
  await browser.close(); server.close();
}
main();
