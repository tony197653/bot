/**
 * Hot-seat Texas Hold'em UI — classic green table.
 * Engine stays pure; this module owns DOM + pass-and-play flow.
 */

import {
  createInitialState,
  applyAction,
  viewForSeat,
  getLegalActions,
  raisePresets,
  PHASE,
  sessionSummary,
} from '../engine/index.js';
import { cardHtml, cardBackPair, fmtChips } from './cards-dom.js';
import { onTick } from './ticker.js';
import { mapSeatsClockwise } from './seating.js';
import {
  playDealAnimation,
  playWinnerFx,
  cancelDealFx,
  cancelWinFx,
  prefersReducedMotion,
  foldWinCenterNote,
} from './fx.js';

const DEFAULT_NAMES = ['宗良', '阿哲', '小芸', '志明', '小美', '老K'];

/** @type {object} */
let state = createInitialState({ timerEnabled: false, roomName: '週五牌局' });
/** Current hot-seat viewer (whose phone it is). */
let viewerSeat = 0;
/** Pass screen pending when actor changes. */
let needsPass = false;
let lastActor = null;
let raiseTo = 0;
let toastTimer = 0;
let dealAnimKey = '';
/** Hand number waiting for deal FX after pass confirm. */
let pendingDealHand = 0;
let lastDealPlayed = 0;
let winFxKey = '';
/** @type {DOMRect | null} */
let prevDealerRect = null;
let dealFxBusy = false;
/** @type {ReturnType<typeof setTimeout> | null} */
let raiseHoldTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let raiseHoldRepeat = null;

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

function clearRaiseHold() {
  if (raiseHoldTimer != null) clearTimeout(raiseHoldTimer);
  if (raiseHoldRepeat != null) clearTimeout(raiseHoldRepeat);
  raiseHoldTimer = null;
  raiseHoldRepeat = null;
}

/** Step raise-to by ±1 BB; press-and-hold auto-repeats after ~400ms then accelerates. */
function bindRaiseStep(btn, dir) {
  if (!btn || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';
  const stepOnce = () => {
    const legal = getLegalActions(state, viewerSeat);
    if (!legal?.canAct) return;
    const min = legal.minRaiseTo;
    const max = legal.maxRaiseTo;
    const bb = state.config.bigBlind;
    raiseTo = clamp(raiseTo + dir * bb, Math.min(min, max), max);
    const range = $('#raiseRange');
    if (range) {
      range.value = String(raiseTo);
      syncRaiseUi();
    }
  };
  const onDown = (e) => {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    clearRaiseHold();
    try {
      btn.setPointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    stepOnce();
    let interval = 140;
    raiseHoldTimer = setTimeout(function tick() {
      stepOnce();
      interval = Math.max(36, Math.floor(interval * 0.82));
      raiseHoldRepeat = setTimeout(tick, interval);
    }, 400);
  };
  const onUp = () => clearRaiseHold();
  btn.addEventListener('pointerdown', onDown);
  btn.addEventListener('pointerup', onUp);
  btn.addEventListener('pointercancel', onUp);
  btn.addEventListener('lostpointercapture', onUp);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}

function syncRaiseUi() {
  const range = $('#raiseRange');
  const out = $('#raiseOut');
  if (out) out.textContent = fmtChips(raiseTo);
  if (range) {
    const min = +range.min;
    const max = +range.max;
    const pct = max > min ? ((raiseTo - min) / (max - min)) * 100 : 0;
    range.style.setProperty('--raise-pct', `${clamp(pct, 0, 100)}%`);
  }
  syncPresetPressed();
  syncRaiseBtn();
  const minus = $('#raiseMinus');
  const plus = $('#raisePlus');
  if (range && minus && plus) {
    minus.disabled = raiseTo <= +range.min;
    plus.disabled = raiseTo >= +range.max;
  }
}

function dispatch(action, env = {}) {
  try {
    state = applyAction(state, action, { now: Date.now(), ...env });
    afterState();
  } catch (e) {
    toast(e.message || String(e));
  }
}

function afterState() {
  // New hand → queue deal presentation (engine already final)
  if (
    state.handNumber > lastDealPlayed &&
    state.phase === PHASE.PREFLOP &&
    state.handNumber !== pendingDealHand
  ) {
    cancelWinFx();
    winFxKey = '';
    pendingDealHand = state.handNumber;
  }
  // Hand over: stop pass gate so winner FX / summary are visible
  if (state.phase === PHASE.HAND_OVER || state.phase === PHASE.SESSION_OVER) {
    needsPass = false;
    $('#passScreen')?.classList.remove('is-on');
  }
  // Hot-seat: when actor changes to another seated player mid-hand, show pass screen
  if (
    state.actor != null &&
    state.actor !== viewerSeat &&
    [PHASE.PREFLOP, PHASE.FLOP, PHASE.TURN, PHASE.RIVER].includes(state.phase)
  ) {
    needsPass = true;
  }
  // Showdown pending for another player
  if (state.phase === PHASE.SHOWDOWN && state.showdown?.pending?.length) {
    const pend = state.showdown.pending[0];
    if (pend !== viewerSeat) {
      needsPass = true;
      viewerSeat = pend; // will confirm via pass screen
    }
  }
  render();
}

function view() {
  return viewForSeat(state, viewerSeat);
}

/* ─── Boot / preload ─── */
async function boot() {
  const bar = $('#bootBar');
  const pct = $('#bootPct');
  const set = (n, label) => {
    bar.style.width = `${n}%`;
    pct.textContent = `${label} ${n}%`;
  };
  set(8, '載入字型');
  try {
    if (document.fonts?.load) {
      await Promise.all([
        document.fonts.load('700 24px "Noto Serif TC"'),
        document.fonts.load('500 16px "Noto Sans TC"'),
        document.fonts.load('400 14px "Noto Sans TC"'),
      ]);
    }
  } catch (_) { /* ignore */ }
  set(40, '載入圖示');
  try {
    await Promise.all(
      ['assets/icon-192.png', 'assets/icon-180.png', 'assets/icon-512.png'].map(
        (src) =>
          new Promise((resolve) => {
            const img = new Image();
            img.onload = img.onerror = () => resolve();
            img.src = src;
          }),
      ),
    );
  } catch (_) { /* ignore */ }
  set(55, '載入介面');
  await new Promise((r) => requestAnimationFrame(() => r()));
  // Warm layout
  $('#app').classList.remove('hidden');
  setupFullscreenButton();
  set(85, '準備牌桌');
  await new Promise((r) => setTimeout(r, 180));
  set(100, '完成');
  await new Promise((r) => setTimeout(r, 220));
  $('#boot').classList.add('is-done');
  setTimeout(() => $('#boot').classList.add('hidden'), 480);
  openLobby();
}

function setupFullscreenButton() {
  const btn = $('#btnFullscreen');
  if (!btn) return;
  const doc = document;
  const el = doc.documentElement;
  const can =
    (doc.fullscreenEnabled || doc.webkitFullscreenEnabled) &&
    (el.requestFullscreen || el.webkitRequestFullscreen);
  if (!can) {
    btn.classList.add('hidden');
    return;
  }
  btn.classList.remove('hidden');
  const isFs = () => !!(doc.fullscreenElement || doc.webkitFullscreenElement);
  const sync = () => {
    const on = isFs();
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? '離開全螢幕' : '全螢幕';
  };
  btn.onclick = async () => {
    try {
      if (isFs()) {
        await (doc.exitFullscreen || doc.webkitExitFullscreen).call(doc);
      } else {
        await (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
      }
    } catch (_) {
      toast('無法進入全螢幕');
    }
    sync();
  };
  doc.addEventListener('fullscreenchange', sync);
  doc.addEventListener('webkitfullscreenchange', sync);
  sync();
}

/* ─── Lobby ─── */
function openLobby() {
  const scr = $('#lobbyScreen');
  scr.classList.remove('hidden');
  scr.classList.add('is-on');
  $('#passScreen').classList.remove('is-on');
  needsPass = false;
  const box = $('#playerRows');
  const seated = state.seats.map((p, i) => (p ? p.name : null));
  // Default fill 宗良 + friends if empty lobby
  if (!seated.some(Boolean)) {
    box.innerHTML = DEFAULT_NAMES.map(
      (n, i) => rowHtml(i, n, i < 4),
    ).join('');
  } else {
    box.innerHTML = DEFAULT_NAMES.map((n, i) =>
      rowHtml(i, seated[i] || n, !!seated[i]),
    ).join('');
  }
  $('#roomNameInput').value = state.room.name;
  $('#bbInput').value = state.config.bigBlind;
  $('#stackInput').value = state.config.startingStack;
  $('#timerToggle').checked = state.config.timerEnabled;
  bindLobby();
}

function rowHtml(i, name, on) {
  const ch = name.slice(0, 1);
  return `<div class="p-row" data-seat="${i}">
    <div class="av"><span>${esc(ch)}</span></div>
    <input type="text" maxlength="12" value="${esc(name)}" aria-label="玩家${i + 1}暱稱" ${on ? '' : 'disabled'}/>
    <button type="button" data-toggle="${i}">${on ? '移除' : '加入'}</button>
  </div>`;
}

function bindLobby() {
  const box = $('#playerRows');
  box.onclick = (e) => {
    const btn = e.target.closest('[data-toggle]');
    if (!btn) return;
    const row = btn.closest('.p-row');
    const input = row.querySelector('input');
    const on = !input.disabled;
    input.disabled = on;
    btn.textContent = on ? '加入' : '移除';
  };
  $('#bbInput').onchange = () => {
    const bb = Math.max(2, parseInt($('#bbInput').value, 10) || 20);
    const min = bb * 100;
    const cur = parseInt($('#stackInput').value, 10) || 0;
    if (cur < min) $('#stackInput').value = String(min);
  };
  $('#btnStart').onclick = () => {
    const name = $('#roomNameInput').value.trim() || '週五牌局';
    const bb = Math.max(2, parseInt($('#bbInput').value, 10) || 20);
    const stack = parseInt($('#stackInput').value, 10) || bb * 100;
    const timerOn = $('#timerToggle').checked;
    state = createInitialState({
      roomName: name,
      bigBlind: bb,
      smallBlind: Math.floor(bb / 2),
      startingStack: Math.max(stack, bb * 100),
      timerEnabled: timerOn,
    });
    try {
      state = applyAction(state, {
        type: 'CONFIG',
        bigBlind: bb,
        startingStack: Math.max(stack, bb * 100),
        timerEnabled: timerOn,
        roomName: name,
      });
    } catch (_) { /* fresh state already configured */ }

    const rows = $$('#playerRows .p-row');
    let hostSet = false;
    let count = 0;
    for (const row of rows) {
      const input = row.querySelector('input');
      if (input.disabled) continue;
      const seat = +row.dataset.seat;
      const nm = input.value.trim() || DEFAULT_NAMES[seat];
      state = applyAction(state, {
        type: 'SEAT',
        seat,
        name: nm,
        isHost: !hostSet,
      });
      hostSet = true;
      count++;
    }
    if (count < 2) {
      toast('至少需要兩位玩家');
      openLobby();
      return;
    }
    dispatch({ type: 'START_HAND' });
    // First actor gets the device
    viewerSeat = state.actor ?? state.room.hostSeat;
    needsPass = true;
    $('#lobbyScreen').classList.remove('is-on');
    $('#lobbyScreen').classList.add('hidden');
    showPass();
  };
}

/* ─── Pass screen ─── */
function showPass() {
  const p = state.seats[viewerSeat];
  if (!p) return;
  needsPass = true;
  // Privacy: clear hole cards until the correct player confirms
  $('#heroHole').innerHTML = '';
  $('#heroName').textContent = '（換人中）';
  $('#heroChips').textContent = '';
  $('#passScreen').classList.remove('hidden');
  $('#passScreen').classList.add('is-on');
  $('#passName').textContent = p.name;
  $('#passHint').textContent =
    state.phase === PHASE.SHOWDOWN
      ? '請把裝置交給這位玩家，選擇亮牌或蓋沒。'
      : '請把裝置交給這位玩家。其他人請勿偷看手牌。';
}

function hidePass() {
  needsPass = false;
  $('#passScreen').classList.remove('is-on');
  lastActor = state.actor;
  dealAnimKey = `${state.handNumber}-${viewerSeat}`;
  render();
  maybePlayDealFx();
}

$('#btnPassOk').onclick = () => hidePass();

/* ─── Render ─── */
function render() {
  if (
    needsPass &&
    state.phase !== PHASE.HAND_OVER &&
    state.phase !== PHASE.SESSION_OVER
  ) {
    showPass();
  }
  const v = view();
  renderTop(v);
  renderTable(v);
  renderSide(v);
  renderActions(v);
  renderHandOver(v);
}

function renderTop(v) {
  $('#roomTitle').textContent = v.room.name;
  // Two spans: on phone .meta-b wraps to a second line so nothing truncates
  $('#roomMeta').innerHTML =
    `<span class="meta-a">無限注 <b>盲注 ${v.config.smallBlind}／${v.config.bigBlind}</b></span>` +
    `<span class="meta-b">　第 ${v.handNumber} 手　房號 ${v.room.code}</span>`;
  $('#btnTimerCfg').textContent = v.config.timerEnabled ? '計時開' : '計時關';
  $('#btnTimerCfg').onclick = () => {
    dispatch({ type: 'SET_TIMER', enabled: !state.config.timerEnabled });
  };
}

function renderTable(v) {
  const boardEl = $('#board');
  const slots = [];
  for (let i = 0; i < 5; i++) {
    if (v.board[i]) slots.push(cardHtml(v.board[i], { anim: true }));
    else slots.push('<span class="slot"></span>');
  }
  boardEl.innerHTML = slots.join('');

  $('#potAmt').textContent = fmtChips(v.potTotal);
  $('#potSub').textContent = v.streetBets ? `本輪下注共 ${fmtChips(v.streetBets)}` : '';

  // Relative seating: viewer at bottom (.me), others around
  const seatsRoot = $('#seats');
  const betsRoot = $('#bets');
  seatsRoot.innerHTML = '';
  betsRoot.innerHTML = '';

  const anim = dealAnimKey === `${v.handNumber}-${viewerSeat}`;

  // Fixed 6 slots; viewer at bottom-center; empty seats keep placeholders
  const occupied = [];
  for (let seat = 0; seat < 6; seat++) {
    if (v.seats[seat]) occupied.push(seat);
  }
  const { seatToPos, emptySlots } = mapSeatsClockwise(occupied, viewerSeat);
  const opponents = occupied.filter((s) => s !== viewerSeat);

  for (const pos of emptySlots) {
    const el = document.createElement('div');
    el.className = `seat pos-${pos} is-empty`;
    el.dataset.empty = '1';
    el.innerHTML = `<div class="av" aria-label="空位"><span>空位</span></div>`;
    seatsRoot.appendChild(el);
  }

  for (const seat of opponents) {
    const p = v.seats[seat];
    const pos = seatToPos.get(seat);
    if (typeof pos !== 'number') continue;
    const role = roleTag(v, seat);
    const folded = p.folded ? ' is-folded' : '';
    const actor = v.actor === seat ? ' is-actor' : '';
    const backs = p.holeHidden && !p.folded ? cardBackPair() : '';
    const holeShow =
      p.hole && p.hole.length
        ? `<div class="mini-hole">${p.hole.map((c) => cardHtml(c)).join('')}</div>`
        : '';
    const wonAmt = state.winnerPayouts?.[seat];
    const isWin = wonAmt != null && (v.isHandOver || v.isShowdown);
    const el = document.createElement('div');
    el.className = `seat pos-${pos}${folded}${actor}${isWin ? ' is-winner' : ''}`;
    el.dataset.seat = String(seat);
    // Street bet amount lives on the chip marker — omit state line while bet>0
    // so the plate is shorter and never fights the chip for the same “10”.
    const stateText =
      p.bet > 0
        ? ''
        : p.lastAction || (p.sittingOut ? '主出' : '　');
    el.innerHTML = `
      <div class="av"><span>${esc(p.name.slice(0, 1))}</span>${backs}</div>
      <div class="plate${isWin ? ' is-winner' : ''}">
        <b class="nm">${esc(p.name)}${role}</b>
        <span class="ch">${fmtChips(p.chips)}</span>
        ${stateText ? `<span class="state">${esc(stateText)}</span>` : ''}
      </div>${holeShow}${
        isWin ? `<div class="win-badge">WIN +${fmtChips(wonAmt)}</div>` : ''
      }`;
    seatsRoot.appendChild(el);

    // Hide street bets once the hand is decided — chips slide to winner via FX
    if (p.bet > 0 && !v.isHandOver && !v.isShowdown) {
      const b = document.createElement('div');
      b.className = 'bet is-in';
      b.dataset.forSeat = String(seat);
      b.dataset.pos = String(pos);
      b.innerHTML = `<span class="chips"><i class="a"></i><i class="b"></i><i class="c"></i></span><span class="amt">${fmtChips(p.bet)}</span>`;
      betsRoot.appendChild(b);
    }
  }

  // Dealer button — final % set in layoutDealer() after seats/bets paint
  const dealer = $('#dealer');
  const btnPos = seatToPos.get(v.button);
  dealer.dataset.pos = btnPos === 'hero' || v.button === viewerSeat ? 'hero' : String(btnPos);
  dealer.dataset.forSeat = String(v.button);

  // Hero
  const hero = v.seats[viewerSeat];
  const hole = $('#heroHole');
  if (hero?.hole?.length) {
    hole.innerHTML = hero.hole
      .map((c) => cardHtml(c, { hero: true, anim }))
      .join('');
  } else {
    hole.innerHTML = '';
  }
  {
    const nameEl = $('#heroName');
    if (nameEl) {
      if (hero) {
        const role = roleTag(v, viewerSeat);
        nameEl.innerHTML = `${esc(hero.name)}（你）${role}`;
      } else {
        nameEl.textContent = '';
      }
    }
  }
  $('#heroChips').textContent = hero ? fmtChips(hero.chips) : '';
  const mePlate = $('#mePlate');
  const heroWon = state.winnerPayouts?.[viewerSeat];
  const heroIsWin = heroWon != null && (v.isHandOver || v.isShowdown);
  mePlate?.classList.toggle('is-winner', !!heroIsWin);
  document.querySelectorAll('#meRoot > .win-badge').forEach((n) => n.remove());
  if (heroIsWin && mePlate) {
    const badge = document.createElement('div');
    badge.className = 'win-badge';
    badge.textContent = `WIN +${fmtChips(heroWon)}`;
    $('#meRoot')?.appendChild(badge);
  }

  // Fold-win center note (persistent until next hand)
  document.querySelectorAll('.table-note').forEach((n) => n.remove());
  {
    const note = foldWinCenterNote(state);
    if (note && (v.isHandOver || v.isShowdown)) {
      const el = document.createElement('div');
      el.className = 'table-note';
      el.textContent = note;
      document.querySelector('.table')?.appendChild(el);
    }
  }

  // Hero street bet (omit after hand decided)
  if (hero?.bet > 0 && !v.isHandOver && !v.isShowdown) {
    const b = document.createElement('div');
    b.className = 'bet is-in';
    b.dataset.forSeat = String(viewerSeat);
    b.dataset.hero = '1';
    b.innerHTML = `<span class="chips"><i class="a"></i><i class="b"></i><i class="c"></i></span><span class="amt">${fmtChips(hero.bet)}</span>`;
    betsRoot.appendChild(b);
  }

  // Place bets + dealer after layout so they clear plates / board / cards
  requestAnimationFrame(() => {
    layoutBets();
    layoutDealer();
    const d = $('#dealer');
    if (d && getComputedStyle(d).display !== 'none') {
      prevDealerRect = d.getBoundingClientRect();
    }
    maybePlayWinnerFx(v);
  });
}

function maybePlayDealFx() {
  if (needsPass || dealFxBusy) return;
  if (!pendingDealHand || pendingDealHand !== state.handNumber) return;
  if (state.phase !== PHASE.PREFLOP) return;
  if (prefersReducedMotion()) {
    lastDealPlayed = state.handNumber;
    pendingDealHand = 0;
    return;
  }
  dealFxBusy = true;
  const hand = state.handNumber;
  const prev = prevDealerRect;
  pendingDealHand = 0;
  lastDealPlayed = hand;
  requestAnimationFrame(() => {
    playDealAnimation({
      state,
      viewerSeat,
      prevDealer: prev,
      onDone: () => {
        dealFxBusy = false;
        document.documentElement.classList.remove('is-dealing');
      },
    });
  });
}

function maybePlayWinnerFx(v) {
  if (needsPass) return;
  if (!(v.isHandOver || v.isShowdown) || !state.winners?.length) return;
  const key = `${state.handNumber}:${JSON.stringify(state.winnerPayouts || state.winners)}`;
  if (key === winFxKey) return;
  winFxKey = key;
  playWinnerFx({ state, viewerSeat, holdMs: 2000 });
}

/** Safe chip-rail anchors (% of .table) — inward from seats, clear of pot (~28%) / board. */
const BET_ANCHOR_PHONE = {
  0: [50, 26],
  1: [66, 36],
  2: [66, 50],
  3: [34, 50],
  4: [34, 36],
  // Below board band (board ~52–60% on short phones)
  hero: [50, 70],
};
const BET_ANCHOR_DESKTOP = {
  0: [50, 22],
  1: [68, 34],
  2: [68, 54],
  3: [32, 54],
  4: [32, 34],
  hero: [50, 70],
};

/** Dealer «D» anchors — near the button seat but inward; nudged clear of plates. */
const DEALER_ANCHOR_PHONE = {
  0: [62, 16],
  1: [78, 34],
  2: [78, 54],
  3: [22, 54],
  4: [22, 34],
  hero: [58, 70],
};
const DEALER_ANCHOR_DESKTOP = {
  0: [58, 20],
  1: [76, 34],
  2: [74, 58],
  3: [26, 58],
  4: [24, 34],
  hero: [60, 74],
};

/**
 * Position each .bet on a safe rail toward the pot, then nudge away from
 * plates / board / pot / other bets if anything still collides.
 */
function layoutBets() {
  const table = document.querySelector('.table');
  const board = $('#board');
  const potEl = document.querySelector('.pot');
  if (!table) return;
  const t = table.getBoundingClientRect();
  if (t.width < 8 || t.height < 8) return;
  const desktop = window.matchMedia('(min-width: 1024px)').matches;
  const anchors = desktop ? BET_ANCHOR_DESKTOP : BET_ANCHOR_PHONE;
  const boardBox = board?.getBoundingClientRect();
  const potBox = potEl?.getBoundingClientRect();
  const plates = [...document.querySelectorAll('.seat .plate, .meinfo')].map((el) =>
    el.getBoundingClientRect(),
  );
  const holeBoxes = [...document.querySelectorAll('#heroHole .card')].map((el) =>
    el.getBoundingClientRect(),
  );
  const bets = [...document.querySelectorAll('#bets .bet')];

  /** @type {{el:HTMLElement, x:number, y:number, w:number, h:number, hero:boolean}[]} */
  const placed = [];

  for (const bet of bets) {
    const key = bet.dataset.hero === '1' ? 'hero' : bet.dataset.pos;
    const [px, py] = anchors[key] || anchors.hero;
    bet.style.left = `${px}%`;
    bet.style.top = `${py}%`;
    const br = bet.getBoundingClientRect();
    placed.push({
      el: bet,
      x: br.left,
      y: br.top,
      w: br.width,
      h: br.height,
      hero: bet.dataset.hero === '1',
    });
  }

  const pad = 8;
  const potPad = 6;
  for (let pass = 0; pass < 18; pass++) {
    for (const p of placed) {
      const box = () => ({
        left: p.x - pad,
        top: p.y - pad,
        right: p.x + p.w + pad,
        bottom: p.y + p.h + pad,
      });
      for (const pl of plates) {
        const d = separationDelta(box(), pl, 4) || overlapDelta(box(), pl);
        if (d) {
          p.x += d.dx;
          p.y += d.dy;
        }
      }
      if (!p.hero) {
        for (const hc of holeBoxes) {
          const d = overlapDelta(box(), {
            left: hc.left - 4,
            top: hc.top - 4,
            right: hc.right + 4,
            bottom: hc.bottom + 4,
          });
          if (d) {
            p.x += d.dx;
            p.y += d.dy;
          }
        }
      }
      if (boardBox) {
        const inflated = {
          left: boardBox.left - 8,
          top: boardBox.top - 8,
          right: boardBox.right + 8,
          bottom: boardBox.bottom + 8,
        };
        const d = overlapDelta(box(), inflated);
        if (d) {
          if (p.hero) {
            // Hero bets live under the board — never slide upward into the pot
            p.y += Math.max(Math.abs(d.dy), d.dy, 4);
            p.x += d.dx;
          } else {
            p.x += d.dx;
            p.y += d.dy;
          }
        }
      }
      // Clear pot: prefer vertical/horizontal slide that does not walk onto plates
      if (potBox) {
        const inflated = {
          left: potBox.left - potPad,
          top: potBox.top - potPad,
          right: potBox.right + potPad,
          bottom: potBox.bottom + potPad,
        };
        const d = overlapDelta(box(), inflated);
        if (d) {
          const pcx = (potBox.left + potBox.right) / 2;
          const pcy = (potBox.top + potBox.bottom) / 2;
          const bcx = p.x + p.w / 2;
          const bcy = p.y + p.h / 2;
          const awayX = bcx >= pcx ? 1 : -1;
          const awayY = p.hero ? 1 : bcy >= pcy ? 1 : -1;
          if (d.dx !== 0 && Math.abs(d.dx) <= Math.abs(d.dy) + 1 && !p.hero) {
            p.x += awayX * Math.abs(d.dx);
          } else {
            p.y += awayY * Math.abs(d.dy || d.dx);
            if (p.hero) p.x += awayX * Math.min(8, Math.abs(d.dx));
          }
        }
      }
      for (const q of placed) {
        if (q === p) continue;
        const d = overlapDelta(box(), {
          left: q.x - pad,
          top: q.y - pad,
          right: q.x + q.w + pad,
          bottom: q.y + q.h + pad,
        });
        if (d) {
          p.x += d.dx * 0.6;
          p.y += d.dy * 0.6;
        }
      }
      p.x = clamp(p.x, t.left + 2, t.right - p.w - 2);
      p.y = clamp(p.y, t.top + 2, t.bottom - p.h - 2);
      p.el.style.left = `${((p.x + p.w / 2 - t.left) / t.width) * 100}%`;
      p.el.style.top = `${((p.y + p.h / 2 - t.top) / t.height) * 100}%`;
      const br = p.el.getBoundingClientRect();
      p.x = br.left;
      p.y = br.top;
      p.w = br.width;
      p.h = br.height;
    }
  }

  // Final separation: plates first (priority), then pot, board, peers
  for (let fin = 0; fin < 12; fin++) {
    for (const p of placed) {
      const a0 = () => ({ left: p.x, top: p.y, right: p.x + p.w, bottom: p.y + p.h });
      for (const pl of plates) {
        const d = separationDelta(a0(), pl, 5);
        if (d) {
          p.x += d.dx;
          p.y += d.dy;
        }
      }
      if (potBox) {
        const inflated = {
          left: potBox.left - potPad,
          top: potBox.top - potPad,
          right: potBox.right + potPad,
          bottom: potBox.bottom + potPad,
        };
        const d = overlapDelta(a0(), inflated);
        if (d) {
          const pcx = (potBox.left + potBox.right) / 2;
          const pcy = (potBox.top + potBox.bottom) / 2;
          const bcx = p.x + p.w / 2;
          const bcy = p.y + p.h / 2;
          p.x += (bcx >= pcx ? 1 : -1) * Math.max(2, Math.abs(d.dx));
          p.y += (bcy >= pcy ? 1 : -1) * Math.max(2, Math.abs(d.dy));
        }
      }
      if (boardBox) {
        const inflated = {
          left: boardBox.left - 4,
          top: boardBox.top - 4,
          right: boardBox.right + 4,
          bottom: boardBox.bottom + 4,
        };
        const d = overlapDelta(a0(), inflated);
        if (d) {
          p.x += d.dx;
          p.y += d.dy;
        }
      }
      for (const q of placed) {
        if (q === p) continue;
        const d = separationDelta(
          a0(),
          { left: q.x, top: q.y, right: q.x + q.w, bottom: q.y + q.h },
          4,
        );
        if (d) {
          p.x += d.dx * 0.75;
          p.y += d.dy * 0.75;
        }
      }
      p.x = clamp(p.x, t.left + 2, t.right - p.w - 2);
      p.y = clamp(p.y, t.top + 2, t.bottom - p.h - 2);
      p.el.style.left = `${((p.x + p.w / 2 - t.left) / t.width) * 100}%`;
      p.el.style.top = `${((p.y + p.h / 2 - t.top) / t.height) * 100}%`;
      const br = p.el.getBoundingClientRect();
      p.x = br.left;
      p.y = br.top;
      p.w = br.width;
      p.h = br.height;
    }
  }
}

/**
 * Place the dealer «D» tight against the button seat's nameplate, on the
 * side facing table center. Score candidate spots around the plate's inward
 * perimeter so D never drifts toward another seat. Bet chips yield to D.
 */
function layoutDealer() {
  const table = document.querySelector('.table');
  const dealer = $('#dealer');
  if (!table || !dealer) return;
  const t = table.getBoundingClientRect();
  if (t.width < 8 || t.height < 8) return;

  const key = dealer.dataset.pos || 'hero';
  const seatId = dealer.dataset.forSeat;
  const anchorEl =
    key === 'hero'
      ? document.querySelector('.meinfo')
      : document.querySelector(`.seat[data-seat="${seatId}"] .plate`);
  if (!anchorEl) return;

  const ar = anchorEl.getBoundingClientRect();
  const ax = ar.left + ar.width / 2;
  const ay = ar.top + ar.height / 2;
  const cx = t.left + t.width / 2;
  const cy = t.top + t.height * 0.4;
  const toCx = cx - ax;
  const toCy = cy - ay;
  const toLen = Math.hypot(toCx, toCy) || 1;
  const ux = toCx / toLen;
  const uy = toCy / toLen;

  dealer.style.left = '50%';
  dealer.style.top = '50%';
  const br0 = dealer.getBoundingClientRect();
  const dw = br0.width;
  const dh = br0.height;
  const gap = 4;

  const otherPlates = [...document.querySelectorAll('.seat .plate, .meinfo')].filter(
    (el) => el !== anchorEl,
  );
  const potEl = document.querySelector('.pot');
  const boardEl = $('#board');
  const noteEl = document.querySelector('.table-note');
  const softRects = [
    potEl,
    boardEl,
    noteEl,
    ...document.querySelectorAll(
      '#board .card, #board .slot, #heroHole .card, .mini-hole .card, .seat .av',
    ),
  ]
    .filter(Boolean)
    .map((el) => {
      const r = el.getBoundingClientRect();
      const pad = el === potEl || el === noteEl ? 4 : el === boardEl ? 2 : 1;
      return {
        left: r.left - pad,
        top: r.top - pad,
        right: r.right + pad,
        bottom: r.bottom + pad,
      };
    });
  for (const pl of otherPlates) {
    const r = pl.getBoundingClientRect();
    softRects.push({
      left: r.left - 8,
      top: r.top - 8,
      right: r.right + 8,
      bottom: r.bottom + 8,
    });
  }

  const overlaps = (a, b) => {
    const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return ox > 0 && oy > 0;
  };
  const edgeDist = (px, py, r) => {
    const dx = Math.max(r.left - px, 0, px - r.right);
    const dy = Math.max(r.top - py, 0, py - r.bottom);
    return Math.hypot(dx, dy);
  };

  // Candidates: ring around the plate, biased to the inward (table-center) half
  /** @type {{x:number,y:number,score:number}[]} */
  const candidates = [];
  const rings = [gap + Math.max(dw, dh) / 2, gap + Math.max(dw, dh) / 2 + 8];
  for (const rad of rings) {
    for (let i = 0; i < 24; i++) {
      const ang = (i / 24) * Math.PI * 2;
      const dx = Math.cos(ang);
      const dy = Math.sin(ang);
      // Inward hemisphere only (dot with table-center direction >= -0.15)
      if (dx * ux + dy * uy < -0.15) continue;
      const x = ax + dx * (rad + (Math.abs(dx) * ar.width + Math.abs(dy) * ar.height) / 2);
      const y = ay + dy * (rad + (Math.abs(dx) * ar.width + Math.abs(dy) * ar.height) / 2);
      candidates.push({ x, y, score: 0 });
    }
  }
  // Also try the pure inward radial spot
  {
    const plateAlong = (Math.abs(ux) * ar.width + Math.abs(uy) * ar.height) / 2;
    const rad = plateAlong + Math.max(dw, dh) / 2 + gap;
    candidates.push({ x: ax + ux * rad, y: ay + uy * rad, score: 0 });
  }

  // Hero plate sits below the felt — allow D into that band
  const stage = document.querySelector('.stage')?.getBoundingClientRect() || t;
  const minX = Math.min(t.left, stage.left) + dw / 2 + 4;
  const maxX = Math.max(t.right, stage.right) - dw / 2 - 4;
  const minY = t.top + dh / 2 + 4;
  const maxY = Math.max(t.bottom, ar.bottom + dh / 2 + 8) - dh / 2 - 2;

  // Hero hole cards sit above meinfo; for hero, don't treat them as hard blocks on
  // lateral candidates (left/right of the plate still read as "this seat's D").
  const softForHeroSide = softRects.filter((r) => {
    if (key !== 'hero') return true;
    // drop obstacles that are mostly above the plate (hole cards)
    return r.bottom > ar.top - 4;
  });

  let best = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    let x = clamp(c.x, minX, maxX);
    let y = clamp(c.y, minY, maxY);
    const box = {
      left: x - dw / 2,
      top: y - dh / 2,
      right: x + dw / 2,
      bottom: y + dh / 2,
    };
    // Must not cover own plate
    if (overlaps(box, ar)) continue;
    const soft = key === 'hero' && Math.abs(x - ax) > Math.abs(y - ay) ? softForHeroSide : softRects;
    let blocked = false;
    for (const ob of soft) {
      if (overlaps(box, ob)) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    const own = edgeDist(x, y, ar);
    if (own > 26) continue;
    // Must be nearer to own plate than to any other
    let nearerOther = false;
    for (const pl of otherPlates) {
      const pr = pl.getBoundingClientRect();
      if (edgeDist(x, y, pr) <= own + 1) {
        nearerOther = true;
        break;
      }
    }
    if (nearerOther) continue;
    // Prefer inward + close to plate
    const inward = (x - ax) * ux + (y - ay) * uy;
    const score = own * 3 + Math.max(0, -inward) * 2;
    if (score < bestScore) {
      bestScore = score;
      best = { x, y };
    }
  }

  // Fallback: glue to the inward / side edge of the plate
  if (!best) {
    const plateAlong = (Math.abs(ux) * ar.width + Math.abs(uy) * ar.height) / 2;
    const rad = plateAlong + Math.max(dw, dh) / 2 + gap;
    // Prefer left/right of hero plate if radial is blocked
    if (key === 'hero') {
      best = {
        x: clamp(ar.left - dw / 2 - gap, minX, maxX),
        y: clamp(ay, minY, maxY),
      };
    } else {
      best = {
        x: clamp(ax + ux * rad, minX, maxX),
        y: clamp(ay + uy * rad, minY, maxY),
      };
    }
  }

  dealer.style.left = `${((best.x - t.left) / t.width) * 100}%`;
  dealer.style.top = `${((best.y - t.top) / t.height) * 100}%`;

  // Street bets yield to D / pot / board / plates / peers (never move D toward another seat)
  const potBox = potEl?.getBoundingClientRect();
  const boardBox = boardEl?.getBoundingClientRect();
  const plateRects = [...document.querySelectorAll('.seat .plate, .meinfo')].map((el) =>
    el.getBoundingClientRect(),
  );
  const betEls = [...document.querySelectorAll('#bets .bet')];
  for (let pass = 0; pass < 14; pass++) {
    const finalD = dealer.getBoundingClientRect();
    let moved = false;
    for (let i = 0; i < betEls.length; i++) {
      const bet = betEls[i];
      const isHero = bet.dataset.hero === '1';
      const br = bet.getBoundingClientRect();
      let px = (br.left + br.right) / 2;
      let py = (br.top + br.bottom) / 2;
      const pushAway = (ob, pad, opts = {}) => {
        const box = {
          left: px - br.width / 2 - pad,
          top: py - br.height / 2 - pad,
          right: px + br.width / 2 + pad,
          bottom: py + br.height / 2 + pad,
        };
        let d = separationDelta(box, ob, pad) || overlapDelta(box, ob);
        if (!d) return false;
        // Stacked chips share a center — bias by index so both don't nudge the same way
        if (opts.peerDir != null && Math.abs(d.dx) + Math.abs(d.dy) > 0) {
          const ocx = (ob.left + ob.right) / 2;
          const ocy = (ob.top + ob.bottom) / 2;
          if (Math.abs(px - ocx) < 1.5 && Math.abs(py - ocy) < 1.5) {
            d = { dx: opts.peerDir * Math.max(Math.abs(d.dx), pad + 2), dy: d.dy };
          }
        }
        if (opts.heroBoard) {
          // Hero bets sit under the board — only slide down / sideways
          py += Math.max(Math.abs(d.dy), d.dy, 3);
          px += d.dx;
        } else {
          px += d.dx;
          py += d.dy;
        }
        return true;
      };
      let hit = pushAway(finalD, 5);
      if (potBox) hit = pushAway(potBox, 6) || hit;
      if (boardBox) {
        const inflated = {
          left: boardBox.left - 4,
          top: boardBox.top - 4,
          right: boardBox.right + 4,
          bottom: boardBox.bottom + 4,
        };
        hit = pushAway(inflated, 4, { heroBoard: isHero }) || hit;
      }
      for (const pl of plateRects) hit = pushAway(pl, 5) || hit;
      for (let j = 0; j < betEls.length; j++) {
        if (j === i) continue;
        hit =
          pushAway(betEls[j].getBoundingClientRect(), 4, {
            peerDir: i < j ? -1 : 1,
          }) || hit;
      }
      if (!hit) continue;
      moved = true;
      // Re-clear board / plates / peers without a center pull (that collapsed
      // neighboring street bets on short phones).
      if (boardBox) {
        const inflated = {
          left: boardBox.left - 4,
          top: boardBox.top - 4,
          right: boardBox.right + 4,
          bottom: boardBox.bottom + 4,
        };
        pushAway(inflated, 4, { heroBoard: isHero });
      }
      for (const pl of plateRects) pushAway(pl, 5);
      for (let j = 0; j < betEls.length; j++) {
        if (j === i) continue;
        pushAway(betEls[j].getBoundingClientRect(), 5, { peerDir: i < j ? -1 : 1 });
      }
      const left = clamp(px, t.left + br.width / 2 + 2, t.right - br.width / 2 - 2);
      const top = clamp(py, t.top + br.height / 2 + 2, t.bottom - br.height / 2 - 2);
      bet.style.left = `${((left - t.left) / t.width) * 100}%`;
      bet.style.top = `${((top - t.top) / t.height) * 100}%`;
    }
    if (!moved) break;
  }

  // Final peer pass: after D yields, ensure street bets still clear each other
  for (let pass = 0; pass < 8; pass++) {
    let moved = false;
    for (let i = 0; i < betEls.length; i++) {
      const bet = betEls[i];
      const isHero = bet.dataset.hero === '1';
      const br = bet.getBoundingClientRect();
      let px = (br.left + br.right) / 2;
      let py = (br.top + br.bottom) / 2;
      const pushAway = (ob, pad, opts = {}) => {
        const box = {
          left: px - br.width / 2 - pad,
          top: py - br.height / 2 - pad,
          right: px + br.width / 2 + pad,
          bottom: py + br.height / 2 + pad,
        };
        let d = separationDelta(box, ob, pad) || overlapDelta(box, ob);
        if (!d) return false;
        if (opts.peerDir != null) {
          const ocx = (ob.left + ob.right) / 2;
          const ocy = (ob.top + ob.bottom) / 2;
          if (Math.abs(px - ocx) < 1.5 && Math.abs(py - ocy) < 1.5) {
            d = { dx: opts.peerDir * Math.max(Math.abs(d.dx), pad + 2), dy: d.dy };
          }
        }
        if (opts.heroBoard) {
          py += Math.max(Math.abs(d.dy), d.dy, 3);
          px += d.dx;
        } else {
          px += d.dx;
          py += d.dy;
        }
        return true;
      };
      let hit = false;
      for (let j = 0; j < betEls.length; j++) {
        if (j === i) continue;
        hit =
          pushAway(betEls[j].getBoundingClientRect(), 5, {
            peerDir: i < j ? -1 : 1,
          }) || hit;
      }
      if (boardBox) {
        hit =
          pushAway(
            {
              left: boardBox.left - 4,
              top: boardBox.top - 4,
              right: boardBox.right + 4,
              bottom: boardBox.bottom + 4,
            },
            4,
            { heroBoard: isHero },
          ) || hit;
      }
      if (potBox) hit = pushAway(potBox, 6) || hit;
      for (const pl of plateRects) hit = pushAway(pl, 5) || hit;
      const finalD = dealer.getBoundingClientRect();
      hit = pushAway(finalD, 5) || hit;
      if (!hit) continue;
      moved = true;
      const left = clamp(px, t.left + br.width / 2 + 2, t.right - br.width / 2 - 2);
      const top = clamp(py, t.top + br.height / 2 + 2, t.bottom - br.height / 2 - 2);
      bet.style.left = `${((left - t.left) / t.width) * 100}%`;
      bet.style.top = `${((top - t.top) / t.height) * 100}%`;
    }
    if (!moved) break;
  }
}

/** Push `a` away from `b` until edge gap >= minGap (or clear overlap). */
function separationDelta(a, b, minGap) {
  const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  const acx = (a.left + a.right) / 2;
  const acy = (a.top + a.bottom) / 2;
  const bcx = (b.left + b.right) / 2;
  const bcy = (b.top + b.bottom) / 2;
  if (ox > 0 && oy > 0) {
    if (ox < oy) {
      return { dx: (acx >= bcx ? 1 : -1) * (ox + minGap), dy: 0 };
    }
    return { dx: 0, dy: (acy >= bcy ? 1 : -1) * (oy + minGap) };
  }
  if (ox > 0) {
    const gap = Math.max(a.top - b.bottom, b.top - a.bottom);
    if (gap >= minGap) return null;
    return { dx: 0, dy: (acy >= bcy ? 1 : -1) * (minGap - gap) };
  }
  if (oy > 0) {
    const gap = Math.max(a.left - b.right, b.left - a.right);
    if (gap >= minGap) return null;
    return { dx: (acx >= bcx ? 1 : -1) * (minGap - gap), dy: 0 };
  }
  return null;
}

/** @returns {{dx:number,dy:number}|null} */
function overlapDelta(a, b) {
  const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (ox <= 0 || oy <= 0) return null;
  const acx = (a.left + a.right) / 2;
  const acy = (a.top + a.bottom) / 2;
  const bcx = (b.left + b.right) / 2;
  const bcy = (b.top + b.bottom) / 2;
  // Prefer pushing toward table center-ish (down from top seats, inward from sides)
  if (ox < oy) {
    return { dx: (acx >= bcx ? 1 : -1) * (ox + 2), dy: 0 };
  }
  return { dx: 0, dy: (acy >= bcy ? 1 : -1) * (oy + 2) };
}

function roleTag(v, seat) {
  const tags = [];
  if (seat === v.room.hostSeat) tags.push('<span class="tag host">房主</span>');
  // Button / dealer — shown even when HU (dealer is also SB)
  if (state.button === seat) tags.push('<span class="tag dealer-tag">莊家</span>');
  if (state.sbSeat === seat) tags.push('<span class="tag">小盲</span>');
  else if (state.bbSeat === seat) tags.push('<span class="tag">大盲</span>');
  return tags.join('');
}

function renderSide(v) {
  const info = $('#sideInfo');
  if (!info) return;
  const seated = v.seats.filter(Boolean).length;
  const host = v.seats[v.room.hostSeat]?.name || '—';
  info.innerHTML = `<h2>牌局資訊</h2><dl>
    <dt>盲注</dt><dd>${v.config.smallBlind}／${v.config.bigBlind}</dd>
    <dt>起始籌碼</dt><dd>${fmtChips(v.config.startingStack)}</dd>
    <dt>在座</dt><dd>${seated} 人</dd>
    <dt>房主</dt><dd>${esc(host)}</dd></dl>`;

  const log = $('#sideLog');
  const items = v.streetLog
    .map((x) =>
      x.kind === 'street'
        ? `<li class="street">${esc(x.text)}</li>`
        : `<li>${esc(x.text)}</li>`,
    )
    .join('');
  log.innerHTML = `<h2>這一手</h2><ol>${items || '<li class="street">尚未開始</li>'}</ol>`;
}

function renderActions(v) {
  const act = $('#act');
  const legal = v.legal;
  const myTurn =
    !needsPass &&
    legal?.canAct &&
    v.actor === viewerSeat &&
    [PHASE.PREFLOP, PHASE.FLOP, PHASE.TURN, PHASE.RIVER].includes(v.phase);

  const showdownMine =
    !needsPass && v.isShowdown && v.showdown?.myPending;

  if (v.isHandOver) {
    act.classList.remove('is-dim');
    $('#turnTitle').textContent = '這一手結束';
    $('#turnHint').textContent = '查看結果後可開下一手，或結束牌局看戰績。';
    $('#raiseWrap').classList.add('hidden');
    $('#presets').classList.add('hidden');
    $('#showBtns').classList.add('hidden');
    $('#btns').innerHTML = `
      <button type="button" class="call" id="btnNext">下一手</button>
      <button type="button" class="fold" id="btnEnd">結束牌局</button>
      <button type="button" class="raiseb" id="btnSummary">看戰績</button>`;
    $('#btnNext').onclick = () => {
      dispatch({ type: 'ACK_HAND' });
      dispatch({ type: 'NEXT_HAND' });
      viewerSeat = state.actor ?? viewerSeat;
      needsPass = true;
      showPass();
    };
    $('#btnEnd').onclick = () => {
      dispatch({ type: 'END_SESSION' });
      showSummary();
    };
    $('#btnSummary').onclick = () => showSummary();
    return;
  }

  if (showdownMine) {
    act.classList.remove('is-dim');
    $('#turnTitle').textContent = '攤牌';
    $('#turnHint').textContent = '你沒有贏得底池，可選擇亮牌或蓋沒。';
    $('#raiseWrap').classList.add('hidden');
    $('#presets').classList.add('hidden');
    $('#btns').innerHTML = '';
    $('#showBtns').classList.remove('hidden');
    $('#showBtns').innerHTML = `
      <button type="button" id="btnMuck">蓋沒</button>
      <button type="button" id="btnShow1">亮一張</button>
      <button type="button" class="primary" id="btnShowBoth">亮兩張</button>`;
    $('#btnMuck').onclick = () => {
      dispatch({ type: 'MUCK', seat: viewerSeat });
      passToNextIfNeeded();
    };
    $('#btnShowBoth').onclick = () => {
      dispatch({ type: 'SHOW', seat: viewerSeat, mode: 'both' });
      passToNextIfNeeded();
    };
    $('#btnShow1').onclick = () => {
      dispatch({ type: 'SHOW', seat: viewerSeat, mode: 'one0' });
      passToNextIfNeeded();
    };
    return;
  }

  $('#showBtns').classList.add('hidden');

  if (!myTurn) {
    act.classList.add('is-dim');
    $('#showBtns').classList.add('hidden');
    $('#showBtns').innerHTML = '';
    const waiting = v.seats[v.actor];
    $('#turnTitle').textContent = waiting ? `等待 ${waiting.name}` : '請稍候';
    $('#turnHint').textContent = '熱座模式：輪到別人時請交給對方。';
    $('#raiseWrap').classList.add('hidden');
    $('#presets').classList.add('hidden');
    $('#btns').innerHTML = `<button type="button" class="call" id="btnHandOff">換人</button>`;
    $('#btnHandOff').onclick = () => {
      if (state.phase === PHASE.SHOWDOWN && state.showdown?.pending?.length) {
        viewerSeat = state.showdown.pending[0];
      } else if (state.actor != null) {
        viewerSeat = state.actor;
      }
      showPass();
    };
    return;
  }

  act.classList.remove('is-dim');
  $('#turnTitle').textContent = '輪到你了';
  const potTxt = fmtChips(v.potTotal);
  let hint = `底池 ${potTxt}`;
  if (legal.check) hint += ' ・ 可以過牌';
  else if (legal.call) {
    hint += ` ・ 跟注 ${fmtChips(legal.callAmount)}`;
    if (legal.raise || legal.bet) hint += ` ・ 最少加到 ${fmtChips(legal.minRaiseTo)}`;
  }
  $('#turnHint').textContent = hint;

  const canRaise = legal.bet || legal.raise;
  if (canRaise || legal.allIn) {
    $('#raiseWrap').classList.remove('hidden');
    $('#presets').classList.remove('hidden');
    const min = legal.minRaiseTo;
    const max = legal.maxRaiseTo;
    const lo = Math.min(min, max);
    const presets = raisePresets(state, viewerSeat);
    const preferred = presets.find((p) => p.preferred)?.to ?? min;
    if (!raiseTo) raiseTo = preferred;
    raiseTo = clamp(raiseTo, lo, max);
    const range = $('#raiseRange');
    range.min = String(lo);
    range.max = String(max);
    range.step = '1';
    range.value = String(raiseTo);
    range.oninput = () => {
      raiseTo = +range.value;
      syncRaiseUi();
    };
    $('#presets').innerHTML = presets
      .map(
        (p) =>
          `<button type="button" data-to="${p.to}" data-id="${p.id}" aria-pressed="${p.to === raiseTo}">` +
          `<span class="preset-lbl">${p.label}</span>` +
          `<span class="preset-amt">${fmtChips(p.to)}</span></button>`,
      )
      .join('');
    $('#presets').onclick = (e) => {
      const b = e.target.closest('button[data-to]');
      if (!b) return;
      raiseTo = clamp(+b.dataset.to, lo, max);
      range.value = String(raiseTo);
      syncRaiseUi();
    };
    bindRaiseStep($('#raiseMinus'), -1);
    bindRaiseStep($('#raisePlus'), 1);
    syncRaiseUi();
  } else {
    $('#raiseWrap').classList.add('hidden');
    $('#presets').classList.add('hidden');
    clearRaiseHold();
  }

  const foldBtn = legal.fold
    ? `<button class="fold" type="button" id="btnFold">蓋牌<span class="key">F</span></button>`
    : `<button class="fold" type="button" disabled>蓋牌</button>`;
  let mid;
  if (legal.check) {
    mid = `<button class="call" type="button" id="btnCheck">過牌<span class="key">C</span></button>`;
  } else if (legal.call) {
    mid = `<button class="call" type="button" id="btnCall">跟注<small>${fmtChips(legal.callAmount)}</small></button>`;
  } else {
    mid = `<button class="call" type="button" disabled>—</button>`;
  }
  let raiseBtn;
  // 本街尚無人下注 →「下注 X」；已有人下注／加注 →「加注到 X」
  if (legal.bet) {
    raiseBtn = `<button class="raiseb" type="button" id="btnRaise">下注 ${fmtChips(raiseTo)}<span class="key">R</span></button>`;
  } else if (legal.raise) {
    raiseBtn = `<button class="raiseb" type="button" id="btnRaise">加注到 ${fmtChips(raiseTo)}<span class="key">R</span></button>`;
  } else if (legal.allIn && !legal.call) {
    raiseBtn = `<button class="raiseb" type="button" id="btnAllIn">全下<span class="key">R</span></button>`;
  } else if (legal.allIn && legal.call && legal.callAmount === state.seats[viewerSeat].chips) {
    raiseBtn = `<button class="raiseb" type="button" id="btnAllIn">全下</button>`;
  } else {
    raiseBtn = `<button class="raiseb" type="button" id="btnRaise" disabled>加注</button>`;
  }
  $('#btns').innerHTML = foldBtn + mid + raiseBtn;

  $('#btnFold')?.addEventListener('click', () => {
    dispatch({ type: 'FOLD', seat: viewerSeat });
    passToNextIfNeeded();
  });
  $('#btnCheck')?.addEventListener('click', () => {
    dispatch({ type: 'CHECK', seat: viewerSeat });
    passToNextIfNeeded();
  });
  $('#btnCall')?.addEventListener('click', () => {
    dispatch({ type: 'CALL', seat: viewerSeat });
    passToNextIfNeeded();
  });
  $('#btnRaise')?.addEventListener('click', () => {
    dispatch({ type: 'BET_RAISE', seat: viewerSeat, amount: raiseTo });
    passToNextIfNeeded();
  });
  $('#btnAllIn')?.addEventListener('click', () => {
    dispatch({ type: 'ALL_IN', seat: viewerSeat });
    passToNextIfNeeded();
  });
}

function syncRaiseBtn() {
  const b = $('#btnRaise');
  if (!b) return;
  const legal = getLegalActions(state, viewerSeat);
  if (legal.bet) b.innerHTML = `下注 ${fmtChips(raiseTo)}<span class="key">R</span>`;
  else if (legal.raise) b.innerHTML = `加注到 ${fmtChips(raiseTo)}<span class="key">R</span>`;
}

function syncPresetPressed() {
  for (const b of $$('#presets button')) {
    b.setAttribute('aria-pressed', String(+b.dataset.to === raiseTo));
  }
}

function passToNextIfNeeded() {
  raiseTo = 0;
  if (state.phase === PHASE.HAND_OVER) {
    render();
    return;
  }
  if (state.phase === PHASE.SHOWDOWN && state.showdown?.pending?.length) {
    const next = state.showdown.pending[0];
    if (next !== viewerSeat) {
      viewerSeat = next;
      showPass();
      return;
    }
  }
  if (
    state.actor != null &&
    state.actor !== viewerSeat &&
    [PHASE.PREFLOP, PHASE.FLOP, PHASE.TURN, PHASE.RIVER].includes(state.phase)
  ) {
    viewerSeat = state.actor;
    showPass();
    return;
  }
  render();
}

function renderHandOver() {
  /* handled in actions */
}

function showSummary() {
  const rows = sessionSummary(state);
  const scr = $('#summaryScreen');
  scr.classList.add('is-on');
  const body = rows
    .map((r) => {
      const cls = r.net > 0 ? 'pos' : r.net < 0 ? 'neg' : '';
      const net = (r.net >= 0 ? '+' : '') + fmtChips(r.net);
      return `<tr><td>${esc(r.name)}</td><td>${fmtChips(r.buyInTotal)}</td><td>${fmtChips(r.chips)}</td><td class="${cls}">${net}</td></tr>`;
    })
    .join('');
  $('#summaryBody').innerHTML = `
    <div class="summary">
      <table>
        <thead><tr><th>玩家</th><th>買入</th><th>籌碼</th><th>淨勝</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

$('#btnSummaryClose').onclick = () => {
  $('#summaryScreen').classList.remove('is-on');
  if (state.phase === PHASE.SESSION_OVER) {
    state = createInitialState({
      roomName: state.room.name,
      bigBlind: state.config.bigBlind,
      startingStack: state.config.startingStack,
      timerEnabled: state.config.timerEnabled,
    });
    openLobby();
  }
};

$('#btnLobby').onclick = () => {
  if (
    state.phase !== PHASE.LOBBY &&
    state.phase !== PHASE.HAND_OVER &&
    state.phase !== PHASE.SESSION_OVER
  ) {
    if (!confirm('確定要離開目前這手牌、回到大廳？')) return;
    state = createInitialState({
      roomName: state.room.name,
      bigBlind: state.config.bigBlind,
      startingStack: state.config.startingStack,
      timerEnabled: false,
    });
  }
  openLobby();
};

/* ─── Timer tick ─── */
onTick(() => {
  if (needsPass) return;
  if (!state.config.timerEnabled || state.deadline == null || state.actor !== viewerSeat) {
    updateTimerDisplay(null);
    return;
  }
  const left = Math.max(0, state.deadline - Date.now());
  updateTimerDisplay(left);
  if (left <= 0) {
    const seat = state.actor;
    dispatch({ type: 'TIMEOUT', seat });
    passToNextIfNeeded();
  }
});

function updateTimerDisplay(leftMs) {
  const el = $('#timerSec');
  const fg = $('#timerFg');
  if (leftMs == null) {
    el.textContent = '—';
    fg.style.strokeDashoffset = '0';
    return;
  }
  const sec = Math.ceil(leftMs / 1000);
  el.textContent = String(sec);
  const total = state.config.actionTimeoutMs;
  const circ = 125.66;
  fg.style.strokeDashoffset = String(circ * (1 - leftMs / total));
}

/* ─── Keyboard (desktop) ─── */
window.addEventListener('keydown', (e) => {
  if (needsPass) return;
  if (e.target.matches('input,textarea,select')) return;
  const k = e.key.toLowerCase();
  if (k === 'f') $('#btnFold')?.click();
  if (k === 'r') $('#btnRaise')?.click() || $('#btnAllIn')?.click();
  if (k === 'c') $('#btnCheck')?.click() || $('#btnCall')?.click();
});

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), 2400);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Expose for headless e2e / layout tests
window.__poker = {
  getState: () => state,
  getViewer: () => viewerSeat,
  /** Pin the hot-seat viewer (skips pass gate) and re-render. */
  setViewer(seat) {
    viewerSeat = seat;
    needsPass = false;
    $('#passScreen')?.classList.remove('is-on');
    render();
  },
  dispatch,
  view,
  applyAction,
  createInitialState,
};

boot();
