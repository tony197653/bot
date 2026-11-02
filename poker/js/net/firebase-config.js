/** tony-poker web config. Override authDomain to hosting domain for same-domain redirect (§8.2). */
export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyAt35bQoP7z5_lDPF9bMbm5t8R5aJgBJQw',
  authDomain: 'tony-poker.web.app',
  projectId: 'tony-poker',
  storageBucket: 'tony-poker.firebasestorage.app',
  messagingSenderId: '912362174174',
  appId: '1:912362174174:web:1bcf937cbb58868e17344f',
};

/** Local emulator project — only used when isEmuMode() is true. */
export const EMU_FIREBASE_CONFIG = {
  apiKey: 'demo-api-key',
  authDomain: '127.0.0.1',
  projectId: 'demo-poker',
  storageBucket: 'demo-poker.appspot.com',
  messagingSenderId: '123456789012',
  appId: '1:123456789012:web:demo',
};

export const EMU_PORTS = { auth: 9099, firestore: 8195 };

/** True only on localhost with ?emu=1 — never enables against production. */
export function isEmuMode() {
  try {
    if (typeof location === 'undefined') return false;
    if (location.hostname !== '127.0.0.1' && location.hostname !== 'localhost') {
      return false;
    }
    return new URLSearchParams(location.search).get('emu') === '1';
  } catch {
    return false;
  }
}

export const LS_PREFIX = 'poker.v2';
