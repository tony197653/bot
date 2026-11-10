/**
 * Table 「‹ 大廳」 confirm: cancel stays; host closes; guest leaves; no 我的牌桌.
 */
import { describe, it } from 'node:test';
import vm from 'node:vm';
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
    assert.match(fn, /showResultCard: hostMidHand/);
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

  it('mid-hand: ‹ 大廳 always shows confirm without a phase early return', () => {
    const app = read('js/ui/mp-app.js');
    const show = app.slice(
      app.indexOf('function showLeaveTableConfirm'),
      app.indexOf('let statsMode'),
    );
    assert.doesNotMatch(show, /toastLeaveAfterHand/);
    assert.match(show, /isHandInProgress\(\)/);
    assert.match(show, /el\.id = 'mpLeaveConfirm'/);
    assert.match(show, /el\.hidden = false/);
    assert.match(show, /void confirmLeaveTable\(\)/);
  });

  it('race: 確認離開 reaches host close or guest LEAVE without a mid-hand abort', () => {
    const app = read('js/ui/mp-app.js');
    const fn = app.slice(
      app.indexOf('async function confirmLeaveTable'),
      app.indexOf('function tearDownRoom'),
    );
    assert.doesNotMatch(fn, /toastLeaveAfterHand|mpLeaveConfirm/);
    assert.match(fn, /const midHand = isHandInProgress\(\)/);
    assert.match(fn, /if \(midHand\)\s*\{\s*goLobbyClean\(\);\s*watchLeaveSettlement\(fb, uid, leavingRoomId\);\s*return;/);
    assert.match(fn, /if \(isHost\)\s*\{[\s\S]{0,160}const hostMidHand = isHandInProgress\(\);[\s\S]*startHostClose\(\{ showResultCard: hostMidHand \}\)/);
    assert.match(fn, /await requestLeave\(\)/);
    assert.match(fn, /goLobbyClean\(\)/);
  });
});


describe('收桌即時回饋與單次讀取（source contracts）', () => {
  const app = read('js/ui/mp-app.js');
  const host = read('js/net/host.js');
  const section = (src, start, end) => src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)));
  it('同步顯示 pending 卡，再啟動背景收桌；完成才顯示金額', () => {
    const start = section(app, 'function startHostClose', 'async function performHostCloseRoomInner');
    assert.match(start, /showCloseResultCard\(\{ state: 'pending' \}\);\s*closeInFlight = performHostCloseRoom/);
    assert.match(start, /pending.then\(\(chips\) => \{[\s\S]*closeInFlight = null;[\s\S]*showCloseResultCard\(\{ chips, auto: !!opts.auto \}\)/);
    const card = section(app, 'function showCloseResultCard', 'function showHostAloneLeaveDialog');
    assert.match(card, /state === 'pending' \? '結算中…'/);
    assert.match(card, /state !== 'done'[\s\S]*mpCloseLobby[\s\S]*remove\(\)/);
    assert.match(app, /void startHostClose\(\{ showResultCard: true \}\)/);
    const leave = section(app, 'async function confirmLeaveTable', 'function tearDownRoom');
    assert.match(leave, /startHostClose[\s\S]*if \(!hostMidHand\) void dismissCloseResultToLobby\(\);\s*await pending/);
  });
  it('失敗保留同一卡，提供重試與回牌桌，且停止 host loop', () => {
    assert.match(app, /結算沒有完成，請再按一次收桌/);
    assert.match(app, /id="mpCloseRetry">重試/);
    assert.match(app, /id="mpCloseBack">回牌桌/);
    assert.match(app, /state: 'failed', retry: \(\) => startHostClose\(opts\)/);
    const perform = section(app, 'async function performHostCloseRoom(opts', 'function startHostClose');
    assert.match(perform, /finally\s*\{\s*closingLoop\?\.stop\(\)/);
    assert.doesNotMatch(app, /mpClosingNotice/);
  });
  it('大廳摘要不重讀；收桌讀一次並優先整桌結算，拒絕才逐席共用資料', () => {
    const refresh = section(host, 'async function refreshLobbySummary', 'function curStatus');
    assert.doesNotMatch(refresh, /getDoc/);
    const prepare = section(host, 'async function prepareClose', 'function voidHand');
    assert.equal((prepare.match(/fs.getDoc/g) || []).length, 1);
    assert.match(prepare, /VOID_HAND[\s\S]*await writeChain;[\s\S]*fs.getDoc[\s\S]*return current/);
    const cashout = section(host, 'async function cashoutSeat', 'function startHand');
    assert.match(cashout, /let room = opts.room;\s*if \(!room\) \{[\s\S]*fs.getDoc/);
    assert.match(cashout, /await hostCashoutBatch[\s\S]*Object.assign\(room, roomPatch\)/);
    const close = section(app, 'async function performHostCloseRoomInner', 'function showCloseRoomConfirm');
    assert.match(close, /const payoutRoom = await closingLoop.prepareClose\(\)/);
    assert.match(close, /for \(let i[\s\S]*await closingLoop.cashoutSeat\(i, u, \{ room: payoutRoom \}\)/);
    assert.doesNotMatch(close, /Promise.all/);
    assert.match(close, /opts.returnedChips = chips[\s\S]*await closingLoop.closeAll\(payoutRoom\)/);
    assert.match(close, /code !== 'permission-denied'\) throw e[\s\S]*console.warn[\s\S]*await closingLoop.cashoutSeat/);
    assert.match(close, /await closeRoom\(fb, id, closedRoom \? \{ closedRoom \} : \{\}\)/);
  });
  it('開房不等待收桌；停止／關桌後不重排下一手或離座重試', () => {
    assert.doesNotMatch(section(app, 'async function doCreate', 'async function doJoin'), /closeInFlight/);
    for (const [start, end] of [['function scheduleNextHand', 'function afterEngineChange'], ['async function drainSitLeave()', 'async function drainSitLeaveInner']]) {
      assert.match(section(host, start, end), /closing \|\| !running \|\| getRoom\(\)\?\.status === 'closed'/);
    }
    const stop = section(host, 'function stop()', '\n  return {');
    assert.match(stop, /clearInterval\(tickTimer\)/);
    assert.match(stop, /clearNextHandTimer\(\)/);
    assert.match(stop, /clearTimeout\(timer\)/);
  });
});

// Execute the actual dialog functions with a minimal DOM, including button clicks.

describe('收桌確認實際互動', () => {
  const app = read('js/ui/mp-app.js');
  function harness(phase = 'lobby', uid = 'host') {
    const elements = new Map(), handlers = new Map();
    let closes = 0;
    const ctx = vm.createContext({
      document: {
        getElementById: id => elements.get(id),
        createElement: () => ({ setAttribute() {}, hidden: true }),
        body: { appendChild: el => elements.set(el.id, el) },
      },
      $: (selector, el) => ({ addEventListener: (_event, fn) => handlers.set(`${el.id}:${selector}`, fn) }),
      room: { hostUid: 'host', pub: { phase } }, getUser: () => ({ uid }),
      doCloseRoom: () => { closes++; },
      mpCloseRoom: () => { throw new Error('不應顯示第二次確認'); },
    });
    for (const [start, end] of [
      ['function showHostAloneLeaveDialog()', '/** Hand live'],
      ['function isHandInProgress(', '/**\n * Table'],
      ['function showLeaveTableConfirm()', 'let statsMode'],
      ['function showCloseRoomConfirm(', '\nexport function mpCloseRoom()'],
    ]) vm.runInContext(app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start))), ctx);
    return { ctx, elements, handlers, closes: () => closes };
  }
  it('房主獨坐僅一個對話框，按一次收桌直接啟動關桌', () => {
    const h = harness();
    h.ctx.showHostAloneLeaveDialog();
    assert.equal(h.elements.size, 1);
    const modal = h.elements.get('mpHostAlone');
    assert.match(modal.innerHTML, /桌上只剩你，要收桌嗎？/);
    assert.doesNotMatch(modal.innerHTML, /玩家籌碼會結帳回帳戶/);
    h.handlers.get('mpHostAlone:#mpHostAloneClose')();
    assert.equal(h.closes(), 1);
    assert.equal(modal.hidden, true);
    assert.equal(h.elements.has('mpCloseConfirm'), false);
  });
  it('牌局中兩個房主確認入口皆說明作廢；手間與訪客文案正確', () => {
    for (const phase of ['lobby', 'hand_over', 'flop']) {
      const h = harness(phase);
      h.ctx.showCloseRoomConfirm(() => {});
      h.ctx.showLeaveTableConfirm();
      const close = h.elements.get('mpCloseConfirm').innerHTML;
      const leave = h.elements.get('mpLeaveConfirm').innerHTML;
      if (phase === 'flop') {
        assert.match(close, /這一手會作廢，已下注的籌碼退回，所有人照桌上籌碼結帳回帳戶/);
        assert.match(leave, /是否離開並收桌？這一手會作廢，已下注的籌碼退回/);
      } else {
        assert.match(close, /確定收桌？玩家將結帳回帳戶。/);
        assert.match(leave, /是否離開並收桌？玩家將結帳回帳戶。/);
        assert.doesNotMatch(close + leave, /作廢/);
      }
      const guest = harness(phase, 'guest');
      guest.ctx.showLeaveTableConfirm();
      assert.match(guest.elements.get('mpLeaveConfirm').innerHTML, /是否離開牌局？/);
      assert.doesNotMatch(guest.elements.get('mpLeaveConfirm').innerHTML, /作廢|並收桌/);
    }
  });
});
