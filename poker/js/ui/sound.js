/** Public-state detection only; no browser APIs in these helpers. */
const PRIORITY = ['deal', 'bet', 'win', 'turn', 'hurry'];
export const soundHandKey = (pub) => pub?.handId ?? pub?.handNo ?? null;
const won = (pub, seat) => Number(pub?.winnerPayouts?.[seat]) > 0 ||
  (pub?.winners || []).some((pot) => pot.seats?.includes(seat));

export function detectSoundEvents(prevPub, nextPub, mySeat) {
  if (!prevPub || !nextPub || !Number.isInteger(mySeat) || mySeat < 0) return [];
  const kinds = [];
  const sameHand = soundHandKey(prevPub) === soundHandKey(nextPub);
  if ((!sameHand && nextPub.phase === 'preflop') ||
      (sameHand && prevPub.phase !== nextPub.phase && ['flop', 'turn', 'river'].includes(nextPub.phase))) {
    kinds.push('deal');
  }
  if ((nextPub.seats || []).some((seat, i) => Number(seat?.bet || 0) >
      (sameHand ? Number(prevPub.seats?.[i]?.bet || 0) : 0))) kinds.push('bet');
  if (nextPub.actor === mySeat && nextPub.actionSeq != null &&
      (!sameHand || prevPub.actionSeq !== nextPub.actionSeq)) kinds.push('turn');
  if (['showdown', 'hand_over'].includes(nextPub.phase) && won(nextPub, mySeat) &&
      (!sameHand || !['showdown', 'hand_over'].includes(prevPub.phase) || !won(prevPub, mySeat))) kinds.push('win');
  return kinds;
}

export function pickSound(kinds) {
  return PRIORITY.slice().reverse().find((kind) => kinds.includes(kind)) ?? null;
}

export function hurryCrossed(prevRemMs, remMs, threshold) {
  return Number.isFinite(prevRemMs) && Number.isFinite(remMs) &&
    prevRemMs > threshold && remMs <= threshold && remMs > 0;
}

let initialized = false;
let enabled = true;
let context = null;
let active = null;
let buffers = {};
let loading = null;
let gesturesArmed = false;

/** When true, Safari 17+ audioSession is set to 'playback' while sfx is on.
 *  Sound can then play with the hardware silent switch on, which also means
 *  the silent switch will not mute poker sfx. PM may set this to false. */
export const SOUND_OPTIONS = { usePlaybackAudioSession: true };

function preload() {
  if (!context || loading) return;
  loading = Promise.all(PRIORITY.map(async (kind) => {
    try {
      const response = await window.fetch(new URL(`../../assets/sfx/${kind}.mp3`, import.meta.url));
      if (!response.ok) return;
      buffers[kind] = await context.decodeAudioData(await response.arrayBuffer());
    } catch { /* Audio failure never affects the table. */ }
  })).catch(() => {});
}

function syncAudioSession() {
  if (!SOUND_OPTIONS.usePlaybackAudioSession) return;
  try {
    const session = (typeof navigator !== 'undefined' && navigator.audioSession)
      || (typeof window !== 'undefined' && window.navigator?.audioSession);
    if (!session) return;
    session.type = enabled ? 'playback' : 'auto';
  } catch { /* ignore */ }
}

function playSilentUnlock() {
  if (!context) return;
  try {
    const buffer = context.createBuffer(1, 1, context.sampleRate || 22050);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start(0);
  } catch { /* ignore */ }
}

function ensureContext() {
  if (context) return true;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return false;
  context = new AudioCtx();
  context.onstatechange = () => {
    if (context.state !== 'running') { stopSound(); stopUiSounds(); armGestures(); }
  };
  return true;
}

function armGestures() {
  if (gesturesArmed || typeof window === 'undefined') return;
  gesturesArmed = true;
  for (const type of ['pointerdown', 'keydown', 'touchstart']) {
    window.addEventListener(type, unlock, { once: true, passive: true, capture: true });
  }
}

function unlock() {
  gesturesArmed = false;
  for (const type of ['pointerdown', 'keydown', 'touchstart']) {
    window.removeEventListener(type, unlock, true);
  }
  try {
    // Create, resume, and tick a silent buffer in this user-gesture turn (iOS Safari).
    if (!ensureContext()) return;
    if (context.state !== 'running') context.resume();
    playSilentUnlock();
    syncAudioSession();
    preload();
    Promise.resolve(context.state === 'running' ? undefined : context.resume())
      .catch(() => {})
      .finally(() => {
        if (context.state !== 'running') armGestures();
      });
  } catch { armGestures(); }
}

function onVisibilityChange() {
  if (window.document?.hidden) {
    stopSound();
    stopUiSounds();
    return;
  }
  if (!context || context.state === 'running') return;
  try {
    Promise.resolve(context.resume()).catch(() => {}).finally(() => {
      if (context.state !== 'running') armGestures();
    });
  } catch { armGestures(); }
}

export function initSound() {
  if (typeof window === 'undefined') return;
  if (!initialized) {
    initialized = true;
    try { enabled = window.localStorage.getItem('poker.sfx') !== 'off'; } catch {}
    wireUiSound(window.document);
    window.document?.addEventListener('visibilitychange', onVisibilityChange);
    syncAudioSession();
    armGestures();
  }
  preload();
}

export function isSoundOn() { return enabled; }
export function setSoundOn(on) {
  enabled = !!on;
  if (!enabled) { stopSound(); stopUiSounds(); }
  try { if (typeof window !== 'undefined') window.localStorage.setItem('poker.sfx', enabled ? 'on' : 'off'); } catch {}
  syncAudioSession();
}
export function stopSound() {
  const current = active;
  active = null;
  try { current?.source.stop(); } catch {}
  try { current?.source.disconnect(); } catch {}
}
export function playSound(kind) {
  try {
    if (!enabled || typeof window === 'undefined' || window.document?.hidden ||
        context?.state !== 'running' || !buffers[kind]) return;
    if (active && PRIORITY.indexOf(kind) <= PRIORITY.indexOf(active.kind)) return;
    stopSound();
    const source = context.createBufferSource();
    source.buffer = buffers[kind];
    source.connect(context.destination);
    active = { source, kind };
    source.onended = () => {
      if (active?.source === source) active = null;
      try { source.disconnect(); } catch {}
    };
    source.start();
  } catch { stopSound(); }
}


const UI_TONES = {
  tap: { frequency: 620, end: 440, duration: 0.045, gain: 0.025 },
  confirm: { frequency: 660, end: 990, duration: 0.065, gain: 0.035 },
  tick: { frequency: 240, end: 150, duration: 0.022, gain: 0.025 },
};
// UI voices never occupy or stop the table's `active` source.
const uiVoices = new Set();
function stopUiSounds() {
  for (const voice of [...uiVoices]) voice.stop();
}
export function playUiSound(kind) {
  const tone = Object.hasOwn(UI_TONES, kind) ? UI_TONES[kind] : null;
  if (!tone || !enabled || typeof window === 'undefined' || window.document?.hidden ||
      context?.state !== 'running') return;
  let voice;
  try {
    // A tiny attack/release prevents clicks, including rapid stepper retriggers.
    // At the cap, drop the new voice rather than truncating an existing envelope.
    const same = [...uiVoices].filter((v) => v.kind === kind);
    if (same.length >= (kind === 'tick' ? 3 : 8)) return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const now = context.currentTime;
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(tone.frequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(tone.end, now + tone.duration);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(tone.gain, now + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + tone.duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    const cleanup = () => {
      uiVoices.delete(voice);
      try { oscillator.disconnect(); gain.disconnect(); } catch {}
    };
    voice = { kind, stop() { try { oscillator.stop(); } catch {} cleanup(); } };
    uiVoices.add(voice);
    oscillator.onended = cleanup;
    oscillator.start(now);
    oscillator.stop(now + tone.duration);
  } catch { voice?.stop(); /* UI audio never affects the action. */ }
}

const UI_IDS = {
  tap: new Set('mpMenuBtn mpBtnMute mpNtcX mpNtcA btnBackLobby btnMenu btnMute btnLobby mpBtnMembers mpAddon mpAddonCancel mpRaise btnRaiseOpen raiseCancel raiseScrim mpShow mpMuck btnShowBoth btnMuck mpLeave mpQuotaLeave mpQuotaLobby mpLeaveConfirmCancel soloLobbyConfirmCancel mpCloseConfirmCancel mpHostAloneCancel mpCloseStats mpCloseBack mpCloseLobby heroAv opAdd opSub mCancel logout clearBtn btnSummary'.split(' ')),
  confirm: new Set('mpBtnCreate mpBtnCreateE btnGoogle gateBtn mpStart btnStart btnNext mpFold btnFold mpCheck btnCheck mpCall btnCall btnAllIn raiseConfirm mpLeaveConfirmOk soloLobbyConfirmOk mpCloseConfirmOk mpBtnCloseRoom mpHostAloneClose mpQuotaClose mpCloseRetry confirmAdj mOk'.split(' ')),
  tick: new Set(['raiseMinus', 'raisePlus']),
};
const TAP_ACTIONS = new Set(['avatar', 'my-stats', 'stats', 'settings', 'signout', 'mute', 'open-table', 'share', 'copy', 'lobby', 'cancel', 'back']);
const CONFIRM_ACTIONS = new Set(['create', 'enter', 'rescue', 'continue']);

/** Classifies one control; unknown controls and all range inputs are silent. */
export function classifyUiSound(el) {
  if (!el?.getAttribute || el.closest?.('[disabled], [aria-disabled="true"], [inert], [data-sfx="none"]') ||
      el.disabled || el.matches?.(':disabled, input[type="range"]')) return null;
  if (el.matches?.('.mp-seg-item') && el.querySelector?.('input[type="radio"]:disabled')) return null;
  const explicit = el.getAttribute('data-sfx');
  if (explicit !== null) return Object.hasOwn(UI_TONES, explicit) ? explicit : null;
  for (const kind of ['tap', 'confirm', 'tick']) if (UI_IDS[kind].has(el.id)) return kind;
  if (el.matches?.('[data-chips-minus], [data-chips-plus], [data-minus], [data-plus]')) return 'tick';
  if (el.matches?.('[data-confirm], #createForm button[type="submit"]')) return 'confirm';
  const act = el.getAttribute('data-act');
  if (CONFIRM_ACTIONS.has(act)) return 'confirm';
  if (TAP_ACTIONS.has(act) || el.matches?.('[data-cancel], .mp-seg-item, .mp-chip, .mp-lb-av, .mp-empty-seat, #seats .av, #presets button, #players .row[data-uid]')) return 'tap';
  if (['avatar', 'back', 'retry', 'pick-choice', 'pick-cancel', 'scrim'].includes(el.getAttribute('data-ps'))) return 'tap';
  return null;
}

const wiredUiRoots = new WeakSet();
export function wireUiSound(root) {
  if (!root?.addEventListener || wiredUiRoots.has(root)) return;
  wiredUiRoots.add(root);
  root.addEventListener('click', (event) => {
    const control = event.target?.closest?.('[data-sfx], button, [data-act], [data-ps], .mp-seg-item, .mp-chip, .mp-lb-av, .mp-empty-seat, #seats .av, #heroAv, #raiseScrim');
    // Labels forward a second click to their radio: sound only that forwarded
    // click, also covering direct/keyboard radio clicks without doubling.
    if (control?.matches?.('label.mp-seg-item') && !event.target?.matches?.('input[type="radio"]')) return;
    const kind = classifyUiSound(control);
    if (kind) playUiSound(kind);
  }, true);
}
