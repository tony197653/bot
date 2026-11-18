import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addonOptions, queueAddon, cancelAddons, queuedTotal } from '../js/net/addon-client.js';

test('加碼數量：預設 50 大盲、不足就全部、最少 1 大盲、扣掉已排隊', () => {
  assert.deepEqual(addonOptions(5000, 20), { min: 20, max: 5000, step: 1, amount: 1000 });
  assert.equal(addonOptions(300, 20).amount, 300);
  assert.equal(addonOptions(19, 20), null);
  assert.equal(addonOptions(1000, 20, 990), null);
  assert.equal(addonOptions(1000, 20, 500).max, 500);
});

function fakeFb() {
  const data = new Map([['pokerRooms/r', { config: { bb: 20 } }], ['pokerPlayers/u', { bank: 150000 }]]);
  return { data, fb: { db: {}, fs: { doc: (_, ...p) => p.join('/'), serverTimestamp: () => 'TS',
    runTransaction: async (_, fn) => fn({ get: async r => ({ data: () => data.get(r) }), set: (r, v) => data.set(r, v) }) } } };
}

test('多筆排隊累加、seq 遞增；一顆鈕全部取消', async () => {
  const { data, fb } = fakeFb();
  await queueAddon(fb, { uid: 'u', roomId: 'r', amount: 100, id: 'a' });
  await queueAddon(fb, { uid: 'u', roomId: 'r', amount: 200, id: 'b' });
  const q = data.get('pokerRooms/r/addons/u');
  assert.deepEqual(q, { items: [{ id: 'a', amount: 100 }, { id: 'b', amount: 200 }], seq: 2, at: 'TS' });
  assert.equal(queuedTotal(q), 300);
  await cancelAddons(fb, { uid: 'u', roomId: 'r' });
  assert.deepEqual(data.get('pokerRooms/r/addons/u'), { items: [], seq: 3, at: 'TS' });
  // 房主已處理（清空）後再按取消：不寫入、回報不能取消
  assert.equal((await cancelAddons(fb, { uid: 'u', roomId: 'r' })).cancelled, false);
  assert.equal(data.get('pokerRooms/r/addons/u').seq, 3);
});

test('R45 補碼單筆上限及可用帳戶邊界', async () => {
  assert.equal(addonOptions(150000, 20).max, 100000);
  assert.equal(addonOptions(150000, 20, 60000).max, 90000);
  for (const amount of [19, 20.5, -1, 100001]) {
    const { fb, data } = fakeFb();
    await assert.rejects(queueAddon(fb, { uid: 'u', roomId: 'r', amount }));
    assert.equal(data.has('pokerRooms/r/addons/u'), false);
  }
  const { fb, data } = fakeFb();
  for (const amount of [100000, 1234]) await queueAddon(fb, { uid: 'u', roomId: 'r', amount });
  assert.equal(queuedTotal(data.get('pokerRooms/r/addons/u')), 101234);
  await assert.rejects(queueAddon(fb, { uid: 'u', roomId: 'r', amount: 50000 }));
});
