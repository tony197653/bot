import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCode,
  formatCode,
  buildLobbySummary,
  isRoomOpenStatus,
  ROOM_CONST,
} from '../js/net/room.js';

describe('room code L7', () => {
  it('CODE_DIGITS is 3', () => {
    assert.equal(ROOM_CONST.CODE_DIGITS, 3);
  });

  it('normalizeCode keeps 3 digits', () => {
    assert.equal(normalizeCode('12'), '12');
    assert.equal(normalizeCode('7a2b9'), '729');
    assert.equal(normalizeCode('12345'), '123');
  });

  it('formatCode pads 3-digit', () => {
    assert.equal(formatCode('7'), '007');
    assert.equal(formatCode('42'), '042');
    assert.equal(formatCode('123'), '123');
  });

  it('isRoomOpenStatus', () => {
    assert.equal(isRoomOpenStatus('lobby'), true);
    assert.equal(isRoomOpenStatus('playing'), true);
    assert.equal(isRoomOpenStatus('closed'), false);
  });

  it('buildLobbySummary', () => {
    const s = buildLobbySummary(
      {
        name: '週五',
        config: { sb: 10, bb: 20 },
        seatUids: ['a', 'b', '', '', '', ''],
      },
      { hostName: '阿明', hostPhoto: null },
    );
    assert.deepEqual(s, {
      name: '週五',
      hostName: '阿明',
      hostPhoto: null,
      blinds: '10/20',
      seated: 2,
    });
  });
});
