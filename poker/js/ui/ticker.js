/**
 * Single rAF ticker for UI timers / smooth updates.
 * Animations prefer CSS transform/opacity; ticker drives countdown + deadline checks.
 */

/** @type {Set<(now:number, dt:number) => void>} */
const listeners = new Set();
let raf = 0;
let last = 0;

export function onTick(fn) {
  listeners.add(fn);
  ensure();
  return () => listeners.delete(fn);
}

function ensure() {
  if (raf) return;
  last = performance.now();
  const loop = (now) => {
    const dt = Math.min(64, now - last);
    last = now;
    for (const fn of listeners) fn(now, dt);
    if (listeners.size) raf = requestAnimationFrame(loop);
    else raf = 0;
  };
  raf = requestAnimationFrame(loop);
}

/** Non-linear ease helpers for JS-driven values if needed */
export function easeOutCubic(t) {
  return 1 - (1 - t) ** 3;
}
export function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
}
