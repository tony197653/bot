import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guestWaitFirstHandHint } from '../js/ui/table-hints.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('seated guest in lobby sees wait-for-host copy', () => {
  assert.equal(
    guestWaitFirstHandHint({ isHost: false, mySeat: 1, phase: 'lobby', handNo: 0 }),
    '等房主按『開始第一手』',
  );
  assert.equal(
    guestWaitFirstHandHint({ isHost: false, mySeat: 0, phase: 'lobby' }),
    '等房主按『開始第一手』',
  );
});

test('host, standing guest, or later streets get no first-hand hint', () => {
  assert.equal(guestWaitFirstHandHint({ isHost: true, mySeat: 0, phase: 'lobby' }), '');
  assert.equal(guestWaitFirstHandHint({ isHost: false, mySeat: -1, phase: 'lobby' }), '');
  assert.equal(guestWaitFirstHandHint({ isHost: false, mySeat: 1, phase: 'hand_over', handNo: 1 }), '');
  assert.equal(guestWaitFirstHandHint({ isHost: false, mySeat: 1, phase: 'preflop', handNo: 1 }), '');
});

test('mp-app wires the helper into the guest between-hands bar', () => {
  const src = readFileSync(join(root, 'js/ui/mp-app.js'), 'utf8');
  assert.match(src, /refreshOpenTables\(\);\n\s+void sweepLobbyTables/);
  assert.match(src, /guestWaitFirstHandHint/);
  assert.match(src, /等房主按『開始第一手』|waitHint/);
});

test('start button uses existing primary class and shared gold style', () => {
  const app = readFileSync(join(root, 'js/ui/mp-app.js'), 'utf8');
  const css = readFileSync(join(root, 'css/game.css'), 'utf8');
  assert.match(app, /class="primary" id="mpStart"/);
  assert.match(css, /\.btns \.primary/);
});
