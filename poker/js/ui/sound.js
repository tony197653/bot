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

const UI_SAMPLES = { tick: 'ui-tick' };
/** Destination peaks. Table sfx play at gain 1 (deal ≈ 0.27, bet ≈ 0.76).
 *  A and B share the confirm tone at 0.40 (~−8 dBFS). C (tick) stays 0.28. */
export const UI_GAIN = { tap: 0.40, confirm: 0.40, tick: 0.28 };
const uiPeaks = {};
function bufferPeak(buffer) {
  try {
    let peak = 0;
    for (let c = 0; c < (buffer.numberOfChannels || 0); c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
    }
    return peak || 1;
  } catch { return 1; }
}

function preload() {
  if (!context || loading) return;
  const files = [...PRIORITY, ...Object.values(UI_SAMPLES)];
  loading = Promise.all(files.map(async (kind) => {
    try {
      const response = await window.fetch(new URL(`../../assets/sfx/${kind}.mp3`, import.meta.url));
      if (!response.ok) return;
      buffers[kind] = await context.decodeAudioData(await response.arrayBuffer());
      if (Object.values(UI_SAMPLES).includes(kind)) uiPeaks[kind] = bufferPeak(buffers[kind]);
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
    if (context.state !== 'running') {
      gestureUntil = 0;
      stopSound();
      stopUiSounds();
      armGestures();
    }
  };
  return true;
}

// HTML / WebKit: only these are activation-triggering on touch:
// keydown, mousedown, pointerdown (mouse only), pointerup (not mouse), touchend.
// pointerdown/touchstart on iPhone do NOT grant activation, so resume() there is ignored.
// https://html.spec.whatwg.org/multipage/interaction.html#tracking-user-activation
// https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/User_activation
// https://webkit.org/blog/13862/the-user-activation-api/
export const SOUND_UNLOCK_EVENTS = ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'click', 'keydown'];

function armGestures() {
  if (gesturesArmed || typeof window === 'undefined') return;
  gesturesArmed = true;
  for (const type of SOUND_UNLOCK_EVENTS) {
    window.addEventListener(type, unlock, { passive: true, capture: true });
  }
}
function disarmGestures() {
  if (!gesturesArmed) return;
  gesturesArmed = false;
  if (typeof window === 'undefined') return;
  for (const type of SOUND_UNLOCK_EVENTS) {
    window.removeEventListener(type, unlock, true);
  }
}

function unlock() {
  try {
    // Create, resume, and tick a silent buffer in this user-gesture turn (iOS Safari).
    // Do not drop listeners until the context is actually running — a touch
    // pointerdown is not an activation event, and pointerup/click follow it.
    if (!ensureContext()) return;
    markGesture();
    if (context.state !== 'running') context.resume();
    playSilentUnlock();
    syncAudioSession();
    preload();
    Promise.resolve(context.state === 'running' ? undefined : context.resume())
      .catch(() => {})
      .finally(() => {
        if (context.state === 'running') disarmGestures();
        else armGestures();
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
  ensureContext();
  preload();
}

export function isSoundOn() { return enabled; }
export function getSoundDebug() {
  let audioSessionType = null;
  try {
    audioSessionType = (typeof navigator !== 'undefined' && navigator.audioSession?.type)
      || (typeof window !== 'undefined' && window.navigator?.audioSession?.type)
      || null;
  } catch { /* ignore */ }
  let activation = null;
  try {
    const ua = (typeof navigator !== 'undefined' && navigator.userActivation)
      || (typeof window !== 'undefined' && window.navigator?.userActivation);
    if (ua) activation = { isActive: !!ua.isActive, hasBeenActive: !!ua.hasBeenActive };
  } catch { /* ignore */ }
  return { contextState: context?.state ?? 'none', enabled, audioSessionType, activation };
}

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
  confirm: { frequency: 660, end: 990, duration: 0.065, gain: UI_GAIN.confirm },
};
// UI voices never occupy or stop the table's `active` source.
const uiVoices = new Set();
function stopUiSounds() {
  for (const voice of [...uiVoices]) voice.stop();
}
// iOS: resume() is async; start() in the same user-gesture turn still works.
let gestureUntil = 0;
function markGesture() {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  gestureUntil = now + 1000;
}
function uiAudioReady() {
  if (!context) return false;
  if (context.state === 'running') return true;
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return now < gestureUntil;
}

export function playUiSound(kind) {
  if (!Object.hasOwn(UI_GAIN, kind) || !enabled || typeof window === 'undefined' ||
      window.document?.hidden || !uiAudioReady()) return;
  // At the cap, drop the new voice rather than truncating an existing envelope.
  // A and B share the confirm tone; C keeps the chip sample. Cap by played
  // sound so rapid −/＋ (tick) overlaps at most 3 voices and is not cut off.
  const played = kind === 'tick' ? 'tick' : 'confirm';
  const same = [...uiVoices].filter((v) => v.kind === played);
  if (same.length >= (played === 'tick' ? 3 : 8)) return;
  let voice;
  const track = (source, gain, stopAt) => {
    const cleanup = () => {
      uiVoices.delete(voice);
      try { source.disconnect(); gain.disconnect(); } catch {}
    };
    voice = { kind: played, stop() { try { source.stop(); } catch {} cleanup(); } };
    uiVoices.add(voice);
    source.onended = cleanup;
    source.start(context.currentTime);
    if (stopAt != null) source.stop(stopAt);
  };
  try {
    if (played === 'confirm') {
      const tone = UI_TONES.confirm;
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
      track(oscillator, gain, now + tone.duration);
      return;
    }
    const sample = UI_SAMPLES[kind];
    const buffer = buffers[sample];
    if (!buffer) return;
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    gain.gain.value = UI_GAIN[kind] / (uiPeaks[sample] || 1);
    source.connect(gain);
    gain.connect(context.destination);
    track(source, gain);
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
  if (explicit !== null) return Object.hasOwn(UI_GAIN, explicit) ? explicit : null;
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
  // Play on activation-triggering events. On iOS, a touch pointerdown is not
  // activation; pointerup/click/touchend are. One lastUiAt is shared across
  // those events so one tap = one sound. Click can lag (~120ms); pointerup and
  // touchend are near-instant, so a short window coalesces them without
  // swallowing a later rapid −/＋ tap (overlap cap still lives in playUiSound).
  let lastUiAt = null;
  const isActivationPlay = (event) => {
    if (event.type === 'click' || event.type === 'touchend') return true;
    if (event.type === 'pointerup' && event.pointerType !== 'mouse') return true;
    // Mouse pointerdown is activation; unit tests omit pointerType.
    if (event.type === 'pointerdown' && event.pointerType !== 'touch') return true;
    return false;
  };
  const onUi = (event) => {
    if ((event.type === 'pointerdown' || event.type === 'pointerup') && event.button != null && event.button !== 0) return;
    if (!isActivationPlay(event)) return;
    const control = event.target?.closest?.('[data-sfx], button, [data-act], [data-ps], .mp-seg-item, .mp-chip, .mp-lb-av, .mp-empty-seat, #seats .av, #heroAv, #raiseScrim');
    // Labels forward a second click to their radio: sound only that forwarded
    // click, also covering direct/keyboard radio clicks without doubling.
    if (control?.matches?.('label.mp-seg-item') && event.type === 'click' && !event.target?.matches?.('input[type="radio"]')) return;
    const kind = classifyUiSound(control);
    if (!kind) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const coalesceMs = event.type === 'click' ? 120 : 32;
    if (lastUiAt != null && now - lastUiAt < coalesceMs) return;
    lastUiAt = now;
    playUiSound(kind);
  };
  for (const type of ['pointerdown', 'pointerup', 'touchend', 'click']) {
    root.addEventListener(type, onUi, true);
  }
}
