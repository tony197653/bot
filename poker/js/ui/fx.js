/**
 * Presentation-only table FX: hand-start deal (~3s) and winner celebration.
 * Engine state is always final; these never mutate game rules.
 */

import { dealOrderFromSb, seatVisualPos } from './seating.js';
import { fmtChips } from './cards-dom.js';
import { foldWinCenterNote as foldWinNoteFromEngine } from '../engine/index.js';

const $ = (sel, el = document) => el.querySelector(sel);

/** Deal sequence timing (ms) — total ≈ 3s for 6-max with stagger. */
export const DEAL_FX = Object.freeze({
  dealerMs: 400,
  blindMs: 360,
  blindStaggerMs: 140,
  cardFlightMs: 300,
  cardStaggerMs: 145,
  settleMs: 120,
});

export function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** @type {AbortController | null} */
let dealAbort = null;
/** @type {AbortController | null} */
let winAbort = null;

export function cancelDealFx() {
  dealAbort?.abort();
  dealAbort = null;
  $('#fxLayer')?.replaceChildren();
  document.documentElement.classList.remove('is-dealing');
}

export function cancelWinFx() {
  winAbort?.abort();
  winAbort = null;
  // Only clear flying chips — glow/badge/note are owned by renderTable
  $('#fxLayer')?.querySelectorAll('.fx-chip-fly').forEach((n) => n.remove());
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

function animateEl(el, keyframes, opts, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const anim = el.animate(keyframes, opts);
    const onAbort = () => {
      anim.cancel();
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    anim.onfinish = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    anim.oncancel = () => {
      signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('aborted', 'AbortError'));
    };
  });
}

function seatAnchorEl(pos, viewerSeat) {
  if (pos === 'hero' || pos === viewerSeat) return $('#mePlate') || $('.meinfo') || $('.me');
  return document.querySelector(`.seat.pos-${pos}`);
}

function centerOf(el, root) {
  const a = el.getBoundingClientRect();
  const r = root.getBoundingClientRect();
  return {
    x: a.left + a.width / 2 - r.left,
    y: a.top + a.height / 2 - r.top,
  };
}

export function foldWinCenterNote(state) {
  return foldWinNoteFromEngine(state);
}

/**
 * Amount each winner seat collected.
 * @param {object} state
 * @returns {Map<number, number>}
 */
export function winnerAmounts(state) {
  /** @type {Map<number, number>} */
  const map = new Map();
  if (state.winnerPayouts) {
    for (const [seat, amt] of Object.entries(state.winnerPayouts)) {
      map.set(+seat, +amt);
    }
    return map;
  }
  for (const w of state.winners || []) {
    const seats = w.seats || [];
    if (seats.length === 1) {
      map.set(seats[0], (map.get(seats[0]) || 0) + (w.amount || 0));
    } else if (seats.length > 1) {
      const each = Math.floor((w.amount || 0) / seats.length);
      let rem = (w.amount || 0) - each * seats.length;
      for (const seat of seats) {
        const add = each + (rem > 0 ? 1 : 0);
        if (rem > 0) rem -= 1;
        map.set(seat, (map.get(seat) || 0) + add);
      }
    }
  }
  return map;
}

/**
 * @param {object} opts
 * @param {object} opts.state
 * @param {number} opts.viewerSeat
 * @param {DOMRect} [opts.prevDealer]
 * @param {() => void} [opts.onDone]
 */
export async function playDealAnimation({ state, viewerSeat, prevDealer, onDone }) {
  cancelDealFx();
  const table = $('.table');
  const layer = $('#fxLayer');
  if (!table || !layer) {
    onDone?.();
    return;
  }
  if (prefersReducedMotion()) {
    onDone?.();
    return;
  }

  const ac = new AbortController();
  dealAbort = ac;
  const { signal } = ac;
  document.documentElement.classList.add('is-dealing');

  const skip = () => ac.abort();
  const onSkip = (e) => {
    // Tap anywhere skips to the final dealt state
    if (e.target?.closest?.('#passScreen, .screen.is-on, .menu-pop, .raise-panel')) return;
    e.preventDefault();
    skip();
  };
  document.addEventListener('pointerdown', onSkip, { capture: true });

  const t0 = performance.now();
  try {
    const occupied = state.seats.map((p, i) => (p ? i : null)).filter((x) => x != null);
    const dealer = $('#dealer');
    const tBox = table.getBoundingClientRect();

    // 1) Dealer button slides to new button seat
    if (dealer && prevDealer) {
      const dest = dealer.getBoundingClientRect();
      const dx = prevDealer.left + prevDealer.width / 2 - (dest.left + dest.width / 2);
      const dy = prevDealer.top + prevDealer.height / 2 - (dest.top + dest.height / 2);
      dealer.style.opacity = '1';
      await animateEl(
        dealer,
        [
          { transform: `translate(${dx}px, ${dy}px)` },
          { transform: 'translate(0px, 0px)' },
        ],
        { duration: DEAL_FX.dealerMs, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'none' },
        signal,
      );
    } else {
      await wait(Math.min(180, DEAL_FX.dealerMs), signal);
    }

    // 2) SB then BB chips slide from seat → bet rail (staggered)
    const potPt = { x: tBox.width * 0.5, y: tBox.height * 0.42 };
    function flyBlind(seat) {
      const pos = seatVisualPos(seat, viewerSeat);
      const anchor = seatAnchorEl(pos, viewerSeat);
      if (!anchor) return Promise.resolve();
      const from = centerOf(anchor, table);
      const chip = document.createElement('div');
      chip.className = 'fx-chip-fly';
      const blue = seat === state.sbSeat ? ' is-blue' : '';
      chip.innerHTML = `<span class="chips${blue}"><i class="a"></i></span>`;
      chip.style.transform = `translate(${from.x}px, ${from.y}px) translate(-50%,-50%)`;
      layer.appendChild(chip);
      const bet =
        document.querySelector(`.bet[data-for-seat="${seat}"]`) ||
        (seat === viewerSeat ? document.querySelector('#bets .bet[data-hero="1"]') : null);
      const to = bet ? centerOf(bet, table) : potPt;
      return animateEl(
        chip,
        [
          { transform: `translate(${from.x}px, ${from.y}px) translate(-50%,-50%) scale(.8)`, opacity: 0.15 },
          { transform: `translate(${to.x}px, ${to.y}px) translate(-50%,-50%) scale(1)`, opacity: 1 },
        ],
        { duration: DEAL_FX.blindMs, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' },
        signal,
      ).then(() => chip.remove());
    }
    const blindJobs = [];
    if (state.sbSeat != null) blindJobs.push(flyBlind(state.sbSeat));
    if (state.bbSeat != null && state.bbSeat !== state.sbSeat) {
      blindJobs.push(
        wait(DEAL_FX.blindStaggerMs, signal).then(() => flyBlind(state.bbSeat)),
      );
    }
    await Promise.all(blindJobs);

    // 3) Hole cards: two rounds clockwise from SB; each flight ~0.3s with stagger
    const order = dealOrderFromSb(occupied, state.sbSeat ?? occupied[0]);
    const origin = { x: tBox.width * 0.5, y: tBox.height * 0.48 };
    const flights = [];
    for (let i = 0; i < order.length; i++) {
      const seat = order[i];
      const round = i < occupied.length ? 0 : 1;
      const pos = seatVisualPos(seat, viewerSeat);
      const anchor = seatAnchorEl(pos, viewerSeat);
      const to = anchor ? centerOf(anchor, table) : origin;
      const startDelay = i * DEAL_FX.cardStaggerMs;
      const rot = ((i % 5) - 2) * 7;
      const ease = i % 2 === 0 ? 'cubic-bezier(.18,.75,.22,1)' : 'cubic-bezier(.2,.7,.25,1)';
      flights.push(
        (async () => {
          await wait(startDelay, signal);
          const card = document.createElement('div');
          card.className = 'fx-deal-card';
          card.setAttribute('aria-hidden', 'true');
          layer.appendChild(card);
          await animateEl(
            card,
            [
              {
                transform: `translate(${origin.x}px, ${origin.y}px) translate(-50%,-50%) rotate(${rot}deg) scale(.55)`,
                opacity: 0,
              },
              {
                transform: `translate(${(origin.x + to.x) / 2}px, ${(origin.y + to.y) / 2 - 28}px) translate(-50%,-50%) rotate(${rot / 2}deg) scale(.95)`,
                opacity: 1,
                offset: 0.42,
              },
              {
                transform: `translate(${to.x}px, ${to.y}px) translate(-50%,-50%) rotate(0deg) scale(1)`,
                opacity: 0.2,
              },
            ],
            { duration: DEAL_FX.cardFlightMs, easing: ease, fill: 'forwards' },
            signal,
          );
          card.remove();
          // Settle the live back / hero placeholder at this seat
          const live =
            pos === 'hero'
              ? $('#heroHole .back, #heroHole i, #heroHole .card')?.[round]
              : document.querySelector(
                  `.seat.pos-${pos} .backs i:nth-child(${round + 1}), .seat.pos-${pos} .backs .back:nth-child(${round + 1})`,
                );
          if (live) {
            live.animate(
              [
                { opacity: 0, transform: 'scale(.88)' },
                { opacity: 1, transform: 'scale(1)' },
              ],
              { duration: DEAL_FX.settleMs, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' },
            );
          }
        })(),
      );
    }
    await Promise.all(flights);

    // Pad short heads-up deals toward ~3s total
    const elapsed = performance.now() - t0;
    const target = 2800;
    if (elapsed < target) await wait(target - elapsed, signal);
  } catch (e) {
    if (e?.name !== 'AbortError') console.warn(e);
  } finally {
    document.removeEventListener('pointerdown', onSkip, { capture: true });
    layer.replaceChildren();
    document.documentElement.classList.remove('is-dealing');
    // Snap live backs/hero placeholders visible after skip/finish
    document
      .querySelectorAll('#heroHole .card, #heroHole .back, #heroHole i, .backs i, .backs .back')
      .forEach((el) => {
        el.style.opacity = '';
        el.style.transform = '';
      });
    if (dealAbort === ac) dealAbort = null;
    onDone?.();
  }
}

/**
 * Winner glow + badge + pot chips slide; hold ~2s.
 * @param {object} opts
 */
export async function playWinnerFx({ state, viewerSeat, holdMs = 2000 }) {
  cancelWinFx();
  const table = $('.table');
  const layer = $('#fxLayer');
  if (!table || !layer || !state.winners?.length) return;

  const ac = new AbortController();
  winAbort = ac;
  const { signal } = ac;

  const amounts = winnerAmounts(state);
  // Glow / badge / fold note are owned by renderTable; here we only animate chips + badge pop
  const potEl = $('.pot') || table;
  const from = centerOf(potEl, table);

  // Any leftover street-bet chips: fly a clone to the winner, then remove the marker
  const leftoverBets = [...document.querySelectorAll('#bets .bet')];
  if (leftoverBets.length && amounts.size) {
    const firstSeat = amounts.keys().next().value;
    const winPos = seatVisualPos(firstSeat, viewerSeat);
    const winAnchor = seatAnchorEl(winPos, viewerSeat) || potEl;
    const toWin = centerOf(winAnchor, table);
    for (const bet of leftoverBets) {
      const start = centerOf(bet, table);
      const html = bet.innerHTML;
      bet.remove();
      if (prefersReducedMotion()) continue;
      const fly = document.createElement('div');
      fly.className = 'fx-chip-fly';
      fly.innerHTML = html;
      layer.appendChild(fly);
      animateEl(
        fly,
        [
          { transform: `translate(${start.x}px, ${start.y}px) translate(-50%,-50%)`, opacity: 1 },
          { transform: `translate(${toWin.x}px, ${toWin.y}px) translate(-50%,-50%) scale(.7)`, opacity: 0.2 },
        ],
        { duration: 420, easing: 'cubic-bezier(.18,.75,.22,1)', fill: 'forwards' },
        signal,
      ).catch(() => {});
    }
  }

  for (const [seat, amt] of amounts) {
    const pos = seatVisualPos(seat, viewerSeat);
    const anchor = seatAnchorEl(pos, viewerSeat);
    if (!anchor) continue;
    const badge =
      pos === 'hero'
        ? document.querySelector('#meRoot > .win-badge')
        : anchor.querySelector('.win-badge');
    if (badge && !prefersReducedMotion()) {
      badge.animate(
        [
          { opacity: 0, transform: 'translate(-50%, 8px) scale(.8)' },
          { opacity: 1, transform: 'translate(-50%, 0) scale(1)' },
        ],
        { duration: 380, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' },
      );
    }
    const note = table.querySelector('.table-note');
    if (note && !prefersReducedMotion()) {
      note.animate(
        [
          { opacity: 0, transform: 'translate(-50%,-40%) scale(.96)' },
          { opacity: 1, transform: 'translate(-50%,-50%) scale(1)' },
        ],
        { duration: 320, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' },
      );
    }

    // Under reduced motion, skip fly chips — unpositioned nodes sit at table (0,0) as stray top-left chips
    if (prefersReducedMotion()) continue;
    const chip = document.createElement('div');
    chip.className = 'fx-chip-fly';
    chip.innerHTML = `<span class="chips"><i class="a"></i><i class="b"></i><i class="c"></i></span><span class="amt">${fmtChips(amt)}</span>`;
    layer.appendChild(chip);
    const to = centerOf(anchor, table);
    animateEl(
      chip,
      [
        { transform: `translate(${from.x}px, ${from.y}px) translate(-50%,-50%) scale(.7)`, opacity: 0.3 },
        { transform: `translate(${to.x}px, ${to.y}px) translate(-50%,-50%) scale(1)`, opacity: 1 },
      ],
      { duration: 520, easing: 'cubic-bezier(.18,.75,.22,1)', fill: 'forwards' },
      signal,
    ).catch(() => {});
  }

  try {
    await wait(holdMs, signal);
  } catch {
    /* skip */
  } finally {
    // Keep note/glow until next hand clears via cancelWinFx
    layer.querySelectorAll('.fx-chip-fly').forEach((n) => n.remove());
    if (winAbort === ac) winAbort = null;
  }
}
