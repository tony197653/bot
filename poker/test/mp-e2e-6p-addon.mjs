/**
 * ONE e2e (宗良 quota): 6 players → sit → start → 攤牌.
 * PR client + PR rules; demo-poker emulator only (blockProd aborts tony-poker).
 * Main 9ac534c join denial path is covered by rules #compat 方案A tests.
 *
 *
 * 情境 4 草稿：目前找不到可點擊的手動暫離 UI。
 * mp-app.js:2700–2726 的兩手之間動作列只有開始、加碼、離座；
 * :2743 僅讀取 sittingOut，:2495–2496 的「暫離」只是座位標籤。
 * host.js:1105–1125 依心跳超過 60 秒自動暫離，恢復心跳就清除。
 * 不以離座冒充暫離，也不直接改 sittingOut／away；情境 7 後明確記錄未覆蓋。
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
  page.on('console', (m) => { if (/\[host\]/.test(m.text())) console.log('HOSTCONSOLE', m.type(), m.text().slice(0, 300)); });
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
    if (/開始下一手|開始第一手|(?<!這)手結束|準備中/.test(t) && i > 4) {
      return { done: true, sawShow, ticks: i };
    }
    if (!acted) await warm.page.waitForTimeout(400);
  }
  await warm.page.waitForTimeout(6500);
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
  const dflt = Number(String(await p.page.locator('#mpBuyinPicker input[type="text"]').inputValue()).replaceAll(',', ''));
  await p.page.locator('#mpBuyinPicker [data-confirm]').click();
  await p.page.waitForSelector('#mpAddonCancel', { timeout: 8000 });
  await hostP.page.bringToFront();
  return dflt;
}

async function foldPlayer(players, target, hostP, roomId) {
  // 依房主已寫入的 actor 操作；每次只點一次，等 actionSeq 確認後才換人。
  // 不輪巡可能仍停在上一回合的背景頁按鈕，也不重送尚未確認的動作。
  for (let i = 0; i < 80; i++) {
    const room = await readDoc(`pokerRooms/${roomId}`);
    const seat = room.seatUids.indexOf(target.uid);
    if (seat < 0) throw new Error(`蓋牌目標已離座：${target.name}`);
    if (room.pub?.seats?.[seat]?.folded) {
      await target.page.bringToFront();
      await target.page.waitForSelector('#mpAddon:not([disabled])', { timeout: 8000 });
      return true;
    }
    if (['lobby', 'hand_over', 'showdown'].includes(room.pub?.phase)) {
      throw new Error(`蓋牌前本手已結束：${target.name} ${room.pub?.phase}`);
    }
    const actor = players.find(p => p.uid === room.seatUids[room.pub?.actor]);
    if (!actor) throw new Error(`找不到 actor：${room.pub?.actor}`);
    await actor.page.bringToFront();
    const selector = actor === target ? '#mpFold:not([disabled])'
      : '#mpCheck:not([disabled]), #mpCall:not([disabled])';
    await actor.page.locator(selector).first().waitFor({ timeout: 8000 });
    await actor.page.locator(selector).first().click();
    await hostP.page.bringToFront();
    const confirmed = await waitFor(async () => {
      const next = await readDoc(`pokerRooms/${roomId}`);
      return next?.pub?.handNo === room.pub.handNo &&
        next.pub.actionSeq > room.pub.actionSeq && next;
    }, 10000);
    if (!confirmed) {
      const [latest, intent] = await Promise.all([
        readDoc(`pokerRooms/${roomId}`),
        readDoc(`pokerRooms/${roomId}/intents/${actor.uid}`),
      ]);
      log('蓋牌動作未確認，重試', actor.name, JSON.stringify({
        i, before: { phase: room.pub?.phase, handNo: room.pub?.handNo, actionSeq: room.pub?.actionSeq, actor: room.pub?.actor },
        after: { phase: latest?.pub?.phase, handNo: latest?.pub?.handNo, actionSeq: latest?.pub?.actionSeq, actor: latest?.pub?.actor, rejects: latest?.pub?.rejects },
        intent, toasts: await toasts(actor),
      }));
      await sleep(300);
      continue;
    }
  }
  throw new Error(`蓋牌超過 80 次動作：${target.name}`);
}
async function setBank(uid, bank) {
  const r = await fetch(`http://${EMU}/v1/projects/${PROJECT}/databases/(default)/documents/pokerPlayers/${uid}?updateMask.fieldPaths=bank`, {
    method: 'PATCH', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { bank: { integerValue: String(bank) } } }) });
  return r.status;
}
async function queueAddonAmount(p, hostP, amount) {
  await p.page.bringToFront();
  const ready = await p.page.waitForSelector('#mpAddon:not([disabled])', { timeout: 8000 }).catch(() => null);
  if (!ready) throw new Error(`加碼鈕不可按 ${p.name}`);
  const prev = await p.page.evaluate(() => document.getElementById('mpAddonCancel')?.getAttribute('aria-label') || '');
  await p.page.locator('#mpAddon:not([disabled])').click();
  await p.page.waitForSelector('#mpBuyinPicker', { timeout: 5000 });
  await p.page.locator('#mpBuyinPicker input[type="text"]').fill(String(amount));
  await p.page.locator('#mpBuyinPicker [data-confirm]').click();
  await p.page.waitForFunction(pv => { const l = document.getElementById('mpAddonCancel')?.getAttribute('aria-label') || ''; return l && l !== pv; }, prev, { timeout: 8000 });
  await hostP.page.bringToFront();
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
    const room0 = await readDoc(`pokerRooms/${roomId}`);
    const bb = room0.config.bb;
    const g1 = guests[0], g2 = guests[1], g3 = guests[2];
    const seatOf = (room, p) => room.seatUids.indexOf(p.uid);

    // 情境 1（兩手之間）：大雄加碼，房主在開下一手前處理
    await host.page.screenshot({ path: join(ART, '390-between-lobby.png') });
    const before = await readDoc(`pokerRooms/${roomId}`);
    const s1 = seatOf(before, g1);
    const bank1 = (await readDoc(`pokerPlayers/${g1.uid}`)).bank;
    const total0 = before.chipTotal;
    const d1 = await step('addon g1', () => queueAddonUI(g1, host), 30000);
    ok('預設 50 大盲（帳戶不足就全部）', d1 === Math.min(50 * bb, bank1), { d1, bb, bank1 });
    await g1.page.screenshot({ path: join(ART, '390-queued.png') }).catch(() => {});
    const after = await waitFor(async () => { const r = await readDoc(`pokerRooms/${roomId}`); return r.lastMoneyEvent?.type === 'addon' && r.lastMoneyEvent.uid === g1.uid && r; }, 15000);
    ok('情境1 加碼上桌（stacks+x）', after && after.stacks[s1] === before.stacks[s1] + d1, { before: before.stacks[s1], after: after?.stacks[s1] });
    ok('情境1 帳戶扣款＝x', (await readDoc(`pokerPlayers/${g1.uid}`)).bank === bank1 - d1);
    await sleep(1500);
    const seen = await Promise.all(players.map(toasts));
    ok('情境1 全桌看到「大雄 加碼」', seen.filter((t, i) => i !== 1 && t.some(x => x.includes(`${NAMES[1]} 加碼`))).length === 5, seen.map(t => t.filter(x => x.includes('加碼'))));
    await host.page.screenshot({ path: join(ART, '390-host-after-addon.png') });

    const st = await step('startHand1', () => startHand(players), 90000);
    // 情境 3：手中沒蓋牌 → 加碼鈕灰
    const inHand = await waitFor(async () => (await g3.page.locator('#mpFold').count()) > 0, 10000);
    ok('情境3 手中沒蓋牌加碼鈕灰', inHand && (await g3.page.locator('#mpAddon[disabled]').count()) === 1);
    await g3.page.screenshot({ path: join(ART, '390-inhand-grey.png') });
    let folded = false;
    for (let i = 0; i < 80 && !folded; i++) {
      for (const p of players) {
        if (p === g3 && await g3.page.locator('#mpFold:not([disabled])').count()) {
          await g3.page.bringToFront(); await g3.page.locator('#mpFold').click();
        }
        if (p !== g3 && await p.page.locator('#mpCheck:not([disabled])').count()) { await p.page.bringToFront(); await p.page.locator('#mpCheck').click(); break; }
        if (p !== g3 && await p.page.locator('#mpCall:not([disabled])').count()) { await p.page.bringToFront(); await p.page.locator('#mpCall').click(); break; }
      }
      await host.page.bringToFront();
      folded = !!(await g3.page.locator('#mpAddon:not([disabled])').count()) ||
        !!(await g3.page.evaluate(() => {
          const seats = window.__room?.pub?.seats || [];
          const me = seats.find(s => s && (s.uid === window.__uid || s.name === '小夫'));
          return !!(me?.folded);
        }).catch(() => false));
      await sleep(400);
    }
    ok('小夫蓋牌', folded); log('folded', folded);
    const midRoom = await readDoc(`pokerRooms/${roomId}`);
    const s3 = seatOf(midRoom, g3);
    const bank3 = (await readDoc(`pokerPlayers/${g3.uid}`)).bank;
    ok('情境2 蓋牌後加碼鈕可按', await waitFor(async () => {
      await host.page.bringToFront();
      await g3.page.bringToFront();
      return (await g3.page.locator('#mpAddon:not([disabled])').count()) > 0;
    }, 12000));
    // 情境 5：手中排隊後取消 → 不扣
    await step('addon g3 cancel-case', () => queueAddonUI(g3, host), 30000);
    await g3.page.bringToFront();
    await g3.page.locator('#mpAddonCancel').click();
    await g3.page.waitForSelector('#mpAddonCancel', { state: 'detached', timeout: 8000 }).catch(() => {});
    const q3 = await readDoc(`pokerRooms/${roomId}/addons/${g3.uid}`);
    ok('情境5 取消後排隊清空、帳戶不扣', q3?.items?.length === 0 && (await readDoc(`pokerPlayers/${g3.uid}`)).bank === bank3, q3);
    { const t3 = await waitFor(async () => { const t = await toasts(g3); return t.includes('已取消加碼，帳戶沒有扣') && t; }, 3000); ok('情境5 本人看到「已取消加碼」', !!t3, await toasts(g3)); }
    // 情境 2：再排一筆，本手不動
    const d3 = await step('addon g3', () => queueAddonUI(g3, host), 30000);
    await g3.page.screenshot({ path: join(ART, '390-folded-queued.png') });
    const midRoom2 = await readDoc(`pokerRooms/${roomId}`);
    ok('情境2 手中排隊不動本手（stacks、底池、帳戶不變）',
      midRoom2.stacks[s3] === midRoom.stacks[s3] && JSON.stringify(midRoom2.pub?.pots ?? midRoom2.pub?.pot ?? null) === JSON.stringify(midRoom.pub?.pots ?? midRoom.pub?.pot ?? null) &&
      (await readDoc(`pokerPlayers/${g3.uid}`)).bank === bank3);
    // 情境 6 也在同一手排隊：蓋牌後排兩筆再把帳戶改少，這手結束才整批判定。
    const g4 = guests[3], g5 = guests[4];
    const midSeats = await readDoc(`pokerRooms/${roomId}`);
    const s4 = seatOf(midSeats, g4), s5 = seatOf(midSeats, g5);
    const folded4 = await step('fold g4', () => foldPlayer(players, g4, host, roomId), 120000);
    ok('宜靜蓋牌', folded4);
    let bank5 = (await readDoc(`pokerPlayers/${guests[4].uid}`)).bank;
    if (!folded4) throw new Error('宜靜蓋牌失敗，情境 6 無法建立');
    {
      await step('g4 排 2,000', () => queueAddonAmount(g4, host, 2000), 20000);
      await step('g4 再排 1,000', () => queueAddonAmount(g4, host, 1000), 20000);
      const q4 = await readDoc(`pokerRooms/${roomId}/addons/${g4.uid}`);
      const queued4 = q4?.items?.length === 2 && q4.items.reduce((sum, item) => sum + item.amount, 0) === 3000;
      ok('多筆排隊（2 筆合計 3,000）', queued4, q4?.items);
      if (!queued4) throw new Error('情境 6 未建立兩筆合計 3,000 的排隊');
      const bank4Status = await setBank(g4.uid, 2500);
      log('g4 帳戶改成 2,500', bank4Status);
      if (bank4Status !== 200) throw new Error(`情境 6 帳戶調整失敗：${bank4Status}`);
      ok('技安蓋牌', await step('fold g5', () => foldPlayer(players, g5, host, roomId), 60000));
      bank5 = (await readDoc(`pokerPlayers/${g5.uid}`)).bank;
      await step('g5 排 1,000', () => queueAddonAmount(g5, host, 1000), 20000);
      // 模擬管理頁補碼：排隊中帳戶 +5,000（emulator owner 直寫，非實際管理頁 UI）
      log('管理頁補 5,000', await setBank(g5.uid, bank5 + 5000));
    }
    R.hand1 = await step('play1', () => playToShowdown(players, st.host), 150000);
    const after2 = await waitFor(async () => { const r = await readDoc(`pokerRooms/${roomId}`); return ['lobby', 'hand_over'].includes(r?.pub?.phase) && (r.sess?.[s3]?.topUpChips || 0) === d3 && r; }, 30000);
    ok('情境2 這手結束後才上桌（sess.topUpChips＝x）', !!after2, { d3 });
    ok('情境2 帳戶扣款＝x', (await readDoc(`pokerPlayers/${g3.uid}`)).bank === bank3 - d3);
    R.hand2 = { done: true, via: 'same-hand-as-情景6' };

    const p4 = await waitFor(async () => { const q = await readDoc(`pokerRooms/${roomId}/addons/${g4.uid}`); return q?.items?.length === 0 && q; }, 20000);
    const r2b = await readDoc(`pokerRooms/${roomId}`);
    ok('情境6 帳戶不足整批不上桌、不扣', !!p4 && (await readDoc(`pokerPlayers/${g4.uid}`)).bank === 2500 && (r2b.sess[s4].topUpChips || 0) === 0, { bank: (await readDoc(`pokerPlayers/${g4.uid}`)).bank, top: r2b.sess[s4].topUpChips });
    const t4 = await waitFor(async () => { const t = await toasts(g4); return t.some(x => x === '⚠ 帳戶不足，沒有加碼') && t; }, 5000);
    ok('情境6 本人看到帳戶不足', !!t4, await toasts(g4));
    const p5 = await waitFor(async () => { const r = await readDoc(`pokerRooms/${roomId}`); return (r.sess[s5].topUpChips || 0) === 1000 && r; }, 20000);
    const bank5b = (await readDoc(`pokerPlayers/${g5.uid}`)).bank;
    ok('管理頁補碼與加碼同時：帳戶＝原＋5,000－1,000（沒有蓋掉）', !!p5 && bank5b === bank5 + 5000 - 1000, { bank5, now: bank5b });
    // 自動開下一手若已開始，先打完再做兩手之間的帳戶／離座檢查。
    const between = await waitFor(async () => {
      const r = await readDoc(`pokerRooms/${roomId}`);
      if (['lobby', 'hand_over'].includes(r?.pub?.phase)) return r;
      return null;
    }, 2000);
    if (!between) await step('打完自動開的下一手', () => playToShowdown(players, host), 150000);
    await waitFor(async () => {
      const r = await readDoc(`pokerRooms/${roomId}`);
      return ['lobby', 'hand_over'].includes(r?.pub?.phase) && r;
    }, 20000);
    // 情境 10：前台帳戶即時更新（開加碼選擇器看帳戶數字，再取消）
    await g5.page.bringToFront();
    await g5.page.locator('#mpAddon:not([disabled])').click().catch(() => {});
    const shownBank = await g5.page.waitForSelector('#mpBuyinBank', { timeout: 5000 }).then(e => e.innerText()).catch(() => '');
    await g5.page.screenshot({ path: join(ART, '390-addon-picker.png') });
    ok('情境10 前台帳戶即時顯示', shownBank.replace(/[^\d]/g, '') === String(bank5b), { shownBank, bank5b });
    await g5.page.locator('#mpBuyinPicker [data-cancel]').click().catch(() => {});
    const total2 = (await readDoc(`pokerRooms/${roomId}`)).chipTotal;
    ok('籌碼守恆（第二手後）', total2 === total0 + d1 + d3 + 1000, { total2 });
    // 情境 7：加碼後離座結帳（大雄）→ 退回 stacks（含加碼）
    const rL = await readDoc(`pokerRooms/${roomId}`);
    const stackL = rL.stacks[s1];
    const bankL = (await readDoc(`pokerPlayers/${g1.uid}`)).bank;
    await g1.page.bringToFront();
    await g1.page.locator('#mpLeave').click();
    await host.page.bringToFront();
    const pL = await waitFor(async () => { const p = await readDoc(`pokerPlayers/${g1.uid}`); return !p.tableRoomId && p; }, 25000);
    ok('情境7 加碼後離座結帳：帳戶＋桌上籌碼（含加碼）', !!pL && pL.bank === bankL + stackL && (pL.inPlay || 0) === 0, { bankL, stackL, now: pL?.bank });
    // QA r1c 7b：縮為三人，非房主隱藏 >60 秒，兩手之間加碼後手動開手。
    for (const leaving of [guests[2], guests[3]]) {
      await leaving.page.locator('#mpLeave').click();
      await waitFor(async () => !(await readDoc(`pokerRooms/${roomId}`)).seatUids.includes(leaving.uid), 25000);
    }
    const gA = guests[1];
    const rA = await readDoc(`pokerRooms/${roomId}`);
    const sA = seatOf(rA, gA);
    const setVis = (vis) => gA.page.evaluate((v) => {
      window.__hidden = !v;
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (window.__hidden ? 'hidden' : 'visible') });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => !!window.__hidden });
      document.dispatchEvent(new Event('visibilitychange'));
    }, vis);
    await setVis(false);
    const awayRoom = await step('等房主標暫離（>60 秒無心跳）', () => waitFor(async () => {
      const r = await readDoc(`pokerRooms/${roomId}`);
      return r.pub?.away?.[String(sA)] && r;
    }, 100000), 105000);
    ok('情境4 心跳斷 60 秒後房主標暫離', !!awayRoom);
    // 保持 hidden，不送回桌心跳；先完成當前手，再於 HAND_OVER 排隊。
    const activePlayers = [host, guests[4]];
    const current = await readDoc(`pokerRooms/${roomId}`);
    if (!['lobby', 'hand_over'].includes(current.pub?.phase)) {
      await step('暫離後完成當前手', () => playToShowdown(activePlayers, host), 150000);
    }
    const beforeAwayStart = await readDoc(`pokerRooms/${roomId}`);
    if (!['lobby', 'hand_over'].includes(beforeAwayStart.pub?.phase)) throw new Error('情境4 必須在兩手之間排隊');
    ok('情境4 三人且非房主暫離', beforeAwayStart.seatUids.filter(Boolean).length === 3 && !!beforeAwayStart.pub.away?.[String(sA)]);
    const bankA = (await readDoc(`pokerPlayers/${gA.uid}`)).bank;
    const stackA = beforeAwayStart.stacks[sA];
    const topA = beforeAwayStart.sess[sA].topUpChips || 0;
    await queueAddonAmount(gA, host, 1000);
    await host.page.locator('#mpStart').click();
    const opened = await waitFor(async () => {
      const r = await readDoc(`pokerRooms/${roomId}`);
      return !['lobby', 'hand_over'].includes(r.pub?.phase) && r.pub.handNo > beforeAwayStart.pub.handNo && r;
    }, 20000);
    // 開手後立即讀取，不打完這手，也不等待加碼條件才採樣。
    const accountA = await readDoc(`pokerPlayers/${gA.uid}`);
    ok('情境4 手動下一手立即上桌且保留暫離', !!opened && accountA.bank === bankA - 1000 &&
      opened.stacks[sA] === stackA + 1000 && opened.sess[sA].topUpChips === topA + 1000 &&
      opened.chipTotal === beforeAwayStart.chipTotal + 1000 && opened.pub.seats[sA].sittingOut === true);
    const total4 = (await readDoc(`pokerRooms/${roomId}`)).chipTotal;
    log('chipTotal after 4', total4);
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
