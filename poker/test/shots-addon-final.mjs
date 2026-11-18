/** 補碼最終截圖；僅供 PM 透過本機 firebase emulators:exec 執行。 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const REPO = join(ROOT, '..');
const ART = process.env.SHOTS_DIR || '/workspace/poker-addon/shots/final';
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

const NAMES = ['阿明', '大雄', '靜香', '小夫', '宜靜', '技安'];

async function makeHost(browser, base, name, uid, VP) {
  const ctx = await browser.newContext({
    viewport: VP,
    deviceScaleFactor: 1,
    isMobile: VP.width === 390,
    hasTouch: VP.width === 390,
  });
  await ctx.addInitScript(ALWAYS_VISIBLE);
  await ctx.route('**/*', blockProd);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (/\[host\]/.test(m.text())) console.log('HOSTCONSOLE', m.type(), m.text().slice(0, 300)); });
  await page.goto(`${base}/poker/?emu=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.__qaSignIn === 'function', null, {
    timeout: 20000,
  });
  await page.evaluate(([u, n]) => window.__qaSignIn(u, n), [uid, name]);
  await page.waitForSelector('.mp-lobby, .mp-shell', { timeout: 20000 });
  return { ctx, page, name, uid, errors };
}

async function createAndShare(host, prefix) {
  await host.page.locator('.mp-btn-primary[data-act="create"]:visible').first().click();
  await host.page.waitForSelector('form, .mp-create', { timeout: 8000 });
  if (prefix) {
    await host.page.locator('label.mp-seg-item:has(input[name="blinds"][value="5/10"])').click();
    await host.page.waitForFunction(() => document.getElementById('mpCreateChips')?.value === '500');
    await capture(host, prefix, 'open-table-buyin');
    // 後續補碼情境維持原本的 10/20 盲注。
    await host.page.locator('label.mp-seg-item:has(input[name="blinds"][value="10/20"])').click();
  }
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

async function joinViaLink(browser, base, name, uid, roomId, code, VP) {
  const path = `/poker/?emu=1&room=${encodeURIComponent(code)}&r=${encodeURIComponent(roomId)}`;
  const ctx = await browser.newContext({ viewport: VP, deviceScaleFactor: 1, isMobile: VP.width === 390, hasTouch: VP.width === 390 });
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
    if (/開始下一手|開始第一手|(?<!這)手結束|準備中/.test(t) && i > 4) {
      return { done: true, sawShow, ticks: i };
    }
    if (!acted) await warm.page.waitForTimeout(400);
  }
  await warm.page.waitForFunction(() => /亮牌|不亮|開始下一手|(?<!這)手結束|準備中|開始第一手/.test(document.body.innerText), null, { timeout: 6500 }).catch(() => {});
  const t = await warm.page.innerText('body');
  const hasShowOrNext = /亮牌|不亮|開始下一手|(?<!這)手結束|準備中|開始第一手/.test(t);
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
async function readDoc(path, signal) {
  const r = await fetch(`http://${EMU}/v1/projects/${PROJECT}/databases/(default)/documents/${path}`, { headers: { Authorization: 'Bearer owner' }, signal });
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
    log('補碼鈕不可按', p.name, JSON.stringify(await p.page.evaluate(() => ({
      bar: document.getElementById('mpAddon')?.closest('div')?.innerHTML?.slice(0, 400) ?? null,
      addon: document.getElementById('mpAddon')?.outerHTML ?? null,
      body: document.body.innerText.replace(/\s+/g, ' ').slice(0, 300) }))), 'toasts', JSON.stringify(await toasts(p)));
    throw new Error('補碼鈕不可按');
  }
  await p.page.locator('#mpAddon:not([disabled])').click({ timeout: 8000 });
  const pk = await p.page.waitForSelector('#mpBuyinPicker', { timeout: 5000 }).catch(() => null);
  if (!pk) {
    log('picker 沒出現', p.name, 'toasts', JSON.stringify(await toasts(p)), 'bank(db)', (await readDoc(`pokerPlayers/${p.uid}`))?.bank);
    throw new Error('補碼選擇器沒出現');
  }
  const dflt = Number(String(await p.page.locator('#mpBuyinPicker input[type="text"]').inputValue()).replaceAll(',', ''));
  await p.page.locator('#mpBuyinPicker [data-confirm]').click();
  await p.page.waitForSelector('#mpAddonCancel', { timeout: 8000 });
  await hostP.page.bringToFront();
  return dflt;
}

async function foldPlayer(players, target, hostP) {
  for (let i = 0; i < 80; i++) {
    if (await target.page.locator('#mpAddon:not([disabled])').count()) return true;
    for (const p of players) {
      if (p === target && await p.page.locator('#mpFold:not([disabled])').count()) {
        await p.page.bringToFront(); await p.page.locator('#mpFold').click();
      } else if (p !== target && await p.page.locator('#mpCheck:not([disabled])').count()) {
        await p.page.bringToFront(); await p.page.locator('#mpCheck').click(); break;
      } else if (p !== target && await p.page.locator('#mpCall:not([disabled])').count()) {
        await p.page.bringToFront(); await p.page.locator('#mpCall').click(); break;
      }
    }
    await hostP.page.bringToFront(); await sleep(400);
  }
  return !!(await target.page.locator('#mpAddon:not([disabled])').count());
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
  await p.page.locator('#mpBuyinPicker input[type="text"]').fill(String(amount));
  await p.page.locator('#mpBuyinPicker [data-confirm]').click();
  await p.page.waitForFunction(pv => { const l = document.getElementById('mpAddonCancel')?.getAttribute('aria-label') || ''; return l && l !== pv; }, prev, { timeout: 8000 });
  await hostP.page.bringToFront();
}


const shots = [];
const missing = [];
const EXPECTED = ['open-table-buyin', 'addon-button', 'start-next', 'addon-picker', 'inhand-hint', 'queued', 'table-message', 'insufficient', 'away-addon'];
async function capture(p, prefix, name) {
  const filename = `${prefix}-${name}.png`;
  await p.page.screenshot({ path: join(ART, filename), fullPage: true });
  const toast = await p.page.evaluate(() => {
    const el = document.getElementById('mpToast');
    return el && !el.hidden ? el.textContent : '';
  });
  shots.push(filename);
  log('截圖', filename, 'toast', JSON.stringify(toast));
}
async function toastShot(p, prefix, name, text, timeout = 20000) {
  await p.page.waitForFunction(expected => {
    const el = document.getElementById('mpToast');
    return el && !el.hidden && el.getClientRects().length && el.textContent.includes(expected) &&
      (expected !== '帳戶不足，沒有補碼' ||
        (el.classList.contains('mp-toast-warning') && el.textContent.trim() === `⚠ ${expected}`));
  }, text, { timeout });
  await capture(p, prefix, name);
}
async function runViewport(browser, base, VP) {
  const prefix = String(VP.width);
  const players = [];
  const run = (name, fn, ms = 60000) => step(`${prefix} ${name}`, fn, ms);
  try {
    const hint = `shots${prefix}${Date.now()}`;
    const host = await run('建立房主', () => makeHost(browser, base, NAMES[0], `${hint}host`, VP));
    players.push(host);
    const { roomId, code } = await run('開桌', () => createAndShare(host, prefix));
    for (let i = 1; i <= 2; i++) {
      const g = await run(`加入 ${i}`, () => joinViaLink(browser, base, NAMES[i], `${hint}g${i}`, roomId, code, VP));
      players.push(g);
      await run(`入座 ${i}`, async () => {
        if (!await sitGuest(g.page, host.page, i + 1)) throw new Error('入座失敗');
      });
    }
    await run('UID 對照與帳戶種子', async () => {
      const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST;
      const response = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:query`, {
        method: 'POST', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: '{}' });
      if (!response.ok) throw new Error(`帳戶查詢失敗 ${response.status}`);
      const acc = await response.json();
      const byEmail = Object.fromEntries((acc.userInfo || []).map(u => [u.email, u.localId]));
      for (const p of players) {
        const real = byEmail[`${p.uid}@test.local`];
        if (!real) throw new Error(`找不到 UID：${p.uid}`);
        log('uid', p.name, p.uid, '→', real);
        p.uid = real;
        const status = await setBank(p.uid, 8000);
        log('帳戶種子', p.name, status);
        if (status !== 200) throw new Error(`帳戶種子失敗 ${status}`);
      }
      if (!await waitFor(async () => (await occupiedFromHost(host.page)) >= 3)) throw new Error('三人尚未入座');
    });
    const guest = players[1], observer = players[2];
    await run('兩手之間補碼按鈕與預設選擇器', async () => {
      await guest.page.waitForSelector('#mpAddon:not([disabled])');
      await capture(guest, prefix, 'addon-button');
      await guest.page.locator('#mpAddon').click();
      await guest.page.waitForSelector('#mpBuyinPicker');
      const room = await readDoc(`pokerRooms/${roomId}`);
      const bank = (await readDoc(`pokerPlayers/${guest.uid}`)).bank;
      const amount = Number(String(await guest.page.locator('#mpBuyinPicker input[type="text"]').inputValue()).replaceAll(',', ''));
      if (amount !== 50 * room.config.bb || bank < amount) throw new Error(`預設非 50 大盲：${amount}`);
      await capture(guest, prefix, 'addon-picker');
      await guest.page.locator('#mpBuyinPicker [data-cancel]').click();
    });
    const started = await run('開始一手', () => startHand(players), 90000);
    if (!started.ok) throw new Error('未開始牌局');
    await run('手中補碼提示截圖', async () => {
      await guest.page.waitForSelector('#mpAddonHint, #mpAddon[disabled]', { timeout: 8000 });
      await capture(guest, prefix, 'inhand-hint');
    });
    await run('蓋牌後排隊截圖', async () => {
      if (!await foldPlayer(players, guest, started.host)) throw new Error('客人未蓋牌');
      const amount = await queueAddonUI(guest, started.host);
      await queueAddonAmount(guest, started.host, amount);
      const queue = await readDoc(`pokerRooms/${roomId}/addons/${guest.uid}`);
      if (!Array.isArray(queue?.items) || queue.items.length < 2) throw new Error('排隊未達兩筆');
      const total = queue.items.reduce((sum, item) => sum + Number(item.amount), 0);
      await guest.page.waitForFunction(expected => {
        const row = document.getElementById('mpAddonQueueRow');
        const button = document.getElementById('mpAddonCancel');
        const label = button?.getAttribute('aria-label') || '';
        const amount = expected.toLocaleString('en-US');
        const toast = document.getElementById('mpToast');
        const visibleToast = toast && !toast.hidden ? toast.textContent : '';
        const queuedToast = /補碼排隊中|下一手前補碼/.test(visibleToast);
        return row?.getClientRects().length && row.querySelector('span')?.textContent.trim() === `下一手前補碼 ${amount}` &&
          button && !button.disabled && button.getClientRects().length && label === `取消補碼 ${amount}` &&
          !visibleToast.includes('補碼排隊中') &&
          (!queuedToast || visibleToast.trim() === `下一手前補碼 ${amount}`);
      }, total, { timeout: 8000 });
      await capture(guest, prefix, 'queued');
    });
    // 先監聽另一位玩家，避免牌局結束後才等待而錯過 toast。
    const message = run('全桌補碼訊息截圖', () => toastShot(observer, prefix, 'table-message', `${guest.name} 補碼`, 170000), 175000)
      .catch(e => { log('缺少全桌訊息', e.message); });
    await run('完成本手', async () => {
      const result = await playToShowdown(players, started.host);
      if (!result.done) throw new Error('本手尚未完成');
      // 必須是已完成第一手、三人仍在座的 hand_over，不接受開始第一手。
      const between = await waitFor(async () => {
        const room = await readDoc(`pokerRooms/${roomId}`);
        return room?.pub?.phase === 'hand_over' && room.seatUids.filter(Boolean).length === 3 && room;
      }, 8000);
      if (!between) throw new Error('未等到三人仍在座的 hand_over');
      await host.page.bringToFront();
      await host.page.waitForFunction(() => {
        const button = document.getElementById('mpStart');
        return button && !button.disabled && button.getClientRects().length &&
          button.textContent.trim() === '開始下一手（3人）';
      }, null, { timeout: 5000 });
      await capture(host, prefix, 'start-next');
    }, 150000);
    await message;
    await run('兩手之間上桌後取消競態', async () => {
      const before = await readDoc(`pokerRooms/${roomId}`);
      const seat = before?.seatUids?.indexOf(guest.uid) ?? -1;
      if (seat < 0 || before.sess?.[seat]?.uid !== guest.uid) throw new Error('找不到客人座位與 session');
      const topUpBefore = Number(before.sess[seat].topUpChips || 0);
      await guest.page.locator('#mpAddon:not([disabled])').click();
      await guest.page.waitForSelector('#mpBuyinPicker');
      await guest.page.locator('#mpBuyinPicker [data-confirm]').click();
      const deadline = Date.now() + 15000;
      const signal = AbortSignal.timeout(15000);
      let processed = false;
      while (Date.now() < deadline) {
        const [queue, room] = await Promise.all([
          readDoc(`pokerRooms/${roomId}/addons/${guest.uid}`, signal),
          readDoc(`pokerRooms/${roomId}`, signal),
        ]);
        if (Array.isArray(queue?.items) && queue.items.length === 0 &&
            room?.sess?.[seat]?.uid === guest.uid &&
            Number(room.sess[seat].topUpChips) > topUpBefore) {
          processed = true;
          break;
        }
        await sleep(Math.min(100, Math.max(0, deadline - Date.now())));
      }
      if (!processed) throw new Error('15 秒內未確認房主清空 items 且該座位 topUpChips 增加');
      log('已確認房主處理補碼', 'seat', seat, 'topUpBefore', topUpBefore);
      // 僅透過真實頁面流程；cancelAddon 位於模組內，沒有可直接呼叫的頁面介面。
      const clicked = await guest.page.evaluate(() => {
        const button = document.getElementById('mpAddonCancel');
        if (!button || button.disabled || !button.getClientRects().length) return false;
        button.click();
        return true;
      });
      if (!clicked) throw new Error('房主處理後取消鈕已消失或不可按；cancelAddon 未公開於頁面，無法直接呼叫取消流程');
      await guest.page.waitForFunction(() => {
        const t = document.getElementById('mpToast');
        return t && !t.hidden && /已上桌，不能取消|已取消補碼/.test(t.textContent);
      }, null, { timeout: 10000 });
      const actual = await guest.page.locator('#mpToast').innerText();
      log('取消競態實際文字', actual);
      if (actual.includes('已上桌，不能取消')) await capture(guest, prefix, 'already-on-table');
      else if (actual.includes('已取消補碼')) await capture(guest, prefix, 'cancelled');
    }).catch(e => {
      const filename = `${prefix}-already-on-table.png`;
      log('選用取消競態未截到', filename, e.message);
    });
    await run('暫離時補碼截圖', async () => {
      const leftoverPicker = guest.page.locator('#mpBuyinPicker [data-cancel]');
      if (await leftoverPicker.isVisible()) await leftoverPicker.click();
      const room = await readDoc(`pokerRooms/${roomId}`);
      const seat = room?.seatUids?.indexOf(guest.uid) ?? -1;
      if (seat < 0 || room.hostUid === guest.uid) throw new Error('客人座位不存在或已成為房主');
      if ((await readDoc(`pokerPlayers/${guest.uid}`))?.bank <= 0) throw new Error('暫離截圖前帳戶已歸零');
      const setVisible = visible => guest.page.evaluate(v => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => !v });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v ? 'visible' : 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      }, visible);
      await setVisible(false);
      try {
        const away = await waitFor(async () => {
          const current = await readDoc(`pokerRooms/${roomId}`, AbortSignal.timeout(5000));
          return current?.pub?.away?.[seat] && current;
        }, 100000);
        if (!away) throw new Error('100 秒內房主未依心跳標記暫離');
        // 自己的座位不畫暫離標籤（hero 走 #meRoot）。保持 hidden 以免心跳恢復後標籤被清掉。
        // 60 秒等待期間可能已開下一手並發牌給尚未被標暫離的客人，之後被自動蓋牌，
        // 產品在 folded 時優先顯示「已蓋牌」。等 sittingOut 寫入後先打完該手，再新開一手（暫離者不發牌、folded=false），才看得到「暫離」。
        const viewer = players.find(p => p.uid === away.hostUid);
        if (!viewer || viewer === guest) throw new Error('找不到房主觀察頁');
        const sitting = await waitFor(async () => {
          const current = await readDoc(`pokerRooms/${roomId}`, AbortSignal.timeout(5000));
          return current?.pub?.seats?.[seat]?.sittingOut && current;
        }, 15000);
        if (!sitting) throw new Error('15 秒內 pub.seats 未出現 sittingOut');
        const inHand = !['lobby', 'hand_over', '', undefined].includes(sitting.pub?.phase);
        if (inHand) {
          const result = await playToShowdown(players, viewer);
          if (!result.done) throw new Error('暫離後未能完成本手');
        }
        const startedAway = await startHand(players);
        if (!startedAway.ok) throw new Error('暫離後未能開下一手');
        const tag = await viewer.page.waitForSelector(`#seats [data-seat="${seat}"] .is-away-tag`, { timeout: 15000 }).catch(() => null);
        if (!tag) {
          const diag = await viewer.page.evaluate(s => {
            const el = document.querySelector(`#seats [data-seat="${s}"]`);
            return { html: el?.outerHTML || null, seats: document.getElementById('seats')?.innerHTML?.slice(0, 800) || null };
          }, seat);
          throw new Error(`房主頁未見暫離標籤 ${JSON.stringify(diag)}`);
        }
        await guest.page.locator('#mpAddon:not([disabled])').click();
        await guest.page.waitForSelector('#mpBuyinPicker', { timeout: 5000 });
        await capture(viewer, prefix, 'away-addon');
        const cancelPicker = guest.page.locator('#mpBuyinPicker [data-cancel]');
        if (await cancelPicker.isVisible()) await cancelPicker.click();
      } finally {
        await setVisible(true);
      }
    }, 240000).catch(e => { log('暫離截圖失敗', e.message); });
    await run('帳戶不足截圖', async () => {
      // 開著選擇器等帳戶即時數字到 0，確保前台已收到 setBank。
      await guest.page.locator('#mpAddon:not([disabled])').click();
      await guest.page.waitForSelector('#mpBuyinBank');
      const status = await setBank(guest.uid, 0);
      if (status !== 200) throw new Error(`setBank 失敗 ${status}`);
      await guest.page.waitForFunction(() => document.getElementById('mpBuyinBank')?.textContent.trim() === '0', null, { timeout: 10000 });
      await guest.page.locator('#mpBuyinPicker [data-cancel]').click();
      await guest.page.locator('#mpAddon:not([disabled])').click();
      await toastShot(guest, prefix, 'insufficient', '帳戶不足，沒有補碼');
    });
  } catch (e) {
    log('尺寸流程失敗', prefix, e.stack || e.message);
  } finally {
    for (const name of EXPECTED) {
      const filename = `${prefix}-${name}.png`;
      if (!shots.includes(filename) && !missing.includes(filename)) missing.push(filename);
    }
    for (const p of players) await p.ctx.close();
  }
}
async function main() {
  const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const local = /^(127\.0\.0\.1|localhost):\d+$/;
  if (!EMU || !local.test(EMU) || !AUTH || !local.test(AUTH)) throw new Error('只連本機 Firestore 與 Auth emulator');
  const { server, base } = await step('啟動靜態伺服器', startStatic);
  let browser;
  try {
    browser = await step('啟動瀏覽器', () => chromium.launch({ headless: true }));
    // 產品是單桌：同一個 emulator 只能有一張開放牌桌，所以每個尺寸分開跑（ONLY_VP=390 或 1280）。
    for (const VP of [{ width: 390, height: 844 }, { width: 1280, height: 800 }].filter(v => !process.env.ONLY_VP || String(v.width) === process.env.ONLY_VP)) {
      await runViewport(browser, base, VP);
    }
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
  process.exitCode = missing.length ? 1 : 0;
}
main().catch(e => {
  log('失敗', e.stack || e.message);
  for (const prefix of ['390', '1280']) for (const name of EXPECTED) {
    const filename = `${prefix}-${name}.png`;
    if (!shots.includes(filename) && !missing.includes(filename)) missing.push(filename);
  }
  process.exitCode = 1;
}).finally(() => console.log(JSON.stringify({ shots, missing })));
