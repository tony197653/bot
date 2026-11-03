/**
 * Table 「‹ 大廳」 confirm: cancel stays; host closes; guest leaves; no 我的牌桌.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

describe('‹ 大廳 leave confirm（source contracts）', () => {
  it('dialog: 是否離開牌局？ 取消 / 確認離開 — reuse mp-close-result + btn styles', () => {
    const app = read('js/ui/mp-app.js');
    assert.match(app, /function showLeaveTableConfirm/);
    assert.match(app, /是否離開牌局？/);
    assert.match(app, /mpLeaveConfirmOk/);
    assert.match(app, /確認離開/);
    assert.match(app, /mpLeaveConfirmCancel/);
    assert.match(app, />取消</);
    const dlg = app.slice(
      app.indexOf('function showLeaveTableConfirm'),
      app.indexOf('function showLeaveTableConfirm') + 1600,
    );
    assert.match(dlg, /mp-close-result/);
    assert.match(dlg, /mp-btn-primary/);
    assert.match(dlg, /mp-btn-ghost/);
  });

  it('cancel: dialog hides only — no close/leave', () => {
    const app = read('js/ui/mp-app.js');
    const dlg = app.slice(
      app.indexOf('function showLeaveTableConfirm'),
      app.indexOf('async function confirmLeaveTable'),
    );
    assert.match(dlg, /mpLeaveConfirmCancel[\s\S]*el\.hidden = true/);
    assert.doesNotMatch(
      dlg.slice(dlg.indexOf('mpLeaveConfirmCancel'), dlg.indexOf('mpLeaveConfirmOk')),
      /confirmLeaveTable|performHostCloseRoom|requestLeave/,
    );
  });

  it('confirm: host → performHostCloseRoom (收桌); guest → requestLeave; then clean lobby', () => {
    const app = read('js/ui/mp-app.js');
    const fn = app.slice(
      app.indexOf('async function confirmLeaveTable'),
      app.indexOf('async function confirmLeaveTable') + 2200,
    );
    assert.match(fn, /performHostCloseRoom/);
    assert.match(fn, /showResultCard:\s*false/);
    assert.match(fn, /requestLeave/);
    assert.match(fn, /goLobbyClean/);
    assert.match(fn, /lobbyExitSuppressMine\s*=\s*true/);
  });

  it('no soft-detach keepAlive; ‹ 大廳 wires showLeaveTableConfirm', () => {
    const app = read('js/ui/mp-app.js');
    assert.doesNotMatch(app, /Soft detach/);
    assert.doesNotMatch(app, /const keepAlive\s*=/);
    assert.match(app, /btnBackLobby[\s\S]{0,400}showLeaveTableConfirm/);
    assert.match(app, /lobbyExitSuppressMine/);
    // continueId suppressed after voluntary exit
    assert.match(app, /const continueId = lobbyExitSuppressMine/);
  });

  it('stats 回大廳 still sets screen lobby (not leave confirm)', () => {
    const app = read('js/ui/mp-app.js');
    assert.match(app, /onBack:\s*\(\)\s*=>\s*\{[\s\S]*?screen = 'lobby'/);
  });
});
