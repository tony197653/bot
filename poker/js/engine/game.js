/**
 * Pure Texas Hold'em state machine.
 * applyAction(state, action) → newState | throws
 * All state is JSON-serializable.
 */

import { makeDeck, cloneJson, cloneCards, cardKey } from './cards.js';
import { shuffle } from './shuffle.js';
import { evaluateHand, compareRanks, categoryZh } from './hand.js';
import { computePots, splitPot } from './pots.js';

export const PHASE = {
  LOBBY: 'lobby',
  PREFLOP: 'preflop',
  FLOP: 'flop',
  TURN: 'turn',
  RIVER: 'river',
  SHOWDOWN: 'showdown',
  HAND_OVER: 'hand_over',
  SESSION_OVER: 'session_over',
};

export const STREET_ZH = {
  preflop: '翻牌前',
  flop: '翻牌',
  turn: '轉牌',
  river: '河牌',
  showdown: '攤牌',
};

const DEFAULT_ACTION_MS = 30000;

/**
 * @param {object} [opts]
 */
export function createInitialState(opts = {}) {
  const bigBlind = opts.bigBlind ?? 20;
  const smallBlind = opts.smallBlind ?? Math.floor(bigBlind / 2);
  let startingStack = opts.startingStack ?? 2000;
  const minStack = 100 * bigBlind;
  if (startingStack < minStack) startingStack = minStack;

  return {
    version: 1,
    config: {
      smallBlind,
      bigBlind,
      startingStack,
      actionTimeoutMs: opts.actionTimeoutMs ?? DEFAULT_ACTION_MS,
      maxSeats: 6,
      timerEnabled: opts.timerEnabled !== false,
    },
    room: {
      name: opts.roomName ?? '週五牌局',
      code: opts.roomCode ?? randomRoomCode(),
      hostSeat: 0,
    },
    seats: /** @type {(Player|null)[]} */ (Array(6).fill(null)),
    handNumber: 0,
    button: 0,
    phase: PHASE.LOBBY,
    deck: [],
    board: [],
    // street betting
    currentBet: 0,
    minRaiseTo: 0,
    lastFullRaiseSize: bigBlind,
    actor: null,
    sbSeat: null,
    bbSeat: null,
    actedBit: 0, // bitmask of seats that have acted since last full raise reopen
    deadline: null,
    pots: [],
    log: [],
    streetLog: [],
    winners: null,
    /** @type {Record<number, number>|null} per-seat chips won this hand */
    winnerPayouts: null,
    showdown: null,
    lastHandSummary: null,
    rngSeedUsed: null,
  };
}

/**
 * @typedef {object} Player
 * @property {number} seat
 * @property {string} id
 * @property {string} name
 * @property {number} chips
 * @property {number} buyInTotal
 * @property {boolean} sittingOut
 * @property {{r:number,s:number}[]|null} hole
 * @property {number} bet
 * @property {number} contributed
 * @property {boolean} folded
 * @property {boolean} allIn
 * @property {string|null} lastAction
 * @property {'muck'|'both'|'auto'|null} showChoice
 * @property {boolean} hasHole
 */

/**
 * @param {object} state
 * @param {object} action
 * @param {object} [env] { now?: number, randUnit?: () => number }
 */
export function applyAction(state, action, env = {}) {
  const s = cloneJson(state);
  const now = env.now ?? Date.now();
  const type = action.type;

  switch (type) {
    case 'CONFIG':
      return doConfig(s, action);
    case 'SEAT':
      return doSeat(s, action);
    case 'UNSEAT':
      return doUnseat(s, action);
    case 'SET_TIMER':
      s.config.timerEnabled = !!action.enabled;
      return s;
    case 'START_HAND':
      return startHand(s, env);
    case 'FOLD':
      return doPlayerAction(s, action.seat, 'fold', 0, now, env);
    case 'CHECK':
      return doPlayerAction(s, action.seat, 'check', 0, now, env);
    case 'CALL':
      return doPlayerAction(s, action.seat, 'call', 0, now, env);
    case 'BET_RAISE':
      return doPlayerAction(s, action.seat, 'raise', action.amount, now, env);
    case 'ALL_IN':
      return doPlayerAction(s, action.seat, 'allin', 0, now, env);
    case 'TIMEOUT':
      return doTimeout(s, action.seat, now, env);
    case 'SHOW':
      return doShow(s, action);
    case 'MUCK':
      return doMuck(s, action);
    case 'REVEAL_TIMEOUT':
      return doRevealTimeout(s, action);
    case 'ACK_HAND':
      return doAckHand(s);
    case 'END_SESSION':
      s.phase = PHASE.SESSION_OVER;
      return s;
    case 'NEXT_HAND':
      return startHand(s, env);
    default:
      throw err('未知動作: ' + type);
  }
}

function doConfig(s, action) {
  assertLobbyOrOver(s);
  if (action.bigBlind != null) {
    const bb = assertPosInt(action.bigBlind, '大盲');
    s.config.bigBlind = bb;
    s.config.smallBlind = action.smallBlind != null
      ? assertPosInt(action.smallBlind, '小盲')
      : Math.max(1, Math.floor(bb / 2));
    // When BB changes, starting stack auto-becomes at least 100×BB
    const min = 100 * bb;
    if (s.config.startingStack < min) s.config.startingStack = min;
  } else if (action.smallBlind != null) {
    s.config.smallBlind = assertPosInt(action.smallBlind, '小盲');
  }
  if (action.startingStack != null) {
    const stack = assertPosInt(action.startingStack, '起始籌碼');
    const min = 100 * s.config.bigBlind;
    if (stack < min) throw err(`起始籌碼必須 ≥ 100 倍大盲（${min}）`);
    s.config.startingStack = stack;
  }
  if (action.roomName != null) s.room.name = String(action.roomName).slice(0, 40);
  if (action.actionTimeoutMs != null) {
    s.config.actionTimeoutMs = assertPosInt(action.actionTimeoutMs, '思考時間');
  }
  if (action.timerEnabled != null) s.config.timerEnabled = !!action.timerEnabled;
  return s;
}

function doSeat(s, action) {
  if (s.phase !== PHASE.LOBBY && s.phase !== PHASE.HAND_OVER && s.phase !== PHASE.SESSION_OVER) {
    // Allow seating only between hands / lobby
    if (s.phase !== PHASE.LOBBY && s.phase !== PHASE.HAND_OVER) {
      throw err('牌局進行中無法入座');
    }
  }
  if (s.phase === PHASE.SESSION_OVER) s.phase = PHASE.LOBBY;
  const seat = action.seat;
  if (!Number.isInteger(seat) || seat < 0 || seat >= s.config.maxSeats) throw err('座位無效');
  if (s.seats[seat]) throw err('座位已被佔用');
  const name = String(action.name || '').trim() || `玩家${seat + 1}`;
  const buyIn = action.buyIn != null ? assertPosInt(action.buyIn, '買入') : s.config.startingStack;
  const min = 100 * s.config.bigBlind;
  if (buyIn < min) throw err(`買入必須 ≥ 100 倍大盲（${min}）`);
  s.seats[seat] = {
    seat,
    id: action.id || `p${seat}-${Date.now()}`,
    name: name.slice(0, 12),
    chips: buyIn,
    buyInTotal: buyIn,
    sittingOut: false,
    hole: null,
    bet: 0,
    contributed: 0,
    folded: false,
    allIn: false,
    lastAction: null,
    showChoice: null,
    hasHole: false,
  };
  if (action.isHost) s.room.hostSeat = seat;
  return s;
}

function doUnseat(s, action) {
  if (s.phase !== PHASE.LOBBY && s.phase !== PHASE.HAND_OVER) throw err('牌局進行中無法離座');
  const seat = action.seat;
  if (!s.seats[seat]) throw err('座位是空的');
  s.seats[seat] = null;
  return s;
}

function startHand(s, env) {
  if (s.phase !== PHASE.LOBBY && s.phase !== PHASE.HAND_OVER) {
    throw err('現在無法開新的一手');
  }
  const active = seatedPlayers(s).filter((p) => p.chips > 0);
  if (active.length < 2) throw err('至少需要兩位有籌碼的玩家');

  // Mark broke players sitting out
  for (const p of seatedPlayers(s)) {
    p.sittingOut = p.chips <= 0;
    p.hole = null;
    p.bet = 0;
    p.contributed = 0;
    p.folded = false;
    p.allIn = false;
    p.lastAction = null;
    p.showChoice = null;
    p.hasHole = false;
  }

  s.handNumber += 1;
  s.board = [];
  s.pots = [];
  s.winners = null;
  s.winnerPayouts = null;
  s.showdown = null;
  s.lastHandSummary = null;
  s.log = [];
  s.streetLog = [];
  s.actedBit = 0;

  // Advance button among players with chips
  if (s.handNumber === 1) {
    s.button = active[0].seat;
  } else {
    s.button = nextOccupiedSeat(s, s.button, (p) => p.chips > 0);
  }

  const deck = shuffle(makeDeck(), env.randUnit);
  s.deck = deck;

  // Deal hole cards: 2 each, starting left of button
  let dealFrom = nextOccupiedSeat(s, s.button, (p) => p.chips > 0);
  for (let round = 0; round < 2; round++) {
    let seat = dealFrom;
    for (let i = 0; i < active.length; i++) {
      const p = s.seats[seat];
      if (!p.hole) p.hole = [];
      p.hole.push(s.deck.pop());
      p.hasHole = true;
      seat = nextOccupiedSeat(s, seat, (x) => x.chips > 0);
    }
  }

  // Blinds
  const isHeadsUp = active.length === 2;
  let sbSeat;
  let bbSeat;
  if (isHeadsUp) {
    sbSeat = s.button;
    bbSeat = nextOccupiedSeat(s, s.button, (p) => p.chips > 0);
  } else {
    sbSeat = nextOccupiedSeat(s, s.button, (p) => p.chips > 0);
    bbSeat = nextOccupiedSeat(s, sbSeat, (p) => p.chips > 0);
  }

  postBlind(s, sbSeat, s.config.smallBlind, '小盲');
  postBlind(s, bbSeat, s.config.bigBlind, '大盲');
  s.sbSeat = sbSeat;
  s.bbSeat = bbSeat;

  s.currentBet = Math.max(
    ...active.map((p) => s.seats[p.seat].bet),
  );
  s.lastFullRaiseSize = s.config.bigBlind;
  s.minRaiseTo = s.currentBet + s.lastFullRaiseSize;
  s.phase = PHASE.PREFLOP;
  pushLog(s, 'street', STREET_ZH.preflop);

  // First to act preflop
  if (isHeadsUp) {
    s.actor = sbSeat; // button/SB
  } else {
    s.actor = nextOccupiedSeat(s, bbSeat, (p) => p.chips > 0 && !p.folded && !p.allIn);
  }
  // If first actor somehow all-in from blind, advance
  s.actor = findNextActor(s, prevSeat(s, s.actor)) ?? null;

  // Reset acted: blinds have "acted" only in the sense they posted; they can still act
  s.actedBit = 0;
  armDeadline(s, env.now ?? Date.now());
  rebuildPots(s);
  return s;
}

function postBlind(s, seat, amount, label) {
  const p = s.seats[seat];
  const pay = Math.min(amount, p.chips);
  p.chips -= pay;
  p.bet += pay;
  p.contributed += pay;
  if (p.chips === 0) {
    p.allIn = true;
    p.lastAction = `全下 ${pay}`;
  } else {
    p.lastAction = `${label} ${pay}`;
  }
  pushLog(s, 'action', `${p.name} ${p.lastAction}`);
}

function doPlayerAction(s, seat, kind, amount, now, env) {
  assertInHand(s);
  if (s.actor !== seat) throw err('還沒輪到這位玩家');
  const p = s.seats[seat];
  if (!p || p.folded || p.allIn || p.sittingOut) throw err('無法行動');
  if (s.config.timerEnabled && s.deadline != null && now > s.deadline + 50) {
    // Soft: still allow if slightly late from UI; hard timeout via TIMEOUT action
  }

  const toCall = s.currentBet - p.bet;
  const legal = getLegalActions(s, seat);

  if (kind === 'fold') {
    if (!legal.fold) throw err('現在不能蓋牌');
    p.folded = true;
    p.lastAction = '蓋牌';
    pushLog(s, 'action', `${p.name} 蓋牌`);
    markActed(s, seat);
    return afterAction(s, env);
  }

  if (kind === 'check') {
    if (!legal.check) throw err('現在不能過牌');
    p.lastAction = '過牌';
    pushLog(s, 'action', `${p.name} 過牌`);
    markActed(s, seat);
    return afterAction(s, env);
  }

  if (kind === 'call') {
    if (!legal.call) throw err('現在不能跟注');
    const pay = Math.min(toCall, p.chips);
    p.chips -= pay;
    p.bet += pay;
    p.contributed += pay;
    if (p.chips === 0) {
      p.allIn = true;
      p.lastAction = `全下 ${p.bet}`;
    } else {
      p.lastAction = `跟注 ${pay}`;
    }
    pushLog(s, 'action', `${p.name} ${p.lastAction}`);
    markActed(s, seat);
    return afterAction(s, env);
  }

  if (kind === 'allin') {
    const raiseTo = p.bet + p.chips;
    return applyRaiseTo(s, seat, raiseTo, env, true);
  }

  if (kind === 'raise') {
    if (!legal.bet && !legal.raise && !legal.allIn) throw err('現在不能下注／加注');
    const raiseTo = assertPosInt(amount, '金額');
    return applyRaiseTo(s, seat, raiseTo, env, false);
  }

  throw err('未知行動');
}

function applyRaiseTo(s, seat, raiseTo, env, isAllInBtn) {
  const p = s.seats[seat];
  const legal = getLegalActions(s, seat);
  const maxTo = p.bet + p.chips;

  if (raiseTo > maxTo) throw err('超過籌碼');
  if (raiseTo < p.bet) throw err('金額無效');

  const isAllIn = raiseTo === maxTo;
  const prevBet = s.currentBet;
  const raiseSize = raiseTo - prevBet;

  // If just calling all-in
  if (raiseTo <= s.currentBet) {
    const pay = raiseTo - p.bet;
    p.chips -= pay;
    p.bet += pay;
    p.contributed += pay;
    p.allIn = p.chips === 0;
    p.lastAction = p.allIn ? `全下 ${p.bet}` : `跟注 ${pay}`;
    pushLog(s, 'action', `${p.name} ${p.lastAction}`);
    markActed(s, seat);
    return afterAction(s, env);
  }

  // Opening bet (currentBet == 0) or raise
  const opening = s.currentBet === 0;
  const minTo = opening ? s.config.bigBlind : s.minRaiseTo;
  const isFullRaise = raiseTo >= minTo || (isAllIn && raiseTo >= minTo);

  if (!isAllIn && raiseTo < minTo) {
    throw err(opening ? `最少下注 ${minTo}` : `最少加注到 ${minTo}`);
  }

  // Short all-in below min raise is allowed but does not reopen
  const fullRaise = raiseTo >= minTo && raiseSize >= (opening ? s.config.bigBlind : s.lastFullRaiseSize);
  // More precise: a full raise is one that increases by at least lastFullRaiseSize
  // (or BB when opening). Short all-in: raiseTo > currentBet but raiseSize < lastFullRaiseSize.

  let reopens = false;
  if (opening) {
    reopens = raiseTo >= s.config.bigBlind; // any legal open reopens (all have not acted)
    if (isAllIn && raiseTo < s.config.bigBlind) {
      // all-in for less than BB — rare (short stack); still sets currentBet
      reopens = true; // others still need to act
    }
  } else {
    reopens = raiseSize >= s.lastFullRaiseSize;
  }

  const pay = raiseTo - p.bet;
  p.chips -= pay;
  p.bet += pay;
  p.contributed += pay;
  if (p.chips === 0) p.allIn = true;

  if (isAllInBtn || p.allIn) p.lastAction = `全下 ${raiseTo}`;
  else if (opening) p.lastAction = `下注 ${raiseTo}`;
  else p.lastAction = `加注到 ${raiseTo}`;

  pushLog(s, 'action', `${p.name} ${p.lastAction}`);

  if (reopens) {
    s.lastFullRaiseSize = raiseTo - prevBet;
    if (s.lastFullRaiseSize < 1) s.lastFullRaiseSize = s.config.bigBlind;
    s.currentBet = raiseTo;
    s.minRaiseTo = s.currentBet + s.lastFullRaiseSize;
    s.actedBit = 0;
    markActed(s, seat);
  } else {
    // Short all-in: raises currentBet but does not reopen for those who already acted
    s.currentBet = raiseTo;
    // minRaiseTo stays based on last full raise from previous level
    // Actually: min raise is still lastFullRaiseSize above the NEW current bet? 
    // Standard rule: incomplete raise does not change the min raise size required.
    // minRaiseTo = prevBet + lastFullRaiseSize... but currentBet moved up.
    // Remaining players who haven't acted must at least call the new currentBet;
    // players who already acted do not get option to re-raise.
    s.minRaiseTo = prevBet + s.lastFullRaiseSize; // still the full raise target from before
    if (s.minRaiseTo <= s.currentBet) {
      s.minRaiseTo = s.currentBet + s.lastFullRaiseSize;
    }
    markActed(s, seat);
    // Do NOT clear actedBit — those who acted stay "done" unless they face a full raise
  }

  return afterAction(s, env);
}

function doTimeout(s, seat, now, env) {
  assertInHand(s);
  if (s.actor !== seat) throw err('還沒輪到這位玩家');
  const legal = getLegalActions(s, seat);
  if (legal.check) {
    return doPlayerAction(s, seat, 'check', 0, now, env);
  }
  return doPlayerAction(s, seat, 'fold', 0, now, env);
}

function afterAction(s, env) {
  rebuildPots(s);

  // Only one player left (others folded)
  const contenders = livePlayers(s).filter((p) => !p.folded);
  if (contenders.length === 1) {
    return awardUncontested(s, contenders[0].seat);
  }

  // Betting round complete?
  if (!bettingRoundDone(s)) {
    s.actor = findNextActor(s, s.actor);
    armDeadline(s, env.now ?? Date.now());
    return s;
  }

  // Advance street or showdown
  return advanceStreet(s, env);
}

function bettingRoundDone(s) {
  const live = livePlayers(s).filter((p) => !p.folded);
  const canAct = live.filter((p) => !p.allIn);
  if (canAct.length === 0) return true; // all-in runout
  if (canAct.length === 1) {
    // One player can still act: done only if they've matched currentBet (or everyone else all-in and they matched)
    const p = canAct[0];
    if (p.bet >= s.currentBet && bitHas(s.actedBit, p.seat)) return true;
    // If they haven't matched and somehow... they should still act
    if (p.bet < s.currentBet) return false;
    // Matched but not yet "acted" this reopen cycle — e.g. BB option
    if (!bitHas(s.actedBit, p.seat)) return false;
    return true;
  }
  for (const p of canAct) {
    if (p.bet < s.currentBet) return false;
    if (!bitHas(s.actedBit, p.seat)) return false;
  }
  return true;
}

function advanceStreet(s, env) {
  // Collect bets into pot already tracked via contributed; reset street bets
  for (const p of seatedPlayers(s)) {
    p.bet = 0;
    if (!p.folded) p.lastAction = p.allIn ? '全下' : p.lastAction;
  }
  s.currentBet = 0;
  s.actedBit = 0;
  s.lastFullRaiseSize = s.config.bigBlind;
  s.minRaiseTo = s.config.bigBlind;
  s.actor = null;
  s.deadline = null;
  rebuildPots(s);

  const contenders = livePlayers(s).filter((p) => !p.folded);
  const canBet = contenders.filter((p) => !p.allIn);

  if (s.phase === PHASE.PREFLOP) {
    // Burn + flop 3
    s.deck.pop();
    s.board.push(s.deck.pop(), s.deck.pop(), s.deck.pop());
    s.phase = PHASE.FLOP;
    pushLog(s, 'street', `${STREET_ZH.flop}　${boardLabel(s.board)}`);
  } else if (s.phase === PHASE.FLOP) {
    s.deck.pop();
    s.board.push(s.deck.pop());
    s.phase = PHASE.TURN;
    pushLog(s, 'street', `${STREET_ZH.turn}　${boardLabel(s.board)}`);
  } else if (s.phase === PHASE.TURN) {
    s.deck.pop();
    s.board.push(s.deck.pop());
    s.phase = PHASE.RIVER;
    pushLog(s, 'street', `${STREET_ZH.river}　${boardLabel(s.board)}`);
  } else if (s.phase === PHASE.RIVER) {
    return goShowdown(s);
  }

  // If ≤1 player can still bet, run out remaining board then showdown
  if (canBet.length <= 1) {
    return runoutAndShowdown(s, env);
  }

  // First actor postflop: left of button
  s.actor = findNextActor(s, s.button);
  if (s.actor == null) return runoutAndShowdown(s, env);
  armDeadline(s, env.now ?? Date.now());
  return s;
}

function runoutAndShowdown(s, env) {
  while (s.board.length < 5) {
    s.deck.pop(); // burn
    s.board.push(s.deck.pop());
  }
  if (s.phase === PHASE.PREFLOP || s.phase === PHASE.FLOP) {
    // log remaining
  }
  s.phase = PHASE.RIVER;
  pushLog(s, 'street', `公共牌　${boardLabel(s.board)}`);
  return goShowdown(s);
}

function awardUncontested(s, seat) {
  rebuildPots(s);
  const total = s.pots.reduce((a, p) => a + p.amount, 0);
  const p = s.seats[seat];
  p.chips += total;
  p.lastAction = `贏得 ${total}`;
  pushLog(s, 'result', `${p.name} 贏得 ${total}（其他人蓋牌）`);
  s.winners = [{ seats: [seat], amount: total, hand: null }];
  s.winnerPayouts = { [seat]: total };
  s.pots = [];
  // Street bets are already in contributed/pots — clear markers so UI chips leave the felt
  for (const sp of seatedPlayers(s)) sp.bet = 0;
  s.currentBet = 0;
  s.actor = null;
  s.deadline = null;
  // Fold-win: every player who had hole cards (incl. winner) may 亮牌／不亮
  return beginRevealPhase(s, { autoRevealSeats: new Set(), foldWin: true });
}

/**
 * Center-table note when everyone else folded (Traditional Chinese).
 * @param {object} s
 * @returns {string|null}
 */
export function foldWinCenterNote(s) {
  if (!s?.winners?.length) return null;
  const foldWin =
    s.showdown?.foldWin === true ||
    s.lastHandSummary?.foldWin === true ||
    s.winners.every((w) => w.hand == null && !w.handZh);
  if (!foldWin) return null;
  if (s.winners.length !== 1 || s.winners[0].seats?.length !== 1) return null;
  const seat = s.winners[0].seats[0];
  const name = s.seats[seat]?.name;
  if (!name) return null;
  const amt = s.winnerPayouts?.[seat] ?? s.winners[0].amount;
  return `${name} 贏得 ${Number(amt).toLocaleString('zh-TW')}（其他人蓋牌）`;
}

function goShowdown(s) {
  s.phase = PHASE.SHOWDOWN;
  s.actor = null;
  s.deadline = null;
  rebuildPots(s);
  pushLog(s, 'street', STREET_ZH.showdown);

  const contenders = livePlayers(s).filter((p) => !p.folded && p.hole && p.hole.length === 2);

  // Evaluate all
  /** @type {{seat:number, rank:number[], name:string}[]} */
  const ranked = contenders.map((p) => ({
    seat: p.seat,
    name: p.name,
    rank: evaluateHand(p.hole, s.board),
  }));

  // Auto-show: winners must show; also standard: all who reach showdown show if they win a pot
  /** @type {Map<number, {amount:number, handZh:string, rank:number[]}>} */
  const awards = new Map();
  /** @type {object[]} */
  const winnerRecords = [];

  for (const pot of s.pots) {
    if (pot.amount <= 0) continue;
    const elig = ranked.filter((r) => pot.eligible.includes(r.seat));
    if (elig.length === 0) continue;
    let best = elig[0].rank;
    for (const e of elig) {
      if (compareRanks(e.rank, best) > 0) best = e.rank;
    }
    const winners = elig.filter((e) => compareRanks(e.rank, best) === 0).map((e) => e.seat);
    const shares = splitPot(pot.amount, winners, s.button, s.config.maxSeats);
    for (const [seat, amt] of shares) {
      const prev = awards.get(seat) || { amount: 0, handZh: '', rank: null };
      prev.amount += amt;
      prev.rank = ranked.find((r) => r.seat === seat).rank;
      prev.handZh = categoryZh(prev.rank);
      awards.set(seat, prev);
      s.seats[seat].chips += amt;
      s.seats[seat].showChoice = 'auto';
    }
    winnerRecords.push({
      seats: winners,
      amount: pot.amount,
      handZh: categoryZh(best),
    });
    const names = winners.map((seat) => s.seats[seat].name).join('、');
    pushLog(
      s,
      'result',
      winners.length > 1
        ? `${names} 以${categoryZh(best)}平分 ${pot.amount}`
        : `${names} 以${categoryZh(best)}贏得 ${pot.amount}`,
    );
  }

  s.winners = winnerRecords;
  s.winnerPayouts = Object.fromEntries(
    [...awards.entries()].map(([seat, v]) => [seat, v.amount]),
  );
  s.pots = [];
  for (const sp of seatedPlayers(s)) sp.bet = 0;
  s.currentBet = 0;

  // Showdown winners auto-reveal; everyone else who had hole cards may choose
  const winnerSeats = new Set([...awards.keys()]);
  for (const p of contenders) {
    if (winnerSeats.has(p.seat)) {
      p.lastAction = awards.has(p.seat)
        ? `贏得 ${awards.get(p.seat).amount}`
        : '攤牌';
    }
  }
  return beginRevealPhase(s, {
    autoRevealSeats: winnerSeats,
    foldWin: false,
    ranks: Object.fromEntries(ranked.map((r) => [r.seat, r.rank])),
  });
}

/**
 * Hand-end reveal: each player who still holds hole cards chooses 亮牌 or 不亮
 * (both cards together). `autoRevealSeats` are forced face-up (showdown winners).
 */
function beginRevealPhase(s, { autoRevealSeats, foldWin, ranks = null }) {
  /** @type {Record<string, {cards: object[], mode: string}>} */
  const revealed = {};
  /** @type {number[]} */
  const pending = [];
  for (const p of seatedPlayers(s)) {
    if (!p.hole || p.hole.length < 2) continue;
    if (autoRevealSeats.has(p.seat)) {
      p.showChoice = 'auto';
      revealed[p.seat] = { cards: cloneCards(p.hole), mode: 'both' };
    } else {
      p.showChoice = null;
      if (!p.lastAction || p.folded) p.lastAction = '待選擇亮牌';
      pending.push(p.seat);
    }
  }
  s.phase = PHASE.SHOWDOWN;
  s.showdown = {
    pending,
    revealed,
    ranks: ranks || {},
    foldWin: !!foldWin,
    /** UI starts a 5s countdown from this timestamp (ms); null until UI sets via SET_REVEAL_DEADLINE */
    revealDeadline: null,
  };
  if (pending.length === 0) return finishShowdown(s);
  return s;
}

function doShow(s, action) {
  if (s.phase !== PHASE.SHOWDOWN) throw err('現在不是攤牌階段');
  const seat = action.seat;
  const p = s.seats[seat];
  if (!p || !s.showdown?.pending.includes(seat)) throw err('無法亮牌');
  // All-or-nothing: both hole cards together only
  const mode = action.mode || 'both';
  if (mode !== 'both') throw err('亮牌須同時亮兩張');
  if (!p.hole || p.hole.length < 2) throw err('沒有手牌可亮');
  p.showChoice = 'both';
  s.showdown.revealed[seat] = { cards: cloneCards(p.hole), mode: 'both' };
  p.lastAction = '亮牌';
  pushLog(s, 'action', `${p.name} 亮牌`);
  s.showdown.pending = s.showdown.pending.filter((x) => x !== seat);
  if (s.showdown.pending.length === 0) return finishShowdown(s);
  return s;
}

function doMuck(s, action) {
  if (s.phase !== PHASE.SHOWDOWN) throw err('現在不是攤牌階段');
  const seat = action.seat;
  const p = s.seats[seat];
  if (!p || !s.showdown?.pending.includes(seat)) throw err('無法不亮');
  p.showChoice = 'muck';
  p.lastAction = '不亮';
  pushLog(s, 'action', `${p.name} 不亮`);
  s.showdown.pending = s.showdown.pending.filter((x) => x !== seat);
  if (s.showdown.pending.length === 0) return finishShowdown(s);
  return s;
}

/** Default no-show when the 5s reveal countdown expires (all remaining → 不亮). */
function doRevealTimeout(s, action) {
  if (s.phase !== PHASE.SHOWDOWN) throw err('現在不是攤牌階段');
  const seats = action.seats?.length
    ? action.seats
    : [...(s.showdown?.pending || [])];
  for (const seat of seats) {
    if (s.phase !== PHASE.SHOWDOWN) break;
    if (!s.showdown?.pending.includes(seat)) continue;
    doMuck(s, { seat });
  }
  return s;
}

/** Reveal-choice window (ms). UI countdown; timeout → 不亮. */
export const REVEAL_MS = 5000;

function finishShowdown(s) {
  s.phase = PHASE.HAND_OVER;
  s.lastHandSummary = {
    winners: s.winners,
    winnerPayouts: s.winnerPayouts,
    board: cloneCards(s.board),
    revealed: s.showdown?.revealed ?? {},
    foldWin: !!s.showdown?.foldWin,
  };
  return s;
}

function doAckHand(s) {
  if (s.phase !== PHASE.HAND_OVER) throw err('這一手尚未結束');
  // Clear holes
  for (const p of seatedPlayers(s)) {
    p.hole = null;
    p.hasHole = false;
    p.bet = 0;
    p.contributed = 0;
    p.folded = false;
    p.allIn = false;
    p.showChoice = null;
  }
  s.board = [];
  s.showdown = null;
  s.deck = [];
  return s;
}

/* ─── Legal actions & helpers ─── */

/**
 * @param {object} s
 * @param {number} seat
 */
export function getLegalActions(s, seat) {
  const none = {
    fold: false,
    check: false,
    call: false,
    callAmount: 0,
    bet: false,
    raise: false,
    allIn: false,
    minRaiseTo: 0,
    maxRaiseTo: 0,
    canAct: false,
  };
  if (!s || s.actor !== seat) return none;
  if (![PHASE.PREFLOP, PHASE.FLOP, PHASE.TURN, PHASE.RIVER].includes(s.phase)) return none;
  const p = s.seats[seat];
  if (!p || p.folded || p.allIn) return none;

  const toCall = Math.max(0, s.currentBet - p.bet);
  const maxTo = p.bet + p.chips;
  const opening = s.currentBet === 0;

  /** @type {typeof none} */
  const L = {
    fold: toCall > 0,
    check: toCall === 0,
    call: toCall > 0 && p.chips > 0,
    callAmount: Math.min(toCall, p.chips),
    bet: opening && p.chips > 0,
    raise: !opening && p.chips > toCall,
    allIn: p.chips > 0,
    minRaiseTo: opening ? s.config.bigBlind : s.minRaiseTo,
    maxRaiseTo: maxTo,
    canAct: true,
  };

  // If player can't afford min raise, they can still all-in
  if (L.raise && L.minRaiseTo > maxTo) {
    L.raise = false; // use all-in instead for "raise"
  }
  if (L.bet && L.minRaiseTo > maxTo) {
    L.bet = false;
  }
  // After an incomplete (short) all-in raise, players who already acted
  // may call/fold the difference but cannot re-raise.
  if (bitHas(s.actedBit, seat) && toCall > 0) {
    L.raise = false;
    L.bet = false;
  }
  return L;
}

/**
 * Quick-pick raise-to totals in a fixed 3×2 grid (labels change by situation).
 * - Preflop, only blinds (currentBet ≤ BB): 最小 / 2.5–5 大盲 / 全下（大盲倍數＝加到總額）
 * - Preflop, facing a raise above BB: 最小 / 2.5–4 倍 / 一池 / 全下（倍數＝對目前面額 currentBet）
 * - Postflop: 最小 / 池比例 / 全下（raise-to ≈ call + frac×(pot+call)）
 * Every amount is rounded to whole chips and clamped to [minRaise, all-in].
 */
export function raisePresets(s, seat) {
  const L = getLegalActions(s, seat);
  if (!L.bet && !L.raise && !L.allIn) return [];
  const pot = totalPot(s);
  const p = s.seats[seat];
  const toCall = Math.max(0, s.currentBet - p.bet);
  const minTo = L.minRaiseTo;
  const maxTo = L.maxRaiseTo;
  const bb = s.config.bigBlind;
  const lo = Math.min(minTo, maxTo);
  const hi = maxTo;

  // Pot-style sizing: raise-to ≈ call + fraction * (pot + call)
  const potRaiseTo = (frac) => {
    const add = Math.round((pot + toCall) * frac);
    return p.bet + toCall + add;
  };

  const preflop = s.phase === PHASE.PREFLOP;
  /** @type {{ id: string, label: string, to: number }[]} */
  let picks;
  /** @type {string} */
  let preferId;

  if (preflop && s.currentBet <= bb) {
    preferId = '3bb';
    picks = [
      { id: 'min', label: '最小', to: minTo },
      { id: '2.5bb', label: '2.5 大盲', to: 2.5 * bb },
      { id: '3bb', label: '3 大盲', to: 3 * bb },
      { id: '4bb', label: '4 大盲', to: 4 * bb },
      { id: '5bb', label: '5 大盲', to: 5 * bb },
      { id: 'allin', label: '全下', to: maxTo },
    ];
  } else if (preflop) {
    preferId = '3x';
    const face = s.currentBet;
    picks = [
      { id: 'min', label: '最小', to: minTo },
      { id: '2.5x', label: '2.5 倍', to: 2.5 * face },
      { id: '3x', label: '3 倍', to: 3 * face },
      { id: '4x', label: '4 倍', to: 4 * face },
      { id: 'pot', label: '一池', to: potRaiseTo(1) },
      { id: 'allin', label: '全下', to: maxTo },
    ];
  } else {
    preferId = '1/2';
    picks = [
      { id: 'min', label: '最小', to: minTo },
      { id: '1/3', label: '1/3 池', to: potRaiseTo(1 / 3) },
      { id: '1/2', label: '半池', to: potRaiseTo(1 / 2) },
      { id: '2/3', label: '2/3 池', to: potRaiseTo(2 / 3) },
      { id: 'pot', label: '一池', to: potRaiseTo(1) },
      { id: 'allin', label: '全下', to: maxTo },
    ];
  }

  return picks.map((x) => {
    const to = clamp(Math.round(x.to), lo, hi);
    return {
      ...x,
      to,
      preferred: x.id === preferId,
    };
  });
}

export function totalPot(s) {
  const committed = seatedPlayers(s).reduce((a, p) => a + p.contributed, 0);
  return committed;
}

export function streetBetsTotal(s) {
  return seatedPlayers(s).reduce((a, p) => a + p.bet, 0);
}

export function sessionSummary(s) {
  return seatedPlayers(s).map((p) => ({
    seat: p.seat,
    name: p.name,
    buyInTotal: p.buyInTotal,
    chips: p.chips,
    net: p.chips - p.buyInTotal,
  }));
}

function rebuildPots(s) {
  const rows = seatedPlayers(s).map((p) => ({
    seat: p.seat,
    contributed: p.contributed,
    folded: p.folded,
  }));
  s.pots = computePots(rows);
}

function livePlayers(s) {
  return seatedPlayers(s).filter((p) => !p.sittingOut && p.hasHole);
}

function seatedPlayers(s) {
  return s.seats.filter(Boolean);
}

function nextOccupiedSeat(s, from, pred) {
  const n = s.config.maxSeats;
  for (let i = 1; i <= n; i++) {
    const seat = (from + i) % n;
    const p = s.seats[seat];
    if (p && (!pred || pred(p))) return seat;
  }
  return from;
}

function prevSeat(s, seat) {
  const n = s.config.maxSeats;
  return (seat - 1 + n) % n;
}

function findNextActor(s, afterSeat) {
  const n = s.config.maxSeats;
  for (let i = 1; i <= n; i++) {
    const seat = (afterSeat + i) % n;
    const p = s.seats[seat];
    if (!p || p.folded || p.allIn || p.sittingOut || !p.hasHole) continue;
    // Needs to act if: not yet acted this cycle, OR bet < currentBet
    if (p.bet < s.currentBet || !bitHas(s.actedBit, seat)) return seat;
  }
  return null;
}

function markActed(s, seat) {
  s.actedBit |= 1 << seat;
}

function bitHas(bit, seat) {
  return (bit & (1 << seat)) !== 0;
}

function armDeadline(s, now) {
  if (!s.config.timerEnabled) {
    s.deadline = null;
    return;
  }
  s.deadline = now + s.config.actionTimeoutMs;
}

function pushLog(s, kind, text) {
  s.log.push({ kind, text, t: s.handNumber });
  s.streetLog.push({ kind, text });
}

function boardLabel(board) {
  return board.map(cardKey).join(' ');
}

function assertInHand(s) {
  if (![PHASE.PREFLOP, PHASE.FLOP, PHASE.TURN, PHASE.RIVER].includes(s.phase)) {
    throw err('現在不是下注階段');
  }
}

function assertLobbyOrOver(s) {
  if (s.phase !== PHASE.LOBBY && s.phase !== PHASE.HAND_OVER && s.phase !== PHASE.SESSION_OVER) {
    throw err('牌局進行中無法更改設定');
  }
}

function assertPosInt(n, label) {
  if (!Number.isInteger(n) || n <= 0) throw err(`${label}必須為正整數`);
  return n;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

function err(msg) {
  const e = new Error(msg);
  e.code = 'POKER_RULE';
  return e;
}

function randomRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const buf = new Uint8Array(4);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < 4; i++) buf[i] = (Math.random() * 256) | 0;
  }
  for (let i = 0; i < 4; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}

/** Export for tests that need to force deck / mid-hand state */
export const _test = {
  nextOccupiedSeat,
  findNextActor,
  bettingRoundDone,
  rebuildPots,
};
