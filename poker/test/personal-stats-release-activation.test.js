import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHostStatsRuntime, STATS_ENABLED, STATS_T0 } from '../js/stats/host-runtime.js';

/** 2026-11-09 00:00:00 Asia/Taipei — go-live day constant (spec: T0 from release settings). */
export const EXPECTED_T0 = 1794153600000;

test('release activation: production defaults enable stats without __qaStats inject', () => {
  assert.equal(STATS_ENABLED, true);
  assert.equal(STATS_T0, EXPECTED_T0);
  // Formal path: createHostLoop spreads qaStatsOpts() which is undefined off-emu → defaults apply.
  // Minimal stubs: prove defaults create queue/worker without __qaStats / without opts.enabled inject.
  const fs = {
    doc: () => ({}),
    collection: () => ({}),
    getDocFromServer: async () => ({ exists: () => false, data: () => null }),
    runTransaction: async (db, fn) => fn({ get: async () => ({ exists: () => false }), set() {} }),
  };
  const win = new EventTarget();
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  const runtime = createHostStatsRuntime({
    fs,
    db: {},
    roomId: 'r',
    uid: 'host',
    isCurrentHost: () => true,
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
    windowTarget: win,
    documentTarget: doc,
    // no enabled/startedAt — must use STATS_ENABLED / STATS_T0 defaults
  });
  assert.ok(runtime.queue, 'queue must exist when STATS_ENABLED+T0 set (no inject)');
  assert.equal(typeof runtime.recovery?.wake, 'function');
  runtime.start();
  runtime.stop();
});

test('release activation: hands before T0 are rejected by personalSummary period check', async () => {
  const { personalSummary } = await import('../js/stats/submission.js');
  assert.throws(
    () =>
      personalSummary(
        {
          roomId: 'r',
          handId: 'h',
          uid: 'u',
          summary: {
            handStartedAt: EXPECTED_T0 - 1,
            wonAnyPot: false,
            vpipOpp: false,
            vpip: false,
            pfrOpp: false,
            pfr: false,
            threeBetOpp: false,
            threeBet: false,
            netDelta: 0,
          },
        },
        EXPECTED_T0,
      ),
    /invalid stats period/,
  );
  assert.doesNotThrow(() =>
    personalSummary(
      {
        roomId: 'r',
        handId: 'h',
        uid: 'u',
        summary: {
          handStartedAt: EXPECTED_T0,
          wonAnyPot: false,
          vpipOpp: false,
          vpip: false,
          pfrOpp: false,
          pfr: false,
          threeBetOpp: false,
          threeBet: false,
          netDelta: 0,
        },
      },
      EXPECTED_T0,
    ),
  );
});
