/**
 * Stable per-hand identity for personal stats.
 * roomId+handNo alone can collide when a coalesced/skipped pub write loses an
 * intermediate handNo bump (host.js queueWrite may no-op when hidden).
 */

/**
 * @returns {string}
 */
export function generateHandId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = (Math.random() * 256) | 0;
  }
  // RFC4122-ish v4 shape without claiming cryptographic uniqueness beyond crypto API.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Restore handId from published room state when host reconnects / handoff resumes.
 * Mid-hand reconnect voids the hand (§6.8); HAND_OVER resumes the same id for re-send.
 * @param {object|null|undefined} pub
 * @returns {string|null}
 */
export function handIdFromPub(pub) {
  const id = pub?.handId;
  if (typeof id === 'string' && id.length > 0) return id;
  return null;
}
