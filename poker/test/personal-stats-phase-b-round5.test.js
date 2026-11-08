import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHostLoop } from '../js/net/host.js';
import { createHostStatsRuntime, STATS_ENABLED, STATS_T0 } from '../js/stats/host-runtime.js';
const entry = { roomId: 'r', handId: 'h', uid: 'u', summary: {
  handStartedAt: 100, wonAnyPot: true, vpipOpp: true, vpip: true,
  pfrOpp: true, pfr: false, threeBetOpp: false, threeBet: false, netDelta: 5,
} };
function fixture() {
  const win = new EventTarget(), doc = new EventTarget(); doc.visibilityState = 'visible';
  let host = true, reads = 0, commits = 0, cleans = 0, release;
  let rows = [], remote = [entry], block = false;
  const queue = { list: async () => rows, enqueue: async e => { rows.push(e); return 'added'; },
    dequeue: async () => { rows = []; cleans++; } };
  const opts = { enabled: true, startedAt: 1, roomId: 'r', uid: 'host',
    isCurrentHost: () => host, windowTarget: win, documentTarget: doc, queue,
    remoteQueue: { list: async () => { reads++; if (block) await new Promise(r => { release = r; }); return remote; },
      enqueue: async () => 'added', dequeue: async () => { remote = []; cleans++; } },
    adapter: { readReceipt: async () => null, commit: async () => { commits++; } }, onStatus() {} };
  return { opts, win, doc, queue, host: v => { host = v; }, block: () => { block = true; },
    release: () => release(), state: () => ({ reads, commits, cleans, rows, remote }) };
}
test('B5 host runtime restores acknowledged remote only, coalesces wakes, disposes permanently', async () => {
  const f = fixture(); f.block(); const runtime = createHostStatsRuntime(f.opts);
  runtime.start(); runtime.start();
  const wake = runtime.recovery.wake();
  f.win.dispatchEvent(new Event('online')); f.doc.dispatchEvent(new Event('visibilitychange'));
  await new Promise(r => setImmediate(r)); assert.equal(f.state().reads, 1);
  f.release(); await wake;
  assert.equal(f.state().commits, 1); assert.equal(f.state().cleans, 1);
  runtime.stop(); runtime.start(); f.win.dispatchEvent(new Event('online'));
  await runtime.recovery.wake(); assert.equal(f.state().reads, 1);
});
test('B5 handover during remote read revokes all later submit/cleanup and retains pending', async () => {
  const f = fixture(); f.block(); const runtime = createHostStatsRuntime(f.opts);
  runtime.start(); const wake = runtime.recovery.wake();
  await new Promise(r => setImmediate(r)); f.host(false); runtime.stop(); f.release(); await wake;
  assert.equal(f.state().commits, 0); assert.equal(f.state().cleans, 0);
  assert.equal(f.state().remote.length, 1);
});
test('B5 real host wiring persists HAND_OVER snapshot and wakes independently; stop removes wake listeners', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture(); let room = { hostUid: 'host', config: { sb: 5, bb: 10, newPlayerChips: 1000, actionMs: 30000 }, seatUids: ['host', 'u', null, null, null, null], stacks: [1000, 1000, 0, 0, 0, 0], chipTotal: 2000, sess: Array(6).fill(null), rev: 0 }, account = 'host';
  const fs = { collection: () => '', doc: () => '', onSnapshot: () => () => {}, serverTimestamp: () => 1,
    writeBatch: () => ({ set() {}, async commit() {} }), async updateDoc() {}, async setDoc() {} };
  const priorDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: f.doc });
  t.after(() => { if (priorDocument) Object.defineProperty(globalThis, 'document', priorDocument); else delete globalThis.document; });
  const host = createHostLoop({ fs, db: {} }, { roomId: 'r', uid: 'host',
    getRoom: () => room, getCurrentUid: () => account, stats: f.opts });
  t.after(() => host.stop());
  host.start(); await new Promise(r => setImmediate(r));
  assert.equal(host.startHand(), true);
  host.hostAction({ type: 'FOLD', seat: host.getEngine().actor });
  assert.ok(host.getStatsSession().getLastSnapshot());
  await host.getStatsWriteChain().whenIdle(); await new Promise(r => setImmediate(r));
  assert.ok(f.state().commits >= 2);
  const before = f.state().commits;
  account = 'other'; room = { hostUid: 'other' }; host.stop();
  f.win.dispatchEvent(new Event('online')); await new Promise(r => setImmediate(r));
  assert.equal(f.state().commits, before);
});
test('B5 production disabled runtime makes no subscriptions or adapter requests', () => {
  assert.equal(STATS_ENABLED, false); assert.equal(STATS_T0, null);
  const runtime = createHostStatsRuntime({ isCurrentHost: () => true });
  runtime.start(); runtime.stop(); assert.equal(runtime.queue, null);
});
