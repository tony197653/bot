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
const ART = process.env.ADDON_SHOTS || join(ROOT, 'test-artifacts');
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
  window.__toasts = [];
  let last = '';
  setInterval(() => {
    const t = document.getElementById('mpToast');
    const s = t && !t.hidden ? t.textContent : '';
    if (s && s !== last) window.__toasts.push(s);
    last = s;
  }, 50);
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
      // 入座現在先跳攜入選擇器（舊 e2e 沒按確認，入座永遠不會送出）
      const picker = await guestPage.waitForSelector('#mpBuyinPicker [data-confirm]', { timeout: 3000 }).catch(() => null);
      console.log('  picker shown', !!picker);
      if (picker) await picker.click().catch(() => {});
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


const EMU = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-poker';
function decode(v) {
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decode);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, decode(x)]));
  if ('timestampValue' in v) return v.timestampValue;
  return v;
}
async function readDoc(path) {
  const r = await fetch(`http://${EMU}/v1/projects/${PROJECT}/databases/(default)/documents/${path}`, { headers: { Authorization: 'Bearer owner' } });
  if (r.status === 404) return null;
  const j = await r.json();
  return Object.fromEntries(Object.entries(j.fields || {}).map(([k, x]) => [k, decode(x)]));
}
const toasts = p => p.page.evaluate(() => window.__toasts.slice());
const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
async function step(name, fn, ms = 60000) {
  log('▶', name);
  let timer;
  try {
    const v = await Promise.race([fn(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`逾時 ${ms}ms：${name}`)), ms); })]);
    log('✔', name, typeof v === 'object' ? '' : v ?? '');
    return v;
  } finally { clearTimeout(timer); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(300); }
  return null;
}
async function queueAddonUI(p, hostP) {
  await p.page.bringToFront();
  await p.page.locator('#mpAddon:not([disabled])').click();
  await p.page.waitForSelector('#mpBuyinPicker', { timeout: 5000 });
  const dflt = Number(await p.page.locator('#mpBuyinPicker input[type="number"]').inputValue());
  await p.page.locator('#mpBuyinPicker [data-confirm]').click();
  await p.page.waitForSelector('#mpAddonCancel', { timeout: 8000 });
  await hostP.page.bringToFront();
  return dflt;
}

async function main() {
  if (!EMU || !/^(127\.0\.0\.1|localhost):\d+$/.test(EMU)) throw new Error('只連本機 emulator');
  const { server, base } = await startStatic();
  const browser = await chromium.launch({ headless: true });
  const R = { name: 'e2e-6p-addon', checks: {} };
  const ok = (k, v, info) => { R.checks[k] = { ok: !!v, ...(info ? { info } : {}) }; };
  try {
    const host = await step('makeHost', () => makeHost(browser, base, NAMES[0], 'hostadd'), 40000);
    const { roomId, code } = await step('createAndShare', () => createAndShare(host), 60000);
    R.roomId = roomId;
    const guests = [];
    for (let i = 1; i < 6; i++) {
      const g = await step(`join ${i}`, () => joinViaLink(browser, base, NAMES[i], `gadd${i}`, roomId, code), 60000);
      log('diag', i, JSON.stringify(await guestDiag(g.page)));
      const sat = await step(`sit ${i}`, () => sitGuest(g.page, host.page, i + 1), 60000);
      log('sat', i, sat, 'occupied', await occupiedFromHost(host.page));
      guests.push(g);
    }
    const players = [host, ...guests];
    R.seatedN = await waitFor(async () => { const n = await occupiedFromHost(host.page); return n >= 6 && n; }, 20000);
    const room0 = await readDoc(`pokerRooms/${roomId}`);
    const bb = room0.config.bb;
    const g1 = guests[0], g2 = guests[1], g3 = guests[2];
    const seatOf = (room, p) => room.seatUids.indexOf(p.uid);

    // 情境 1＋5（兩手之間）：大雄加碼；靜香加碼後取消
    await host.page.screenshot({ path: join(ART, '390-between-lobby.png') });
    const bank1 = (await readDoc(`pokerPlayers/${g1.uid}`)).bank;
    const d1 = await step('addon g1', () => queueAddonUI(g1, host), 30000);
    ok('預設 50 大盲（帳戶不足就全部）', d1 === Math.min(50 * bb, bank1), { d1, bb, bank1 });
    await g1.page.screenshot({ path: join(ART, '390-queued.png') });
    const bank2 = (await readDoc(`pokerPlayers/${g2.uid}`)).bank;
    await step('addon g2', () => queueAddonUI(g2, host), 30000);
    await g2.page.bringToFront();
    await g2.page.locator('#mpAddonCancel').click();
    await g2.page.waitForSelector('#mpAddonCancel', { state: 'detached', timeout: 8000 });
    const q2 = await readDoc(`pokerRooms/${roomId}/addons/${g2.uid}`);
    ok('情境5 取消後排隊清空', q2 && q2.items.length === 0, q2);

    // 開第一手：起手籌碼含加碼、全桌看到訊息、取消者不扣
    const before = await readDoc(`pokerRooms/${roomId}`);
    const s1 = seatOf(before, g1);
    const st = await step('startHand1', () => startHand(players), 90000);
    R.started1 = st.ok;
    const after = await waitFor(async () => { const r = await readDoc(`pokerRooms/${roomId}`); return r.lastMoneyEvent?.type === 'addon' && r; }, 15000);
    ok('情境1 加碼上桌（stacks+x）', after && after.stacks[s1] === before.stacks[s1] + d1, { before: before.stacks[s1], after: after?.stacks[s1] });
    const p1 = await readDoc(`pokerPlayers/${g1.uid}`);
    ok('情境1 帳戶扣款＝x', p1.bank === bank1 - d1, { bank1, now: p1.bank });
    ok('情境5 取消者帳戶不扣', (await readDoc(`pokerPlayers/${g2.uid}`)).bank === bank2);
    await sleep(1500);
    const seen = await Promise.all(players.map(toasts));
    const msg = `${NAMES[1]} 加碼`;
    ok('情境1 全桌看到「大雄 加碼」', seen.filter((t, i) => i !== 1 && t.some(x => x.includes(msg))).length === 5, seen.map(t => t.filter(x => x.includes('加碼'))));

    // 情境 3：手中沒蓋牌 → 加碼鈕灰；情境 2：蓋牌後加碼不影響本手
    const inHand = await waitFor(async () => (await g3.page.locator('#mpFold').count()) > 0, 10000);
    const grey = await g3.page.locator('#mpAddon[disabled]').count();
    ok('情境3 手中沒蓋牌加碼鈕灰', inHand && grey === 1);
    await g3.page.screenshot({ path: join(ART, '390-inhand-grey.png') });
    // 等靜香輪到再蓋牌（其他人 check/call）
    let folded = false;
    for (let i = 0; i < 80 && !folded; i++) {
      for (const p of players) {
        if (p === g3 && await g3.page.locator('#mpFold:not([disabled])').count()) {
          await g3.page.bringToFront(); await g3.page.locator('#mpFold').click(); folded = true; break;
        }
        if (p !== g3 && await p.page.locator('#mpCheck:not([disabled])').count()) { await p.page.bringToFront(); await p.page.locator('#mpCheck').click(); break; }
        if (p !== g3 && await p.page.locator('#mpCall:not([disabled])').count()) { await p.page.bringToFront(); await p.page.locator('#mpCall').click(); break; }
      }
      await host.page.bringToFront(); await sleep(400);
    }
    ok('靜香蓋牌', folded); log('folded', folded);
    const midRoom = await readDoc(`pokerRooms/${roomId}`);
    const s3 = seatOf(midRoom, g3);
    const potBefore = midRoom.pub?.pot ?? null;
    const enabled = await waitFor(async () => (await g3.page.locator('#mpAddon:not([disabled])').count()) > 0, 8000);
    ok('情境2 蓋牌後加碼鈕可按', enabled);
    const bank3 = (await readDoc(`pokerPlayers/${g3.uid}`)).bank;
    const d3 = enabled ? await step('addon g3', () => queueAddonUI(g3, host), 30000) : 0;
    await g3.page.screenshot({ path: join(ART, '390-folded-queued.png') });
    const midRoom2 = await readDoc(`pokerRooms/${roomId}`);
    ok('情境2 手中排隊不動本手（stacks、底池、帳戶不變）',
      midRoom2.stacks[s3] === midRoom.stacks[s3] && (midRoom2.pub?.pot ?? null) === potBefore &&
      (await readDoc(`pokerPlayers/${g3.uid}`)).bank === bank3, { pot: [potBefore, midRoom2.pub?.pot] });
    const hand = await step('play1', () => playToShowdown(players, st.host), 150000);
    R.hand1 = hand;
    // 第二手開始前上桌
    const ho = await readDoc(`pokerRooms/${roomId}`);
    const st2 = await step('startHand2', () => startHand(players), 90000);
    R.started2 = st2.ok;
    const after2 = await waitFor(async () => { const r = await readDoc(`pokerRooms/${roomId}`); return r.lastMoneyEvent?.type === 'addon' && r.lastMoneyEvent.uid === g3.uid && r; }, 15000);
    ok('情境2 下一手才上桌（hand_over stacks＋x）', after2 && after2.stacks[s3] === ho.stacks[s3] + d3, { ho: ho.stacks[s3], after: after2?.stacks[s3], d3 });
    ok('情境2 帳戶扣款＝x', (await readDoc(`pokerPlayers/${g3.uid}`)).bank === bank3 - d3);
    const total = after2 ? after2.stacks.reduce((a, b) => a + b, 0) : -1;
    ok('chipTotal 與 stacks 合計一致', after2 && after2.chipTotal === total, { chipTotal: after2?.chipTotal, total });
    await host.page.screenshot({ path: join(ART, '390-host-after-addon.png') });

    R.errs = players.flatMap(p => p.errors).filter(e => !/favicon|Fonts|net::ERR_FAILED|AbortError|Failed to load|座位已被佔用/i.test(e)).slice(0, 8);
    R.ok = Object.values(R.checks).every(c => c.ok) && R.errs.length === 0;
    for (const p of players) await p.ctx.close();
  } finally {
    await browser.close();
    server.close();
  }
  console.log(JSON.stringify(R, null, 2));
  process.exit(R.ok ? 0 : 1);
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
