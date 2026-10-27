/**
 * Presentation-only table FX: hand-start deal (~2s) and winner celebration.
 * Engine state is always final; these never mutate game rules.
 */

import { dealOrderFromSb, seatVisualPos } from './seating.js';
import { fmtChips } from './cards-dom.js';
import { foldWinCenterNote as foldWinNoteFromEngine } from '../engine/index.js';

const $ = (sel, el = document) => el.querySelector(sel);

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
    e.preventDefault();
    skip();
  };
  document.addEventListener('pointerdown', onSkip, { capture: true });

  try {
    const occupied = state.seats.map((p, i) => (p ? i : null)).filter((x) => x != null);
    const dealer = $('#dealer');
    const tBox = table.getBoundingClientRect();

    // 1) Dealer button slides to new seat (~350ms)
    if (dealer && prevDealer) {
      const dest = dealer.getBoundingClientRect();
      const dx = prevDealer.left + prevDealer.width / 2 - (dest.left + dest.width / 2);
      const dy = prevDealer.top + prevDealer.height / 2 - (dest.top + dest.height / 2);
      dealer.style.opacity = '1';
      await animateEl(
        dealer,
        [
          { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`, offset: 0 },
          { transform: 'translate(-50%, -50%)', offset: 1 },
        ],
        { duration: 320, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'none' },
        signal,
      );
    } else {
      await wait(120, signal);
    }

    // 2) Blind chips slide out
    const potPt = {
      x: tBox.width * 0.5,
      y: tBox.height * 0.42,
    };
    async function flyBlind(seat, delay) {
      const pos = seatVisualPos(seat, viewerSeat);
      const anchor = seatAnchorEl(pos, viewerSeat);
      if (!anchor) return;
      const from = centerOf(anchor, table);
      const chip = document.createElement('div');
      chip.className = 'fx-chip-fly';
      chip.innerHTML = '<span class="chips"><i class="a"></i><i class="b"></i><i class="c"></i></span>';
      chip.style.transform = `translate(${from.x}px, ${from.y}px) translate(-50%,-50%)`;
      layer.appendChild(chip);
      await wait(delay, signal);
      const bet = document.querySelector(`.bet[data-for-seat="${seat}"]`);
      const to = bet ? centerOf(bet, table) : potPt;
      await animateEl(
        chip,
        [
          { transform: `translate(${from.x}px, ${from.y}px) translate(-50%,-50%) scale(.85)`, opacity: 0.2 },
          { transform: `translate(${to.x}px, ${to.y}px) translate(-50%,-50%) scale(1)`, opacity: 1 },
        ],
        { duration: 280, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' },
        signal,
      );
      chip.remove();
    }
    if (state.sbSeat != null) await flyBlind(state.sbSeat, 0);
    if (state.bbSeat != null && state.bbSeat !== state.sbSeat) await flyBlind(state.bbSeat, 40);

    // 3) Deal cards one-by-one clockwise from SB, two rounds
    const order = dealOrderFromSb(occupied, state.sbSeat ?? occupied[0]);
    const per = Math.max(55, Math.floor(900 / Math.max(1, order.length)));
    const origin = { x: tBox.width * 0.5, y: tBox.height * 0.48 };
    for (let i = 0; i < order.length; i++) {
      const seat = order[i];
      const pos = seatVisualPos(seat, viewerSeat);
      const anchor = seatAnchorEl(pos, viewerSeat);
      const to = anchor ? centerOf(anchor, table) : origin;
      const card = document.createElement('div');
      card.className = 'fx-deal-card';
      card.setAttribute('aria-hidden', 'true');
      layer.appendChild(card);
      const rot = ((i % 5) - 2) * 8;
      await animateEl(
        card,
        [
          {
            transform: `translate(${origin.x}px, ${origin.y}px) translate(-50%,-50%) rotate(${rot}deg) scale(.6)`,
            opacity: 0,
          },
          {
            transform: `translate(${(origin.x + to.x) / 2}px, ${(origin.y + to.y) / 2 - 24}px) translate(-50%,-50%) rotate(${rot / 2}deg) scale(.9)`,
            opacity: 1,
            offset: 0.45,
          },
          {
            transform: `translate(${to.x}px, ${to.y}px) translate(-50%,-50%) rotate(0deg) scale(1)`,
            opacity: 0.15,
          },
        ],
        { duration: per + 40, easing: 'cubic-bezier(.18,.7,.22,1)', fill: 'forwards' },
        signal,
      );
      card.remove();
      // Reveal hero / backs progressively via CSS class on live nodes
      const live =
        pos === 'hero'
          ? $('#heroHole .card')?.[Math.floor(i / occupied.length)]
          : document.querySelector(`.seat.pos-${pos} .backs i:nth-child(${(i < occupied.length ? 1 : 2)})`);
      if (live) {
        live.animate(
          [
            { opacity: 0, transform: 'scale(.85)' },
            { opacity: 1, transform: 'scale(1)' },
          ],
          { duration: 160, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' },
        );
      }
      await wait(Math.floor(per * 0.15), signal);
    }
    await wait(80, signal);
  } catch (e) {
    if (e?.name !== 'AbortError') console.warn(e);
  } finally {
    document.removeEventListener('pointerdown', onSkip, { capture: true });
    layer.replaceChildren();
    document.documentElement.classList.remove('is-dealing');
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

    const chip = document.createElement('div');
    chip.className = 'fx-chip-fly';
    chip.innerHTML = `<span class="chips"><i class="a"></i><i class="b"></i><i class="c"></i></span><span class="amt">${fmtChips(amt)}</span>`;
    layer.appendChild(chip);
    const to = centerOf(anchor, table);
    if (!prefersReducedMotion()) {
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
