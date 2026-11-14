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
    if (context.state !== 'running') { stopSound(); armGestures(); }
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
    window.document?.addEventListener('visibilitychange', onVisibilityChange);
    syncAudioSession();
    armGestures();
  }
  preload();
}

export function isSoundOn() { return enabled; }
export function setSoundOn(on) {
  enabled = !!on;
  if (!enabled) stopSound();
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
