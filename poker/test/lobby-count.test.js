import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHostLoop } from '../js/net/host.js';
import { openRowHtml } from '../js/ui/lobby.js';

for (const hostUid of ['new-host', 'host']) {
  test(`${hostUid} 接管過期摘要：不等下一手即更新房間與列表人數`, async () => {
    const priorDocument = globalThis.document;
    globalThis.document = { visibilityState: 'visible' };
    let room = {
      hostUid, name: '牌桌', code: '123', status: 'lobby', rev: 2,
      config: { sb: 10, bb: 20, newPlayerChips: 2000, actionMs: 30000 },
      seatUids: [hostUid, '', '', '', '', ''], stacks: [2000, 0, 0, 0, 0, 0],
      chipTotal: 2000, sess: [null, null, null, null, null, null],
      pub: { phase: 'lobby', handNo: 0, seats: [] },
      lobby: { name: '牌桌', hostName: '房主', hostPhoto: '', blinds: '10/20', seated: 2 },
    };
    let listing, finishListing;
    const listed = new Promise(resolve => { finishListing = resolve; });
    const fs = {
      doc: (_db, ...parts) => parts.join('/'), collection: (_db, ...parts) => parts.join('/'),
      serverTimestamp: () => 1, onSnapshot: () => () => {},
      getDoc: async () => ({ exists: () => true, data: () => ({}) }),
      updateDoc: async (ref, patch) => {
        if (ref === 'pokerRooms/r') {
          assert.equal(patch.rev, room.rev + 1);
          assert.equal(patch.lastMoneyEvent, undefined, '摘要更新不包含帳務事件');
          room = { ...room, ...patch };
        } else { listing = patch; finishListing(); }
      },
    };
    const loop = createHostLoop({ db: {}, fs }, {
      roomId: 'r', uid: hostUid, getRoom: () => room, stats: { enabled: false },
    });
    try {
      loop.start();
      await Promise.race([listed, new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('接管後未更新列表')), 500);
        timer.unref();
      })]);
      assert.equal(room.lobby.seated, 1);
      assert.equal(listing.seated, 1);
      assert.equal(listing.hostUid, hostUid);
    } finally {
      loop.stop();
      if (priorDocument === undefined) delete globalThis.document;
      else globalThis.document = priorDocument;
    }
  });
}

test('完整房間以即時 seatUids 為準；精簡列表保留 seated，空桌顯示 0', () => {
  const stale = { id: 'r', name: '牌桌', code: '123', seated: 6, lobby: { seated: 6 } };
  assert.match(openRowHtml({ ...stale, seatUids: ['host', '', '', '', '', ''] }), /1\/6/);
  assert.match(openRowHtml({ ...stale, seatUids: [] }), /0\/6/);
  assert.match(openRowHtml(stale), /6\/6/);
});

test('列表寫入失敗不記錄成功指紋；同內容可重送，成功後才去重', async () => {
  const source = readFileSync(new URL('../js/net/host.js', import.meta.url), 'utf8');
  const start = source.indexOf('  async function syncLobbyListingDoc(');
  const end = source.indexOf('  /** Non-money follow-up:', start);
  let attempts = 0;
  const context = vm.createContext({
    uid: 'host', db: {}, fs: {}, roomId: 'r', lastLobbyListingKey: '',
    buildLobbyListing: () => ({ seated: 1 }), lobbyListingKey: () => 'same',
    upsertLobbyListing: async () => ++attempts > 1,
  });
  vm.runInContext(source.slice(start, end), context);
  for (let i = 0; i < 3; i++) {
    await context.syncLobbyListingDoc({ hostUid: 'host', status: 'lobby' }, {}, 'lobby');
  }
  assert.equal(attempts, 2);
});
