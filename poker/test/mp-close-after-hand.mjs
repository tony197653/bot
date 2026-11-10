// 手後收桌結果：僅使用本機 emulator。AP、FP、PROJ、TAG 必填；GUEST_VP=desktop|phone。
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPO = dirname(ROOT);
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.mp3':'audio/mpeg', '.json':'application/json', '.webmanifest':'application/manifest+json' };
const results = [];
const check = (name, ok, extra='') => { results.push({ name, ok: !!ok, extra }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); };
function startStatic() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      let file = p.startsWith('/lib/') ? join(REPO, p.slice(1)) : p.startsWith('/poker/') ? join(ROOT, p.replace(/^\/poker\/?/, '') || 'index.html') : join(ROOT, 'index.html');
      if (!existsSync(file) || !file.startsWith(REPO)) { res.writeHead(404); return res.end('nf'); }
      let body = readFileSync(file);
      if (file.endsWith('firebase-config.js')) body = Buffer.from(String(body).replace(/9099/g, process.env.AP).replace(/8195/g, process.env.FP).replace(/'demo-poker'/g, `'${process.env.PROJ}'`).replace(/demo-poker\.appspot/g, `${process.env.PROJ}.appspot`));
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' }); res.end(body);
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}
function blockProd(route) {
  const u = route.request().url();
  if (/googleapis|tony-poker\.web\.app|tony-poker\.firebase|firebaseio/i.test(u) && !/127\.0\.0\.1|localhost/.test(u)) return route.abort();
  return route.continue();
}
async function makePlayer(browser, base, name, uid, viewport, path = '/poker/?emu=1') {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: viewport.width < 700 ? 3 : 1, isMobile: viewport.width < 700, hasTouch: viewport.width < 700 });
  await ctx.route('**/*', blockProd);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  await page.goto(base + path, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.__qaSignIn === 'function', null, { timeout: 20000 });
  await page.evaluate(([u, n]) => window.__qaSignIn(u, n), [uid, name]);
  await page.waitForTimeout(2500);
  uid = await page.evaluate(async () => (await import('/lib/auth/auth.js')).getUser()?.uid);
  if (!uid) throw Error('登入後缺少 Firebase UID');
  return { ctx, page, name, uid, errors };
}
async function sitAll(p) {
  for (let i = 0; i < 6 && (await p.page.locator('.mp-empty-seat').count()); i++) {
    await p.page.evaluate(() => document.querySelector('.mp-empty-seat')?.click());
    await p.page.waitForTimeout(1500);
    const ok = p.page.locator('button:visible:has-text("坐下"), button:visible:has-text("確認"), button:visible:has-text("入座")');
    if (await ok.count()) { await ok.first().click().catch(() => {}); await p.page.waitForTimeout(1500); }
  }
}
async function openTable(browser, base, name, uid, vp, q='') {
  const p = await makePlayer(browser, base, name, uid, vp, '/poker/?emu=1' + q);
  await p.page.locator('.mp-btn-primary[data-act="create"]:visible').first().click();
  await p.page.waitForSelector('form, .mp-create', { timeout: 8000 });
  await p.page.click('button[type="submit"]');
  await p.page.waitForSelector('.mp-url', { timeout: 20000 });
  const url = new URL((await p.page.innerText('.mp-url')).trim());
  await p.page.click('[data-act="enter"]'); await p.page.waitForTimeout(3500);
  await sitAll(p);
  return { p, roomId: url.searchParams.get('r'), code: url.searchParams.get('room') };
}

async function joinSit(browser, base, name, uid, vp, T) {
  const D = await makePlayer(browser, base, name, uid, vp, `/poker/?emu=1&room=${T.code}&r=${T.roomId}`);
  const cont = D.page.locator('[data-act="continue"], [data-act="enter"]');
  if (await cont.count()) { await cont.first().click().catch(() => {}); await D.page.waitForTimeout(2000); }
  await D.page.waitForTimeout(1500); await sitAll(D); return D;
}

function decode(value) {
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('stringValue' in value) return value.stringValue;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decode);
  if ('mapValue' in value) return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([k, v]) => [k, decode(v)]));
  if ('booleanValue' in value) return value.booleanValue;
  return null;
}
async function readDoc(path) {
  const res = await fetch(`http://127.0.0.1:${process.env.FP}/v1/projects/${process.env.PROJ}/databases/(default)/documents/${path}`, {
    headers: { Authorization: 'Bearer owner' },
  });
  if (!res.ok) throw Error(`讀取 ${path}: HTTP ${res.status}`);
  const doc = await res.json();
  return decode({ mapValue: { fields: doc.fields } });
}
async function waitForDoc(path, predicate) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const doc = await readDoc(path);
    if (predicate(doc)) return doc;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw Error(`等待文件狀態逾時：${path}`);
}
async function main() {
  let server, browser;
  try {
    for (const key of ['AP', 'FP', 'PROJ', 'TAG']) {
      if (!process.env[key]) throw Error(`缺少環境變數 ${key}`);
    }
    if (!/^\d+$/.test(process.env.AP) || !/^\d+$/.test(process.env.FP) ||
        !/^demo-[a-z0-9-]+$/.test(process.env.PROJ)) throw Error('僅接受本機埠與 demo- emulator 專案');
    const guestVP = process.env.GUEST_VP || 'phone';
    if (!['desktop', 'phone'].includes(guestVP)) throw Error('GUEST_VP 必須為 desktop 或 phone');
    const desktop = { width: 1280, height: 800 }, phone = { width: 390, height: 844 };
    const serving = await startStatic();
    server = serving.server;
    browser = await chromium.launch();
    const tag = process.env.TAG;
    const table = await openTable(browser, serving.base, `H${tag}`, `h${tag}`, guestVP === 'phone' ? desktop : phone);
    const host = table.p;
    const guest = await joinSit(browser, serving.base, `G${tag}`, `g${tag}`, guestVP === 'phone' ? phone : desktop, table);
    const before = await readDoc(`pokerRooms/${table.roomId}`);
    const guestSeat = before.seatUids.indexOf(guest.uid);
    const hostSeat = before.seatUids.indexOf(host.uid);
    if (guestSeat < 0 || hostSeat < 0) throw Error('雙方尚未入座');
    // 第一手 button 是最小座號；讓房主坐較小座號，才能蓋牌送出小盲 10。
    if (hostSeat > guestSeat) throw Error('房主必須先坐較小座號，才能測非房主贏 10');
    const sessionNo = before.sess[guestSeat].sessionNo;
    await host.page.click('#mpStart');
    await host.page.locator('#mpFold:visible:not([disabled])').waitFor({ timeout: 15000 });
    check('DOM 確認房主為行動者', await host.page.locator('#mpFold').isEnabled());
    await host.page.click('#mpFold');
    await waitForDoc(`pokerRooms/${table.roomId}`, r => r.stacks?.[guestSeat] === 2010);
    await guest.page.waitForFunction(() => document.querySelector('#heroChips')?.textContent.trim() === '2,010', null, { timeout: 15000 });
    const N = Number((await guest.page.innerText('#heroChips')).replace(/,/g, '').trim());
    check('非房主桌上籌碼 N=2010（贏 10）', N === 2010, `N=${N}`);
    await host.page.click('#btnBackLobby');
    await host.page.locator('#mpLeaveConfirmOk:visible').click();
    const card = guest.page.locator('#mpCloseResult:visible');
    await card.waitFor({ timeout: 20000 });
    const expected = `你帶回 ${N.toLocaleString('en-US')} 籌碼`;
    await guest.page.waitForFunction(text => document.querySelector('#mpCloseResult')?.innerText.includes(text), expected, { timeout: 15000 });
    const text = await card.innerText();
    check('非房主結果卡顯示 N', text.includes(expected), text.replace(/\s+/g, ' '));
    const player = await readDoc(`pokerPlayers/${guest.uid}`);
    const ledger = await readDoc(`pokerPlayers/${guest.uid}/ledger/${table.roomId}_${sessionNo}_cashout`);
    check('結果卡等於 emulator bank', player.bank === N, `bank=${player.bank}, N=${N}`);
    check('結果卡等於 cashout ledger amount', ledger.amount === N, `amount=${ledger.amount}, N=${N}`);
    if (process.env.SHOT) await guest.page.screenshot({ path: process.env.SHOT, fullPage: true });
  } catch (error) {
    check('流程完成', false, error.stack || String(error));
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
    const pass = results.filter(r => r.ok).length;
    const fail = results.length - pass;
    console.log(`SUMMARY pass=${pass} fail=${fail}`);
    if (fail) process.exitCode = 1;
  }
}
await main();
