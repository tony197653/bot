/**
 * Appendix M helpers / contracts (M2 exits, M3 copy, M4 forms, M5 M29–M34).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOM_CONST, normalizeCode } from '../js/net/room.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

describe('附錄 M — 房號與錯誤契約', () => {
  it('M4: 房號一律 3 碼', () => {
    assert.equal(ROOM_CONST.CODE_DIGITS, 3);
    assert.equal(ROOM_CONST.CODE_ATTEMPTS, 10);
    assert.equal(normalizeCode('12'), '12');
    assert.equal(normalizeCode('1234'), '123');
    assert.equal(normalizeCode('a9b8c'), '98');
  });

  it('M2 #9 / room.js: 撞號重抽 10 次且錯誤白話', () => {
    const src = read('js/net/room.js');
    assert.match(src, /CODE_ATTEMPTS\s*=\s*10/);
    assert.match(src, /現在牌桌太多，房號暫時用完了，請稍後再按一次開房/);
  });

  it('M3: friendlyError / join 文案在 mp-app', () => {
    const src = read('js/ui/mp-app.js');
    assert.match(src, /這桌已經結束了，回大廳看看其他牌桌/);
    assert.match(src, /連線太慢，沒有加入成功。請按 Enter 再試一次/);
    assert.match(src, /沒有送出去，可能是網路斷了。請再按一次/);
    assert.match(src, /結帳沒成功，籌碼還在桌上不會不見/);
    assert.match(src, /籌碼數字對不上，為了不算錯先停住/);
    assert.match(src, /牌桌沒開成功，可能是網路斷了，請再按一次/);
  });

  it('M2 #5: 收桌結果卡不自動踢回大廳', () => {
    const src = read('js/ui/mp-app.js');
    assert.match(src, /showCloseResultCard/);
    assert.match(src, /牌桌已收桌，你帶回/);
    assert.match(src, /mpCloseLobby/);
    assert.match(src, /mpCloseStats/);
    assert.match(src, /沒人在線 30 分鐘，已自動收桌/);
    const closedBlock = src.slice(
      src.indexOf("if (r.status === 'closed')"),
      src.indexOf("if (r.status === 'closed')") + 1600,
    );
    assert.match(closedBlock, /showCloseResultCard/);
    assert.match(closedBlock, /silentlySettleClosedBinding/);
    assert.doesNotMatch(closedBlock, /leaveToLobby\(\)/);
  });

  it('M2: 牌桌頂部有 ‹ 大廳', () => {
    const html = read('index.html');
    assert.match(html, /btnBackLobby/);
    assert.match(html, /‹ 大廳/);
    const css = read('css/game.css');
    assert.match(css, /\.mp-table-back/);
    assert.match(css, /min-width:\s*44px/);
  });

  it('PL: 牌桌無底部回大廳／選單大廳／結束牌局；改由 ‹ 大廳＋收桌', () => {
    const app = read('js/ui/mp-app.js');
    assert.doesNotMatch(app, /mpBtnLeaveLobby/);
    assert.doesNotMatch(app, /wireLeaveLobbyBtn/);
    // menu duplicates hidden; close via mpBtnCloseRoom
    assert.match(app, /\$\('#btnLobby'\)\?\.classList\.add\('hidden'\)/);
    assert.match(app, /\$\('#btnEndMenu'\)\?\.classList\.add\('hidden'\)/);
    assert.match(app, /mpBtnCloseRoom/);
    assert.match(app, /btnBackLobby/);
    assert.match(app, /showLeaveTableConfirm/);
    assert.match(app, /function confirmLeaveTable/);
  });

  it('M2 #14: 戰績空狀態有回大廳', () => {
    const src = read('js/ui/stats.js');
    assert.match(src, /還沒有戰績/);
    assert.match(src, /回大廳/);
  });

  it('M1: 寫入動作有 busy 鎖', () => {
    const src = read('js/ui/mp-app.js');
    assert.match(src, /sittingBusy/);
    assert.match(src, /rescueBusy/);
    assert.match(src, /leaveBusy/);
    assert.match(src, /creating/);
    assert.match(src, /openJoinBusy/);
    assert.match(src, /joining/);
  });
});

describe('附錄 M5 — M29～M34 契約', () => {
  it('M29: M2 14 出口字串／元件皆存在', () => {
    const app = read('js/ui/mp-app.js');
    const lobby = read('js/ui/lobby.js');
    const stats = read('js/ui/stats.js');
    const room = read('js/net/room.js');
    const host = read('js/net/host.js');
    // #1 ended card / 回大廳 + clear URL
    assert.match(app, /clearRoomUrlParams/);
    assert.match(app, /這桌已經結束了，回大廳看看其他牌桌/);
    // #2 just-closed toast
    assert.match(app, /這桌剛收桌了，換一桌或開新牌桌/);
    // #3 keep digits + select-all
    assert.doesNotMatch(lobby, /id="mpJoinCode"/);
    assert.match(app, /M2 #3: keep digits/);
    // #4 leave current table first
    assert.match(app, /先離開「/);
    assert.match(app, /回到這一桌/);
    // #5 close result card
    assert.match(app, /showCloseResultCard/);
    // #8 rescue retry copy
    assert.match(app, /結帳沒成功，籌碼還在桌上不會不見/);
    // #9 collision
    assert.match(room, /現在牌桌太多，房號暫時用完了/);
    // #10 quota banner exits
    assert.match(app, /mpQuotaClose/);
    assert.match(app, /mpQuotaLeave/);
    assert.match(app, /mpQuotaLobby/);
    assert.match(app, /今天的免費用量快用完了/);
    // #11 offline
    assert.match(lobby, /沒有網路，連上後才能開桌或加入/);
    assert.match(lobby, /離線，不是最新/);
    // #12 host alone
    assert.match(app, /showHostAloneLeaveDialog/);
    assert.match(app, /桌上只剩你，不能交給別人/);
    assert.match(app, /mpHostAloneClose/);
    assert.match(app, /先不要/);
    assert.doesNotMatch(host, /denyTopUp|approveTopUp/);
    // #14 stats empty
    assert.match(stats, /還沒有戰績/);
    assert.match(stats, /回大廳/);
  });

  it('M30: 收桌不踢人（結果卡路徑）', () => {
    const app = read('js/ui/mp-app.js');
    assert.match(app, /showCloseResultCard/);
    assert.doesNotMatch(
      app.slice(app.indexOf('export function mpCloseRoom'), app.indexOf('function doCloseRoom') + 1400),
      /leaveToLobby\(\)/,
    );
    assert.match(app, /mpCloseLobby/);
    assert.match(app, /mpCloseStats/);
  });

  it('M31: 大廳移除房號輸入，保留內部加入路徑', () => {
    assert.doesNotMatch(read('js/ui/lobby.js'), /id="mpJoinCode"/);
    assert.match(read('js/ui/mp-app.js'), /async function doJoin\(/);
  });

  it('M32: 防重複 busy flags on writes', () => {
    const app = read('js/ui/mp-app.js');
    for (const flag of [
      'creating',
      'joining',
      'sittingBusy',
      'rescueBusy',
      'leaveBusy',
      'openJoinBusy',
    ]) {
      assert.match(app, new RegExp(flag));
    }
    assert.match(app, /收桌中…/);
    assert.match(app, /開房中…|creating/);
  });

  it('M33: 錯誤白話無英文碼露出路徑', () => {
    const app = read('js/ui/mp-app.js');
    assert.match(app, /function friendlyError/);
    assert.match(app, /permission-denied/);
    assert.match(app, /這桌已經結束了，回大廳看看其他牌桌/);
    assert.match(app, /房號 \$\{digits\} 不存在，請再確認/);
    // console keeps codes; UI maps via friendlyError
    assert.match(app, /console\.error/);
  });

  it('M34: 觸控 44 與正文 16 在頂列／橫幅', () => {
    const css = read('css/game.css');
    assert.match(css, /\.mp-table-back\{[^}]*min-width:\s*44px/s);
    assert.match(css, /\.mp-table-back\{[^}]*min-height:\s*44px/s);
    assert.match(css, /\.mp-banner-act\{[^}]*min-width:\s*44px/s);
    assert.match(css, /\.mp-banner-act\{[^}]*min-height:\s*44px/s);
    assert.match(css, /\.mp-close-result-card h2\{[^}]*font-size:\s*16px/s);
    assert.match(css, /\.mp-close-result-card h2\{[^}]*line-height:\s*1\.5/s);
  });
});

describe('附錄 M — rules/indexes 未為本附錄改動（向下相容）', () => {
  it('補碼處理已移除', () => {
    assert.doesNotMatch(read('js/net/host.js'), /denyTopUp|approveTopUp|TOPUP_REQ/);
  });
});
