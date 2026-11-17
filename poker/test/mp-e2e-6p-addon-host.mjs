/** 第 10 輪：SPEC v1.0 情境 8、9；僅供本機 emulator，未執行驗收。 */
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
  // 本輪禁止固定等待超過 2 秒；保留原本最多 6.5 秒的收尾觀察。
  await waitFor(async () => /亮牌|不亮|開始下一手|手結束|準備中|開始第一手/.test(await warm.page.innerText('body')), 6500);
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
async function queueAddonAmount(p, hostP, amount) {
  await p.page.bringToFront();
  const prev = await p.page.evaluate(() => document.getElementById('mpAddonCancel')?.getAttribute('aria-label') || '');
  await p.page.locator('#mpAddon:not([disabled])').click();
  await p.page.waitForSelector('#mpBuyinPicker', { timeout: 5000 });
  await p.page.locator('#mpBuyinPicker input[type="number"]').fill(String(amount));
  await p.page.locator('#mpBuyinPicker [data-confirm]').click();
  await p.page.waitForFunction(pv => { const l = document.getElementById('mpAddonCancel')?.getAttribute('aria-label') || ''; return l && l !== pv; }, prev, { timeout: 8000 });
  await hostP.page.bringToFront();
}

async function main() {
  const R = { name: 'e2e-6p-addon-host', checks: {}, errs: [], ok: false, pending: [] };
  const ok = (k, v, info) => { R.checks[k] = { ok: !!v, ...(info ? { info } : {}) }; };
  let server, browser;
  const allPlayers = [];
  try {
    if (!EMU || !/^(127\.0\.0\.1|localhost):\d+$/.test(EMU)) throw new Error('只連本機 emulator');
    const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST;
    if (!AUTH || !/^(127\.0\.0\.1|localhost):\d+$/.test(AUTH)) throw new Error('Auth 只連本機 emulator');
    const staticSite = await step('startStatic', () => startStatic(), 10000);
    server = staticSite.server;
    const base = staticSite.base;
    browser = await step('launch', () => chromium.launch({ headless: true }), 30000);
    const { host, guests, players, roomId } = await step('六人入座、uid 對照與帳戶種子', async () => {
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
      // QA 登入的 uid 只是信箱提示（hostadd@test.local），實際 uid 是 auth emulator 產生的 localId。
      const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST;
      const acc = await (await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:query`, {
        method: 'POST', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: '{}' })).json();
      const byEmail = Object.fromEntries((acc.userInfo || []).map(u => [u.email, u.localId]));
      for (const p of players) {
        const real = byEmail[`${p.uid}@test.local`];
        log('uid', p.name, 'hint', p.uid, '→ 實際', real, '讀取路徑', `pokerPlayers/${real}`);
        p.uid = real;
      }
      // 新玩家送 2,000 全攜入後帳戶是 0；測試前用 emulator owner 給每人帳戶 8,000（只寫本機 emulator）。
      if (!process.env.NO_SEED) for (const p of players) {
        const r = await fetch(`http://${EMU}/v1/projects/${PROJECT}/databases/(default)/documents/pokerPlayers/${p.uid}?updateMask.fieldPaths=bank`, {
          method: 'PATCH', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: { bank: { integerValue: '8000' } } }) });
        log('seed bank', p.name, r.status);
      }
      await sleep(800);
      R.seatedN = await waitFor(async () => { const n = await occupiedFromHost(host.page); return n >= 6 && n; }, 20000);

      allPlayers.push(...players);
      ok('六人坐滿', R.seatedN === 6, { seatedN: R.seatedN });
      if (R.seatedN !== 6) throw new Error('未坐滿六人');
      return { host, guests, players, roomId };
    }, 420000);
    const roomPath = `pokerRooms/${roomId}`;
    const target = guests[2];
    const remaining = players.filter(p => p !== host);
    const shot = (p, name) => p.page.screenshot({ path: join(ART, `390-host-${name}.png`) });
    await step('開第一手', async () => {
      const started = await startHand(players);
      ok('第一手已開', started.ok);
      if (!started.ok) throw new Error('第一手未開');
      await shot(host, 'first-hand');
    }, 90000);
    const before = await step('客人蓋牌、排加碼 1,000 並保存斷線前資料', async () => {
      const folded = await foldPlayer(players, target, host);
      ok('guests[2] 蓋牌', folded);
      if (!folded) throw new Error('指定客人未蓋牌');
      await queueAddonAmount(target, host, 1000);
      const room = await readDoc(roomPath);
      const account = await readDoc(`pokerPlayers/${target.uid}`);
      const queue = await readDoc(`${roomPath}/addons/${target.uid}`);
      const snapshot = { bank: account.bank, chipTotal: room.chipTotal,
        stacks: [...room.stacks], hostUid: room.hostUid, seatUids: [...room.seatUids] };
      R.beforeDisconnect = snapshot;
      ok('斷線前加碼排隊一筆 1,000', queue?.items?.length === 1 && queue.items[0].amount === 1000, queue);
      ok('斷線前仍為原房主', room.hostUid === host.uid, { hostUid: room.hostUid, original: host.uid });
      if (room.hostUid !== host.uid) throw new Error('關閉前房主已變更');
      await shot(target, 'queued-before-disconnect');
      return snapshot;
    }, 60000);
    await step('情境8 關閉房主 browser context', () => host.ctx.close(), 15000);
    let samples = 0, lastLog = -Infinity;
    const takeover = await step('情境8、9 輪詢接手（最多 150 秒）', () => waitFor(async () => {
      const room = await readDoc(roomPath);
      if (Date.now() - lastLog >= 2000) {
        log('接手輪詢', 'hostUid', room?.hostUid, 'pub.phase', room?.pub?.phase, 'status', room?.status);
        lastLog = Date.now();
      }
      if (!room) throw new Error('房間文件不存在');
      if (room.hostUid === before.hostUid && room.status !== 'closed') {
        const bank = (await readDoc(`pokerPlayers/${target.uid}`))?.bank;
        const queue = await readDoc(`${roomPath}/addons/${target.uid}`);
        // 重讀房間，避免把接手批次已完成後的帳戶誤認成接手前。
        const confirm = await readDoc(roomPath);
        if (confirm?.hostUid === before.hostUid && confirm.status !== 'closed') {
          samples++;
          const unchanged = bank === before.bank && queue?.items?.length === 1 && queue.items[0].amount === 1000;
          if (!unchanged) {
            ok('情境8 接手前帳戶不扣、排隊仍一筆', false, { bank, expected: before.bank, queue, samples });
            throw new Error('接手前帳戶或排隊已變動');
          }
        }
      }
      return room.hostUid && room.hostUid !== before.hostUid && room.status !== 'closed' && room;
    }, 150000), 155000);
    ok('情境8 接手前帳戶不扣、排隊仍一筆', samples > 0, { samples });
    ok('情境9 150 秒內換房主', !!takeover, { room: await step('讀取接手結果', () => readDoc(roomPath), 10000) });
    if (!takeover) {
      R.pending.push({ name: '情境9 接手後加碼與新房主收桌退款', reason: '150 秒內沒有可用的新房主；不直接修改 hostUid 或呼叫產品內部函式。情境8 完整斷線收桌退款尚未覆蓋。' });
      await step('接手逾時截圖', () => shot(target, 'takeover-timeout'), 10000);
    } else {
      R.afterTakeover = { hostUid: takeover.hostUid, chipTotal: takeover.chipTotal, stacks: takeover.stacks, phase: takeover.pub?.phase, status: takeover.status };
      const newHost = remaining.find(p => p.uid === takeover.hostUid);
      if (!newHost) throw new Error('新房主不在留下的玩家頁面中');
      await step('接手後完成本手，必要時由新房主開始下一手', async () => {
        let room = await readDoc(roomPath);
        if (!['lobby', 'hand_over'].includes(room.pub?.phase)) {
          R.handAfterTakeover = await playToShowdown(remaining, newHost);
        }
        room = await readDoc(roomPath);
        if (['lobby', 'hand_over'].includes(room.pub?.phase)) {
          const starter = await waitFor(() => findStartPage(remaining), 15000);
          ok('新房主頁面有 #mpStart', starter?.uid === room.hostUid);
          if (!starter || starter.uid !== room.hostUid) throw new Error('找不到新房主開始按鈕');
          const started = await startHand(remaining);
          ok('新房主開下一手', started.ok);
          if (!started.ok) throw new Error('新房主未能開下一手');
        }
        await shot(target, 'after-takeover');
      }, 180000);
      await step('情境9 加碼上桌與總額一致', async () => {
        const seat = before.seatUids.indexOf(target.uid);
        const applied = await waitFor(async () => {
          const r = await readDoc(roomPath);
          return r?.sess?.[seat]?.topUpChips === 1000 && r;
        }, 20000);
        const room = applied || await readDoc(roomPath);
        const account = await readDoc(`pokerPlayers/${target.uid}`);
        const sum = room.stacks.reduce((a, b) => a + b, 0);
        ok('情境9 sess.topUpChips＝1,000', room.sess?.[seat]?.topUpChips === 1000);
        ok('情境9 bank 只減 1,000', account.bank === before.bank - 1000, { before: before.bank, now: account.bank });
        ok('情境9 stacks 合計＝接手後 chipTotal', sum === room.chipTotal, { sum, chipTotal: room.chipTotal, takeoverTotal: takeover.chipTotal });
        ok('情境9 chipTotal＝原總額＋1,000', room.chipTotal === before.chipTotal + 1000, { before: before.chipTotal, now: room.chipTotal });
      }, 30000);
      await step('收桌前結束牌局並記錄留下玩家 stacks、bank', async () => {
        const room = await readDoc(roomPath);
        if (!['lobby', 'hand_over'].includes(room.pub?.phase)) {
          R.finalHand = await playToShowdown(remaining, newHost);
        }
        const settled = await waitFor(async () => {
          const r = await readDoc(roomPath);
          return ['lobby', 'hand_over'].includes(r?.pub?.phase) && r;
        }, 20000);
        if (!settled) throw new Error('收桌前本手未結算，無法直接用 stacks 核對退款');
        R.beforeClose = await Promise.all(remaining.filter(p => settled.seatUids.includes(p.uid)).map(async p => ({
          uid: p.uid, name: p.name, stack: settled.stacks[settled.seatUids.indexOf(p.uid)],
          bank: (await readDoc(`pokerPlayers/${p.uid}`)).bank,
        })));
        if (!R.beforeClose.some(p => p.uid === target.uid)) throw new Error('加碼客人已不在座位中');
        await shot(newHost, 'before-close');
      }, 180000);
      await step('新房主由選單收桌並核對退款', async () => {
        // mp-app.js:3735、3754–3760、3946、3953–3963；選單開關見 :3781。
        if (!await newHost.page.locator('#btnMenu').count() || !await newHost.page.locator('#mpBtnCloseRoom').count()) {
          R.pending.push({ name: '新房主收桌退款', reason: '實際頁面找不到 #btnMenu 或 #mpBtnCloseRoom，未硬寫替代操作。' });
          return;
        }
        await newHost.page.bringToFront();
        await newHost.page.locator('#btnMenu').click();
        await newHost.page.locator('#mpBtnCloseRoom').click();
        await newHost.page.locator('#mpCloseConfirmOk').click();
        for (const p of R.beforeClose) {
          const account = await waitFor(async () => {
            const a = await readDoc(`pokerPlayers/${p.uid}`);
            return a && !a.tableRoomId && a.inPlay === 0 && a;
          }, 25000);
          ok(`收桌 ${p.name} bank 增加＝stacks（含加碼）、inPlay＝0`,
            !!account && account.bank === p.bank + p.stack && account.inPlay === 0,
            { bankBefore: p.bank, stack: p.stack, bankAfter: account?.bank, inPlay: account?.inPlay });
        }
        ok('收桌後 room.status＝closed', (await readDoc(roomPath))?.status === 'closed');
        await shot(newHost, 'closed');
      }, 150000);
    }
  } catch (e) {
    R.errs.push(String(e?.stack || e));
  } finally {
    R.errs.push(...allPlayers.flatMap(p => p.errors).filter(e => !/favicon|Fonts|net::ERR_FAILED|AbortError|Failed to load|座位已被佔用/i.test(e)).slice(0, 8));
    if (browser) await step('關閉瀏覽器', () => browser.close(), 15000).catch(e => R.errs.push(String(e)));
    if (server) await step('關閉靜態伺服器', () => new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())), 10000).catch(e => R.errs.push(String(e)));
  }
  R.ok = Object.values(R.checks).every(c => c.ok) && R.errs.length === 0;
  console.log(JSON.stringify(R, null, 2));
  process.exitCode = R.ok ? 0 : 1;
}

main().catch((e) => { console.error('FAIL', e); process.exitCode = 1; });
