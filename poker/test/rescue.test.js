import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideRescue, RESCUE_AFTER_MS } from '../js/net/rescue.js';

const NOW = 1_700_000_000_000;
const MIN = 60_000;

describe('decideRescue', () => {
  it('missing room → gone', () => {
    assert.deepEqual(decideRescue({ uid: 'A', room: null, now: NOW }), {
      ok: true,
      reason: 'gone',
    });
  });

  it('closed room → closed even for host', () => {
    assert.deepEqual(
      decideRescue({
        uid: 'H',
        room: { status: 'closed', hostUid: 'H', updatedAtMs: NOW },
        hostBeatMs: NOW,
        now: NOW,
      }),
      { ok: true, reason: 'closed' },
    );
  });

  it('viewer is host → never 房主失聯 even if timestamps ancient', () => {
    assert.deepEqual(
      decideRescue({
        uid: 'H',
        room: {
          status: 'open',
          hostUid: 'H',
          updatedAtMs: NOW - 30 * MIN,
        },
        hostBeatMs: NOW - 30 * MIN,
        now: NOW,
      }),
      { ok: false, reason: null },
    );
  });

  it('non-host: room+presence both ≥10m → gone', () => {
    assert.deepEqual(
      decideRescue({
        uid: 'A',
        room: {
          status: 'open',
          hostUid: 'H',
          updatedAtMs: NOW - 11 * MIN,
        },
        hostBeatMs: NOW - 11 * MIN,
        now: NOW,
      }),
      { ok: true, reason: 'gone' },
    );
  });

  it('non-host: room stale but host heartbeat fresh → no rescue', () => {
    assert.deepEqual(
      decideRescue({
        uid: 'A',
        room: {
          status: 'open',
          hostUid: 'H',
          updatedAtMs: NOW - 11 * MIN,
        },
        hostBeatMs: NOW - MIN,
        now: NOW,
      }),
      { ok: false, reason: null },
    );
  });

  it('non-host: missing presence + room stale → gone', () => {
    assert.deepEqual(
      decideRescue({
        uid: 'A',
        room: {
          status: 'open',
          hostUid: 'H',
          updatedAtMs: NOW - RESCUE_AFTER_MS,
        },
        hostBeatMs: null,
        now: NOW,
      }),
      { ok: true, reason: 'gone' },
    );
  });

  it('non-host: both fresh → no rescue', () => {
    assert.deepEqual(
      decideRescue({
        uid: 'A',
        room: {
          status: 'open',
          hostUid: 'H',
          updatedAtMs: NOW - MIN,
        },
        hostBeatMs: NOW - 5_000,
        now: NOW,
      }),
      { ok: false, reason: null },
    );
  });
});
