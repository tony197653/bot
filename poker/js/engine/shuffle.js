/**
 * Fisher–Yates shuffle using an injectable RNG.
 * Default RNG uses crypto.getRandomValues with rejection sampling (no modulo bias).
 */

/**
 * @param {number} maxExclusive positive integer
 * @param {() => number} [randUnit] returns float in [0,1)
 * @returns {number} integer in [0, maxExclusive)
 */
export function randomInt(maxExclusive, randUnit = defaultRandUnit) {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
    throw new Error('maxExclusive must be a positive integer');
  }
  // Prefer crypto path when available and using default RNG
  if (randUnit === defaultRandUnit && typeof globalThis.crypto?.getRandomValues === 'function') {
    return cryptoRandomInt(maxExclusive);
  }
  // Rejection sampling on float → int for injectable RNGs
  // Map [0,1) uniformly onto [0, maxExclusive)
  for (;;) {
    const u = randUnit();
    if (u >= 0 && u < 1) {
      const n = Math.floor(u * maxExclusive);
      if (n < maxExclusive) return n;
    }
  }
}

/** @param {number} maxExclusive */
function cryptoRandomInt(maxExclusive) {
  const cryptoObj = globalThis.crypto;
  // Rejection sampling: take 32-bit values below largest multiple of maxExclusive
  const limit = 0x100000000;
  const threshold = limit - (limit % maxExclusive);
  const buf = new Uint32Array(1);
  for (;;) {
    cryptoObj.getRandomValues(buf);
    const v = buf[0];
    if (v < threshold) return v % maxExclusive;
  }
}

function defaultRandUnit() {
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    globalThis.crypto.getRandomValues(buf);
    return buf[0] / 0x100000000;
  }
  return Math.random();
}

/**
 * @template T
 * @param {T[]} arr
 * @param {() => number} [randUnit]
 * @returns {T[]}
 */
export function shuffle(arr, randUnit = defaultRandUnit) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1, randUnit);
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}

/**
 * Mulberry32 PRNG — deterministic for tests.
 * @param {number} seed
 * @returns {() => number}
 */
export function mulberry32(seed) {
  let t = seed >>> 0;
  return function randUnit() {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
