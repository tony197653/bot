import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickListedOpenTables,
  noteLobbyRoomClosed,
  _resetLobbyClosedSuppress,
} from '../js/net/room.js';

function row(id, status, createdAtMs = 1) {
  return { id, status, createdAtMs };
}

test('ghost leftover is skipped so the real newer table is listed', () => {
  _resetLobbyClosedSuppress();
  const ghost = row('rarc9ioelae', 'lobby', 1);
  const real = row('rnewtable01', 'lobby', 2);
  noteLobbyRoomClosed(ghost.id);
  const listed = pickListedOpenTables([ghost, real]);
  assert.deepEqual(listed.map((t) => t.id), ['rnewtable01']);
});

test('closed status is dropped even if it is the oldest row', () => {
  _resetLobbyClosedSuppress();
  const listed = pickListedOpenTables([
    row('old-closed', 'closed', 1),
    row('real-open', 'playing', 9),
  ]);
  assert.deepEqual(listed.map((t) => t.id), ['real-open']);
});

test('keeps only the oldest still-open table', () => {
  _resetLobbyClosedSuppress();
  const listed = pickListedOpenTables([
    row('a', 'lobby', 5),
    row('b', 'playing', 1),
    row('c', 'lobby', 3),
  ]);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, 'b');
});

test('empty when every leftover is closed or suppressed', () => {
  _resetLobbyClosedSuppress();
  noteLobbyRoomClosed('gone');
  assert.deepEqual(pickListedOpenTables([row('gone', 'lobby'), row('x', 'closed')]), []);
});
