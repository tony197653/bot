/**
 * e2e-light: open raise panel → click 確認 → BET_RAISE applied.
 * Catches inert/scrim regressions where the panel looks open but clicks no-op
 * (boot sets #raisePanel inert; openRaisePanel must clear it).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const REPO = join(ROOT, '..');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

function startServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let path = decodeURIComponent(req.url.split('?')[0]);
      let file;
      if (path.startsWith('/lib/')) file = join(REPO, path.replace(/^\//, ''));
      else {
        if (path === '/') path = '/index.html';
        file = join(ROOT, path.replace(/^\//, ''));
      }
      if (!existsSync(file)) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      });
      res.end(readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

describe('加注確認實際送出（inert/scrim regression）', () => {
  it('openRaisePanel 清除 inert／aria-hidden；confirm 讀 range.value（source）', () => {
    const src = readFileSync(join(ROOT, 'js/ui/app.js'), 'utf8');
    const open = src.slice(
      src.indexOf('function openRaisePanel'),
      src.indexOf('function openRaisePanel') + 3600,
    );
    assert.match(open, /panel\.inert\s*=\s*false/);
    assert.match(open, /removeAttribute\(\s*['"]aria-hidden['"]\s*\)/);
    assert.match(open, /Number\(\s*range\.value\s*\)/);
    // Unlock must precede raisePresets / syncRaiseUi (56b2833 MP regression pattern)
    const unlockAt = open.indexOf('panel.inert = false');
    const presetsAt = open.indexOf('raisePresets(');
    assert.ok(unlockAt >= 0 && presetsAt > unlockAt, 'inert clear must run before raisePresets');
    const close = src.slice(
      src.indexOf('function closeRaisePanel'),
      src.indexOf('function openRaisePanel'),
    );
    assert.match(close, /panel\.inert\s*=\s*true/);
  });

  it('openMpRaise 先 unlock 再組 UI；confirm 讀 range.value（e44c13f contract）', () => {
    const src = readFileSync(join(ROOT, 'js/ui/mp-app.js'), 'utf8');
    const open = src.slice(
      src.indexOf('function openMpRaise'),
      src.indexOf('function openMpRaise') + 4200,
    );
    const unlockAt = open.indexOf('panel.inert = false');
    const presetsAt = open.indexOf('mpRaisePresets(');
    assert.ok(unlockAt >= 0 && (presetsAt < 0 || presetsAt > unlockAt));
    assert.match(open, /Number\(\s*range\.value\s*\)/);
    assert.match(open, /raiseOpen\s*=\s*true/);
  });

  it('solo: 點確認加注後引擎收到 BET_RAISE（非 inert 穿透）', async () => {
    const { server, url } = await startServer();
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    try {
      await page.goto(`${url}/?solo=1`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#lobbyScreen.is-on', { timeout: 15000 });
      await page.click('#btnStart');
      await page.waitForSelector('#passScreen.is-on', { timeout: 10000 });
      await page.click('#btnPassOk');

      for (let i = 0; i < 50; i++) {
        if (await page.locator('#btnRaiseOpen:not([disabled])').count()) break;
        if (await page.locator('#passScreen.is-on').count()) {
          await page.click('#btnPassOk');
        }
        await page.waitForTimeout(150);
      }
      assert.ok(
        await page.locator('#btnRaiseOpen:not([disabled])').count(),
        'raise button never enabled',
      );

      const before = await page.evaluate(() => {
        const api = window.__poker;
        const st = api?.getState?.();
        return {
          hand: st?.handNumber,
          bet: st?.currentBet,
          actor: st?.actor,
          hasApi: !!api,
        };
      });
      assert.ok(before.hasApi, 'window.__poker missing');

      await page.click('#btnRaiseOpen');
      await page.waitForSelector('#raisePanel.is-on', { timeout: 5000 });

      const hit = await page.evaluate(() => {
        const panel = document.getElementById('raisePanel');
        const conf = document.getElementById('raiseConfirm');
        const r = conf.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
          inert: panel.inert,
          ariaHidden: panel.getAttribute('aria-hidden'),
          topId: top?.id || top?.tagName,
          confirmText: conf.textContent,
        };
      });
      assert.equal(hit.inert, false, `panel still inert: ${JSON.stringify(hit)}`);
      assert.notEqual(hit.ariaHidden, 'true', 'panel aria-hidden still true');
      assert.notEqual(hit.topId, 'raiseScrim', 'scrim still intercepts confirm');

      // Prefer a quick-pick then confirm
      const pick = page.locator('#presets button[data-id="3bb"]');
      if (await pick.count()) await pick.click({ force: false });
      const amount = await page.locator('#raiseOut').innerText();
      await page.click('#raiseConfirm');
      await page.waitForTimeout(400);

      const after = await page.evaluate(() => {
        const st = window.__poker.getState();
        return {
          bet: st.currentBet,
          log: (st.streetLog || []).map((x) => x.text).join('|'),
          panelOn: document.getElementById('raisePanel')?.classList.contains('is-on'),
          panelInert: document.getElementById('raisePanel')?.inert,
        };
      });

      assert.equal(after.panelOn, false, 'panel should close after confirm');
      assert.ok(
        after.bet > before.bet || /加注|下注|raise|bet/i.test(after.log),
        `BET_RAISE not applied: before=${JSON.stringify(before)} after=${JSON.stringify(after)} amount=${amount}`,
      );
      assert.equal(errors.length, 0, `page errors: ${errors.join('; ')}`);
    } finally {
      await browser.close();
      server.close();
    }
  });
});
