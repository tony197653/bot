/**
 * Capture phone-390 evidence for timer ring + deal FX (PR artifacts).
 * Run: node test/capture-timer-deal.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  unlinkSync,
  readdirSync,
} from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ART = existsSync('/opt/cursor/artifacts')
  ? '/opt/cursor/artifacts'
  : join(ROOT, 'test-artifacts');
mkdirSync(ART, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

function startServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let path = decodeURIComponent(req.url.split('?')[0]);
      if (path === '/') path = '/index.html';
      const file = join(ROOT, path.replace(/^\//, ''));
      if (!file.startsWith(ROOT) || !existsSync(file)) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/` });
    });
  });
}

async function waitFrames(page, n = 3) {
  await page.evaluate(
    (count) =>
      new Promise((r) => {
        let i = 0;
        const step = () => {
          i += 1;
          if (i >= count) r();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    n,
  );
}

async function configureLobby(page, seatCount) {
  const rows = page.locator('#playerRows .p-row');
  const nRows = await rows.count();
  for (let i = 0; i < nRows; i++) {
    const row = rows.nth(i);
    const input = row.locator('input');
    const disabled = await input.isDisabled();
    const wantOn = i < seatCount;
    if (wantOn === disabled) await row.locator('button[data-toggle]').click();
  }
  const t = page.locator('#timerToggle');
  if (!(await t.isChecked())) await t.check();
}

async function main() {
  const { server, url } = await startServer();
  const browser = await chromium.launch({ headless: true });
  const meta = { url };

  // ── Deal sequence recording (short context) ──
  {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      recordVideo: { dir: ART, size: { width: 390, height: 844 } },
    });
    const page = await ctx.newPage();
    await page.goto(url);
    await page.waitForSelector('#lobbyScreen', { timeout: 15000 });
    await configureLobby(page, 5);
    await page.click('#btnStart');

    await page.waitForFunction(
      () => document.documentElement.classList.contains('is-dealing'),
      { timeout: 5000 },
    );

    // Burst-sample during deal; keep best mid-flight frames
    const bursts = [];
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const snap = await page.evaluate(() => ({
        dealing: document.documentElement.classList.contains('is-dealing'),
        fxCards: document.querySelectorAll('.fx-deal-card').length,
        fxChips: document.querySelectorAll('.fx-chip-fly').length,
        passOn: !!document.querySelector('#passScreen.is-on'),
        t: performance.now(),
      }));
      if (snap.passOn) break;
      if (snap.fxCards > 0 || snap.fxChips > 0 || snap.dealing) {
        const buf = await page.screenshot({ type: 'png' });
        bursts.push({ ...snap, buf });
      }
      await page.waitForTimeout(90);
      if (!snap.dealing && bursts.length >= 3) break;
    }
    // Prefer frames with flying cards, then chips, spaced apart in time
    const withCards = bursts.filter((b) => b.fxCards > 0);
    const withChips = bursts.filter((b) => b.fxChips > 0 && b.fxCards === 0);
    const pool = withCards.length >= 2 ? withCards : [...withChips, ...withCards, ...bursts];
    const picked = [];
    for (const b of pool) {
      if (picked.length >= 3) break;
      if (picked.length && b.t - picked[picked.length - 1].t < 200) continue;
      picked.push(b);
    }
    while (picked.length < 3 && pool.length) {
      const b = pool[Math.min(picked.length, pool.length - 1)];
      if (!picked.includes(b)) picked.push(b);
      else break;
    }
    for (let i = 0; i < Math.min(3, picked.length); i++) {
      const path = join(ART, `poker-deal-frame${i + 1}-phone-390.png`);
      writeFileSync(path, picked[i].buf);
      meta[`deal${i + 1}`] = {
        dealing: picked[i].dealing,
        fxCards: picked[i].fxCards,
        fxChips: picked[i].fxChips,
        passOn: picked[i].passOn,
        path,
      };
    }

    // Let deal finish so video includes full sequence + 換人
    await page.waitForSelector('#passScreen.is-on', { timeout: 8000 });
    await page.waitForTimeout(400);

    const vpath = await page.video()?.path();
    await ctx.close();
    if (vpath && existsSync(vpath)) {
      const dest = join(ART, 'poker-deal-sequence-phone-390.webm');
      copyFileSync(vpath, dest);
      try {
        unlinkSync(vpath);
      } catch {
        /* ignore */
      }
      meta.video = dest;
    }
  }

  // ── Timer ring stills (no video) ──
  {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    await page.goto(url);
    await page.waitForSelector('#lobbyScreen', { timeout: 15000 });
    await configureLobby(page, 4);
    await page.click('#btnStart');
    await page.waitForSelector('#passScreen.is-on', { timeout: 12000 });
    await page.click('#btnPassOk');
    await page.waitForTimeout(200);
    await waitFrames(page, 4);

    await page.evaluate(() => {
      const s = window.__poker.getState();
      window.__poker.setViewer(s.actor);
    });
    await waitFrames(page, 3);

    // Mid gold (~15s)
    meta.mid = await page.evaluate(() => {
      window.__poker.debugTimerRing(15000);
      const av = document.querySelector('.av.is-timing');
      const fg = av?.querySelector('.av-ring-fg');
      const r = av?.getBoundingClientRect();
      return {
        hasAv: !!av,
        urgent: !!av?.classList.contains('is-urgent'),
        offset: fg?.style.strokeDashoffset || null,
        stroke: fg ? getComputedStyle(fg).stroke : null,
        box: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
      };
    });
    await page.screenshot({ path: join(ART, 'poker-timer-mid-phone-390.png') });
    if (meta.mid.box) {
      const b = meta.mid.box;
      await page.screenshot({
        path: join(ART, 'poker-timer-mid-crop-phone-390.png'),
        clip: {
          x: Math.max(0, b.x - 24),
          y: Math.max(0, b.y - 24),
          width: Math.min(390 - Math.max(0, b.x - 24), b.w + 48),
          height: Math.min(844 - Math.max(0, b.y - 24), b.h + 96),
        },
      });
    }

    // Urgent red (~3s)
    meta.urgent = await page.evaluate(() => {
      window.__poker.debugTimerRing(3000);
      const av = document.querySelector('.av.is-timing');
      const fg = av?.querySelector('.av-ring-fg');
      const r = av?.getBoundingClientRect();
      return {
        hasAv: !!av,
        urgent: !!av?.classList.contains('is-urgent'),
        offset: fg?.style.strokeDashoffset || null,
        stroke: fg ? getComputedStyle(fg).stroke : null,
        box: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
      };
    });
    await page.screenshot({ path: join(ART, 'poker-timer-urgent-phone-390.png') });
    if (meta.urgent.box) {
      const b = meta.urgent.box;
      await page.screenshot({
        path: join(ART, 'poker-timer-urgent-crop-phone-390.png'),
        clip: {
          x: Math.max(0, b.x - 24),
          y: Math.max(0, b.y - 24),
          width: Math.min(390 - Math.max(0, b.x - 24), b.w + 48),
          height: Math.min(844 - Math.max(0, b.y - 24), b.h + 96),
        },
      });
    }

    await ctx.close();
  }

  writeFileSync(join(ART, 'poker-timer-deal-meta.json'), JSON.stringify(meta, null, 2));
  console.log(JSON.stringify(meta, null, 2));
  // Clean stray webm leftovers from playwright
  for (const f of readdirSync(ART)) {
    if (f.endsWith('.webm') && f !== 'poker-deal-sequence-phone-390.webm' && f.includes('capture')) {
      try {
        unlinkSync(join(ART, f));
      } catch {
        /* ignore */
      }
    }
  }

  await browser.close();
  server.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
