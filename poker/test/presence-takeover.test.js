import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isTakeoverStatus, takeoverOrder } from '../js/net/presence.js';

describe('presence takeover status', () => {
  it('accepts lobby/playing/open (not only legacy open)', () => {
    assert.equal(isTakeoverStatus('lobby'), true);
    assert.equal(isTakeoverStatus('playing'), true);
    assert.equal(isTakeoverStatus('open'), true);
    assert.equal(isTakeoverStatus('closed'), false);
  });

  it('takeoverOrder skips host and away seats', () => {
    const order = takeoverOrder({
      hostUid: 'H',
      seatUids: ['H', 'A', 'B', '', '', ''],
      pub: { seatedAt: [1, 3, 2, 0, 0, 0], away: { 1: true } },
    });
    assert.deepEqual(order, ['B']);
  });
});
