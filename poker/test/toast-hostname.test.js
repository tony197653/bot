import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createIntentSender } from '../js/net/client.js';
import { createHostLoop } from '../js/net/host.js';

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

for (const phase of ['pending', 'reading', 'writing', 'inactive']) {
  test(`離桌取消 intent（${phase}）：不再寫入、重試或提示`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    let release, writes = 0, labels = 0, failures = 0, active = true;
    const gate = new Promise(resolve => { release = resolve; });
    const fs = {
      doc: () => 'intent', serverTimestamp: () => 1,
      getDoc: async () => { if (phase === 'reading') await gate; return { exists: () => false }; },
      setDoc: async () => { writes++; if (phase === 'writing') await gate; },
    };
    const sender = createIntentSender({ db: {}, fs }, 'r', 'u', () => active);
    try {
      const sent = sender.send({ type: 'CALL', turn: 1, handNo: 1 }, {
        onPending: () => labels++, onFail: () => failures++,
      });
      await settle();
      if (phase === 'inactive') active = false;
      else sender.clearResend();
      release();
      await sent;
      for (let i = 0; i < 120; i++) { t.mock.timers.tick(250); await settle(); }
      assert.equal(writes, phase === 'reading' ? 0 : 1);
      assert.equal(labels, 0);
      assert.equal(failures, 0);
    } finally { t.mock.timers.reset(); }
  });
}

test('仍在原桌時保留重試及失敗提示', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let writes = 0, failures = 0;
  const sender = createIntentSender({ db: {}, fs: {
    doc: () => 'intent', serverTimestamp: () => 1,
    getDoc: async () => ({ exists: () => false }), setDoc: async () => { writes++; },
  } }, 'r', 'u');
  try {
    await sender.send({ type: 'CALL', turn: 1, handNo: 1 }, { onFail: () => failures++ });
    for (let i = 0; i < 120; i++) { t.mock.timers.tick(250); await settle(); }
    assert.equal(writes, 3);
    assert.equal(failures, 1);
  } finally { sender.clearResend(); t.mock.timers.reset(); }
});

const app = readFileSync(new URL('../js/ui/mp-app.js', import.meta.url), 'utf8');
for (const marker of ['const sendReveal = (type)', 'const send = (type, amount)']) {
  test(`${marker}：回呼只提示原桌，切換房間或回大廳均不提示`, () => {
    const start = app.indexOf('intents?.send(payload, {', app.indexOf(marker));
    const end = app.indexOf('\n    });', start);
    // Reveal 的縮排不同。
    const revealEnd = app.indexOf('\n        });', start);
    const call = app.slice(start, revealEnd >= 0 && revealEnd < end ? revealEnd + 12 : end + 7);
    for (const [screen, roomId, expected] of [['table', 'r', true], ['lobby', 'r', false], ['table', 'other', false]]) {
      let hooks, toasts = 0;
      vm.runInNewContext(call, { screen, roomId, sentRoomId: 'r', payload: {}, isHost: false,
        intents: { send: (_p, h) => { hooks = h; } }, toast: () => toasts++, paintTableChrome: () => {} });
      hooks.onFail();
      hooks.onPending?.();
      assert.equal(toasts > 0, expected);
    }
  });
}

for (const source of ['displayName', 'seat', 'unknown', 'same-host-stale-name', 'same-host-valid']) {
  test(`交棒／啟動摘要 ${source}：人數相同仍修正舊房主名稱與照片`, async () => {
    const previous = globalThis.document;
    globalThis.document = { visibilityState: 'visible' };
    const same = source.startsWith('same-host');
    const expectedName = source === 'unknown' ? 'new-host' : '新房主';
    let room = {
      hostUid: 'new-host', name: '牌桌', code: '123', status: 'lobby', rev: 2,
      config: { sb: 10, bb: 20, newPlayerChips: 2000, actionMs: 30000 },
      seatUids: ['new-host', '', '', '', '', ''], stacks: [2000, 0, 0, 0, 0, 0],
      chipTotal: 2000, sess: Array(6).fill(null),
      pub: { phase: 'lobby', handNo: 0, seats: source === 'seat' ? [{ uid: 'new-host', name: '新房主', chips: 2000 }] : [] },
      lobby: { name: '牌桌', hostName: source === 'same-host-valid' ? '新房主' : '舊房主', hostPhoto: 'https://example.com/old.png', blinds: '10/20', seated: 1 },
    };
    let listing, updates = 0;
    const fs = {
      doc: (_db, ...parts) => parts.join('/'), collection: (_db, ...parts) => parts.join('/'),
      serverTimestamp: () => 1, onSnapshot: () => () => {},
      getDoc: async () => ({ exists: () => true, data: () => ({ hostUid: same ? 'new-host' : 'old-host', hostName: room.lobby.hostName }) }),
      updateDoc: async (ref, patch) => {
        updates++;
        if (ref === 'pokerRooms/r') room = { ...room, ...patch };
        else listing = patch;
      },
    };
    const loop = createHostLoop({ db: {}, fs }, { roomId: 'r', uid: 'new-host', getRoom: () => room,
      displayNameOf: source === 'seat' || source === 'unknown' ? undefined : () => '新房主', stats: { enabled: false } });
    try {
      loop.start();
      await settle();
      if (source === 'same-host-valid') { assert.equal(updates, 0); return; }
      assert.equal(room.lobby.hostName, expectedName);
      assert.equal(listing?.hostName, expectedName);
      assert.equal(listing.hostUid, 'new-host');
      assert.equal(room.lobby.hostPhoto, same ? 'https://example.com/old.png' : '');
      assert.equal(listing.hostPhoto, room.lobby.hostPhoto);
      assert.deepEqual(Object.keys(room.lobby).sort(), ['name', 'hostName', 'hostPhoto', 'blinds', 'seated'].sort());
    } finally { loop.stop(); globalThis.document = previous; }
  });
}
