import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSoundEvents, pickSound, hurryCrossed } from '../js/ui/sound.js';

const pub = (overrides = {}) => ({ handId: 'h1', handNo: 1, phase: 'preflop', actionSeq: 1, actor: 1,
  seats: [{ bet: 0 }, { bet: 0 }, { bet: 0 }], ...overrides });
const detect = (a, b, seat = 0) => detectSoundEvents(a, b, seat);

test('第一個快照只立基線', () => assert.deepEqual(detect(null, pub({ actor: 0 })), []));
test('新手 preflop 發牌（handId 或 handNo）', () => {
  assert.deepEqual(detect(pub(), pub({ handId: 'h2' })), ['deal']);
  assert.deepEqual(detect({ handNo: 1 }, { handNo: 2, phase: 'preflop' }), ['deal']);
});
for (const [before, phase] of [['preflop', 'flop'], ['flop', 'turn'], ['turn', 'river']]) {
  test(`${phase} 進街只播一次`, () => {
    const next = pub({ phase });
    assert.deepEqual(detect(pub({ phase: before }), next), ['deal']);
    assert.deepEqual(detect(next, { ...next }), []);
  });
}
for (const phase of ['showdown', 'hand_over', 'lobby']) {
  test(`${phase} 不發牌`, () => assert.deepEqual(detect(pub(), pub({ phase })), []));
}
test('同街重畫不重播', () => assert.deepEqual(detect(pub(), pub()), []));
test('新手大小盲從零計算，同快照合併一聲', () => {
  const kinds = detect(pub({ seats: [{ bet: 100 }, { bet: 200 }] }),
    pub({ handId: 'h2', seats: [{ bet: 5 }, { bet: 10 }] }));
  assert.deepEqual(kinds, ['deal', 'bet']);
  assert.equal(pickSound(kinds), 'bet');
});
for (const action of ['跟注', '下注', '加注', '全下']) {
  test(`${action} 只根據 bet 增加`, () => {
    assert.deepEqual(detect(pub({ seats: [{ bet: 10 }] }),
      pub({ seats: [{ bet: 100, lastAction: action }] })), ['bet']);
  });
}
for (const action of ['check', 'fold']) {
  test(`${action} 不增 bet 不播`, () => assert.deepEqual(detect(pub(),
    pub({ actionSeq: 2, lastAction: { type: action } })), []));
}
test('換街歸零不產生下注聲', () => assert.deepEqual(detect(
  pub({ seats: [{ bet: 100 }] }), pub({ phase: 'flop' })), ['deal']));
test('本人新 actionSeq 播 turn，同 seq 不播', () => {
  const next = pub({ actor: 0, actionSeq: 2 });
  assert.deepEqual(detect(pub(), next), ['turn']);
  assert.deepEqual(detect(next, { ...next }), []);
});
test('他人 turn 不播', () => assert.deepEqual(detect(pub(), pub({ actionSeq: 2 })), []));
for (const seat of [-1, undefined, null]) {
  test(`未入座 ${seat} 五聲皆不播`, () => assert.deepEqual(
    detectSoundEvents(pub(), pub({ handId: 'h2', actor: seat, actionSeq: 2, seats: [{ bet: 10 }] }), seat), []));
}
test('加注繞回本人再播', () => {
  assert.deepEqual(detect(pub({ actor: 0 }), pub({ actionSeq: 2 })), []);
  assert.deepEqual(detect(pub({ actionSeq: 2 }), pub({ actor: 0, actionSeq: 3 })), ['turn']);
});
test('本人公開贏池播，同手結算重畫不播，輸家不播', () => {
  const result = pub({ phase: 'showdown', winnerPayouts: { 0: 100 } });
  assert.deepEqual(detect(pub(), result), ['win']);
  assert.deepEqual(detect(result, { ...result, phase: 'hand_over' }), []);
  assert.deepEqual(detect(pub(), result, 1), []);
});
test('主池、邊池、平分合併；winners seats 備援', () => {
  const result = pub({ phase: 'hand_over', winners: [{ seats: [0, 1] }, { seats: [0] }] });
  assert.deepEqual(detect(pub(), result), ['win']);
  assert.deepEqual(detect(result, { ...result }), []);
});
test('未公開結算不播贏池', () => assert.deepEqual(detect(pub(), pub({ winnerPayouts: { 0: 100 } })), []));
test('優先序 hurry > turn > win > bet > deal', () => {
  const kinds = ['deal', 'bet', 'win', 'turn', 'hurry'];
  while (kinds.length) assert.equal(pickSound(kinds), kinds.pop());
  assert.equal(pickSound([]), null);
});
test('快超時跨線一次，首次低於門檻不補播', () => {
  assert.equal(hurryCrossed(5001, 5000, 5000), true);
  assert.equal(hurryCrossed(5000, 4999, 5000), false);
  assert.equal(hurryCrossed(null, 4000, 5000), false);
  assert.equal(hurryCrossed(undefined, 4000, 5000), false);
  assert.equal(hurryCrossed(6000, 0, 5000), false);
  assert.equal(hurryCrossed(6000, -1, 5000), false);
});

// Exercise the room adapter with public snapshots and a local clock only.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { soundHandKey } from '../js/ui/sound.js';
const mpSource = readFileSync(new URL('../js/ui/mp-app.js', import.meta.url), 'utf8');
function soundRoom() {
  const played = [];
  const listeners = new Map();
  const ticks = new Set();
  let writes = 0;
  let hintText = '';
  const hint = { get textContent() { return hintText; }, set textContent(text) { hintText = text; writes++; } };
  let cancelled = false;
  const ctx = vm.createContext({
    detectSoundEvents, pickSound, hurryCrossed, soundHandKey,
    MP_FX: { timerWarnLastMs: 5000 }, screen: 'table', lastRecvAt: 0,
    room: { pub: pub({ actor: 0 }), deadlineAt: 10000 }, rem: 6000,
    remainingMs: () => ctx.rem, playSound: (kind) => { if (kind) played.push(kind); },
    $: (selector) => selector === '#turnHint' ? hint : null,
    stopSound() {}, initSound() {}, onTick: (fn) => {
      ticks.add(fn);
      return () => { ticks.delete(fn); cancelled = true; };
    },
    document: { hidden: false, addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener() {} },
    window: { addEventListener() {}, removeEventListener() {} },
  });
  vm.runInContext(mpSource.slice(mpSource.indexOf('// Sound state is independent'), mpSource.indexOf("let joinDigits = '';")), ctx);
  const receive = (next, skip = false, seat = 0) => {
    const previous = ctx.room.pub;
    ctx.room.pub = next;
    ctx.consumeRoomSound(previous, next, seat, skip);
  };
  return { ctx, played, receive, listeners, ticks, hint, writes: () => writes, cancelled: () => cancelled };
}

test('room：同快照只選最高優先；低優先事件也消耗', () => {
  const r = soundRoom();
  r.receive(pub(), true);
  r.receive(pub({ handId: 'h2', actor: 0, actionSeq: 2, seats: [{ bet: 10 }] }));
  assert.deepEqual(r.played, ['turn']);
  r.receive(pub({ handId: 'h2', actor: 0, actionSeq: 2, seats: [{ bet: 10 }] }));
  assert.deepEqual(r.played, ['turn']);
});
test('room：同手贏池資料消失再出現仍只響一次', () => {
  const r = soundRoom();
  r.receive(pub(), true);
  const result = pub({ phase: 'hand_over', winnerPayouts: { 0: 100 } });
  r.receive(result);
  r.receive(pub({ phase: 'hand_over' }));
  r.receive(result);
  assert.deepEqual(r.played, ['win']);
});
test('room：快超時每 turn 一次，延長不重播，新 turn 可再播', () => {
  const r = soundRoom();
  r.receive(pub({ actor: 0 }), true);
  r.ctx.rem = 5000;
  r.ctx.tickRoomSound();
  r.ctx.rem = 9000;
  r.ctx.tickRoomSound();
  r.ctx.rem = 4000;
  r.ctx.tickRoomSound();
  assert.deepEqual(r.played, ['hurry']);
  r.ctx.rem = 6000;
  r.receive(pub({ actor: 0, actionSeq: 2 }));
  r.ctx.rem = 4999;
  r.ctx.tickRoomSound();
  assert.deepEqual(r.played, ['hurry', 'turn', 'hurry']);
});
test('room：skip 重立倒數基線，低於門檻不補，未入座不播', () => {
  const r = soundRoom();
  r.receive(pub({ actor: 0 }), true);
  r.ctx.rem = 4000;
  r.receive(pub({ actor: 0, actionSeq: 8 }), true);
  r.ctx.tickRoomSound();
  assert.deepEqual(r.played, []);
  r.receive(pub({ actor: 0, actionSeq: 9 }), false, -1);
  r.ctx.tickRoomSound();
  assert.deepEqual(r.played, []);
});
test('room：背景返回先等新快照，ticker 可取消且不重畫', () => {
  const r = soundRoom();
  r.ctx.startRoomSound();
  r.receive(pub({ actor: 0 }), true);
  r.listeners.get('visibilitychange')();
  r.ctx.rem = 4000;
  r.ctx.tickRoomSound();
  assert.deepEqual(r.played, []);
  vm.runInContext('stopSoundTick(); resetRoomSound();', r.ctx);
  assert.equal(r.cancelled(), true);
});

test('播放器：五檔預載、手勢解鎖、優先中斷、關閉停聲及恢復不補播', async () => {
  const oldWindow = globalThis.window;
  const gestures = new Map();
  const fetched = [];
  const sources = [];
  const storage = new Map();
  let audio;
  let visibility;
  class AudioContext {
    constructor() { audio = this; this.state = 'suspended'; this.destination = {}; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    decodeAudioData() { return Promise.resolve({}); }
    createBufferSource() {
      const source = { connect() {}, disconnect() {}, start() { this.started = true; }, stop() { this.stopped = true; } };
      sources.push(source);
      return source;
    }
  }
  try {
    globalThis.window = {
      AudioContext,
      localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
      document: { hidden: false, addEventListener: (_type, fn) => { visibility = fn; } },
      addEventListener: (type, fn) => gestures.set(type, fn),
      removeEventListener: (type) => gestures.delete(type),
      fetch: async (url) => { fetched.push(String(url)); return { ok: true, arrayBuffer: async () => new ArrayBuffer(1) }; },
    };
    const sound = await import('../js/ui/sound.js?player-test');
    sound.initSound();
    assert.equal(sound.isSoundOn(), true);
    sound.playSound('turn');
    assert.equal(sources.length, 0);
    gestures.get('pointerdown')();
    await new Promise(setImmediate);
    assert.equal(fetched.length, 5);
    assert.ok(fetched.every((url) => /\/assets\/sfx\/(deal|bet|turn|hurry|win)\.mp3$/.test(url)));
    assert.equal(sources.length, 0, '解鎖不補播');
    sound.playSound('deal');
    sound.playSound('win');
    assert.equal(sources[0].stopped, true);
    sound.playSound('bet');
    assert.equal(sources.length, 2, '低優先丟棄');
    sound.setSoundOn(false);
    assert.equal(sources[1].stopped, true);
    assert.equal(storage.get('poker.sfx'), 'off');
    sound.playSound('hurry');
    sound.setSoundOn(true);
    assert.equal(sources.length, 2, '再開不補播');
    sound.playSound('hurry');
    window.document.hidden = true;
    visibility();
    assert.equal(sources[2].stopped, true);
    audio.state = 'suspended';
    audio.onstatechange();
    window.document.hidden = false;
    visibility();
    sound.playSound('turn');
    assert.equal(sources.length, 3, '恢復前景等下一個手勢');
    gestures.get('keydown')();
    await new Promise(setImmediate);
    assert.equal(sources.length, 3);
    sound.playSound('turn');
    assert.equal(sources.length, 4);
    sound.stopSound();
  } finally {
    if (oldWindow === undefined) delete globalThis.window;
    else globalThis.window = oldWindow;
  }
});
test('room：同 turn 後續快照刷新 lastRecvAt，不會把快超時倒數重設（PM 補）', () => {
  const r = soundRoom();
  let now = 1000;
  r.ctx.remainingMs = (deadlineAt, hostClockAt, recvAt) =>
    deadlineAt == null || hostClockAt == null || recvAt == null ? null : Math.max(0, (deadlineAt - hostClockAt) - (now - recvAt));
  r.ctx.room = { pub: pub({ actor: 0 }), deadlineAt: 40000 };
  r.ctx.lastRecvAt = now;
  r.receive(pub({ actor: 0, hostClockAt: 10000 }), true);
  for (const t of [5000, 10000, 15000, 20000]) {
    now = t + 1000;
    r.ctx.lastRecvAt = now; // presence / lobby writes on the same turn
    r.receive(pub({ actor: 0, hostClockAt: 10000 }));
    r.ctx.tickRoomSound();
  }
  assert.deepEqual(r.played, []);
  now = 26500; // 30 s budget − 25.5 s elapsed = 4.5 s
  r.ctx.tickRoomSound();
  now = 27500;
  r.ctx.tickRoomSound();
  assert.deepEqual(r.played, ['hurry']);
});


test('room：同快照倒數持續減少，顯示 5 秒時與 hurry 同步跨線，文字未變不寫 DOM', () => {
  const r = soundRoom();
  let now = 1000;
  r.ctx.remainingMs = (deadlineAt, hostClockAt, recvAt) =>
    Math.max(0, deadlineAt - hostClockAt - (now - recvAt));
  r.ctx.room.deadlineAt = 17000;
  r.ctx.lastRecvAt = now;
  r.receive(pub({ actor: 0, hostClockAt: 10000 }), true);
  r.ctx.startRoomSound();
  const tick = () => { for (const fn of r.ticks) fn(); };
  tick();
  assert.equal(r.hint.textContent, '7 秒');
  now = 2000;
  tick();
  assert.equal(r.hint.textContent, '6 秒');
  const writes = r.writes();
  now = 2500;
  tick();
  assert.equal(r.writes(), writes);
  assert.deepEqual(r.played, []);
  now = 3000;
  tick();
  assert.equal(r.hint.textContent, '5 秒');
  assert.deepEqual(r.played, ['hurry']);
  vm.runInContext('stopSoundTick(); stopTurnHintTick();', r.ctx);
  assert.equal(r.ticks.size, 0);
});

test('room：其他 actor 的倒數不受後續快照或入座影響，非回合清空提示', () => {
  const r = soundRoom();
  let now = 1000;
  r.ctx.remainingMs = (deadlineAt, hostClockAt, recvAt) =>
    Math.max(0, deadlineAt - hostClockAt - (now - recvAt));
  r.ctx.room.deadlineAt = 20000;
  r.ctx.lastRecvAt = now;
  r.receive(pub({ actor: 1, hostClockAt: 10000 }), true, -1);
  r.ctx.tickTurnHint();
  assert.equal(r.hint.textContent, '10 秒');
  now = 4000;
  r.ctx.lastRecvAt = now;
  r.receive(pub({ actor: 1, hostClockAt: 10000 }), false, 0);
  r.ctx.tickTurnHint();
  assert.equal(r.hint.textContent, '7 秒');
  for (const snapshot of [pub({ phase: 'hand_over' }), pub({ phase: 'lobby' }), pub({ actor: null })]) {
    r.ctx.room.pub = snapshot;
    r.ctx.tickTurnHint();
    assert.equal(r.hint.textContent, '');
  }
  r.ctx.room.pub = pub();
  r.ctx.screen = 'share';
  r.ctx.tickTurnHint();
  assert.equal(r.hint.textContent, '');
});

test('確認 toast：只隱藏指定訊息並取消 timer，其他 toast 保留', () => {
  const el = { textContent: '正在確認牌桌…', hidden: false };
  const cleared = [];
  const ctx = vm.createContext({ $: () => el, toastTimer: 42, clearTimeout: (id) => cleared.push(id) });
  vm.runInContext(mpSource.slice(mpSource.indexOf('function dismissToast('), mpSource.indexOf('function toast(')), ctx);
  ctx.dismissToast('正在確認牌桌…');
  assert.equal(el.hidden, true);
  assert.equal(ctx.toastTimer, 0);
  assert.deepEqual(cleared, [42]);
  el.textContent = '已複製';
  el.hidden = false;
  ctx.toastTimer = 43;
  ctx.dismissToast('正在確認牌桌…');
  assert.equal(el.hidden, false);
  assert.equal(ctx.toastTimer, 43);
  assert.deepEqual(cleared, [42]);
});
