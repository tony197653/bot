/**
 * Lobby list: stable order + row patch; no full-room listen; paint throttle.
 * Emulator: idle lobby while other tables play → paint ≤2 / 10s.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import {
  doc,
  setDoc,
  updateDoc,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const REPO = join(ROOT, '..');
const HAS_EMU = !!process.env.FIRESTORE_EMULATOR_HOST;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

describe('lobby list source contracts', () => {
  it('listenOpenTables reads pokerLobby by createdAt; patch inserts/removes', () => {
    const room = read('js/net/room.js');
    assert.match(room, /LOBBY_LIST_COL\s*=\s*'pokerLobby'/);
    assert.match(room, /function listenOpenTables/);
    const listen = room.slice(
      room.indexOf('export function listenOpenTables'),
      room.indexOf('export function listenRoom'),
    );
    assert.match(listen, /LOBBY_LIST_COL/);
    assert.match(listen, /orderBy\('createdAt'/);
    assert.doesNotMatch(listen, /orderBy\('updatedAt'/);
    assert.doesNotMatch(listen, /collection\(db,\s*'pokerRooms'\)/);

    const lobby = read('js/ui/lobby.js');
    const patch = lobby.slice(
      lobby.indexOf('export function patchOpenTables'),
      lobby.indexOf('export function renderMpLobby'),
    );
    assert.match(patch, /insertBefore|remove\(\)/);
    assert.doesNotMatch(
      patch,
      /ids\.some\(\(id, i\) => id !== existing\[i\]\)/,
    );

    const app = read('js/ui/mp-app.js');
    assert.match(app, /LOBBY_IDLE_CHECK_MS/);
    assert.match(app, /lobbyIdleCheckNeeded/);
  });

  it('host syncs listing only when lobby-visible fields change', () => {
    const host = read('js/net/host.js');
    assert.match(host, /lastLobbyListingKey/);
    assert.match(host, /lobbyListingKey/);
    assert.match(host, /upsertLobbyListing/);
    assert.match(host, /deleteLobbyListing/);
  });
});

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
      res.writeHead(200, {
        'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      });
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

const describeEmu = HAS_EMU ? describe : describe.skip;

describeEmu('lobby idle paint while others play（emulator）', () => {
  it('2 active tables → viewer lobby paint ≤2 in 10s', async () => {
    const { server, base } = await startStatic();
    const browser = await chromium.launch({
      headless: true,
      executablePath: existsSync('/usr/bin/google-chrome')
        ? '/usr/bin/google-chrome'
        : undefined,
      args: ['--no-sandbox'],
    });
    const rules = readFileSync(join(ROOT, 'firebase/firestore.rules'), 'utf8');
    const env = await initializeTestEnvironment({
      projectId: 'demo-poker',
      firestore: { host: '127.0.0.1', port: 8195, rules },
    });
    try {
      const ctx = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      await ctx.route('**/*', blockProd);

      const viewer = await ctx.newPage();
      await viewer.addInitScript(() => {
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
          /* ignore */
        }
      });
      await viewer.goto(`${base}/poker/?emu=1`, {
        waitUntil: 'domcontentloaded',
      });
      await viewer.waitForFunction(
        () => typeof window.__qaSignIn === 'function',
        null,
        { timeout: 20000 },
      );
      await viewer.evaluate(() => window.__qaSignIn('viewerIdle', '觀戰者'));
      await viewer.waitForSelector('.mp-lobby, [data-act="create"]', {
        timeout: 20000,
      });

      // Seed 2 playing tables + lobby listings (rules disabled)
      const now = Timestamp.now();
      await env.withSecurityRulesDisabled(async (c) => {
        const db = c.firestore();
        for (const [id, code, createdOff] of [
          ['rPlayA', '111', 0],
          ['rPlayB', '222', 1000],
        ]) {
          await setDoc(doc(db, 'pokerRooms', id), {
            name: `打中${code}`,
            code,
            hostUid: `host${code}`,
            hostSince: now,
            members: [`host${code}`],
            seatUids: [`host${code}`, '', '', '', '', ''],
            status: 'playing',
            config: { sb: 10, bb: 20, newPlayerChips: 5000, actionMs: 30000 },
            rev: 1,
            createdAt: Timestamp.fromMillis(now.toMillis() - 60_000 + createdOff),
            updatedAt: now,
            pub: {
              phase: 'flop',
              handNo: 3,
              actionSeq: 1,
              board: ['As', 'Kd', '7c'],
              seats: [{ name: 'H' }, null, null, null, null, null],
            },
            deadlineAt: null,
            stacks: [5000, 0, 0, 0, 0, 0],
            chipTotal: 5000,
            sess: [null, null, null, null, null, null],
            lastMoneyEvent: null,
            lobby: {
              name: `打中${code}`,
              hostName: '房主',
              hostPhoto: '',
              blinds: '10/20',
              seated: 1,
            },
          });
          await setDoc(doc(db, 'pokerLobby', id), {
            name: `打中${code}`,
            code,
            blinds: '10/20',
            seated: 1,
            status: 'playing',
            hostName: '房主',
            hostPhoto: '',
            hostUid: `host${code}`,
            createdAt: Timestamp.fromMillis(now.toMillis() - 60_000 + createdOff),
            updatedAt: now,
          });
        }
      });

      // Wait for rows to appear (or at least lobby settled)
      await viewer.waitForTimeout(1500);
      await viewer.evaluate(() => window.__qaResetPaintCount?.());
      const paints0 = await viewer.evaluate(
        () => Number(window.__qaPaintCount) || 0,
      );
      assert.equal(paints0, 0);

      // Spam full-room updates (old bug: reordered list → full paint every action)
      for (let i = 0; i < 12; i++) {
        await env.withSecurityRulesDisabled(async (c) => {
          const db = c.firestore();
          for (const id of ['rPlayA', 'rPlayB']) {
            await updateDoc(doc(db, 'pokerRooms', id), {
              rev: i + 2,
              updatedAt: serverTimestamp(),
              pub: {
                phase: 'turn',
                handNo: 3,
                actionSeq: i + 2,
                board: ['As', 'Kd', '7c', '2h'],
                seats: [{ name: 'H', bet: i }, null, null, null, null, null],
              },
            });
          }
        });
        await viewer.waitForTimeout(200);
      }
      await viewer.waitForTimeout(10_000);

      const paints = await viewer.evaluate(
        () => Number(window.__qaPaintCount) || 0,
      );
      console.log('LOBBY_PAINT_COUNT', paints);
      assert.ok(
        paints <= 2,
        `idle lobby must paint ≤2 in 10s while others play, got ${paints}`,
      );

      await ctx.close();
    } finally {
      await browser.close();
      server.close();
      await env.cleanup();
    }
  });
});
