import { it } from 'node:test';
import assert from 'node:assert/strict';
import { hostAddonBatch } from '../js/net/ledger.js';

function fixture(bank = 1000, items = [{ id: 'u_1', amount: 100 }, { id: 'u_2', amount: 200 }]) {
  const data = new Map([
    ['pokerRooms/r', { hostUid: 'h', status: 'open', config: { bb: 20 },
      pub: { phase: 'hand_over' }, seatUids: ['u'], stacks: [500], chipTotal: 500,
      rev: 3, sess: [{ sessionNo: 2, topUps: 0, topUpChips: 0, hands: 7 }] }],
    ['pokerRooms/r/addons/u', { items, seq: 2 }],
    ['pokerPlayers/u', { bank, inPlay: 500, total: bank + 500, tableRoomId: 'r', sessionNo: 2 }],
  ]);
  let writes = [];
  const fb = { db: {}, fs: {
    doc: (_, ...parts) => parts.join('/'), serverTimestamp: () => 'timestamp',
    runTransaction: async (_, fn) => {
      writes = [];
      const result = await fn({
        get: async ref => ({ exists: () => data.has(ref), data: () => structuredClone(data.get(ref)) }),
        update: (ref, value) => writes.push([ref, value, false]),
        set: (ref, value) => writes.push([ref, value, true]),
      });
      for (const [ref, value, replace] of writes) data.set(ref, replace ? value : { ...data.get(ref), ...value });
      return result;
    },
  } };
  return { data, run: () => hostAddonBatch(fb, { hostUid: 'h', roomId: 'r', playerUid: 'u' }) };
}
it('多筆合併上桌、逐筆帳本，帳戶 total 與其他統計不變', async () => {
  const f = fixture();
  assert.equal((await f.run()).amount, 300);
  assert.deepEqual(f.data.get('pokerPlayers/u'), { bank: 700, inPlay: 800, total: 1500,
    tableRoomId: 'r', sessionNo: 2, updatedAt: 'timestamp' });
  const room = f.data.get('pokerRooms/r');
  assert.deepEqual(room.stacks, [800]);
  assert.equal(room.chipTotal, 800);
  assert.equal(room.sess[0].topUps, 2);
  assert.equal(room.sess[0].topUpChips, 300);
  assert.equal(room.sess[0].hands, 7);
  for (const id of ['u_1', 'u_2']) assert.equal(f.data.get(`pokerPlayers/u/ledger/r_2_addon_${id}`).type, 'addon');
  assert.equal((await f.run()).skipped, true);
});
it('帳戶不足則整批拒絕，不扣款、不寫房間與帳本', async () => {
  const f = fixture(250);
  assert.equal((await f.run()).message, '帳戶不足，沒有補碼');
  assert.equal(f.data.get('pokerPlayers/u').bank, 250);
  assert.equal(f.data.get('pokerRooms/r').chipTotal, 500);
  assert.equal(f.data.size, 3);
  assert.deepEqual(f.data.get('pokerRooms/r/addons/u').items, []);
});
it('取消清空不扣款；已離座排隊作廢', async () => {
  const f = fixture(1000, []);
  assert.equal((await f.run()).skipped, true);
  const g = fixture();
  g.data.get('pokerRooms/r').seatUids = [''];
  assert.equal((await g.run()).skipped, true);
  assert.equal(g.data.get('pokerPlayers/u').bank, 1000);
});
it('已入帳編號重播不會再次扣款或覆寫帳本', async () => {
  const f = fixture();
  await f.run();
  f.data.get('pokerRooms/r/addons/u').items = [{ id: 'u_1', amount: 100 }];
  assert.equal((await f.run()).skipped, true);
  assert.equal(f.data.get('pokerPlayers/u').bank, 700);
});
it('牌局中與低於大盲的要求拒絕且不寫入', async () => {
  const f = fixture();
  f.data.get('pokerRooms/r').pub.phase = 'preflop';
  await assert.rejects(f.run, /尚未到補碼時間/);
  const g = fixture(1000, [{ id: 'u_1', amount: 19 }]);
  await assert.rejects(g.run, /補碼資料無效/);
  assert.equal(g.data.get('pokerPlayers/u').bank, 1000);
});

it('R38 補碼可用完非500倍數的全部剩餘帳戶', async () => {
  const f = fixture(1300, [{ id: 'u_1', amount: 1000 }, { id: 'u_2', amount: 300 }]);
  assert.equal((await f.run()).amount, 1300);
  assert.equal(f.data.get('pokerPlayers/u').bank, 0);
  assert.equal(f.data.get('pokerRooms/r').stacks[0], 1800);
});
