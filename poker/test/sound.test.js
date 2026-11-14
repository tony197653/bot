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
  const timers = new Map();
  let timerId = 0;
  let now = 0;
  let writes = 0;
  let hintText = '';
  const hint = { get textContent() { return hintText; }, set textContent(text) { hintText = text; writes++; } };
  const ctx = vm.createContext({
    hostPaused: false, stopHostBeat: null, hostReturnedTimer: null,
    detectSoundEvents, pickSound, hurryCrossed, soundHandKey,
    MP_FX: { timerWarnLastMs: 5000 }, screen: 'table', lastRecvAt: 0,
    room: { pub: pub({ actor: 0 }), deadlineAt: 10000 }, rem: 6000,
    remainingMs: () => ctx.rem, playSound: (kind) => { if (kind) played.push(kind); },
    $: (selector) => selector === '#turnHint' ? hint : null,
    stopSound() {}, initSound() {},
    setTimeout: (fn, delay) => {
      const id = ++timerId;
      timers.set(id, { fn, delay, at: now + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    document: { hidden: false,
      addEventListener: (type, fn) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      removeEventListener: (type, fn) => listeners.get(type)?.delete(fn),
    },
    window: { addEventListener() {}, removeEventListener() {} },
  });
  vm.runInContext(mpSource.slice(mpSource.indexOf('// Sound state is independent'), mpSource.indexOf("let joinDigits = '';")), ctx);
  const receive = (next, skip = false, seat = 0) => {
    const previous = ctx.room.pub;
    ctx.room.pub = next;
    ctx.consumeRoomSound(previous, next, seat, skip);
    ctx.turnClockTick();
  };
  const advance = (ms) => {
    const target = now + ms;
    while (true) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      ctx.rem -= next[1].at - now;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
    }
    ctx.rem -= target - now;
    now = target;
  };
  return { ctx, played, receive, listeners, timers, advance, hint, writes: () => writes };
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
test('room：背景返回先等新快照，timer 可取消且不重畫', () => {
  const r = soundRoom();
  r.ctx.startRoomSound();
  r.receive(pub({ actor: 0 }), true);
  for (const fn of r.listeners.get('visibilitychange')) fn();
  r.ctx.rem = 4000;
  r.ctx.tickRoomSound();
  assert.deepEqual(r.played, []);
  vm.runInContext('stopTurnClock(); resetRoomSound();', r.ctx);
  assert.equal(r.timers.size, 0);
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
    constructor() { audio = this; this.state = 'suspended'; this.destination = {}; this.sampleRate = 22050; }
    resume() { this.state = 'running'; this.resumed = (this.resumed || 0) + 1; return Promise.resolve(); }
    decodeAudioData() { return Promise.resolve({}); }
    createBuffer(channels, length, rate) { this.silent = { channels, length, rate }; return {}; }
    createBufferSource() {
      const source = { connect() {}, disconnect() {}, start() { this.started = true; }, stop() { this.stopped = true; } };
      sources.push(source);
      return source;
    }
  }
  const audioSession = { type: 'auto' };
  try {
    globalThis.window = {
      AudioContext,
      navigator: { audioSession },
      localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
      document: { hidden: false, addEventListener: (_type, fn) => { visibility = fn; } },
      addEventListener: (type, fn) => gestures.set(type, fn),
      removeEventListener: (type) => gestures.delete(type),
      fetch: async (url) => { fetched.push(String(url)); return { ok: true, arrayBuffer: async () => new ArrayBuffer(1) }; },
    };
    const sound = await import('../js/ui/sound.js?player-test');
    sound.initSound();
    assert.equal(sound.isSoundOn(), true);
    assert.equal(audioSession.type, 'playback');
    sound.playSound('turn');
    assert.equal(sources.length, 0);
    gestures.get('pointerdown')();
    assert.equal(audio.state, 'running', '手勢同步 resume');
    assert.equal(audio.silent?.length, 1, '解鎖播極短靜音');
    assert.equal(sources.length, 1);
    assert.equal(sources[0].started, true);
    await new Promise(setImmediate);
    assert.equal(fetched.length, 5);
    assert.ok(fetched.every((url) => /\/assets\/sfx\/(deal|bet|turn|hurry|win)\.mp3$/.test(url)));
    assert.equal(sources.length, 1, '解鎖不補播音效');
    sound.playSound('deal');
    sound.playSound('win');
    assert.equal(sources[1].stopped, true);
    sound.playSound('bet');
    assert.equal(sources.length, 3, '低優先丟棄');
    sound.setSoundOn(false);
    assert.equal(sources[2].stopped, true);
    assert.equal(storage.get('poker.sfx'), 'off');
    assert.equal(audioSession.type, 'auto');
    sound.playSound('hurry');
    sound.setSoundOn(true);
    assert.equal(audioSession.type, 'playback');
    assert.equal(sources.length, 3, '再開不補播');
    sound.playSound('hurry');
    window.document.hidden = true;
    visibility();
    assert.equal(sources[3].stopped, true);
    audio.state = 'suspended';
    audio.onstatechange();
    window.document.hidden = false;
    visibility();
    await new Promise(setImmediate);
    assert.equal(audio.state, 'running', '回前景直接 resume');
    sound.playSound('turn');
    assert.equal(sources.length, 5, '回前景 resume 成功即可播，不必再點');
    sound.stopSound();
  } finally {
    if (oldWindow === undefined) delete globalThis.window;
    else globalThis.window = oldWindow;
  }
});

test('前景恢復：resume 失敗才再掛手勢', async () => {
  const oldWindow = globalThis.window;
  const gestures = new Map();
  let audio;
  let visibility;
  class AudioContext {
    constructor() { audio = this; this.state = 'suspended'; this.destination = {}; this.sampleRate = 22050; this.allow = true; }
    resume() {
      if (!this.allow) return Promise.reject(new Error('interrupted'));
      this.state = 'running';
      return Promise.resolve();
    }
    decodeAudioData() { return Promise.resolve({}); }
    createBuffer() { return {}; }
    createBufferSource() {
      return { connect() {}, disconnect() {}, start() {}, stop() {} };
    }
  }
  try {
    globalThis.window = {
      AudioContext,
      navigator: {},
      localStorage: { getItem: () => null, setItem() {} },
      document: { hidden: false, addEventListener: (_type, fn) => { visibility = fn; } },
      addEventListener: (type, fn) => gestures.set(type, fn),
      removeEventListener: (type) => gestures.delete(type),
      fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }),
    };
    const sound = await import('../js/ui/sound.js?player-resume-fail');
    sound.initSound();
    gestures.get('pointerdown')();
    await new Promise(setImmediate);
    audio.state = 'interrupted';
    audio.allow = false;
    window.document.hidden = true;
    visibility();
    window.document.hidden = false;
    visibility();
    await new Promise(setImmediate);
    assert.equal(audio.state, 'interrupted');
    assert.equal(typeof gestures.get('pointerdown'), 'function', '失敗後重新掛手勢');
    audio.allow = true;
    gestures.get('pointerdown')();
    await new Promise(setImmediate);
    assert.equal(audio.state, 'running');
    sound.stopSound();
  } finally {
    if (oldWindow === undefined) delete globalThis.window;
    else globalThis.window = oldWindow;
  }
});

test('audioSession 常數關閉時不改 type', async () => {
  const oldWindow = globalThis.window;
  const audioSession = { type: 'auto' };
  const gestures = new Map();
  class AudioContext {
    constructor() { this.state = 'suspended'; this.destination = {}; this.sampleRate = 22050; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    decodeAudioData() { return Promise.resolve({}); }
    createBuffer() { return {}; }
    createBufferSource() { return { connect() {}, disconnect() {}, start() {}, stop() {} }; }
  }
  try {
    globalThis.window = {
      AudioContext,
      navigator: { audioSession },
      localStorage: { getItem: () => null, setItem() {} },
      document: { hidden: false, addEventListener() {} },
      addEventListener: (type, fn) => gestures.set(type, fn),
      removeEventListener: (type) => gestures.delete(type),
      fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }),
    };
    const sound = await import('../js/ui/sound.js?player-session-flag');
    sound.SOUND_OPTIONS.usePlaybackAudioSession = false;
    sound.initSound();
    assert.equal(audioSession.type, 'auto');
    gestures.get('pointerdown')();
    sound.setSoundOn(true);
    assert.equal(audioSession.type, 'auto');
  } finally {
    if (oldWindow === undefined) delete globalThis.window;
    else globalThis.window = oldWindow;
  }
});

test('app 與 startMpApp 在進桌前就呼叫 initSound', () => {
  const app = readFileSync(new URL('../js/ui/app.js', import.meta.url), 'utf8');
  const mp = readFileSync(new URL('../js/ui/mp-app.js', import.meta.url), 'utf8');
  assert.match(app, /import \{ initSound \} from '\.\/sound\.js';/);
  assert.match(app, /async function boot\(\) \{\s*initSound\(\);/);
  assert.match(mp, /export async function startMpApp\(\) \{\s*initSound\(\);/);
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
  r.ctx.rem = 7000;
  r.receive(pub({ actor: 0 }), true);
  r.ctx.startRoomSound();
  assert.equal(r.hint.textContent, '7 秒');
  r.advance(1015);
  assert.equal(r.hint.textContent, '6 秒');
  const writes = r.writes();
  r.advance(500);
  assert.equal(r.writes(), writes);
  assert.deepEqual(r.played, []);
  r.advance(500);
  assert.equal(r.hint.textContent, '5 秒');
  assert.deepEqual(r.played, ['hurry']);
  r.advance(1000);
  assert.deepEqual(r.played, ['hurry']);
  // Run the actual teardown's timer cancellation before unrelated room cleanup.
  vm.runInContext(mpSource.slice(mpSource.indexOf('function tearDownRoom()'),
    mpSource.indexOf('  closingFreeze = false;', mpSource.indexOf('function tearDownRoom()'))) + '}', r.ctx);
  r.ctx.tearDownRoom();
  assert.equal(r.timers.size, 0);
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


test('room：無有效回合或背景不排程，有效回合對齊下一個整秒邊界', () => {
  const r = soundRoom();
  r.ctx.rem = 7300;
  r.receive(pub({ actor: 0 }), true);
  assert.equal(r.timers.size, 1);
  assert.equal([...r.timers.values()][0].delay, 315);
  for (const snapshot of [pub({ phase: 'hand_over' }), pub({ phase: 'lobby' }), pub({ actor: null })]) {
    r.receive(snapshot);
    assert.equal(r.timers.size, 0);
  }
  r.ctx.room.pub = pub({ actor: 0 });
  r.ctx.screen = 'share';
  r.ctx.scheduleTurnClock();
  assert.equal(r.timers.size, 0);
  r.ctx.screen = 'table';
  r.ctx.startRoomSound();
  r.ctx.document.hidden = true;
  for (const fn of r.listeners.get('visibilitychange')) fn();
  assert.equal(r.timers.size, 0);
  r.ctx.document.hidden = false;
  for (const fn of r.listeners.get('visibilitychange')) fn();
  assert.equal(r.timers.size, 1);
  assert.equal([...r.timers.values()][0].delay, 315);
  r.ctx.rem = 0;
  r.ctx.scheduleTurnClock();
  assert.equal(r.timers.size, 0);
});
