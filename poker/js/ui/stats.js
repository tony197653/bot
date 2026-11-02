/**
 * Stats / leaderboard screen (wf-08).
 */

import { nightKeyOf } from '../net/ledger.js';
import { fmtChips } from './lobby.js';

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {HTMLElement} root
 * @param {object} vm
 */
export function renderStats(root, vm) {
  const {
    mode = 'total',
    rows = [],
    nights = [],
    nightKey,
    myUid,
    offline,
    onBack,
    onMode,
    onNight,
  } = vm;

  const body =
    mode === 'total'
      ? `<table class="mp-table">
          <thead><tr><th>#</th><th>玩家</th><th>總籌碼</th><th></th></tr></thead>
          <tbody>
            ${
              rows.length
                ? rows
                    .map((r, i) => {
                      const mine = r.uid === myUid ? ' is-me' : '';
                      const playing = r.tableRoomId ? '<span class="mp-tag">牌桌中</span>' : '';
                      return `<tr class="${mine}"><td>${i + 1}</td><td>${esc(r.displayName)}${playing}</td><td class="num">${fmtChips(r.total)}</td><td></td></tr>`;
                    })
                    .join('')
                : '<tr><td colspan="4">還沒有戰績</td></tr>'
            }
          </tbody>
        </table>`
      : `<div class="mp-night-pick">
          ${nights
            .map(
              (k) =>
                `<button type="button" class="mp-chip ${k === nightKey ? 'is-on' : ''}" data-night="${esc(k)}">${esc(k)}</button>`,
            )
            .join('') || `<button type="button" class="mp-chip is-on" data-night="${esc(nightKeyOf())}">${esc(nightKeyOf())}</button>`}
        </div>
        <table class="mp-table">
          <thead><tr><th>#</th><th>玩家</th><th>淨輸贏</th><th>補碼</th></tr></thead>
          <tbody>
            ${
              rows.length
                ? rows
                    .map((r, i) => {
                      const mine = r.uid === myUid ? ' is-me' : '';
                      const net = r.net ?? 0;
                      return `<tr class="${mine}"><td>${i + 1}</td><td>${esc(r.name || r.displayName)}</td><td class="num">${net >= 0 ? '+' : ''}${fmtChips(net)}</td><td class="num">${r.topUps || 0}</td></tr>`;
                    })
                    .join('')
                : '<tr><td colspan="4">這一晚還沒有戰績</td></tr>'
            }
          </tbody>
        </table>
        <p class="mp-meta">今晚加總（全部結帳後應為 0）</p>`;

  root.innerHTML = `
    <div class="mp-shell mp-stats">
      <header class="mp-top">
        <h1>戰績</h1>
        <button type="button" class="mp-link" data-act="back">返回</button>
      </header>
      ${offline ? '<p class="mp-offline">離線資料</p>' : ''}
      <div class="mp-seg-row" role="tablist">
        <button type="button" class="mp-seg-item ${mode === 'total' ? 'is-on' : ''}" data-mode="total">總排行</button>
        <button type="button" class="mp-seg-item ${mode === 'night' ? 'is-on' : ''}" data-mode="night">每晚輸贏</button>
      </div>
      ${body}
    </div>`;

  root.querySelector('[data-act="back"]')?.addEventListener('click', onBack);
  root.querySelectorAll('[data-mode]').forEach((el) => {
    el.addEventListener('click', () => onMode(el.getAttribute('data-mode')));
  });
  root.querySelectorAll('[data-night]').forEach((el) => {
    el.addEventListener('click', () => onNight(el.getAttribute('data-night')));
  });
}
