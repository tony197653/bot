/**
 * Presentation-only table FX: premium hand-start deal + winner celebration.
 * Engine state is always final; these never mutate game rules.
 *
 * Deal timing per architect spec v1 (PR #24 polish).
 */

import { dealOrderFromSb, seatVisualPos } from './seating.js';
import { fmtChips } from './cards-dom.js';
import { foldWinCenterNote as foldWinNoteFromEngine, totalPot } from '../engine/index.js';

const $ = (sel, el = document) => el.querySelector(sel);

/** Deal sequence timing constants (ms) — see uploads/spec.md §4. */
export const DEAL_FX = Object.freeze({
  actDimMs: 160,
  deckInMs: 240,
  dealerBounceMs: 140,
  dealerMinMs: 480,
  dealerMaxMs: 640,
  dealerBaseMs: 420,
  dealerDistK: 0.4,
  firstHandDealerMs: 480,
  firstHandFadeMs: 80,
  blindMs: 440,
  blindSbAt: 380,
  blindBbAt: 540,
  blindSettleMs: 160,
  chipCountMs: 240,
  potInMs: 220,
  potCountMs: 300,
  card0Ms: 1040,
  settleMs: 180,
  deckOutMs: 220,
  lookPauseMs: 300,
  passInMs: 260,
  skipGuardMs: 150,
  /** Stagger S by occupied player count */
  staggerByPlayers: Object.freeze({ 2: 200, 3: 180, 4: 150, 5: 140, 6: 130 }),
  flightMin: 400,
  flightMax: 520,
  flightBase: 360,
  flightDistK: 0.3,
  arcHRatio: 0.14,
  arcHMax: 40,
  dealerArcHRatio: 0.12,
  dealerArcHMax: 28,
  heroFlipMs: 380,
  heroFlipStaggerMs: 90,
  heroFlipEase: 'cubic-bezier(.4, 0, .2, 1)',
  actRestoreMs: 220,
  /** After flip done → arm timer */
  armAfterFlipMs: 220,
});

/** Opponent hole angles (deg) matching CSS .backs i */
export const SLOT_ANGLE = Object.freeze({ opp0: -6, opp1: 8, hero0: -5, hero1: 5 });

export function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function cardStaggerMs(playerCount) {
  const n = Math.max(2, Math.min(6, playerCount | 0));
  return DEAL_FX.staggerByPlayers[n] ?? 130;
}

export function cardFlightMs(distPx) {
  const d = Math.max(0, distPx);
  return Math.min(DEAL_FX.flightMax, Math.max(DEAL_FX.flightMin, DEAL_FX.flightBase + DEAL_FX.flightDistK * d));
}

export function dealerMoveMs(distPx) {
  const d = Math.max(0, distPx);
  return Math.min(
    DEAL_FX.dealerMaxMs,
    Math.max(DEAL_FX.dealerMinMs, DEAL_FX.dealerBaseMs + DEAL_FX.dealerDistK * d),
  );
}

/**
 * Nominal total deal length until 換人 starts (ms), using average flight F.
 * @param {number} players
 * @param {number} [avgFlightMs=440]
 */
export function estimateDealTotalMs(players, avgFlightMs = 440) {
  const n = Math.max(2, Math.min(6, players | 0));
  const S = cardStaggerMs(n);
  const cards = n * 2;
  const lastStart = DEAL_FX.card0Ms + (cards - 1) * S;
  const lastEnd = lastStart + avgFlightMs;
  const settleEnd = lastEnd + DEAL_FX.settleMs;
  const pauseEnd = settleEnd + DEAL_FX.lookPauseMs;
  return pauseEnd + DEAL_FX.passInMs;
}

/** @type {AbortController | null} */
let dealAbort = null;
/** @type {AbortController | null} */
let winAbort = null;
/** @type {AbortController | null} */
let flipAbort = null;
/** Active WAAPI animations for skip cancel */
let dealAnims = [];

export function cancelDealFx() {
  dealAbort?.abort();
  dealAbort = null;
  for (const a of dealAnims) {
    try {
      a.cancel();
    } catch {
      /* ignore */
    }
  }
  dealAnims = [];
  $('#fxLayer')?.replaceChildren();
  document.documentElement.classList.remove('is-dealing');
  document.getElementById('act')?.classList.remove('is-deal-locked');
}

export function cancelWinFx() {
  winAbort?.abort();
  winAbort = null;
  $('#fxLayer')?.querySelectorAll('.fx-chip-fly').forEach((n) => n.remove());
}

export function cancelHeroFlip() {
  flipAbort?.abort();
  flipAbort = null;
}

function trackAnim(anim) {
  dealAnims.push(anim);
  anim.finished.catch(() => {}).finally(() => {
    dealAnims = dealAnims.filter((a) => a !== anim);
  });
  return anim;
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

function centerOf(el, root) {
  const a = el.getBoundingClientRect();
  const r = root.getBoundingClientRect();
  return {
    x: a.left + a.width / 2 - r.left,
    y: a.top + a.height / 2 - r.top,
    w: a.width,
    h: a.height,
  };
}

function dist(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Quadratic Bézier point */
function bez(p0, p1, p2, t) {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  };
}

/**
 * Control point offset perpendicular to P0→P2.
 * @param {'cw'|'center'} bend  cw = clockwise side; center = toward table center
 */
function controlPoint(p0, p2, hRatio, hMax, bend, tableCenter) {
  const mx = (p0.x + p2.x) / 2;
  const my = (p0.y + p2.y) / 2;
  const dx = p2.x - p0.x;
  const dy = p2.y - p0.y;
  const d = Math.hypot(dx, dy) || 1;
  const h = Math.min(hRatio * d, hMax);
  if (bend === 'center' && tableCenter) {
    const toC = { x: tableCenter.x - mx, y: tableCenter.y - my };
    const cd = Math.hypot(toC.x, toC.y) || 1;
    return { x: mx + (toC.x / cd) * h, y: my + (toC.y / cd) * h };
  }
  // Clockwise perpendicular of (dx,dy) is (dy, -dx)
  return { x: mx + (dy / d) * h, y: my + (-dx / d) * h };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * 13-sample arc keyframes (linear between samples; overall easing on effect).
 * @returns {Keyframe[]}
 */
function arcKeyframes(p0, p2, opts) {
  const {
    hRatio,
    hMax,
    bend = 'cw',
    tableCenter = null,
    thetaStart = 0,
    thetaEnd = 0,
    s0 = 1,
    lift = 0.08,
    overshoot = 2,
  } = opts;
  const p1 = controlPoint(p0, p2, hRatio, hMax, bend, tableCenter);
  const frames = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    const pt = bez(p0, p1, p2, t);
    let theta;
    if (t < 0.9) {
      theta = lerp(thetaStart, thetaEnd + overshoot, t / 0.9);
    } else {
      theta = lerp(thetaEnd + overshoot, thetaEnd, (t - 0.9) / 0.1);
    }
    const scale = lerp(s0, 1, t) * (1 + lift * Math.sin(Math.PI * t));
    frames.push({
      offset: t,
      transform: `translate(${pt.x}px, ${pt.y}px) translate(-50%,-50%) rotate(${theta}deg) scale(${scale})`,
      opacity: 1,
    });
  }
  return frames;
}

function shadowKeyframes() {
  return [
    { offset: 0, transform: 'translate(0,1px) scale(1)', opacity: 0.45 },
    { offset: 0.5, transform: 'translate(0,7px) scale(1.12)', opacity: 0.22 },
    { offset: 1, transform: 'translate(0,1.5px) scale(1)', opacity: 0.45 },
  ];
}

function deckSize() {
  const w = window.innerWidth || 390;
  return w >= 1024 ? { w: 36, h: 50 } : { w: 30, h: 42 };
}

function seatAnchorEl(pos, viewerSeat) {
  if (pos === 'hero' || pos === viewerSeat) return $('#mePlate') || $('.meinfo') || $('.me');
  return document.querySelector(`.seat.pos-${pos}`);
}

function targetCardEl(pos, round) {
  if (pos === 'hero') {
    return document.querySelectorAll('#heroHole .card.is-back, #heroHole .card')[round] || null;
  }
  return (
    document.querySelector(`.seat.pos-${pos} .backs i:nth-child(${round + 1})`) ||
    document.querySelector(`.seat.pos-${pos} .backs .back:nth-child(${round + 1})`)
  );
}

function betElForSeat(seat, viewerSeat) {
  if (seat === viewerSeat) return document.querySelector('#bets .bet[data-hero="1"]');
  return document.querySelector(`.bet[data-for-seat="${seat}"]`);
}

function stackElForSeat(seat, viewerSeat, pos) {
  if (pos === 'hero' || seat === viewerSeat) return document.querySelector('#heroChips, #mePlate strong');
  return document.querySelector(`.seat.pos-${pos} .ch, .seat.pos-${pos} .st`);
}

function countText(el, from, to, ms, signal) {
  if (!el) return Promise.resolve();
  const start = performance.now();
  return new Promise((resolve, reject) => {
    const step = (now) => {
      if (signal?.aborted) {
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }
      const t = Math.min(1, (now - start) / ms);
      const v = Math.round(from + (to - from) * t);
      el.textContent = fmtChips(v);
      if (t < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
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

function revealPending(el) {
  if (!el) return;
  el.classList.remove('is-pending');
  // Inline opacity so the seat card is visible even if a parent rule lags
  el.style.opacity = '1';
}

/** Spec E2: reveal pot only after BB lands; amount is real total (never stuck at 0). */
async function showPotAfterBlinds(state, signal) {
  const pot = document.querySelector('.pot');
  const potAmt = document.querySelector('#potAmt');
  const target = totalPot(state);
  if (potAmt) potAmt.textContent = '0';
  if (pot) {
    pot.classList.remove('is-pending');
    pot.style.visibility = 'visible';
    pot.style.opacity = '0';
    trackAnim(
      pot.animate(
        [
          { opacity: 0, transform: 'translate(-50%,-50%) scale(.9)' },
          { opacity: 1, transform: 'translate(-50%,-50%) scale(1)' },
        ],
        { duration: DEAL_FX.potInMs, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' },
      ),
    );
  }
  if (potAmt) {
    try {
      await countText(potAmt, 0, target, DEAL_FX.potCountMs, signal);
    } catch {
      potAmt.textContent = fmtChips(target);
    }
    // Guarantee final amount even if rAF count was skipped
    potAmt.textContent = fmtChips(target);
  }
  if (pot) {
    pot.style.opacity = '1';
  }
}

function snapDealFinal({ occupied, viewerSeat, state }) {
  // Reveal all cards, bets, pot; remove FX; keep act locked
  document.querySelectorAll('.backs i.is-pending, #heroHole .card.is-pending').forEach(revealPending);
  document.querySelectorAll('#bets .bet.is-pending').forEach((b) => {
    b.classList.remove('is-pending');
    b.style.opacity = '';
    b.style.transform = '';
  });
  const pot = document.querySelector('.pot');
  if (pot) {
    pot.classList.remove('is-pending');
    pot.style.opacity = '';
    pot.style.transform = '';
  }
  const potAmt = document.querySelector('#potAmt');
  if (potAmt) potAmt.textContent = fmtChips(totalPot(state));
  for (const seat of occupied) {
    const pos = seatVisualPos(seat, viewerSeat);
    const stack = stackElForSeat(seat, viewerSeat, pos);
    const p = state.seats[seat];
    if (stack && p) stack.textContent = fmtChips(p.chips);
  }
  $('#fxLayer')?.replaceChildren();
  const dealer = $('#dealer');
  if (dealer) {
    dealer.style.opacity = '1';
    dealer.style.transform = '';
  }
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

  const ac = new AbortController();
  dealAbort = ac;
  const { signal } = ac;
  let skipped = false;

  document.documentElement.classList.add('is-dealing');
  const act = document.getElementById('act');
  act?.classList.add('is-deal-locked');

  const occupied = state.seats.map((p, i) => (p ? i : null)).filter((x) => x != null);
  const nPlayers = occupied.length;
  const S = cardStaggerMs(nPlayers);
  const order = dealOrderFromSb(occupied, state.sbSeat ?? occupied[0]);

  // Reduced motion: short fades only (~0.5s)
  if (prefersReducedMotion()) {
    try {
      snapDealFinal({ occupied, viewerSeat, state });
      document.querySelectorAll('.backs i, #heroHole .card.is-back, #bets .bet, .pot').forEach((el) => {
        el.classList.remove('is-pending');
        const anim = el.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: 150,
          fill: 'both',
          easing: 'ease-out',
        });
        trackAnim(anim);
      });
      await wait(500, signal);
    } catch {
      snapDealFinal({ occupied, viewerSeat, state });
    } finally {
      document.documentElement.classList.remove('is-dealing');
      if (dealAbort === ac) dealAbort = null;
      onDone?.();
    }
    return;
  }

  const startedAt = performance.now();
  const onSkip = (e) => {
    if (performance.now() - startedAt < DEAL_FX.skipGuardMs) return;
    if (e.target?.closest?.('#passScreen, .screen.is-on, .menu-pop, .raise-panel')) return;
    e.preventDefault();
    e.stopPropagation();
    skipped = true;
    ac.abort();
  };
  const onKeySkip = (e) => {
    if (performance.now() - startedAt < DEAL_FX.skipGuardMs) return;
    if (e.key === ' ' || e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      skipped = true;
      ac.abort();
    }
  };
  const onInterrupt = () => {
    skipped = true;
    ac.abort();
  };

  document.addEventListener('pointerdown', onSkip, { capture: true });
  document.addEventListener('keydown', onKeySkip, { capture: true });
  window.addEventListener('resize', onInterrupt);
  window.addEventListener('orientationchange', onInterrupt);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) onInterrupt();
  });

  try {
    // ── Measure once ──
    const tBox = table.getBoundingClientRect();
    const tableCenter = { x: tBox.width * 0.5, y: tBox.height * 0.52 };
    const dSize = deckSize();

    // Board center = deck origin
    const boardEl = $('#board');
    const deckOrigin = boardEl && boardEl.getBoundingClientRect().width
      ? centerOf(boardEl, table)
      : { x: tableCenter.x, y: tableCenter.y, w: dSize.w, h: dSize.h };

    // A) Act dim
    if (act) {
      trackAnim(
        act.animate([{ opacity: 1 }, { opacity: 0.38 }], {
          duration: DEAL_FX.actDimMs,
          fill: 'forwards',
          easing: 'ease-out',
        }),
      );
    }

    // B) Deck enter — 3 offset leaves so it reads as a STACK, never a flat card
    const deck = document.createElement('div');
    deck.className = 'fx-deck';
    deck.setAttribute('aria-hidden', 'true');
    deck.style.width = `${dSize.w}px`;
    deck.style.height = `${dSize.h}px`;
    // Spec §5.1: offsets (0,0), (-1,-1.5), (-2,-3) — exaggerate slightly for phone readability
    const leafOff = [
      [0, 0],
      [-1.5, -2],
      [-3, -4],
    ];
    for (let i = 0; i < 3; i++) {
      const leaf = document.createElement('i');
      leaf.style.transform = `translate(${leafOff[i][0]}px, ${leafOff[i][1]}px)`;
      leaf.style.zIndex = String(3 - i);
      deck.appendChild(leaf);
    }
    // Position BEFORE append so nothing flashes at layer (0,0)
    const deckAt = `translate(${deckOrigin.x}px, ${deckOrigin.y}px) translate(-50%,-50%)`;
    deck.style.transform = `${deckAt} scale(.92)`;
    deck.style.opacity = '0';
    layer.appendChild(deck);
    trackAnim(
      deck.animate(
        [
          { transform: `translate(${deckOrigin.x}px, ${deckOrigin.y + 8}px) translate(-50%,-50%) scale(.92)`, opacity: 0 },
          { transform: `${deckAt} scale(1)`, opacity: 1 },
        ],
        { duration: DEAL_FX.deckInMs, fill: 'forwards', easing: 'cubic-bezier(.2,.8,.2,1)' },
      ),
    );

    // C) Dealer move
    const dealer = $('#dealer');
    let dealerDur = DEAL_FX.firstHandDealerMs;
    if (dealer) {
      const dest = centerOf(dealer, table);
      if (prevDealer) {
        const from = {
          x: prevDealer.left + prevDealer.width / 2 - tBox.left,
          y: prevDealer.top + prevDealer.height / 2 - tBox.top,
        };
        dealerDur = dealerMoveMs(dist(from, dest));
        const frames = arcKeyframes(from, dest, {
          hRatio: DEAL_FX.dealerArcHRatio,
          hMax: DEAL_FX.dealerArcHMax,
          bend: 'center',
          tableCenter,
          s0: 1,
          lift: 0.18,
          overshoot: 0,
          thetaStart: 0,
          thetaEnd: 0,
        }).map((f, i, arr) => {
          // Override scale lift to 1→1.18→1
          const t = i / (arr.length - 1);
          const sc = 1 + 0.18 * Math.sin(Math.PI * t);
          return {
            ...f,
            transform: f.transform.replace(/scale\([^)]+\)/, `scale(${sc})`),
          };
        });
        // Position dealer via left/top already set; animate transform from delta
        // Easier: absolute fly clone? Spec animates #dealer itself.
        // Convert absolute frames to relative to dest:
        const relFrames = frames.map((f) => {
          const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(f.transform);
          const x = m ? +m[1] : dest.x;
          const y = m ? +m[2] : dest.y;
          const sc = /scale\(([-\d.]+)\)/.exec(f.transform);
          return {
            offset: f.offset,
            transform: `translate(${x - dest.x}px, ${y - dest.y}px) scale(${sc ? sc[1] : 1})`,
            opacity: 1,
          };
        });
        dealer.style.opacity = '1';
        const anim = trackAnim(
          dealer.animate(relFrames, {
            duration: dealerDur,
            easing: 'cubic-bezier(.65, 0, .35, 1)',
            fill: 'forwards',
          }),
        );
        anim.finished
          .then(() => {
            dealer.style.transform = '';
            return trackAnim(
              dealer.animate([{ scale: 1.08 }, { scale: 1 }], {
                duration: DEAL_FX.dealerBounceMs,
                easing: 'cubic-bezier(.34,1.56,.64,1)',
              }),
            ).finished;
          })
          .catch(() => {});
      } else {
        // First hand: drop from deck
        const from = { x: deckOrigin.x, y: deckOrigin.y };
        const relFrames = [];
        for (let i = 0; i <= 12; i++) {
          const t = i / 12;
          const x = lerp(from.x, dest.x, t);
          const y = lerp(from.y, dest.y, t);
          const sc = lerp(1.25, 1, t);
          const op = t < 80 / DEAL_FX.firstHandDealerMs ? t / (80 / DEAL_FX.firstHandDealerMs) : 1;
          relFrames.push({
            offset: t,
            transform: `translate(${x - dest.x}px, ${y - dest.y}px) scale(${sc})`,
            opacity: Math.min(1, op),
          });
        }
        const anim = trackAnim(
          dealer.animate(relFrames, {
            duration: DEAL_FX.firstHandDealerMs,
            easing: 'cubic-bezier(.2,.8,.2,1)',
            fill: 'forwards',
          }),
        );
        anim.finished
          .then(() => {
            dealer.style.transform = '';
            dealer.style.opacity = '1';
            return trackAnim(
              dealer.animate([{ scale: 1.08 }, { scale: 1 }], {
                duration: DEAL_FX.dealerBounceMs,
                easing: 'cubic-bezier(.34,1.56,.64,1)',
              }),
            ).finished;
          })
          .catch(() => {});
      }
    }

    // D/E Blind chips
    async function runBlind(seat, delayMs) {
      await wait(delayMs, signal);
      const pos = seatVisualPos(seat, viewerSeat);
      const stack = stackElForSeat(seat, viewerSeat, pos);
      const bet = betElForSeat(seat, viewerSeat);
      const p = state.seats[seat];
      if (!p) return;
      const fromChips = p.chips + p.bet;
      const toChips = p.chips;
      countText(stack, fromChips, toChips, DEAL_FX.chipCountMs, signal).catch(() => {});

      const fromEl = stack || seatAnchorEl(pos, viewerSeat);
      if (!fromEl || !bet) return;
      const from = centerOf(fromEl, table);
      const chipIcon = bet.querySelector('.chips') || bet;
      const to = centerOf(chipIcon, table);
      const blue = seat === state.sbSeat ? ' is-blue' : '';
      const chip = document.createElement('div');
      chip.className = 'fx-chip-fly';
      chip.style.zIndex = '3';
      chip.innerHTML = `<span class="chips${blue}"><i class="a"></i></span>`;
      // Pin at origin BEFORE append — never flash at fx-layer (0,0)
      chip.style.transform = `translate(${from.x}px, ${from.y}px) translate(-50%,-50%) scale(.85)`;
      chip.style.opacity = '0';
      layer.appendChild(chip);
      const anim = trackAnim(
        chip.animate(
          [
            {
              transform: `translate(${from.x}px, ${from.y}px) translate(-50%,-50%) scale(.85)`,
              opacity: 0,
            },
            {
              offset: Math.min(0.14, 60 / DEAL_FX.blindMs),
              transform: `translate(${from.x}px, ${from.y}px) translate(-50%,-50%) scale(.85)`,
              opacity: 1,
            },
            {
              transform: `translate(${to.x}px, ${to.y}px) translate(-50%,-50%) scale(1)`,
              opacity: 1,
            },
          ],
          {
            duration: DEAL_FX.blindMs,
            easing: 'cubic-bezier(.05, .7, .1, 1)',
            fill: 'forwards',
          },
        ),
      );
      await anim.finished;
      chip.remove();
      revealPending(bet);
      const amt = bet.querySelector('.amt');
      trackAnim(
        bet.animate([{ scale: 1.1 }, { scale: 1 }], {
          duration: DEAL_FX.blindSettleMs,
          easing: 'cubic-bezier(.34,1.56,.64,1)',
        }),
      );
      if (amt) {
        trackAnim(
          amt.animate(
            [
              { transform: 'translateY(4px)', opacity: 0 },
              { transform: 'translateY(0)', opacity: 1 },
            ],
            { duration: DEAL_FX.blindSettleMs, easing: 'ease-out', fill: 'both' },
          ),
        );
      }
    }

    const blindJobs = [];
    if (state.sbSeat != null) blindJobs.push(runBlind(state.sbSeat, DEAL_FX.blindSbAt));
    if (state.bbSeat != null && state.bbSeat !== state.sbSeat) {
      blindJobs.push(
        (async () => {
          await runBlind(state.bbSeat, DEAL_FX.blindBbAt);
          // Spec E2: pot only after BB settle completes — never flash amount 0
          await wait(DEAL_FX.blindSettleMs, signal);
          await showPotAfterBlinds(state, signal);
        })(),
      );
    } else if (state.sbSeat != null) {
      // HU: SB is button; still show pot after SB blind settle
      blindJobs.push(
        (async () => {
          await wait(DEAL_FX.blindSbAt + DEAL_FX.blindMs + DEAL_FX.blindSettleMs, signal);
          await showPotAfterBlinds(state, signal);
        })(),
      );
    }

    // Pre-create flying cards (2N) — scheduled with WAAPI delay
    const cardJobs = [];
    let lastCardEnd = 0;
    for (let i = 0; i < order.length; i++) {
      const seat = order[i];
      const round = i < occupied.length ? 0 : 1;
      const pos = seatVisualPos(seat, viewerSeat);
      const target = targetCardEl(pos, round);
      const to = target ? centerOf(target, table) : { ...deckOrigin, w: dSize.w, h: dSize.h };
      const from = { x: deckOrigin.x, y: deckOrigin.y };
      const F = cardFlightMs(dist(from, to));
      const delay = DEAL_FX.card0Ms + i * S;
      lastCardEnd = Math.max(lastCardEnd, delay + F);

      const isHero = pos === 'hero';
      const thetaEnd = isHero
        ? round === 0
          ? SLOT_ANGLE.hero0
          : SLOT_ANGLE.hero1
        : round === 0
          ? SLOT_ANGLE.opp0
          : SLOT_ANGLE.opp1;
      const thetaStart = thetaEnd - 40;
      const tw = to.w || (isHero ? 52 : 20);
      const s0 = dSize.w / tw;

      const card = document.createElement('div');
      card.className = 'fx-deal-card';
      card.style.width = `${tw}px`;
      card.style.height = `${to.h || (isHero ? 72 : 28)}px`;
      card.innerHTML = '<span class="fx-shadow"></span>';
      // CRITICAL: pin at deck origin BEFORE append.
      // fill:'forwards' alone leaves the node at layer (0,0) during `delay`,
      // which painted a huge hero-sized card over the header (週五牌局).
      const atDeck =
        `translate(${from.x}px, ${from.y}px) translate(-50%,-50%) ` +
        `rotate(${thetaStart}deg) scale(${s0})`;
      card.style.transform = atDeck;
      card.style.opacity = '1';
      layer.appendChild(card);

      const frames = arcKeyframes(from, to, {
        hRatio: DEAL_FX.arcHRatio,
        hMax: DEAL_FX.arcHMax,
        bend: 'cw',
        thetaStart,
        thetaEnd,
        s0,
        lift: 0.08,
        overshoot: 2,
      });

      cardJobs.push(
        (async () => {
          // Re-query target at flight start in case DOM shifted
          const liveTarget = targetCardEl(pos, round) || target;
          // fill:'both' = apply first keyframe during delay (stay on deck), keep end after
          const anim = trackAnim(
            card.animate(frames, {
              delay,
              duration: F,
              easing: 'cubic-bezier(.2, .75, .25, 1)',
              fill: 'both',
            }),
          );
          const sh = card.querySelector('.fx-shadow');
          if (sh) {
            trackAnim(
              sh.animate(shadowKeyframes(), {
                delay,
                duration: F,
                easing: 'linear',
                fill: 'both',
              }),
            );
          }
          try {
            await anim.finished;
          } catch {
            // cancelled / skipped
            revealPending(liveTarget);
            card.remove();
            return;
          }
          // Same rAF: reveal seat card first, then delete flyer (seamless handoff)
          await new Promise((r) => requestAnimationFrame(r));
          const handoff = targetCardEl(pos, round) || liveTarget;
          if (handoff) {
            handoff.classList.remove('is-pending');
            handoff.style.opacity = '1';
            handoff.style.visibility = 'visible';
          }
          card.style.opacity = '0';
          card.remove();
          if (handoff) {
            try {
              // Individual `scale` only — must not clobber CSS rotate(±6/8°)
              trackAnim(
                handoff.animate([{ scale: 1.06 }, { offset: 0.55, scale: 0.98 }, { scale: 1 }], {
                  duration: DEAL_FX.settleMs,
                  easing: 'cubic-bezier(.3,0,.2,1)',
                }),
              );
            } catch {
              /* ignore */
            }
          }
        })(),
      );
    }

    await Promise.all([...blindJobs, ...cardJobs]);

    // H) Deck exit (overlap with last settle)
    const deckOutDelay = Math.max(0, lastCardEnd - DEAL_FX.settleMs);
    // We're already past last card; just exit now
    trackAnim(
      deck.animate(
        [
          { transform: `translate(${deckOrigin.x}px, ${deckOrigin.y}px) translate(-50%,-50%) scale(1)`, opacity: 1 },
          {
            transform: `translate(${deckOrigin.x}px, ${deckOrigin.y + 6}px) translate(-50%,-50%) scale(.92)`,
            opacity: 0,
          },
        ],
        { duration: DEAL_FX.deckOutMs, fill: 'forwards', easing: 'ease-in' },
      ),
    );
    await wait(DEAL_FX.settleMs, signal);
    deck.remove();

    // I) Look pause
    await wait(DEAL_FX.lookPauseMs, signal);
  } catch (e) {
    if (e?.name !== 'AbortError') console.warn(e);
    snapDealFinal({ occupied, viewerSeat, state });
  } finally {
    document.removeEventListener('pointerdown', onSkip, { capture: true });
    document.removeEventListener('keydown', onKeySkip, { capture: true });
    window.removeEventListener('resize', onInterrupt);
    window.removeEventListener('orientationchange', onInterrupt);
    for (const a of dealAnims) {
      try {
        a.cancel();
      } catch {
        /* ignore */
      }
    }
    dealAnims = [];
    layer.replaceChildren();
    document.documentElement.classList.remove('is-dealing');
    // Clear act opacity fill from dim anim; CSS .is-deal-locked owns the look
    if (act) {
      act.getAnimations?.().forEach((a) => {
        try {
          a.cancel();
        } catch {
          /* ignore */
        }
      });
      act.style.opacity = '';
      act.style.transform = '';
      act.classList.add('is-deal-locked');
    }
    if (skipped) snapDealFinal({ occupied, viewerSeat, state });
    // Ensure nothing left pending
    document.querySelectorAll('.is-pending').forEach((el) => {
      if (el.matches('.backs i, #heroHole .card, #bets .bet, .pot')) revealPending(el);
    });
    if (dealAbort === ac) dealAbort = null;
    onDone?.();
  }
}

/**
 * 3D flip hero hole cards after 換人 confirm.
 * @param {object} opts
 * @param {{r:number,s:number}[]} opts.cards
 * @param {(html: string) => void} opts.mountHtml  sets #heroHole innerHTML
 * @param {() => void} [opts.onDone]
 */
export async function playHeroFlip({ cards, mountHtml, onDone }) {
  cancelHeroFlip();
  if (!cards?.length) {
    onDone?.();
    return;
  }
  const ac = new AbortController();
  flipAbort = ac;
  const { signal } = ac;

  const skip = () => ac.abort();
  const onSkip = (e) => {
    if (e.target?.closest?.('.menu-pop, .raise-panel')) return;
    e.preventDefault();
    skip();
  };
  document.addEventListener('pointerdown', onSkip, { capture: true });

  try {
    if (prefersReducedMotion()) {
      const { cardHtml } = await import('./cards-dom.js');
      mountHtml(cards.map((c) => cardHtml(c, { hero: true })).join(''));
      await wait(150, signal);
      onDone?.();
      return;
    }

    const { cardFaceInner } = await import('./cards-dom.js');
    const parts = cards.map((c, i) => {
      const red = c.s === 1 || c.s === 2 ? ' red' : ' blk';
      return (
        `<div class="card hero is-flipping" data-i="${i}">` +
        `<div class="flip">` +
        `<div class="face back" aria-hidden="true"></div>` +
        `<div class="face front${red}">${cardFaceInner(c)}</div>` +
        `</div></div>`
      );
    });
    mountHtml(parts.join(''));

    const els = [...document.querySelectorAll('#heroHole .card.is-flipping .flip')];
    const jobs = els.map((flip, i) => {
      const delay = i * DEAL_FX.heroFlipStaggerMs;
      const anim = flip.animate(
        [
          { transform: 'rotateY(0deg) translateY(0) scale(1)' },
          { offset: 0.5, transform: 'rotateY(90deg) translateY(-6px) scale(1.06)' },
          { transform: 'rotateY(180deg) translateY(0) scale(1)' },
        ],
        {
          delay,
          duration: DEAL_FX.heroFlipMs,
          easing: DEAL_FX.heroFlipEase,
          fill: 'forwards',
        },
      );
      return anim.finished;
    });
    await Promise.all(jobs);

    // Replace with normal face cards (no hero-deal fly-in)
    const { cardHtml } = await import('./cards-dom.js');
    mountHtml(cards.map((c) => cardHtml(c, { hero: true })).join(''));
  } catch (e) {
    if (e?.name !== 'AbortError') console.warn(e);
    const { cardHtml } = await import('./cards-dom.js');
    mountHtml(cards.map((c) => cardHtml(c, { hero: true })).join(''));
  } finally {
    document.removeEventListener('pointerdown', onSkip, { capture: true });
    if (flipAbort === ac) flipAbort = null;
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
  const potEl = $('.pot') || table;
  const from = centerOf(potEl, table);

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
      fly
        .animate(
          [
            { transform: `translate(${start.x}px, ${start.y}px) translate(-50%,-50%)`, opacity: 1 },
            { transform: `translate(${toWin.x}px, ${toWin.y}px) translate(-50%,-50%) scale(.7)`, opacity: 0.2 },
          ],
          { duration: 420, easing: 'cubic-bezier(.18,.75,.22,1)', fill: 'forwards' },
        )
        .finished.catch(() => {});
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
    if (prefersReducedMotion()) continue;
    const chip = document.createElement('div');
    chip.className = 'fx-chip-fly';
    chip.innerHTML = `<span class="chips"><i class="a"></i><i class="b"></i><i class="c"></i></span><span class="amt">${fmtChips(amt)}</span>`;
    layer.appendChild(chip);
    const to = centerOf(anchor, table);
    chip
      .animate(
        [
          { transform: `translate(${from.x}px, ${from.y}px) translate(-50%,-50%) scale(.7)`, opacity: 0.3 },
          { transform: `translate(${to.x}px, ${to.y}px) translate(-50%,-50%) scale(1)`, opacity: 1 },
        ],
        { duration: 520, easing: 'cubic-bezier(.18,.75,.22,1)', fill: 'forwards' },
      )
      .finished.catch(() => {});
  }

  try {
    await wait(holdMs, signal);
  } catch {
    /* skip */
  } finally {
    layer.querySelectorAll('.fx-chip-fly').forEach((n) => n.remove());
    if (winAbort === ac) winAbort = null;
  }
}
