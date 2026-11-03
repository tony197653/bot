import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCode,
  formatCode,
  buildLobbySummary,
  buildLobbyListing,
  lobbyListingKey,
  sortLobbyListings,
  isRoomOpenStatus,
  hostRoomCreateDisposition,
  ROOM_CONST,
  LOBBY_LIST_COL,
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
    assert.equal(isRoomOpenStatus('open'), true);
    assert.equal(isRoomOpenStatus('closed'), false);
  });

  it('hostRoomCreateDisposition: idle open → close-then-create; active → resume', () => {
    const now = 1_700_000_000_000;
    const idleMs = ROOM_CONST.IDLE_CLOSE_MS;
    assert.equal(
      hostRoomCreateDisposition('lobby', now - idleMs, now),
      'close-then-create',
    );
    assert.equal(
      hostRoomCreateDisposition('lobby', now - idleMs + 1000, now),
      'resume',
    );
    assert.equal(hostRoomCreateDisposition('closed', now - idleMs, now), 'create');
    assert.equal(hostRoomCreateDisposition('open', now - 31 * 60_000, now), 'close-then-create');
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
      hostPhoto: '',
      blinds: '10/20',
      seated: 2,
    });
  });

  it('buildLobbySummary rejects non-https hostPhoto and clamps seated', () => {
    const s = buildLobbySummary(
      { name: 'x', config: { sb: 5, bb: 10 }, seatUids: [] },
      { hostPhoto: 'javascript:alert(1)', seated: 99 },
    );
    assert.equal(s.hostPhoto, '');
    assert.equal(s.seated, 6);
  });

  it('buildLobbyListing + key + stable sort by createdAt (not updatedAt)', () => {
    assert.equal(LOBBY_LIST_COL, 'pokerLobby');
    const lobby = buildLobbySummary(
      { name: '桌A', config: { sb: 10, bb: 20 }, seatUids: ['h'] },
      { hostName: '房主' },
    );
    const fields = buildLobbyListing(
      { name: '桌A', code: '123', hostUid: 'H', status: 'playing', config: { sb: 10, bb: 20 } },
      lobby,
      'playing',
    );
    assert.equal(fields.status, 'playing');
    assert.equal(fields.seated, 1);
    assert.equal(fields.code, '123');
    const k1 = lobbyListingKey(fields);
    assert.equal(lobbyListingKey({ ...fields }), k1);
    assert.notEqual(lobbyListingKey({ ...fields, seated: 2 }), k1);

    const rows = sortLobbyListings([
      { id: 'b', createdAtMs: 200, updatedAtMs: 900 },
      { id: 'a', createdAtMs: 100, updatedAtMs: 999 },
      { id: 'c', createdAtMs: 100, updatedAtMs: 1 },
    ]);
    assert.deepEqual(
      rows.map((r) => r.id),
      ['a', 'c', 'b'],
      'order by createdAt then id — ignore updatedAt',
    );
  });
});
