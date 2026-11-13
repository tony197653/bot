/** Offline serial-round-trip measurement of the actual open-flow function bodies.
 * Transaction = one round trip (its internal tx.get calls are not counted twice).
 * Background presence/hole/name listeners and engine rendering are isolated.
 * Baseline before production edits (0ms and 2ms): A=0, B=3, C=4, D=12;
 * stale hostRoomId A=3. C/D both start at the enter-table click.
 * D includes the awaited lobby refresh after the authoritative seat write.
 * 固定碼 000 後：A=1、B=4、C=2、D=10。
 * B：legacy listing 預查＋固定 code 讀取＋player 預讀＋原子交易；
 * 移除建立後 listing 查詢，新增 code 讀取，總數仍為 4。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import * as roomNet from '../js/net/room.js';
import * as ledger from '../js/net/ledger.js';
import { createRoomBuyinError, assertMinimumBuyin, wholeBalance, buyinOptions, DEFAULT_NEW_PLAYER_CHIPS } from '../js/net/buyin-policy.js';

globalThis.crypto ||= webcrypto;
const app = readFileSync(new URL('../js/ui/mp-app.js', import.meta.url), 'utf8');
const host = readFileSync(new URL('../js/net/host.js', import.meta.url), 'utf8');
function section(source, start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}
function fakeFirebase(delay = 0) {
  const docs = new Map([['pokerPlayers/u', { bank: 2000, inPlay: 0, total: 2000, sessionNo: 0, tableRoomId: null, hostRoomId: null }]]);
  const calls = [];
  const snapshotErrors = [];
  const snap = ref => ({ id: ref.split('/').at(-1), exists: () => docs.has(ref), data: () => structuredClone(docs.get(ref)) });
  async function trip(kind, fn) {
    calls.push(kind);
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    return fn();
  }
  const write = (ref, value) => docs.set(ref, { ...docs.get(ref), ...value });
  const fs = {
    collection: (_db, ...path) => path.join('/'), query: (...args) => args,
    where: () => null, orderBy: () => null, limit: () => null,
    getDocs: () => trip('getDocs', () => ({ forEach: cb => {
      for (const [ref, data] of docs) if (ref.startsWith('pokerLobby/') && data.status !== 'closed') cb(snap(ref));
    } })),
    doc: (_db, ...path) => path.join('/'), serverTimestamp: () => 1,
    Timestamp: { fromMillis: n => ({ toMillis: () => n }), now: () => 1 },
    getDoc: ref => trip('getDoc', () => snap(ref)),
    updateDoc: (ref, value) => trip('updateDoc', () => write(ref, value)),
    setDoc: (ref, value) => trip('setDoc', () => write(ref, value)),
    runTransaction: (_db, fn) => trip('runTransaction', async () => {
      const writes = [];
      const result = await fn({ get: async ref => snap(ref), set: (r, v) => writes.push([r, v]), update: (r, v) => writes.push([r, v]) });
      for (const [r, v] of writes) write(r, v);
      return result;
    }),
    writeBatch: () => {
      const writes = [];
      return { set: (r, v) => writes.push([r, v]), update: (r, v) => writes.push([r, v]), commit: () => trip('batch.commit', () => writes.forEach(([r, v]) => write(r, v))) };
    },
    onSnapshot: (ref, cb, onErr) => {
      const error = snapshotErrors.shift();
      pending = trip('onSnapshot:first', () => error ? onErr(error) : cb(snap(ref)));
      return () => {};
    },
  };
  let pending;
  return { db: {}, fs, docs, calls, snapshotErrors, settle: () => pending };
}
function harness(fb) {
  const noop = () => {};
  const ctx = vm.createContext({
    ...roomNet, ...ledger, createRoomBuyinError, assertMinimumBuyin, wholeBalance, buyinOptions, DEFAULT_NEW_PLAYER_CHIPS,
    setTimeout: () => 1, clearTimeout: () => {}, enterRoomTimeout: null,
    console, Date, Promise, getFirebase: () => fb, getUser: () => ({ uid: 'u', displayName: 'Host' }),
    playerDoc: structuredClone(fb.docs.get('pokerPlayers/u')), screen: 'lobby', rescueOk: false,
    createDraft: {}, creating: false, createError: '', shareInfo: null,
    closingFreeze: false, hostSitPending: false, closeResultDismissedFor: null,
    closeResultShownFor: null, closeResultChipsShown: 0, pendingCloseReturnChips: null,
    lastKnownSelfTableChips: 0, lobbyClosedSynced: new Set(), roomId: null, room: null,
    roomGoneFor: null, joinEnded: false, joinError: '', document: { getElementById: () => null },
    hostRoomUpdatedMs: null, hostBeatMs: null, watchHostBeat: noop, updateHostDisconnect: noop,
    stopRoom: null, hostLoop: null, presence: null, intents: null, stopHole: null,
    animQ: null, lastRecvAt: 0, nameCache: {}, getLastRoom: () => null,
    enterOpenTable: noop, silentlySettleClosedBinding: async () => {},
    consumeRoomSound: noop, startRoomSound: noop, tearDownRoom: noop, paintEnterShell: noop, paintTableChrome: noop, cachePlayerName: noop,
    startPresence: () => ({}), createIntentSender: () => ({}), listenHole: noop,
    qaStatsOpts: () => ({}), displayNameOf: () => 'Host', createAnimQueue: () => ({}),
    toast: () => { ctx.feedback ??= fb.calls.length; },
    paint: () => { ctx.marks[ctx.screen] = fb.calls.length; }, marks: {},
    friendlyError: e => { throw e; },
  });
  ctx.listenRoom = (fb, id, onData, onErr) => roomNet.listenRoom(fb, id, r => { ctx.firstData = onData(r); }, e => { ctx.firstError = onErr(e); });
  // Execute the real host seat write + lobby refresh; isolate engine and background loop.
  ctx.createHostLoop = (_fb, opts) => {
    const hostCtx = vm.createContext({ ...ctx, fs: fb.fs, db: fb.db, ...opts,
      closing: false, running: true, writeChain: Promise.resolve(), getRoom: () => fb.docs.get(`pokerRooms/${opts.roomId}`), nightKeyOf: () => '20261109', onLocalState: noop,
      engine: {}, actionSeq: 0, seatedAt: [], lastWriteAt: 0,
      applyAction: () => ({}), buildPub: () => ({}), recordWrite: noop,
      playerName: () => 'Host', curStatus: () => 'lobby',
      syncLobbyListingDoc: async (r, lobby, status) => roomNet.upsertLobbyListing(fb, opts.roomId, roomNet.buildLobbyListing(r, lobby, status)),
    });
    vm.runInContext(section(host, '  let lobbyHostUid =', '\n  function ensureEngine(') + section(host, '  async function refreshLobbySummary(', '\n  function curStatus(') + section(host, '  function seatPlayer(', '\n  async function cashoutSeat('), hostCtx);
    return { start: noop, seatPlayer: async (...args) => { await hostCtx.seatPlayer(...args); ctx.seatedAtRoundTrips = fb.calls.length; } };
  };
  vm.runInContext(section(app, 'async function onCreateTable()', '\nasync function doJoin(') + section(app, 'async function enterRoom(', '\nfunction paintTableChrome('), ctx);
  return ctx;
}

for (const delay of [0, 2]) test(`open flow serial round trips (injected latency ${delay}ms)`, async t => {
  const fb = fakeFirebase(delay);
  const ctx = harness(fb);
  await ctx.onCreateTable();
  const A = ctx.marks.create;
  fb.calls.length = 0;
  await ctx.doCreate({ name: 'Test', sb: 10, bb: 20, newPlayerChips: 2000 });
  const B = ctx.marks.share;
  assert.ok(ctx.shareInfo?.roomId);
  assert.equal(ctx.shareInfo.code, '000');
  assert.deepEqual(fb.calls, ['getDoc', 'getDocs', 'getDoc', 'getDoc', 'runTransaction']);
  fb.calls.length = 0;
  await ctx.enterRoom(ctx.shareInfo.roomId, { asHostSit: true });
  await fb.settle();
  await ctx.firstData;
  const C = ctx.marks.table;
  const D = ctx.seatedAtRoundTrips;
  assert.ok(ctx.room?.config, 'table paint has actual room data');
  const stored = fb.docs.get(`pokerRooms/${ctx.shareInfo.roomId}`);
  assert.equal(stored.seatUids[0], 'u');
  assert.equal(stored.stacks[0], 2000);
  assert.equal(fb.docs.get('pokerPlayers/u').bank, 0);
  t.diagnostic(JSON.stringify({ A, B, C, D }));
  assert.deepEqual({ A, B, C, D }, { A: 1, B: 5, C: 2, D: 10 });
});

test('stale host pointer: form round trips', async t => {
  const fb = fakeFirebase(2);
  fb.docs.get('pokerPlayers/u').hostRoomId = 'gone';
  const ctx = harness(fb);
  await ctx.onCreateTable();
  t.diagnostic(`A(stale hostRoomId)=${ctx.marks.create}; feedback=${ctx.feedback}`);
  assert.equal(ctx.marks.create, 3);
  assert.equal(ctx.feedback, 0, 'existing toast runs before the first network wait');
});

for (const scenario of ['join-success', 'join-denied-again', 'unavailable', 'ended']) {
  test(`subscription fallback: ${scenario}`, async () => {
    const fb = fakeFirebase(2);
    const created = await roomNet.createRoom(fb, { uid: 'u', sb: 10, bb: 20, newPlayerChips: 2000 });
    fb.calls.length = 0;
    fb.snapshotErrors.push({ code: scenario === 'unavailable' ? 'unavailable' : 'permission-denied' });
    if (scenario === 'join-denied-again') fb.snapshotErrors.push({ code: 'permission-denied' });
    const ctx = harness(fb);
    let joins = 0;
    ctx.getLastRoom = () => ({ code: created.code });
    ctx.joinByCode = async (_fb, code, uid, id) => {
      joins++;
      assert.equal(code, created.code);
      assert.equal(uid, 'u');
      assert.equal(id, created.roomId);
      return scenario === 'ended' ? { ended: true } : { roomId: id };
    };
    await ctx.enterRoom(created.roomId);
    await fb.settle();
    await ctx.firstError;
    await fb.settle();
    await ctx.firstData;
    await ctx.firstError;
    assert.equal(joins, scenario === 'unavailable' ? 0 : 1, 'retry at most once and only on permission-denied');
    assert.equal(ctx.screen, scenario === 'join-success' ? 'table' : 'join');
  });
}

test('buyin return value covers committed and already-bound player', async () => {
  const fb = fakeFirebase();
  const first = await ledger.buyinAll(fb, 'u', 'r1', 20);
  const { updatedAt: _writtenAt, ...stored } = fb.docs.get('pokerPlayers/u');
  assert.deepEqual(first.player, stored);
  const second = await ledger.buyinAll(fb, 'u', 'r1', 20);
  assert.equal(second.skipped, true);
  const { updatedAt: _readAt, ...reread } = second.player;
  assert.deepEqual(reread, first.player);
  assert.equal(fb.calls.filter(c => c === 'batch.commit').length, 1);
});
