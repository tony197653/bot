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

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

function dispatch(action, env = {}) {
  try {
    state = applyAction(state, action, { now: Date.now(), ...env });
    afterState();
  } catch (e) {
    toast(e.message || String(e));
  }
}

function afterState() {
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
  set(55, '載入介面');
  await new Promise((r) => requestAnimationFrame(() => r()));
  // Warm layout
  $('#app').classList.remove('hidden');
  set(85, '準備牌桌');
  await new Promise((r) => setTimeout(r, 180));
  set(100, '完成');
  await new Promise((r) => setTimeout(r, 220));
  $('#boot').classList.add('is-done');
  setTimeout(() => $('#boot').classList.add('hidden'), 480);
  openLobby();
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
}

$('#btnPassOk').onclick = () => hidePass();

/* ─── Render ─── */
function render() {
  if (needsPass) {
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

  // Clockwise table order with hero rotated to bottom (matches engine seat order)
  const occupied = [];
  for (let seat = 0; seat < 6; seat++) {
    if (v.seats[seat]) occupied.push(seat);
  }
  const { seatToPos } = mapSeatsClockwise(occupied, viewerSeat);
  const opponents = occupied.filter((s) => s !== viewerSeat);

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
    const el = document.createElement('div');
    el.className = `seat pos-${pos}${folded}${actor}`;
    el.dataset.seat = String(seat);
    // Street bet amount lives on the chip marker — omit state line while bet>0
    // so the plate is shorter and never fights the chip for the same “10”.
    const stateText =
      p.bet > 0
        ? ''
        : p.lastAction || (p.sittingOut ? '坐出' : '　');
    el.innerHTML = `
      <div class="av"><span>${esc(p.name.slice(0, 1))}</span>${backs}</div>
      <div class="plate">
        <b class="nm">${esc(p.name)}${role}</b>
        <span class="ch">${fmtChips(p.chips)}</span>
        ${stateText ? `<span class="state">${esc(stateText)}</span>` : ''}
      </div>${holeShow}`;
    seatsRoot.appendChild(el);

    if (p.bet > 0) {
      const b = document.createElement('div');
      b.className = 'bet is-in';
      b.dataset.forSeat = String(seat);
      b.dataset.pos = String(pos);
      b.innerHTML = `<span class="chips"><i class="a"></i><i class="b"></i><i class="c"></i></span><span class="amt">${fmtChips(p.bet)}</span>`;
      betsRoot.appendChild(b);
    }
  }

  // Dealer button
  const dealer = $('#dealer');
  const btnPos = seatToPos.get(v.button);
  if (btnPos === 'hero' || v.button === viewerSeat) {
    dealer.style.setProperty('--x', '58%');
    dealer.style.setProperty('--y', '86%');
  } else {
    const map = {
      0: [50, 18],
      1: [80, 34],
      2: [78, 74],
      3: [22, 74],
      4: [20, 34],
    };
    const [x, y] = map[btnPos] || [50, 50];
    dealer.style.setProperty('--x', x + '%');
    dealer.style.setProperty('--y', y + '%');
  }

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
  $('#heroName').textContent = hero ? `${hero.name}（你）` : '';
  $('#heroChips').textContent = hero ? fmtChips(hero.chips) : '';

  // Hero street bet
  if (hero?.bet > 0) {
    const b = document.createElement('div');
    b.className = 'bet is-in';
    b.dataset.forSeat = String(viewerSeat);
    b.dataset.hero = '1';
    b.innerHTML = `<span class="chips"><i class="a"></i><i class="b"></i><i class="c"></i></span><span class="amt">${fmtChips(hero.bet)}</span>`;
    betsRoot.appendChild(b);
  }

  // Place bets after layout so they clear name plates / board / each other
  requestAnimationFrame(() => layoutBets());
}

/** Safe chip-rail anchors (% of .table) — inward from seats, clear of board band. */
const BET_ANCHOR_PHONE = {
  0: [50, 24],
  1: [70, 40],
  2: [70, 60],
  3: [30, 60],
  4: [30, 40],
  hero: [50, 70],
};
const BET_ANCHOR_DESKTOP = {
  0: [50, 22],
  1: [68, 34],
  2: [70, 64],
  3: [30, 64],
  4: [32, 34],
  hero: [50, 72],
};

/**
 * Position each .bet on a safe rail toward the pot, then nudge away from
 * plates / board / other bets if anything still collides.
 */
function layoutBets() {
  const table = document.querySelector('.table');
  const board = $('#board');
  if (!table) return;
  const t = table.getBoundingClientRect();
  if (t.width < 8 || t.height < 8) return;
  const desktop = window.matchMedia('(min-width: 1024px)').matches;
  const anchors = desktop ? BET_ANCHOR_DESKTOP : BET_ANCHOR_PHONE;
  const boardBox = board?.getBoundingClientRect();
  const plates = [...document.querySelectorAll('.seat .plate, .meinfo')].map((el) =>
    el.getBoundingClientRect(),
  );
  const bets = [...document.querySelectorAll('#bets .bet')];

  /** @type {{el:HTMLElement, x:number, y:number, w:number, h:number}[]} */
  const placed = [];

  for (const bet of bets) {
    const key = bet.dataset.hero === '1' ? 'hero' : bet.dataset.pos;
    const [px, py] = anchors[key] || anchors.hero;
    bet.style.left = `${px}%`;
    bet.style.top = `${py}%`;
    const br = bet.getBoundingClientRect();
    placed.push({ el: bet, x: br.left, y: br.top, w: br.width, h: br.height });
  }

  const pad = 6;
  for (let pass = 0; pass < 10; pass++) {
    for (const p of placed) {
      const box = () => ({
        left: p.x - pad,
        top: p.y - pad,
        right: p.x + p.w + pad,
        bottom: p.y + p.h + pad,
      });
      for (const pl of plates) {
        const d = overlapDelta(box(), pl);
        if (d) {
          p.x += d.dx;
          p.y += d.dy;
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
          p.x += d.dx;
          p.y += d.dy;
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
      // refresh size in case wrapping changed (shouldn't)
      const br = p.el.getBoundingClientRect();
      p.x = br.left;
      p.y = br.top;
      p.w = br.width;
      p.h = br.height;
    }
  }
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
  let hint = '';
  if (legal.check) hint = '可以過牌或下注';
  else if (legal.call)
    hint = `跟注 ${legal.callAmount} 或加注，最少加到 ${legal.minRaiseTo}`;
  $('#turnHint').textContent = hint;

  const canRaise = legal.bet || legal.raise;
  if (canRaise || legal.allIn) {
    $('#raiseWrap').classList.remove('hidden');
    $('#presets').classList.remove('hidden');
    const min = legal.minRaiseTo;
    const max = legal.maxRaiseTo;
    raiseTo = clamp(raiseTo || min, min, max);
    const range = $('#raiseRange');
    range.min = String(min);
    range.max = String(max);
    range.value = String(raiseTo);
    $('#raiseOut').textContent = fmtChips(raiseTo);
    range.oninput = () => {
      raiseTo = +range.value;
      $('#raiseOut').textContent = fmtChips(raiseTo);
      syncPresetPressed();
      syncRaiseBtn();
    };
    const presets = raisePresets(state, viewerSeat);
    $('#presets').innerHTML = presets
      .map(
        (p) =>
          `<button type="button" data-to="${p.to}" data-id="${p.id}">${p.label}</button>`,
      )
      .join('');
    $('#presets').onclick = (e) => {
      const b = e.target.closest('button[data-to]');
      if (!b) return;
      raiseTo = clamp(+b.dataset.to, min, max);
      range.value = String(raiseTo);
      $('#raiseOut').textContent = fmtChips(raiseTo);
      syncPresetPressed();
      syncRaiseBtn();
    };
    syncPresetPressed();
  } else {
    $('#raiseWrap').classList.add('hidden');
    $('#presets').classList.add('hidden');
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
  else b.innerHTML = `加注到 ${fmtChips(raiseTo)}<span class="key">R</span>`;
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

// Expose for headless e2e
window.__poker = {
  getState: () => state,
  getViewer: () => viewerSeat,
  dispatch,
  view,
  applyAction,
  createInitialState,
};

boot();
