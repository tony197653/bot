/**
 * Automated layout checks: board slot gaps, no bet/plate/board overlaps,
 * header not truncated — for seat counts 2–6 at 390×844 and 1280×800.
 * Also: non-table screens (lobby / pass / summary) must vertical-scroll and
 * keep primary CTAs reachable at phone + Safari-toolbar heights.
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

function overlap(a, b, pad = 0) {
  const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return ox > pad && oy > pad ? { ox, oy } : null;
}

async function checkViewport(browser, url, vp, seatCount) {
  const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
  await page.emulateMedia({ reducedMotion: 'reduce' });
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
  // Allow bet + dealer layout rAF + nudge passes
  await page.evaluate(
    () =>
      new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))),
      ),
  );
  await page.waitForTimeout(220);

  const report = await page.evaluate((seatCount) => {
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
    const potEl = document.querySelector('.pot');
    const potBox = potEl ? box(potEl) : null;
    const noteEl = document.querySelector('.table-note');
    const noteBox = noteEl ? box(noteEl) : null;

    // Short Safari toolbars: require clear overlap (pad 0); taller phones keep 3px buffer
    const betPlatePad = window.innerHeight < 700 ? 0 : 3;
    bets.forEach((b, i) => {
      plates.forEach((p, j) => {
        if (overlaps(b, p) || (betPlatePad > 0 && near(b, p, betPlatePad))) {
          issues.push(`bet[${i}] overlaps/covers plate[${j}]`);
        }
      });
      if (overlaps(b, boardBox)) issues.push(`bet[${i}] overlaps board`);
      if (potBox && (overlaps(b, potBox) || near(b, potBox, 2))) {
        issues.push(`bet[${i}] overlaps pot`);
      }
      if (noteBox && overlaps(b, noteBox)) {
        issues.push(`bet[${i}] overlaps center note`);
      }
    });
    const betBetPad = window.innerHeight < 700 ? 0 : 2;
    for (let i = 0; i < bets.length; i++) {
      for (let j = i + 1; j < bets.length; j++) {
        if (overlaps(bets[i], bets[j]) || (betBetPad > 0 && near(bets[i], bets[j], betBetPad))) {
          issues.push(`bet[${i}] overlaps bet[${j}]`);
        }
      }
    }

    // Dealer button must be fully visible and clear of plates / bets / pot / note / cards
    const dealerEl = document.getElementById('dealer');
    const st0 = window.__poker?.getState?.();
    const viewer0 = window.__poker?.getViewer?.();
    const buttonSeat = st0?.button;
    const dealerPlateEl =
      buttonSeat == null
        ? null
        : buttonSeat === viewer0
          ? document.querySelector('.meinfo')
          : document.querySelector(`.seat[data-seat="${buttonSeat}"] .plate`);
    if (dealerEl && getComputedStyle(dealerEl).display !== 'none') {
      const dBox = box(dealerEl);
      const tableBox = box(document.querySelector('.table'));
      // Fully inside the table (not clipped by overflow)
      if (
        dBox.left < tableBox.left - 1 ||
        dBox.top < tableBox.top - 1 ||
        dBox.right > tableBox.right + 1 ||
        dBox.bottom > tableBox.bottom + 1
      ) {
        issues.push('dealer button clipped outside .table');
      }
      const edgeGap = (a, b) => {
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 0 && oy > 0) return -Math.min(ox, oy);
        if (ox > 0) return Math.max(a.top - b.bottom, b.top - a.bottom);
        if (oy > 0) return Math.max(a.left - b.right, b.left - a.right);
        return 99;
      };
      const dC = {
        x: (dBox.left + dBox.right) / 2,
        y: (dBox.top + dBox.bottom) / 2,
      };
      // Edge distance to a plate AABB (0 if center is inside / touching)
      const distToPlate = (p) => {
        const dx = Math.max(p.left - dC.x, 0, dC.x - p.right);
        const dy = Math.max(p.top - dC.y, 0, dC.y - p.bottom);
        return Math.hypot(dx, dy);
      };

      // D must be nearer (by edge distance) to the button seat's plate than to any other
      if (dealerPlateEl) {
        const own = box(dealerPlateEl);
        const ownDist = distToPlate(own);
        const allPlates = [...document.querySelectorAll('.seat .plate, .meinfo')];
        allPlates.forEach((el, j) => {
          if (el === dealerPlateEl) return;
          const otherDist = distToPlate(box(el));
          if (otherDist <= ownDist + 1) {
            issues.push(
              `dealer nearer to plate[${j}] (${otherDist.toFixed(1)}) than button plate (${ownDist.toFixed(1)})`,
            );
          }
          // Other plates keep a clear edge gap
          if (edgeGap(dBox, box(el)) < 8) {
            issues.push(`dealer too close to other plate[${j}] (gap=${edgeGap(dBox, box(el)).toFixed(1)})`);
          }
        });
        // Own plate: may sit tight (gap can be small) but must not heavily cover the plate
        if (overlaps(dBox, own) && edgeGap(dBox, own) < -4) {
          issues.push('dealer heavily overlaps own nameplate');
        }
        // Must stay close to own plate (not drifted toward table center)
        if (ownDist > 28) {
          issues.push(`dealer too far from own nameplate (edgeDist=${ownDist.toFixed(1)})`);
        }
      } else {
        issues.push('missing dealer nameplate for button seat');
      }

      bets.forEach((b, i) => {
        if (overlaps(dBox, b) || near(dBox, b, 2)) {
          issues.push(`dealer overlaps bet[${i}]`);
        }
      });
      if (overlaps(dBox, boardBox)) issues.push('dealer overlaps board');
      if (potBox && (overlaps(dBox, potBox) || near(dBox, potBox, 2))) {
        issues.push('dealer overlaps pot');
      }
      if (noteBox && (overlaps(dBox, noteBox) || near(dBox, noteBox, 2))) {
        issues.push('dealer overlaps center note');
      }
      for (const card of document.querySelectorAll(
        '#heroHole .card, .mini-hole .card, #board .card',
      )) {
        if (overlaps(dBox, box(card))) issues.push('dealer overlaps card');
      }
    }

    // 「莊家」 tag on the button seat nameplate (and HU also keeps 小盲)
    if (st0 && buttonSeat != null) {
      const tagRoot =
        buttonSeat === viewer0
          ? document.getElementById('heroName')
          : document.querySelector(`.seat[data-seat="${buttonSeat}"] .plate .nm`);
      const tagText = tagRoot?.textContent?.replace(/\s+/g, '') || '';
      if (!tagText.includes('莊家')) {
        issues.push(`missing 莊家 tag on button seat ${buttonSeat} (got "${tagText}")`);
      }
      // Tag must not appear on non-button seats
      for (const el of document.querySelectorAll('.seat .plate .nm, #heroName')) {
        const seatEl = el.closest('.seat');
        const seat =
          seatEl?.dataset?.seat != null
            ? +seatEl.dataset.seat
            : el.id === 'heroName'
              ? viewer0
              : null;
        if (seat == null || seat === buttonSeat) continue;
        if ((el.textContent || '').includes('莊家')) {
          issues.push(`莊家 tag on non-button seat ${seat}`);
        }
      }
      if (seatCount === 2 && st0.sbSeat === buttonSeat) {
        if (!tagText.includes('小盲')) {
          issues.push('HU dealer missing 小盲 tag alongside 莊家');
        }
      }
    }

    // Center note must stay one line and clear of pot
    if (noteEl && noteBox) {
      const cs = getComputedStyle(noteEl);
      if (cs.whiteSpace !== 'nowrap') issues.push('center note not white-space:nowrap');
      if (noteEl.scrollHeight > noteEl.clientHeight + 2) {
        issues.push('center note wraps to multiple lines');
      }
      if (potBox && (overlaps(noteBox, potBox) || near(noteBox, potBox, 2))) {
        issues.push('center note overlaps pot');
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

    // Fixed 6 slots: 5 opponent seats (filled or 空位) + hero at bottom
    const oppSeats = [...document.querySelectorAll('#seats .seat')];
    if (oppSeats.length !== 5) {
      issues.push(`expected 5 ring seats (filled+empty), got ${oppSeats.length}`);
    }
    const emptySeats = oppSeats.filter((el) => el.classList.contains('is-empty'));
    const expectEmpty = Math.max(0, 5 - (seatCount - 1));
    if (emptySeats.length !== expectEmpty) {
      issues.push(`empty seats ${emptySeats.length} != ${expectEmpty} (players=${seatCount})`);
    }
    for (const el of emptySeats) {
      const t = el.textContent.replace(/\s+/g, '');
      if (!t.includes('空位')) issues.push('empty seat missing 空位 label');
    }

    // Hero hole cards must not overlap opponent plates/bets, dealer, or action panel
    const holeCards = [...document.querySelectorAll('#heroHole .card')].map(box);
    const actBox = document.getElementById('act')
      ? box(document.getElementById('act'))
      : null;
    const oppPlates = [...document.querySelectorAll('.seat .plate')].map(box);
    const oppBets = [...document.querySelectorAll('#bets .bet:not([data-hero="1"])')].map(box);
    for (const hc of holeCards) {
      oppPlates.forEach((p, j) => {
        if (overlaps(hc, p) || near(hc, p, 2)) issues.push(`hero hole overlaps plate[${j}]`);
      });
      oppBets.forEach((b, i) => {
        if (overlaps(hc, b) || near(hc, b, 2)) issues.push(`hero hole overlaps bet[${i}]`);
      });
      if (dealerEl && overlaps(hc, box(dealerEl))) issues.push('hero hole overlaps dealer');
      if (actBox && overlaps(hc, actBox)) issues.push('hero hole overlaps action panel');
    }

    return {
      issues,
      boardGaps: kids.slice(0, -1).map((k, i) => +(kids[i + 1].left - k.right).toFixed(1)),
      betCount: bets.length,
      metaText: meta.textContent,
      emptySeats: emptySeats.length,
    };
  }, seatCount);

  const shot = join(ART, `poker-layout-${vp.name}-seats${seatCount}.png`);
  await page.screenshot({ path: shot, fullPage: true });

  // Rotate button through every occupied seat with viewer pinned, so D walks
  // every visual ring position; re-assert D nearest + 莊家 each hand.
  const rotationIssues = [];
  const seenButtons = new Set();
  const pinnedViewer = await page.evaluate(() => window.__poker?.getViewer?.());
  const firstBtn = await page.evaluate(() => window.__poker?.getState?.()?.button);
  if (firstBtn != null) seenButtons.add(firstBtn);
  for (let hand = 1; hand < seatCount; hand++) {
    // Fold out current hand (auto-pass via setViewer when needed)
    for (let step = 0; step < 50; step++) {
      const phase = await page.evaluate(() => window.__poker?.getState?.()?.phase || '');
      if (phase === 'hand_over') break;
      await page.evaluate((v) => window.__poker?.setViewer?.(v), pinnedViewer);
      await page.waitForTimeout(40);
      const fold = page.locator('#btnFold:not([disabled])');
      if (await fold.count()) {
        await fold.click();
        await page.waitForTimeout(70);
        continue;
      }
      const check = page.locator('#btnCheck:not([disabled])');
      if (await check.count()) {
        await check.click();
        await page.waitForTimeout(50);
        continue;
      }
      const call = page.locator('#btnCall:not([disabled])');
      if (await call.count()) {
        await call.click();
        await page.waitForTimeout(50);
        continue;
      }
      // Not our turn — jump viewer to actor, act, then pin back
      const actor = await page.evaluate(() => window.__poker?.getState?.()?.actor);
      if (actor != null && actor !== pinnedViewer) {
        await page.evaluate((a) => window.__poker?.setViewer?.(a), actor);
        await page.waitForTimeout(40);
        continue;
      }
      await page.waitForTimeout(50);
    }
    // Next hand
    const next = page.locator('#btnNext:not([disabled])');
    if (await next.count()) await next.click();
    else {
      rotationIssues.push(`hand ${hand}: missing #btnNext after hand_over`);
      break;
    }
    await page.waitForTimeout(120);
    await page.evaluate((v) => window.__poker?.setViewer?.(v), pinnedViewer);
    await page.waitForTimeout(200);
    await page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))),
        ),
    );
    await page.waitForTimeout(180);

    const rot = await page.evaluate((seatCount) => {
      const issues = [];
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      };
      const overlaps = (a, b) => {
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        return ox > 0 && oy > 0;
      };
      const near = (a, b, pad) => {
        const ox =
          Math.min(a.right + pad, b.right + pad) - Math.max(a.left - pad, b.left - pad);
        const oy =
          Math.min(a.bottom + pad, b.bottom + pad) - Math.max(a.top - pad, b.top - pad);
        return ox > 0 && oy > 0;
      };
      const st = window.__poker?.getState?.();
      const viewer = window.__poker?.getViewer?.();
      const buttonSeat = st?.button;
      const dealerEl = document.getElementById('dealer');
      if (!dealerEl || getComputedStyle(dealerEl).display === 'none') {
        return { issues: ['missing dealer'], button: buttonSeat };
      }
      const dBox = box(dealerEl);
      const dC = {
        x: (dBox.left + dBox.right) / 2,
        y: (dBox.top + dBox.bottom) / 2,
      };
      const dealerPlateEl =
        buttonSeat === viewer
          ? document.querySelector('.meinfo')
          : document.querySelector(`.seat[data-seat="${buttonSeat}"] .plate`);
      if (!dealerPlateEl) {
        issues.push(`no plate for button ${buttonSeat}`);
        return { issues, button: buttonSeat };
      }
      const own = box(dealerPlateEl);
      const distToPlate = (p) => {
        const dx = Math.max(p.left - dC.x, 0, dC.x - p.right);
        const dy = Math.max(p.top - dC.y, 0, dC.y - p.bottom);
        return Math.hypot(dx, dy);
      };
      const ownDist = distToPlate(own);
      if (ownDist > 28) {
        issues.push(`button=${buttonSeat}: D too far from own plate (${ownDist.toFixed(1)})`);
      }
      for (const el of document.querySelectorAll('.seat .plate, .meinfo')) {
        if (el === dealerPlateEl) continue;
        const od = distToPlate(box(el));
        if (od <= ownDist + 1) {
          issues.push(
            `button=${buttonSeat}: D nearer other plate (${od.toFixed(1)}) than own (${ownDist.toFixed(1)})`,
          );
        }
      }
      const pot = document.querySelector('.pot');
      if (pot && (overlaps(dBox, box(pot)) || near(dBox, box(pot), 2))) {
        issues.push(`button=${buttonSeat}: D overlaps pot`);
      }
      for (const bet of document.querySelectorAll('#bets .bet')) {
        if (overlaps(dBox, box(bet)) || near(dBox, box(bet), 2)) {
          issues.push(`button=${buttonSeat}: D overlaps bet`);
        }
      }
      const tagRoot =
        buttonSeat === viewer
          ? document.getElementById('heroName')
          : document.querySelector(`.seat[data-seat="${buttonSeat}"] .plate .nm`);
      const tagText = tagRoot?.textContent?.replace(/\s+/g, '') || '';
      if (!tagText.includes('莊家')) {
        issues.push(`button=${buttonSeat}: missing 莊家 (got "${tagText}")`);
      }
      if (seatCount === 2 && st.sbSeat === buttonSeat && !tagText.includes('小盲')) {
        issues.push(`button=${buttonSeat}: HU missing 小盲 with 莊家`);
      }
      return { issues, button: buttonSeat };
    }, seatCount);

    if (rot.button != null) seenButtons.add(rot.button);
    rotationIssues.push(...rot.issues);
  }

  if (seenButtons.size < seatCount) {
    rotationIssues.push(
      `only saw ${seenButtons.size}/${seatCount} button seats: [${[...seenButtons]}]`,
    );
  }

  await page.close();

  return {
    viewport: vp.name,
    seatCount,
    errors,
    issues: [...report.issues, ...rotationIssues],
    boardGaps: report.boardGaps,
    betCount: report.betCount,
    buttonSeatsSeen: [...seenButtons],
    screenshot: shot,
  };
}

/** Fold until hand-over; assert no street bets, one-line note, pot/D/note clear. */
async function checkHandOver(browser, url, vp, seatCount) {
  const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('#lobbyScreen.is-on', { timeout: 15000 });

  const rows = page.locator('#playerRows .p-row');
  const nRows = await rows.count();
  for (let i = 0; i < nRows; i++) {
    const row = rows.nth(i);
    const input = row.locator('input');
    const disabled = await input.isDisabled();
    const wantOn = i < seatCount;
    if (wantOn === disabled) {
      await row.locator('button[data-toggle]').click();
    }
  }

  await page.locator('#timerToggle').uncheck().catch(() => {});
  await page.click('#btnStart');
  await page.waitForSelector('#passScreen.is-on', { timeout: 10000 });
  await page.click('#btnPassOk');
  await page.waitForTimeout(200);

  // Keep folding until hand_over (or safety cap)
  for (let step = 0; step < 40; step++) {
    const phase = await page.evaluate(() => window.__poker?.getState?.()?.phase || '');
    if (phase === 'hand_over') break;
    // Clear pass / hand-off overlays
    const passOn = await page.locator('#passScreen.is-on').count();
    if (passOn) {
      await page.click('#btnPassOk').catch(() => {});
      await page.waitForTimeout(80);
      continue;
    }
    const fold = page.locator('#btnFold:not([disabled])');
    if (await fold.count()) {
      await fold.click();
      await page.waitForTimeout(120);
      continue;
    }
    const check = page.locator('#btnCheck:not([disabled])');
    if (await check.count()) {
      await check.click();
      await page.waitForTimeout(80);
      continue;
    }
    const call = page.locator('#btnCall:not([disabled])');
    if (await call.count()) {
      await call.click();
      await page.waitForTimeout(80);
      continue;
    }
    await page.waitForTimeout(80);
  }

  await page.evaluate(
    () =>
      new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))),
      ),
  );
  await page.waitForTimeout(400);

  const report = await page.evaluate(() => {
    const issues = [];
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    };
    const overlaps = (a, b) => {
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      return ox > 0 && oy > 0;
    };
    const near = (a, b, pad) => {
      const ox =
        Math.min(a.right + pad, b.right + pad) - Math.max(a.left - pad, b.left - pad);
      const oy =
        Math.min(a.bottom + pad, b.bottom + pad) - Math.max(a.top - pad, b.top - pad);
      return ox > 0 && oy > 0;
    };

    const st = window.__poker?.getState?.();
    if (st?.phase !== 'hand_over') {
      issues.push(`expected hand_over, got ${st?.phase || 'none'}`);
    }

    const bets = [...document.querySelectorAll('#bets .bet')];
    if (bets.length > 0) {
      issues.push(`hand-over still has ${bets.length} street bet chip(s) on felt`);
    }

    const potEl = document.querySelector('.pot');
    const potBox = potEl ? box(potEl) : null;
    const dealerEl = document.getElementById('dealer');
    const dBox =
      dealerEl && getComputedStyle(dealerEl).display !== 'none' ? box(dealerEl) : null;
    const noteEl = document.querySelector('.table-note');
    const noteBox = noteEl ? box(noteEl) : null;

    if (st?.lastHandSummary?.foldWin || (st?.winners?.length === 1 && st.winners[0]?.hand == null)) {
      if (!noteEl) issues.push('fold-win missing center note');
    }

    if (noteEl && noteBox) {
      const cs = getComputedStyle(noteEl);
      if (cs.whiteSpace !== 'nowrap') issues.push('hand-over note not nowrap');
      // One visual line: client height ≈ line-height + padding
      if (noteEl.scrollHeight > noteEl.clientHeight + 2) {
        issues.push('hand-over note wraps');
      }
      if (noteEl.getClientRects().length > 1) {
        issues.push('hand-over note has multiple client rects');
      }
      if (potBox && (overlaps(noteBox, potBox) || near(noteBox, potBox, 2))) {
        issues.push('hand-over note overlaps pot');
      }
      if (dBox && (overlaps(noteBox, dBox) || near(noteBox, dBox, 2))) {
        issues.push('hand-over note overlaps dealer');
      }
    }

    if (potBox && dBox && (overlaps(potBox, dBox) || near(potBox, dBox, 2))) {
      issues.push('hand-over dealer overlaps pot');
    }

    return { issues, betCount: bets.length, note: noteEl?.textContent || null };
  });

  const shot = join(ART, `poker-layout-handover-${vp.name}-seats${seatCount}.png`);
  await page.screenshot({ path: shot, fullPage: true });
  await page.close();

  return {
    kind: 'hand-over',
    viewport: vp.name,
    seatCount,
    errors,
    issues: report.issues,
    betCount: report.betCount,
    note: report.note,
    screenshot: shot,
  };
}

/**
 * Scroll-reachability for one overlay screen:
 * - no horizontal overflow on the screen
 * - primary CTA can be brought into the viewport (scroll screen and/or sheet-body)
 */
async function measureScreenReach(page, screenId, ctaSel) {
  return page.evaluate(
    ({ screenId, ctaSel }) => {
      const screen = document.getElementById(screenId);
      const cta = document.querySelector(ctaSel);
      const issues = [];
      if (!screen) return { issues: [`missing #${screenId}`] };
      if (!cta) return { issues: [`missing CTA ${ctaSel}`] };

      const body = screen.querySelector('.sheet-body');
      const vh = window.innerHeight;
      const vw = window.innerWidth;

      if (screen.scrollWidth > screen.clientWidth + 1) {
        issues.push(`#${screenId} horizontal overflow (${screen.scrollWidth}>${screen.clientWidth})`);
      }
      if (body && body.scrollWidth > body.clientWidth + 1) {
        issues.push(`.sheet-body horizontal overflow on #${screenId}`);
      }

      const tryReveal = () => {
        if (body && body.scrollHeight > body.clientHeight + 1) {
          body.scrollTop = body.scrollHeight;
        }
        screen.scrollTop = screen.scrollHeight;
        cta.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      };

      let r = cta.getBoundingClientRect();
      if (!(r.bottom > 0 && r.top < vh && Math.min(r.bottom, vh) - Math.max(r.top, 0) >= 36)) {
        tryReveal();
        r = cta.getBoundingClientRect();
      }

      const visible = Math.min(r.bottom, vh) - Math.max(r.top, 0);
      const reachable =
        r.bottom > 0 && r.top < vh && visible >= Math.min(r.height, 36) && r.left < vw && r.right > 0;
      if (!reachable) {
        issues.push(
          `#${screenId} CTA ${ctaSel} unreachable (top=${r.top.toFixed(1)} bottom=${r.bottom.toFixed(1)} vh=${vh})`,
        );
      }

      // Lobby: start button should stay pinned / sticky without requiring sheet-body scroll
      let lobbyStartPinned = null;
      if (screenId === 'lobbyScreen' && body) {
        body.scrollTop = 0;
        screen.scrollTop = 0;
        const r0 = cta.getBoundingClientRect();
        const pinnedVisible =
          r0.bottom > 0 &&
          r0.top < vh &&
          Math.min(r0.bottom, vh) - Math.max(r0.top, 0) >= Math.min(r0.height, 36);
        lobbyStartPinned = pinnedVisible;
        if (!pinnedVisible) {
          issues.push('#btnStart not visible at lobby top (sticky/pinned foot failed)');
        }
      }

      return {
        issues,
        screenScroll: {
          scrollHeight: screen.scrollHeight,
          clientHeight: screen.clientHeight,
          canScrollY: screen.scrollHeight > screen.clientHeight + 1,
        },
        bodyScroll: body
          ? {
              scrollHeight: body.scrollHeight,
              clientHeight: body.clientHeight,
              canScrollY: body.scrollHeight > body.clientHeight + 1,
            }
          : null,
        cta: { top: r.top, bottom: r.bottom, height: r.height },
        lobbyStartPinned,
        viewport: { w: vw, h: vh },
      };
    },
    { screenId, ctaSel },
  );
}

async function checkScrollScreens(browser, url, vp) {
  const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const issues = [];
  const shots = [];

  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('#lobbyScreen.is-on', { timeout: 15000 });
  await page.locator('#timerToggle').uncheck().catch(() => {});

  // Lobby — tall form (all 6 players on) must still reach 開始牌局
  const lobby = await measureScreenReach(page, 'lobbyScreen', '#btnStart');
  issues.push(...lobby.issues.map((m) => `lobby: ${m}`));
  const lobbyShot = join(ART, `poker-scroll-${vp.name}-lobby.png`);
  await page.screenshot({ path: lobbyShot });
  shots.push(lobbyShot);

  await page.click('#btnStart');
  await page.waitForSelector('#passScreen.is-on', { timeout: 10000 });

  const pass = await measureScreenReach(page, 'passScreen', '#btnPassOk');
  issues.push(...pass.issues.map((m) => `pass: ${m}`));
  const passShot = join(ART, `poker-scroll-${vp.name}-pass.png`);
  await page.screenshot({ path: passShot });
  shots.push(passShot);

  // Inflate pass sheet to force vertical overflow, then confirm CTA still reachable
  await page.evaluate(() => {
    const sheet = document.querySelector('#passScreen .sheet');
    if (!sheet) return;
    const pad = document.createElement('div');
    pad.id = 'scrollTestPad';
    pad.style.cssText = 'height:120vh;margin:8px 0;color:transparent;user-select:none';
    pad.textContent = '.';
    const actions = sheet.querySelector('.actions');
    sheet.insertBefore(pad, actions);
  });
  const passTall = await measureScreenReach(page, 'passScreen', '#btnPassOk');
  issues.push(...passTall.issues.map((m) => `pass-tall: ${m}`));
  if (!passTall.screenScroll?.canScrollY) {
    issues.push('pass-tall: #passScreen did not become vertically scrollable');
  }
  await page.evaluate(() => document.getElementById('scrollTestPad')?.remove());

  await page.click('#btnPassOk');
  await page.waitForTimeout(250);

  // Summary overlay (open directly; pad content so it exceeds short Safari toolbars)
  await page.evaluate(() => {
    const scr = document.getElementById('summaryScreen');
    const body = document.getElementById('summaryBody');
    scr.classList.add('is-on');
    const rows = Array.from({ length: 16 }, (_, i) => {
      const n = `測試玩家${i + 1}`;
      return `<tr><td>${n}</td><td>2,000</td><td>2,000</td><td class="pos">+0</td></tr>`;
    }).join('');
    body.innerHTML = `
      <div class="summary">
        <p class="lead">捲動測試：確認關閉鈕在矮視窗仍可到達。</p>
        <table>
          <thead><tr><th>玩家</th><th>買入</th><th>籌碼</th><th>淨勝</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  });
  await page.waitForSelector('#summaryScreen.is-on');
  const summary = await measureScreenReach(page, 'summaryScreen', '#btnSummaryClose');
  issues.push(...summary.issues.map((m) => `summary: ${m}`));
  if (!summary.screenScroll?.canScrollY) {
    issues.push('summary: #summaryScreen did not become vertically scrollable with tall content');
  }
  const sumShot = join(ART, `poker-scroll-${vp.name}-summary.png`);
  await page.screenshot({ path: sumShot });
  shots.push(sumShot);

  // After scrolling to CTA, capture scrolled summary
  await page.evaluate(() => {
    const scr = document.getElementById('summaryScreen');
    scr.scrollTop = scr.scrollHeight;
    document.getElementById('btnSummaryClose')?.scrollIntoView({ block: 'end' });
  });
  const sumShotEnd = join(ART, `poker-scroll-${vp.name}-summary-end.png`);
  await page.screenshot({ path: sumShotEnd });
  shots.push(sumShotEnd);

  await page.close();
  return {
    kind: 'scroll',
    viewport: vp.name,
    size: `${vp.w}x${vp.h}`,
    errors,
    issues,
    lobby,
    pass,
    passTall,
    summary,
    screenshots: shots,
  };
}

/** Bet/raise panel: 3×2 presets, ± steppers, no table overlap, no page scroll. */
async function checkBetPanel(browser, url, vp) {
  const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const issues = [];

  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('#lobbyScreen.is-on', { timeout: 15000 });
  await page.locator('#timerToggle').uncheck().catch(() => {});
  // 3 players keeps preflop unraised sizing stable for first actor
  const rows = page.locator('#playerRows .p-row');
  const nRows = await rows.count();
  for (let i = 0; i < nRows; i++) {
    const row = rows.nth(i);
    const disabled = await row.locator('input').isDisabled();
    const wantOn = i < 3;
    if (wantOn === disabled) await row.locator('button[data-toggle]').click();
  }
  await page.click('#btnStart');
  await page.waitForSelector('#passScreen.is-on', { timeout: 10000 });
  await page.click('#btnPassOk');
  await page.waitForSelector('#presets:not(.hidden)', { timeout: 10000 });
  await page.waitForTimeout(200);

  const report = await page.evaluate(() => {
    const issues = [];
    const wrap = document.getElementById('raiseWrap');
    const presets = document.getElementById('presets');
    const minus = document.getElementById('raiseMinus');
    const plus = document.getElementById('raisePlus');
    const range = document.getElementById('raiseRange');
    const act = document.getElementById('act');
    const table = document.querySelector('.table');
    const app = document.querySelector('.app');

    if (!wrap || wrap.classList.contains('hidden')) issues.push('raiseWrap hidden on hero turn');
    if (!presets || presets.classList.contains('hidden')) issues.push('presets hidden');
    const buttons = [...(presets?.querySelectorAll('button[data-to]') || [])];
    if (buttons.length !== 6) issues.push(`expected 6 presets, got ${buttons.length}`);

    const labels = buttons.map((b) => b.querySelector('.preset-lbl')?.textContent?.trim());
    const amts = buttons.map((b) => b.querySelector('.preset-amt')?.textContent?.trim());
    if (labels.some((t) => !t)) issues.push('preset missing label');
    if (amts.some((t) => !t)) issues.push('preset missing amount');

    const pressed = buttons.filter((b) => b.getAttribute('aria-pressed') === 'true');
    if (pressed.length < 1) issues.push('no preset aria-pressed');

    for (const el of [minus, plus]) {
      if (!el) {
        issues.push('missing ± button');
        continue;
      }
      const r = el.getBoundingClientRect();
      if (r.width < 44 - 0.5 || r.height < 44 - 0.5) {
        issues.push(`step control too small ${r.width.toFixed(1)}×${r.height.toFixed(1)}`);
      }
    }
    if (!range) issues.push('missing raiseRange');

    // Grid is 3 columns × 2 rows
    if (buttons.length === 6) {
      const tops = buttons.map((b) => b.getBoundingClientRect().top);
      const near = (a, b) => Math.abs(a - b) <= 2;
      const row0 = tops[0];
      const row1 = tops[3];
      if (!(near(tops[1], row0) && near(tops[2], row0))) issues.push('preset row1 not aligned');
      if (!(near(tops[4], row1) && near(tops[5], row1))) issues.push('preset row2 not aligned');
      if (!(row1 > row0 + 20)) issues.push('presets not in 2 rows');
    }

    // No overlap between act panel and table felt
    if (act && table) {
      const a = act.getBoundingClientRect();
      const t = table.getBoundingClientRect();
      const ox = Math.min(a.right, t.right) - Math.max(a.left, t.left);
      const oy = Math.min(a.bottom, t.bottom) - Math.max(a.top, t.top);
      if (ox > 2 && oy > 2) issues.push(`act overlaps table by ${ox.toFixed(1)}×${oy.toFixed(1)}`);
    }

    // Table screen should not require document/app vertical scroll
    const doc = document.documentElement;
    if (doc.scrollHeight > doc.clientHeight + 2) {
      issues.push(`page vertical scroll ${doc.scrollHeight}>${doc.clientHeight}`);
    }
    if (app && app.scrollHeight > app.clientHeight + 2 && getComputedStyle(app).overflowY !== 'hidden') {
      // app may grow; body locks overflow — flag only if window scrolled
      if (window.scrollY > 0) issues.push('window scrolled on table screen');
    }

    // Horizontal lock
    if (doc.scrollWidth > doc.clientWidth + 1) {
      issues.push(`horizontal overflow ${doc.scrollWidth}>${doc.clientWidth}`);
    }

    return {
      issues,
      labels,
      amts,
      raiseBtn: document.getElementById('btnRaise')?.textContent?.replace(/\s+/g, ' ').trim() || null,
      hint: document.getElementById('turnHint')?.textContent || null,
    };
  });
  issues.push(...report.issues);

  // Stepper nudges amount by 1 BB
  const before = await page.locator('#raiseRange').inputValue();
  await page.click('#raisePlus');
  const afterPlus = await page.locator('#raiseRange').inputValue();
  if (!(+afterPlus > +before)) issues.push(`plus did not increase (${before}→${afterPlus})`);
  await page.click('#raiseMinus');
  const afterMinus = await page.locator('#raiseRange').inputValue();
  if (+afterMinus !== +before) issues.push(`minus did not restore (${before}→${afterMinus})`);

  // Preset click selects gold border
  const third = page.locator('#presets button').nth(2);
  await third.click();
  const pressed = await third.getAttribute('aria-pressed');
  if (pressed !== 'true') issues.push('clicked preset not pressed');

  const shot = join(ART, `poker-betpanel-${vp.name}.png`);
  await page.screenshot({ path: shot });
  await page.close();

  return {
    kind: 'bet-panel',
    viewport: vp.name,
    size: `${vp.w}x${vp.h}`,
    errors,
    issues,
    labels: report.labels,
    raiseBtn: report.raiseBtn,
    hint: report.hint,
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
    { name: 'phone-se', w: 375, h: 667 },
    { name: 'safari-toolbars', w: 390, h: 664 },
    { name: 'desktop', w: 1280, h: 800 },
  ];
  const scrollViewports = [
    { name: 'phone-390', w: 390, h: 844 },
    { name: 'phone-se', w: 375, h: 667 },
    { name: 'safari-toolbars', w: 390, h: 664 },
    { name: 'desktop', w: 1280, h: 800 },
  ];
  const betPanelViewports = [
    { name: 'phone-390', w: 390, h: 844 },
    { name: 'phone-se', w: 375, h: 667 },
    { name: 'safari-toolbars', w: 390, h: 664 },
    { name: 'desktop', w: 1280, h: 800 },
  ];
  const results = [];
  for (const vp of viewports) {
    for (let seats = 2; seats <= 6; seats++) {
      results.push(await checkViewport(browser, url, vp, seats));
    }
  }
  const handOverResults = [];
  for (const vp of viewports) {
    for (let seats = 2; seats <= 6; seats++) {
      handOverResults.push(await checkHandOver(browser, url, vp, seats));
    }
  }
  const scrollResults = [];
  for (const vp of scrollViewports) {
    scrollResults.push(await checkScrollScreens(browser, url, vp));
  }
  const betPanelResults = [];
  for (const vp of betPanelViewports) {
    betPanelResults.push(await checkBetPanel(browser, url, vp));
  }

  await browser.close();
  server.close();

  const failed = results.filter((r) => r.issues.length || r.errors.length);
  const handOverFailed = handOverResults.filter((r) => r.issues.length || r.errors.length);
  const scrollFailed = scrollResults.filter((r) => r.issues.length || r.errors.length);
  const betFailed = betPanelResults.filter((r) => r.issues.length || r.errors.length);
  const summary = {
    ok:
      failed.length === 0 &&
      handOverFailed.length === 0 &&
      scrollFailed.length === 0 &&
      betFailed.length === 0,
    checked: results.length,
    failed: failed.length,
    handOverChecked: handOverResults.length,
    handOverFailed: handOverFailed.length,
    scrollChecked: scrollResults.length,
    scrollFailed: scrollFailed.length,
    betPanelChecked: betPanelResults.length,
    betPanelFailed: betFailed.length,
    results,
    handOverResults,
    scrollResults,
    betPanelResults,
  };
  writeFileSync(join(ART, 'poker-layout-overlap.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
