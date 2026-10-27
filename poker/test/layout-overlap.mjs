/**
 * Automated layout checks: board slot gaps, no bet/plate/board overlaps,
 * header not truncated — for seat counts 2–6 at 390×844 and 1280×800.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
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

function overlap(a, b, pad = 0) {
  const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return ox > pad && oy > pad ? { ox, oy } : null;
}

async function checkViewport(browser, url, vp, seatCount) {
  const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('#lobbyScreen.is-on', { timeout: 15000 });

  // Configure N players via lobby toggles (first 6 rows; enable first seatCount)
  const rows = page.locator('#playerRows .p-row');
  const nRows = await rows.count();
  for (let i = 0; i < nRows; i++) {
    const row = rows.nth(i);
    const input = row.locator('input');
    const disabled = await input.isDisabled();
    const wantOn = i < seatCount;
    if (wantOn === disabled) {
      // currently off but want on, or on but want off
      await row.locator('button[data-toggle]').click();
    }
  }

  await page.locator('#timerToggle').uncheck().catch(() => {});
  await page.click('#btnStart');
  await page.waitForSelector('#passScreen.is-on', { timeout: 10000 });
  await page.click('#btnPassOk');
  await page.waitForTimeout(200);
  // Allow bet layout rAF + nudge passes
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(150);

  const report = await page.evaluate(() => {
    const issues = [];
    const board = document.getElementById('board');
    const kids = [...board.children].map((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width };
    });
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].w < 30) issues.push(`board child ${i} too narrow (${kids[i].w})`);
    }
    for (let i = 0; i < kids.length - 1; i++) {
      const gap = kids[i + 1].left - kids[i].right;
      if (gap < 6) issues.push(`board gap ${i}/${i + 1} = ${gap.toFixed(1)}px (<6)`);
      const oy = Math.min(kids[i].bottom, kids[i + 1].bottom) - Math.max(kids[i].top, kids[i + 1].top);
      const ox = Math.min(kids[i].right, kids[i + 1].right) - Math.max(kids[i].left, kids[i + 1].left);
      if (ox > 0 && oy > 0) issues.push(`board slots ${i}/${i + 1} overlap ox=${ox.toFixed(1)}`);
    }

    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    };
    const near = (a, b, pad) => {
      const ox =
        Math.min(a.right + pad, b.right + pad) - Math.max(a.left - pad, b.left - pad);
      const oy =
        Math.min(a.bottom + pad, b.bottom + pad) - Math.max(a.top - pad, b.top - pad);
      return ox > 0 && oy > 0;
    };
    const overlaps = (a, b) => near(a, b, 0);

    const bets = [...document.querySelectorAll('#bets .bet')].map(box);
    const plates = [...document.querySelectorAll('.seat .plate, .meinfo')].map(box);
    const boardBox = box(board);

    bets.forEach((b, i) => {
      plates.forEach((p, j) => {
        if (overlaps(b, p) || near(b, p, 3)) {
          issues.push(`bet[${i}] overlaps/covers plate[${j}]`);
        }
      });
      if (overlaps(b, boardBox)) issues.push(`bet[${i}] overlaps board`);
    });
    for (let i = 0; i < bets.length; i++) {
      for (let j = i + 1; j < bets.length; j++) {
        if (overlaps(bets[i], bets[j]) || near(bets[i], bets[j], 2)) {
          issues.push(`bet[${i}] overlaps bet[${j}]`);
        }
      }
    }

    // Internal chip vs amount
    for (const bet of document.querySelectorAll('#bets .bet')) {
      const chips = bet.querySelector('.chips');
      const amt = bet.querySelector('.amt');
      if (!chips || !amt) continue;
      const c = chips.getBoundingClientRect();
      const a = amt.getBoundingClientRect();
      if (c.right > a.left + 1 && c.left < a.right && c.bottom > a.top && c.top < a.bottom) {
        // horizontal stack expected: chips left of amt — only fail if substantial cover
        const ox = Math.min(c.right, a.right) - Math.max(c.left, a.left);
        if (ox > a.width * 0.35) issues.push(`chip covers amount in bet "${bet.textContent}"`);
      }
    }

    const meta = document.getElementById('roomMeta');
    if (meta.scrollWidth > meta.clientWidth + 1) {
      issues.push(`roomMeta truncated scroll=${meta.scrollWidth} client=${meta.clientWidth}`);
    }
    // Also ensure no ellipsis style effectively hiding
    const cs = getComputedStyle(meta);
    if (cs.textOverflow === 'ellipsis' && meta.scrollWidth > meta.clientWidth + 1) {
      issues.push('roomMeta uses ellipsis while overflowing');
    }

    // Clockwise visual order must match engine order (hero at bottom = angle 0)
    const st = window.__poker?.getState?.();
    const viewer = window.__poker?.getViewer?.();
    if (st && viewer != null) {
      const table = document.querySelector('.table')?.getBoundingClientRect();
      const cx = table ? table.left + table.width / 2 : 0;
      const cy = table ? table.top + table.height / 2 : 0;
      const angleOf = (el) => {
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2 - cx;
        const y = r.top + r.height / 2 - cy;
        // atan2 from bottom-up screen coords → convert so 0 = bottom, CW increases
        let deg = (Math.atan2(x, -y) * 180) / Math.PI; // 0 at bottom, +CW toward left? 
        // atan2(x, -y): bottom (0,+1 in up-y) → atan2(0,-1)=π → 180. Hmm.
        // Use: angle from +y-down (screen): from bottom vector (0, +1)
        deg = (Math.atan2(x, y) * 180) / Math.PI; // 0=bottom, +90=right? atan2(x,y) with y down: right=+x → +90 if y=0.
        // For y positive down, bottom of table is +y from center: atan2(0, +dy)=0. Left is -x: atan2(-,+)≈-90.
        // Clockwise from bottom goes left first → negative atan2. Use -atan2 so CW is positive.
        deg = (-Math.atan2(x, y) * 180) / Math.PI;
        if (deg < 0) deg += 360;
        return deg;
      };
      const me = document.querySelector('.me');
      const seats = [...document.querySelectorAll('.seat[data-seat]')].map((el) => ({
        seat: +el.dataset.seat,
        ang: angleOf(el),
      }));
      if (me) seats.push({ seat: viewer, ang: angleOf(me) });
      seats.sort((a, b) => a.ang - b.ang || a.seat - b.seat);
      const visualOrder = seats.map((s) => s.seat);
      // Engine clockwise from viewer
      const occ = st.seats.map((p, i) => (p ? i : null)).filter((x) => x != null);
      const start = occ.indexOf(viewer);
      const engineOrder = [];
      for (let i = 0; i < occ.length; i++) engineOrder.push(occ[(start + i) % occ.length]);
      if (visualOrder.join() !== engineOrder.join()) {
        issues.push(
          `clockwise mismatch visual=[${visualOrder}] engine=[${engineOrder}]`,
        );
      }
      // SB then BB adjacent in visual order
      if (st.sbSeat != null && st.bbSeat != null && occ.length >= 2) {
        const iSb = visualOrder.indexOf(st.sbSeat);
        const iBb = visualOrder.indexOf(st.bbSeat);
        if (iSb < 0 || iBb < 0 || (iSb + 1) % visualOrder.length !== iBb) {
          // HU: sb===button, bb next — still must be adjacent
          if (!((iSb + 1) % visualOrder.length === iBb)) {
            issues.push(`SB(${st.sbSeat}) not followed CW by BB(${st.bbSeat}) visual=${visualOrder}`);
          }
        }
      }
    }

    return {
      issues,
      boardGaps: kids.slice(0, -1).map((k, i) => +(kids[i + 1].left - k.right).toFixed(1)),
      betCount: bets.length,
      metaText: meta.textContent,
    };
  });

  const shot = join(ART, `poker-layout-${vp.name}-seats${seatCount}.png`);
  await page.screenshot({ path: shot, fullPage: true });
  await page.close();

  return {
    viewport: vp.name,
    seatCount,
    errors,
    issues: report.issues,
    boardGaps: report.boardGaps,
    betCount: report.betCount,
    screenshot: shot,
  };
}

async function main() {
  const { server, url } = await startServer();
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || '/usr/local/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const viewports = [
    { name: 'phone', w: 390, h: 844 },
    { name: 'desktop', w: 1280, h: 800 },
  ];
  const results = [];
  for (const vp of viewports) {
    for (let seats = 2; seats <= 6; seats++) {
      results.push(await checkViewport(browser, url, vp, seats));
    }
  }

  await browser.close();
  server.close();

  const failed = results.filter((r) => r.issues.length || r.errors.length);
  const summary = {
    ok: failed.length === 0,
    checked: results.length,
    failed: failed.length,
    results,
  };
  writeFileSync(join(ART, 'poker-layout-overlap.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
