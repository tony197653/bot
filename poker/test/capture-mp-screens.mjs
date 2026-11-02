/**
 * Capture milestone-2 shell at 390 / 768 / 1280 for PR evidence.
 * Uses mocked signed-out auth shell + playground (no production writes).
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'test-artifacts', 'mp-screens');
mkdirSync(outDir, { recursive: true });

function contentType(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (p.endsWith('.css')) return 'text/css; charset=utf-8';
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.webmanifest')) return 'application/manifest+json';
  return 'application/octet-stream';
}

const server = createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  // also serve ../lib
  let file = path.join(root, urlPath.replace(/^\//, ''));
  if (urlPath.startsWith('/lib/')) {
    file = path.join(root, '..', urlPath.slice(1));
  }
  if (!existsSync(file) || !file.startsWith(root) && !file.includes(`${path.sep}lib${path.sep}`)) {
    // allow lib outside root
    if (!existsSync(file)) {
      res.writeHead(404);
      res.end('missing');
      return;
    }
  }
  try {
    res.writeHead(200, { 'Content-Type': contentType(file) });
    res.end(readFileSync(file));
  } catch {
    res.writeHead(500);
    res.end('err');
  }
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch();
const sizes = [
  { name: '390', w: 390, h: 844 },
  { name: '768', w: 768, h: 1024 },
  { name: '1280', w: 1280, h: 800 },
];

const views = ['auth', 'lobby', 'create', 'share', 'join', 'stats'];
for (const s of sizes) {
  const page = await browser.newPage({ viewport: { width: s.w, height: s.h } });
  for (const v of views) {
    await page.goto(`${base}/test/mp-layout-mock.html?v=${v}`, {
      waitUntil: 'networkidle',
      timeout: 20000,
    });
    await page.waitForTimeout(300);
    await page.screenshot({
      path: path.join(outDir, `${v}-${s.name}.png`),
      fullPage: true,
    });
  }
  await page.goto(`${base}/playground.html`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  await page.screenshot({
    path: path.join(outDir, `playground-${s.name}.png`),
    fullPage: true,
  });
  await page.close();
}

await browser.close();
server.close();
console.log('Wrote screenshots to', outDir);
