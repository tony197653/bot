// 玩家端加碼排隊／取消：用前台實際程式（js/net/addon-client.js）在本機 emulator 測規則放行與拒絕。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import * as fs from 'firebase/firestore';
import { queueAddon, cancelAddons } from '../js/net/addon-client.js';

const endpoint = process.env.FIRESTORE_EMULATOR_HOST;
if (!endpoint || !/^(127\.0\.0\.1|localhost):\d+$/.test(endpoint)) throw Error('必須設定本機 FIRESTORE_EMULATOR_HOST');
const [host, port] = endpoint.split(':');
const rules = readFileSync(new URL('./firestore.rules', import.meta.url), 'utf8');
fs.setLogLevel('silent');

test('addon 前台：成員排隊多筆、全部取消放行；非成員、代別人排、亂改 seq 被擋', async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-addon-client', firestore: { host, port: Number(port), rules } });
  await env.withSecurityRulesDisabled(async c => {
    await fs.setDoc(fs.doc(c.firestore(), 'pokerRooms', 'r1'), { hostUid: 'host', members: ['host', 'p1'], status: 'open', config: { bb: 20 } });
    await fs.setDoc(fs.doc(c.firestore(), 'pokerPlayers', 'p1'), { bank: 150000 });
    await fs.setDoc(fs.doc(c.firestore(), 'pokerPlayers', 'x'), { bank: 150000 });
  });
  const fb = uid => ({ db: env.authenticatedContext(uid).firestore(), fs });
  const read = async () => (await fs.getDoc(fs.doc(fb('p1').db, 'pokerRooms', 'r1', 'addons', 'p1'))).data();
  await assertSucceeds(queueAddon(fb('p1'), { uid: 'p1', roomId: 'r1', amount: 1000, id: 'a' }));
  await assertSucceeds(queueAddon(fb('p1'), { uid: 'p1', roomId: 'r1', amount: 500, id: 'b' }));
  let q = await read();
  assert.deepEqual(q.items, [{ id: 'a', amount: 1000 }, { id: 'b', amount: 500 }]);
  assert.equal(q.seq, 2);
  await assertSucceeds(cancelAddons(fb('p1'), { uid: 'p1', roomId: 'r1' }));
  q = await read();
  assert.deepEqual(q.items, []);
  assert.equal(q.seq, 3);
  // 取消後可再排
  await assertSucceeds(queueAddon(fb('p1'), { uid: 'p1', roomId: 'r1', amount: 20, id: 'c' }));
  assert.equal((await read()).seq, 4);
  // 非成員
  await assertFails(queueAddon(fb('x'), { uid: 'x', roomId: 'r1', amount: 100 }));
  // 代別人排
  await assertFails(queueAddon(fb('host'), { uid: 'p1', roomId: 'r1', amount: 100 }));
  // seq 不遞增
  await assertFails(fs.setDoc(fs.doc(fb('p1').db, 'pokerRooms', 'r1', 'addons', 'p1'), { items: [], seq: 4, at: fs.serverTimestamp() }));
  // 刪除不行
  await assertFails(fs.deleteDoc(fs.doc(fb('p1').db, 'pokerRooms', 'r1', 'addons', 'p1')));
  await env.cleanup();
});
