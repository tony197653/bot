/**
 * 第 12 輪 B：只連 demo-poker 本機模擬器；不啟動 emulator。
 * 複製 mp-e2e-6p-addon.mjs 已驗證 helper，改用房主＋一位客人。
 * L 級回歸切片：加碼→打一手→離座→大廳／每晚戰績→管理頁實際補碼。
 * 所有 owner REST 僅用於本機帳戶種子與唯讀資料核對；補碼必須點管理頁。
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
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
      let path = decodeURIComponent(req.url.split('?')[0]);
      // 原 helper 未處理管理頁目錄；本輪需實際載入 admin/index.html。
      if (path === '/poker/admin/') path += 'index.html';
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
  const ctx = await browser.newContext({ viewport: VP, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await ctx.addInitScript(ALWAYS_VISIBLE);
  await ctx.route('**/*', blockProd);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.__qaSignIn === 'function', null, { timeout: 20000 });
  await page.evaluate(([u, n]) => window.__qaSignIn(u, n), [uid, name]);
  // 等條件成立：看到空位／離座就好；若停在加入／繼續畫面就按，最多 20 秒，不寫死等待。
  const READY = '#seats .mp-empty-seat, #mpLeave';
  const GATE = '[data-act="continue"], [data-act="enter"], [data-act="join"]';
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (await page.locator(READY).count()) break;
    const gate = page.locator(GATE);
    if (await gate.count()) await gate.first().click().catch(() => {});
    await page.waitForSelector(`${READY}, ${GATE}`, { state: 'attached', timeout: 1500 }).catch(() => {});
  }
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
  await waitFor(async () => /開始下一手|手結束|準備中/.test(await warm.page.innerText('body')), 6500);
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
  if (!r.ok) throw new Error(`readDoc ${path}: HTTP ${r.status}`);
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
  const btn = await p.page.waitForSelector('#mpAddon:not([disabled])', { timeout: 8000 }).catch(() => null);
  if (!btn) {
    log('加碼鈕不可按', p.name, JSON.stringify(await p.page.evaluate(() => ({
      bar: document.getElementById('mpAddon')?.closest('div')?.innerHTML?.slice(0, 400) ?? null,
      addon: document.getElementById('mpAddon')?.outerHTML ?? null,
      body: document.body.innerText.replace(/\s+/g, ' ').slice(0, 300) }))), 'toasts', JSON.stringify(await toasts(p)));
    throw new Error('加碼鈕不可按');
  }
  await p.page.locator('#mpAddon:not([disabled])').click({ timeout: 8000 });
  const pk = await p.page.waitForSelector('#mpBuyinPicker', { timeout: 5000 }).catch(() => null);
  if (!pk) {
    log('picker 沒出現', p.name, 'toasts', JSON.stringify(await toasts(p)), 'bank(db)', (await readDoc(`pokerPlayers/${p.uid}`))?.bank);
    throw new Error('加碼選擇器沒出現');
  }
  const dflt = Number(await p.page.locator('#mpBuyinPicker input[type="number"]').inputValue());
  await p.page.locator('#mpBuyinPicker [data-confirm]').click();
  await p.page.waitForSelector('#mpAddonCancel', { timeout: 8000 });
  await hostP.page.bringToFront();
  return dflt;
}

async function foldPlayer(players, target, hostP) {
  for (let i = 0; i < 80; i++) {
    for (const p of players) {
      if (p === target && await p.page.locator('#mpFold:not([disabled])').count()) {
        await p.page.bringToFront(); await p.page.locator('#mpFold').click(); await hostP.page.bringToFront(); return true;
      }
      if (p !== target && await p.page.locator('#mpCheck:not([disabled])').count()) { await p.page.bringToFront(); await p.page.locator('#mpCheck').click(); break; }
      if (p !== target && await p.page.locator('#mpCall:not([disabled])').count()) { await p.page.bringToFront(); await p.page.locator('#mpCall').click(); break; }
    }
    await hostP.page.bringToFront(); await sleep(400);
  }
  return false;
}
async function setBank(uid, bank) {
  const r = await fetch(`http://${EMU}/v1/projects/${PROJECT}/databases/(default)/documents/pokerPlayers/${uid}?updateMask.fieldPaths=bank`, {
    method: 'PATCH', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { bank: { integerValue: String(bank) } } }) });
  return r.status;
}

// 大廳：lobby.js:516；入口 :519、:529。每晚排行：stats.js:79–83。
const LOBBY_BANK = '#mpBAcc';
const numberOf = text => Number(String(text).replace(/[^\d-]/g, ''));
async function lobbyBank(page) {
  const el = page.locator(LOBBY_BANK);
  // 牌桌只隱藏 #mpRoot，舊大廳 DOM 仍在；不可讀取隱藏的舊帳戶值。
  if (!(await el.isVisible())) return null;
  const text = (await el.innerText()).trim();
  return /^\d[\d,]*$/.test(text) ? numberOf(text) : null;
}
async function waitForLobby(page) {
  await page.locator('#mpRoot .mp-lobby').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator(LOBBY_BANK).waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('#mpLeaveConfirm').waitFor({ state: 'hidden', timeout: 10000 });
}
async function openLobbyStats(page) {
  await waitForLobby(page);
  const menu = page.locator('#mpRoot .mp-lobby #mpMenuBtn');
  try {
    await menu.waitFor({ state: 'visible', timeout: 10000 });
    // trial 保留 Playwright 的可見、穩定、啟用與接收點擊檢查；不用 force。
    await menu.click({ trial: true, timeout: 10000 });
    await menu.click({ timeout: 10000 });
    await page.locator('#mpMenu:not([hidden]) [data-act="stats"]').click({ timeout: 10000 });
  } catch (error) {
    const state = await page.evaluate(() => {
      const btn = document.getElementById('mpMenuBtn');
      const rect = btn?.getBoundingClientRect();
      const hit = rect && document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return {
        rootHidden: document.getElementById('mpRoot')?.hidden,
        menuExpanded: btn?.getAttribute('aria-expanded'),
        hit: hit && { tag: hit.tagName, id: hit.id, className: hit.className },
        dialogs: [...document.querySelectorAll('[role="dialog"]')]
          .filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
          .map(el => ({ id: el.id, text: el.textContent?.trim().slice(0, 200) })),
      };
    });
    throw new Error(`大廳戰績入口無法操作；若被產品元素持續遮擋，可能是產品 bug：${JSON.stringify(state)}；${error}`);
  }
}
async function shot(page, name) {
  await page.screenshot({ path: join(ART, name), fullPage: true });
}
function requireLocalEmulators() {
  const auth = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  // 瀏覽器 firebase-config.js:29 使用固定埠，拒絕 REST／UI 指向不同實例。
  if (!/^(127\.0\.0\.1|localhost):8195$/.test(EMU || '') ||
      !/^(127\.0\.0\.1|localhost):9099$/.test(auth || '')) {
    throw new Error('需既有本機 emulator：Firestore 8195、Auth 9099；本測試不負責啟動');
  }
  return auth;
}
async function main() {
  const R = { name: 'e2e-regression-addon', checks: {}, errs: [], pending: [], ok: false };
  const ok = (k, v, info) => { R.checks[k] = { ok: !!v, ...(info !== undefined ? { info } : {}) }; };
  const requireCheck = (k, v, info) => {
    ok(k, v, info);
    if (!v) throw new Error(k);
  };
  const players = [];
  let browser, server, adminCtx;
  try {
    const AUTH = requireLocalEmulators();
    const staticSite = await step('啟動本機靜態頁（不啟動 emulator）', startStatic, 5000);
    server = staticSite.server;
    const { base } = staticSite;
    browser = await step('啟動瀏覽器', () => chromium.launch({ headless: true }), 15000);
    const runId = Date.now().toString(36);
    const host = await step('房主登入', () => makeHost(browser, base, NAMES[0], `regh${runId}`), 40000);
    players.push(host);
    const { roomId, code } = await step('建立並分享兩人測試桌', () => createAndShare(host));
    R.roomId = roomId;
    const guest = await step('客人從連結加入', () => joinViaLink(browser, base, NAMES[1], `regg${runId}`, roomId, code));
    players.push(guest);
    await step('客人入座及 UID 對照／帳戶種子', async () => {
      requireCheck('客人入座', await sitGuest(guest.page, host.page, 2));
      const res = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:query`, {
        method: 'POST', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: '{}' });
      if (!res.ok) throw new Error(`accounts:query HTTP ${res.status}`);
      const acc = await res.json();
      const byEmail = Object.fromEntries((acc.userInfo || []).map(u => [u.email, u.localId]));
      for (const p of players) {
        const real = byEmail[`${p.uid}@test.local`];
        if (!real) throw new Error(`找不到 ${p.uid} 的 emulator localId`);
        log('uid 對照', p.uid, real);
        p.uid = real;
        // 沿用已驗證種子 helper；只在本機修改 bank，不冒充管理頁補碼。
        if (!process.env.NO_SEED) {
          const status = await setBank(real, 8000);
          requireCheck(`${p.name} 本機帳戶種子`, status === 200, { status });
        }
      }
      requireCheck('房主端看到兩人入座', await waitFor(async () => (await occupiedFromHost(host.page)) === 2, 20000));
    });
    const initial = await step('讀取攜入與當晚基準', async () => {
      const room = await readDoc(`pokerRooms/${roomId}`);
      const seat = room.seatUids.indexOf(guest.uid);
      if (seat < 0 || !room.sess?.[seat]?.nightKey) throw new Error('缺客人座位／sess.nightKey');
      const sess = room.sess[seat];
      return { room, seat, sess, night: await readDoc(`pokerPlayers/${guest.uid}/nights/${sess.nightKey}`),
        bank: (await readDoc(`pokerPlayers/${guest.uid}`)).bank };
    }, 15000);
    const { seat, sess } = initial;
    const amount = await step('兩手之間由客人 UI 加碼並等上桌', async () => {
      const amount = await queueAddonUI(guest, host);
      requireCheck('加碼預設＝50 大盲或剩餘帳戶', amount === Math.min(50 * initial.room.config.bb, initial.bank), { amount, bank: initial.bank });
      const room = await waitFor(async () => {
        const r = await readDoc(`pokerRooms/${roomId}`);
        return r?.sess?.[seat]?.topUpChips === (sess.topUpChips || 0) + amount && r;
      }, 20000);
      requireCheck('加碼上桌 sess.topUpChips', !!room, { amount });
      requireCheck('加碼後 stacks 與帳戶正確', room.stacks[seat] === initial.room.stacks[seat] + amount &&
        (await readDoc(`pokerPlayers/${guest.uid}`)).bank === initial.bank - amount);
      return amount;
    }, 40000);
    await step('打一手至實際 hand_over', async () => {
      const started = await startHand(players);
      requireCheck('成功開手', started.ok);
      R.hand = await playToShowdown(players, started.host);
      const ended = await waitFor(async () => {
        const r = await readDoc(`pokerRooms/${roomId}`);
        return r?.pub?.phase === 'hand_over' && r;
      }, 15000);
      requireCheck('一手確實結束', !!ended, R.hand);
    }, 150000);
    const settled = await step('客人 #mpLeave 離座結帳', async () => {
      const room = await readDoc(`pokerRooms/${roomId}`);
      const before = await readDoc(`pokerPlayers/${guest.uid}`);
      await guest.page.bringToFront();
      await guest.page.locator('#mpLeave').click();
      await host.page.bringToFront();
      const after = await waitFor(async () => {
        const p = await readDoc(`pokerPlayers/${guest.uid}`);
        return p && !p.tableRoomId && p;
      }, 25000);
      requireCheck('離座清空 tableRoomId、退回含加碼籌碼', after && after.bank === before.bank + room.stacks[seat] && (after.inPlay || 0) === 0,
        { before: before.bank, stack: room.stacks[seat], after });
      return after;
    }, 35000);
    await step('客人回大廳核對帳戶', async () => {
      await guest.page.bringToFront();
      if (!(await guest.page.locator('#mpRoot .mp-lobby').isVisible())) {
        await guest.page.locator('#btnBackLobby').click();
        // 離座後仍是旁觀者；現行回大廳入口一律顯示離開確認。
        await guest.page.locator('#mpLeaveConfirmOk').click();
      }
      await waitForLobby(guest.page);
      const updated = await waitFor(async () => (await lobbyBank(guest.page)) === settled.bank, 15000);
      ok('大廳帳戶＝pokerPlayers.bank', updated, { expected: settled.bank, shown: await lobbyBank(guest.page) });
      await shot(guest.page, '390-reg-lobby.png');
    }, 25000);
    await step('戰績畫面與當晚 buyIn 核對', async () => {
      await openLobbyStats(guest.page);
      await guest.page.locator('.mp-stats [data-mode="night"]').click();
      const path = `pokerPlayers/${guest.uid}/nights/${sess.nightKey}`;
      const night = await waitFor(async () => readDoc(path), 15000);
      if (!night) {
        R.pending.push({ name: '每晚戰績 buyIn', reason: `已定位 ledger.js:212–223 的資料來源 ${path}，但結帳後 15 秒仍無文件；未核對公式` });
      } else {
        const expected = (initial.night?.buyIn || 0) + sess.buyIn + (sess.topUpChips || 0) + amount;
        ok('這晚 buyIn＝原當晚累計＋攜入＋加碼', night.buyIn === expected, { path, buyIn: night.buyIn, expected });
        const row = guest.page.locator('.mp-stats tr.is-me');
        const shown = await waitFor(async () => (await row.count()) === 1 && numberOf(await row.locator('td.num').innerText()) === night.net, 10000);
        ok('每晚戰績畫面顯示客人淨輸贏', shown, { net: night.net, nightKey: sess.nightKey });
      }
      // stats.js 的每晚頁僅顯示淨輸贏；buyIn 依同一來源文件核對，不虛稱 UI 有買入欄。
      await shot(guest.page, '390-reg-stats.png');
      await guest.page.locator('.mp-stats [data-act="back"]').first().click();
      await waitForLobby(guest.page);
    }, 40000);
    await step('管理頁實際補碼 500 與前台即時同步', async () => {
      // admin.js:46–62：本機假 Google 憑證，預設 ADMIN_EMAIL、verified、google.com。
      // Rules:32–36 同樣判定；無需特殊 claim／名單，故不使用 owner REST 設管理員。
      adminCtx = await browser.newContext({ viewport: VP, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
      await adminCtx.addInitScript(ALWAYS_VISIBLE);
      await adminCtx.route('**/*', blockProd);
      const page = await adminCtx.newPage();
      page.on('pageerror', e => R.errs.push(`admin: ${e}`));
      await page.goto(`${base}/poker/admin/?emu=1`, { waitUntil: 'domcontentloaded' });
      await page.locator('#gateBtn').waitFor({ state: 'visible', timeout: 20000 });
      await page.locator('#gateBtn').click();
      const row = page.locator(`#players .row[data-uid="${guest.uid}"]`);
      await row.waitFor({ state: 'visible', timeout: 20000 });
      const before = await readDoc(`pokerPlayers/${guest.uid}`);
      requireCheck('補碼前前台帳戶已同步', await waitFor(async () => (await lobbyBank(guest.page)) === before.bank, 10000));
      await row.click();
      await page.locator('#opAdd').click();
      await page.locator('#amt').fill('500');
      await page.locator('#reason').fill('第12輪加碼後回歸測試');
      await page.locator('#confirmAdj:not([disabled])').click();
      const after = await waitFor(async () => {
        const p = await readDoc(`pokerPlayers/${guest.uid}`);
        return p?.bank === before.bank + 500 && p;
      }, 15000);
      ok('管理頁補碼 bank＋500', !!after, { before: before.bank, after: after?.bank });
      if (after) {
        const entry = after.lastAdjustId && await readDoc(`pokerPlayers/${guest.uid}/ledger/${after.lastAdjustId}`);
        ok('管理頁補碼有 adjust 帳本', entry?.type === 'adjust' && entry.delta === 500 && entry.bankAfter === after.bank, entry);
      }
      // 客人停留原大廳，不重新載入、不跳頁，以原監聽驗證即時更新。
      await guest.page.bringToFront();
      ok('客人前台帳戶即時＋500', await waitFor(async () => (await lobbyBank(guest.page)) === before.bank + 500, 15000),
        { shown: await lobbyBank(guest.page), expected: before.bank + 500 });
      await page.bringToFront();
      await shot(page, '390-reg-admin.png');
      // 切換桌面尺寸後重開抽屜，清掉手機 sheet 的 inert 狀態；不再送補碼。
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width: 1280, height: 900 });
      await row.click();
      await shot(page, '1280-reg-admin.png');
    }, 100000);
  } catch (e) {
    R.errs.push(String(e.stack || e));
  } finally {
    R.errs.push(...players.flatMap(p => p.errors).filter(e => !/favicon|Fonts|net::ERR_FAILED|AbortError|Failed to load|座位已被佔用/i.test(e)));
    if (adminCtx) await adminCtx.close().catch(e => R.errs.push(String(e)));
    if (browser) await browser.close().catch(e => R.errs.push(String(e)));
    if (server) await new Promise(resolve => server.close(resolve));
    R.ok = Object.keys(R.checks).length > 0 && Object.values(R.checks).every(c => c.ok) && R.errs.length === 0 && R.pending.length === 0;
    console.log(JSON.stringify(R, null, 2));
    process.exitCode = R.ok ? 0 : 1;
  }
}
main().catch(e => { console.error('FAIL', e); process.exitCode = 1; });
