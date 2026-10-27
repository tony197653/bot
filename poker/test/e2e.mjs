/**
 * Headless Playwright smoke: 390×844 & 1280×800, play hands, check overflow & console.
 * Run: node test/e2e.mjs  (server must serve poker/ on PORT, default 4173)
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT = join(ROOT, '..', '..', 'opt', 'cursor', 'artifacts');
// Prefer /opt/cursor/artifacts if present
const ART = existsSync('/opt/cursor/artifacts')
  ? '/opt/cursor/artifacts'
  : join(ROOT, 'test-artifacts');
mkdirSync(ART, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
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
      const body = readFileSync(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

async function playHands(page, label) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.goto('/', { waitUntil: 'networkidle' });
  // Wait for boot
  await page.waitForSelector('#lobbyScreen.is-on', { timeout: 15000 });
  await page.screenshot({ path: join(ART, `poker-${label}-lobby.png`), fullPage: true });

  // Ensure 4 players joined (default)
  await page.click('#btnStart');
  await page.waitForSelector('#passScreen.is-on', { timeout: 10000 });
  await page.screenshot({ path: join(ART, `poker-${label}-pass.png`), fullPage: true });

  // Play several hands: always call/check via UI after pass
  for (let hand = 0; hand < 3; hand++) {
    let steps = 0;
    while (steps++ < 60) {
      if (await page.locator('#passScreen.is-on').count()) {
        await page.click('#btnPassOk');
        await page.waitForTimeout(200);
      }
      // Hand over?
      if (await page.locator('#btnNext').count()) {
        await page.screenshot({
          path: join(ART, `poker-${label}-hand${hand}-over.png`),
          fullPage: true,
        });
        if (hand < 2) {
          await page.click('#btnNext');
          await page.waitForTimeout(300);
        }
        break;
      }
      // Showdown muck
      if (await page.locator('#btnMuck').count()) {
        await page.click('#btnMuck');
        await page.waitForTimeout(150);
        continue;
      }
      if (await page.locator('#btnCheck').count()) {
        await page.click('#btnCheck');
      } else if (await page.locator('#btnCall').count()) {
        await page.click('#btnCall');
      } else if (await page.locator('#btnHandOff').count()) {
        await page.click('#btnHandOff');
      } else if (await page.locator('#btnFold').count()) {
        // Prefer call; if only fold somehow
        await page.click('#btnFold');
      } else {
        await page.waitForTimeout(100);
      }
      await page.waitForTimeout(80);
    }
  }

  await page.screenshot({ path: join(ART, `poker-${label}-table.png`), fullPage: true });

  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      bodyScroll: document.body.scrollWidth,
    };
  });
  const hasHOverflow = overflow.scrollWidth > overflow.clientWidth + 1;

  return { errors, hasHOverflow, overflow };
}

async function main() {
  const { server, url } = await startServer();
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || '/usr/local/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const results = [];
  for (const vp of [
    { name: 'phone', width: 390, height: 844 },
    { name: 'desktop', width: 1280, height: 800 },
  ]) {
    const page = await browser.newPage();
    await page.setViewportSize({ width: vp.width, height: vp.height });
    // Base URL
    page.goto = page.goto.bind(page);
    const origGoto = page.goto.bind(page);
    page.goto = (path, opts) => origGoto(url.replace(/\/$/, '') + path, opts);

    const r = await playHands(page, vp.name);
    results.push({ viewport: vp, ...r });
    await page.close();
  }

  await browser.close();
  server.close();

  const summary = {
    ok: results.every((r) => r.errors.length === 0 && !r.hasHOverflow),
    results: results.map((r) => ({
      viewport: r.viewport,
      errors: r.errors,
      hasHOverflow: r.hasHOverflow,
      overflow: r.overflow,
    })),
    artifacts: ART,
  };
  writeFileSync(join(ART, 'poker-e2e-summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
