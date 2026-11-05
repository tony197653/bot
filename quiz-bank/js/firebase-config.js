/**
 * Firebase Web 設定（公開，可進 repo）。
 * 安全靠 Firestore 規則；本機測試只用 emulator（?emulator=1）。
 * 正式規則由管理者審完後自行部署 — 此分支不部署、不碰正式資料。
 */

/** @type {import('firebase/app').FirebaseOptions} */
export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyBaypuXWHdiAD6iilSvL7pblyicoOIRvJs',
  authDomain: 'quiz-bank-tony.firebaseapp.com',
  projectId: 'quiz-bank-tony',
  storageBucket: 'quiz-bank-tony.firebasestorage.app',
  messagingSenderId: '604190719776',
  appId: '1:604190719776:web:077d10d279477a22cb6145',
};

/** 本機 emulator 專用（?emulator=1 且 hostname 為 localhost／127.0.0.1） */
export const EMU_FIREBASE_CONFIG = {
  apiKey: 'demo-api-key',
  authDomain: '127.0.0.1',
  projectId: 'demo-quiz-bank',
  storageBucket: 'demo-quiz-bank.appspot.com',
  messagingSenderId: '123456789012',
  appId: '1:123456789012:web:demo-quiz-bank',
};

export const EMU_PORTS = { auth: 9199, firestore: 8295 };

/** 只在 localhost／127.0.0.1 且 ?emulator=1 時為 true */
export function isEmuMode() {
  try {
    if (typeof location === 'undefined') return false;
    const h = location.hostname;
    if (h !== '127.0.0.1' && h !== 'localhost') return false;
    return new URLSearchParams(location.search).get('emulator') === '1';
  } catch {
    return false;
  }
}
