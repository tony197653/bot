import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, serverTimestamp, setDoc, Timestamp, updateDoc } from 'firebase/firestore';
import { presetUrl } from '../js/ui/avatars.js';

const endpoint = process.env.FIRESTORE_EMULATOR_HOST;
if (!endpoint || !/^(127\.0\.0\.1|localhost):\d+$/.test(endpoint)) {
  throw new Error('必須設定本機 FIRESTORE_EMULATOR_HOST');
}
const [host, port] = endpoint.split(':');
const rules = readFileSync(new URL('./firestore.rules', import.meta.url), 'utf8');

test('頭像寫入沿用既有規則', async (t) => {
  const env = await initializeTestEnvironment({
    projectId: process.env.RULES_PROJECT || 'demo-poker-avatar',
    firestore: { host, port: Number(port), rules },
  });
  try {
    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      const now = Timestamp.now();
      for (const uid of ['avatar-me', 'avatar-other']) {
        const profile = { displayName: uid, photoURL: null, createdAt: now };
        await setDoc(doc(db, 'users', uid), { ...profile, lastSeen: now });
        await setDoc(doc(db, 'pokerPlayers', uid), {
          ...profile, lastRoomId: 'room1', updatedAt: now,
        });
      }
    });
    const me = 'avatar-me';
    const other = 'avatar-other';
    const db = env.authenticatedContext(me).firestore();
    const preset = presetUrl('cat');
    const google = 'https://lh3.googleusercontent.com/avatar';
    const http = 'http://example.com/avatar.png';
    const data = 'data:image/png;base64,AA==';
    const setUser = (uid, photoURL) => updateDoc(doc(db, 'users', uid), { photoURL, lastSeen: serverTimestamp() });
    const setPlayer = (uid, photoURL) => updateDoc(doc(db, 'pokerPlayers', uid), { photoURL, updatedAt: serverTimestamp() });
    await t.test('本人可儲存預設頭像', () => assertSucceeds(setUser(me, preset)));
    await t.test('本人可還原 Google 頭像', () => assertSucceeds(setUser(me, google)));
    await t.test('本人可清除頭像', () => assertSucceeds(setUser(me, null)));
    await t.test('使用者頭像拒絕 HTTP', () => assertFails(setUser(me, http)));
    await t.test('使用者頭像拒絕 data URL', () => assertFails(setUser(me, data)));
    await t.test('拒絕寫入其他使用者頭像', () => assertFails(setUser(other, preset)));
    await t.test('本人可同步牌手頭像', () => assertSucceeds(setPlayer(me, preset)));
    await t.test('拒絕寫入其他牌手頭像', () => assertFails(setPlayer(other, preset)));
    await t.test('牌手頭像拒絕 HTTP', () => assertFails(setPlayer(me, http)));
    await t.test('牌手頭像拒絕 data URL', () => assertFails(setPlayer(me, data)));
  } finally {
    await env.cleanup();
  }
});
