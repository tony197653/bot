/**
 * axe: login + lobby at 390 / 1280 — expect 0 serious/critical.
 * Uses Auth emulator via ?emu=1. Never talks to production.
 *
 * Run: node test/axe-lobby-login.mjs  (with emulators up, or via run wrapper)
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const REPO = join(ROOT, '..');
const ART = existsSync('/opt/cursor/artifacts')
  ? '/opt/cursor/artifacts'
  : join(ROOT, 'test-artifacts');
mkdirSync(ART, { recursive: true });

const require = createRequire(import.meta.url);
let axeSource;
try {
  axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
} catch {
  console.error('Install axe-core first: npm i -D axe-core');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

function startStatic() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let path = decodeURIComponent(req.url.split('?')[0]);
      let file;
      if (path.startsWith('/lib/')) file = join(REPO, path.replace(/^\//, ''));
      else if (path.startsWith('/poker/')) {
        file = join(ROOT, path.replace(/^\/poker\/?/, '') || 'index.html');
      } else if (path === '/' || path === '/poker') file = join(ROOT, 'index.html');
      else file = join(ROOT, path.replace(/^\//, ''));
      if (!existsSync(file) || !(file.startsWith(ROOT) || file.startsWith(join(REPO, 'lib')))) {
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

async function runAxe(page, label) {
  await page.addScriptTag({ content: axeSource });
  const result = await page.evaluate(async () => {
    // @ts-ignore
    const r = await axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'best-practice'] },
    });
    const bad = r.violations.filter((v) =>
      ['serious', 'critical'].includes(v.impact),
    );
    return {
      seriousCritical: bad.map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.length,
        help: v.help,
      })),
      counts: {
        critical: r.violations.filter((v) => v.impact === 'critical').length,
        serious: r.violations.filter((v) => v.impact === 'serious').length,
      },
    };
  });
  writeFileSync(join(ART, `axe-${label}.json`), JSON.stringify(result, null, 2));
  return result;
}

async function main() {
  const { server, base } = await startStatic();
  const browser = await chromium.launch({
    headless: true,
    executablePath: existsSync('/usr/bin/google-chrome')
      ? '/usr/bin/google-chrome'
      : undefined,
  });
  const out = [];
  try {
    for (const vp of [
      { width: 390, height: 844, label: '390' },
      { width: 1280, height: 800, label: '1280' },
    ]) {
      const ctx = await browser.newContext({
        viewport: vp,
        deviceScaleFactor: 2,
      });
      await ctx.route('**/*', blockProd);
      const page = await ctx.newPage();

      // Login (signed-out)
      await page.goto(`${base}/poker/?emu=1`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#btnGoogle, .mp-auth', { timeout: 20000 });
      await page.waitForTimeout(500);
      // Button width check at 1280
      if (vp.width >= 1280) {
        const widths = await page.evaluate(() => {
          const btn = document.getElementById('btnGoogle');
          const card = document.querySelector('.mp-auth-card');
          return {
            btn: btn?.getBoundingClientRect().width || 0,
            card: card?.getBoundingClientRect().width || 0,
          };
        });
        out.push({ name: `login-width-${vp.label}`, ok: widths.btn <= widths.card + 2, ...widths });
      }
      const loginAxe = await runAxe(page, `login-${vp.label}`);
      out.push({
        name: `axe-login-${vp.label}`,
        ok: loginAxe.counts.critical === 0 && loginAxe.counts.serious === 0,
        ...loginAxe.counts,
        bad: loginAxe.seriousCritical,
      });
      await page.screenshot({
        path: join(ART, `axe-login-${vp.label}.png`),
        fullPage: true,
      });

      // Lobby (signed-in)
      await page.waitForFunction(() => typeof window.__qaSignIn === 'function', null, {
        timeout: 20000,
      });
      await page.evaluate(([u, n]) => window.__qaSignIn(u, n), [
        `axe${vp.label}`,
        '阿明',
      ]);
      await page.waitForSelector('.mp-lobby', { timeout: 20000 });
      await page.waitForTimeout(600);
      const lobbyAxe = await runAxe(page, `lobby-${vp.label}`);
      out.push({
        name: `axe-lobby-${vp.label}`,
        ok: lobbyAxe.counts.critical === 0 && lobbyAxe.counts.serious === 0,
        ...lobbyAxe.counts,
        bad: lobbyAxe.seriousCritical,
      });
      await page.screenshot({
        path: join(ART, `axe-lobby-${vp.label}.png`),
        fullPage: true,
      });
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  writeFileSync(join(ART, 'axe-results.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  const failed = out.filter((r) => r.ok === false);
  if (failed.length) {
    console.error('FAIL', failed.map((f) => f.name));
    process.exit(1);
  }
  console.log('axe lobby+login OK (0 serious/critical)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
