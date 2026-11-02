/**
 * Milestone-2 lobby / create / join screens (wf-01..03).
 */

import { formatCode, shareUrl } from '../net/room.js';

const $ = (sel, el = document) => el.querySelector(sel);

export function fmtChips(n) {
  return Number(n || 0).toLocaleString('en-US');
}

/**
 * @param {HTMLElement} root
 * @param {object} vm
 */
export function renderMpLobby(root, vm) {
  const {
    user,
    player,
    lastRoom,
    leaderPreview = [],
    offline = false,
    onContinue,
    onCreate,
    onJoin,
    onStats,
    onSolo,
    onSignOut,
    onRescue,
    onAvatar,
  } = vm;

  const name = user?.displayName || '玩家';
  const bank = player?.bank ?? 0;
  const inPlay = player?.inPlay ?? 0;
  const total = player?.total ?? bank + inPlay;
  const needRescue = !!(player?.tableRoomId && vm.rescueAvailable);

  const continueCard = lastRoom && !needRescue
    ? `<article class="mp-card mp-c3">
        <h3>繼續上次的牌桌</h3>
        <p class="mp-meta">${esc(lastRoom.name || '牌桌')} · 房號 ${esc(formatCode(lastRoom.code || ''))}</p>
        <p class="mp-meta">座位 ${lastRoom.seat != null ? lastRoom.seat + 1 : '—'} · 籌碼 ${fmtChips(lastRoom.chips || inPlay)}</p>
        <button type="button" class="mp-b1" data-act="continue">回到牌桌</button>
      </article>`
    : needRescue
      ? `<article class="mp-card mp-c3 mp-warn-card">
          <h3>房主失聯：結帳離開</h3>
          <p class="mp-meta">桌上還有籌碼。先結帳回帳戶才能開新桌或加入。</p>
          <button type="button" class="mp-b1" data-act="rescue">結帳離開（帶回 ${fmtChips(inPlay)}）</button>
        </article>`
      : `<article class="mp-card mp-c3">
          <h3>開新牌桌</h3>
          <p class="mp-meta">邀請家人用 Google 登入同一桌。</p>
          <button type="button" class="mp-b1" data-act="create">開新牌桌</button>
        </article>`;

  const ranks = leaderPreview
    .slice(0, 3)
    .map(
      (r, i) =>
        `<li><span>${i + 1}. ${esc(r.displayName || '玩家')}</span><b>${fmtChips(r.total)}</b></li>`,
    )
    .join('');

  root.innerHTML = `
    <div class="mp-shell mp-lobby">
      <header class="mp-top">
        <button type="button" class="mp-avatar" data-act="avatar" aria-label="帳號">
          ${avatarHtml(user)}
          <span>${esc(name)}</span>
        </button>
        <div class="mp-bal">
          <span>帳戶 ${fmtChips(bank)}</span>
          <span>牌桌中 ${fmtChips(inPlay)}</span>
          <strong>總計 ${fmtChips(total)}</strong>
        </div>
      </header>
      ${offline ? '<p class="mp-offline">離線資料</p>' : ''}
      <div class="mp-cols">
        <div class="mp-main">
          ${continueCard}
          <div class="mp-actions">
            <button type="button" class="mp-b2" data-act="create" ${needRescue ? 'disabled' : ''}>開新牌桌</button>
            <button type="button" class="mp-b2" data-act="join">輸入房號加入</button>
          </div>
        </div>
        <aside class="mp-side">
          <article class="mp-card mp-c1" data-act="stats" role="button" tabindex="0">
            <h3>戰績</h3>
            <ol class="mp-ranks">${ranks || '<li class="mp-mute">還沒有戰績</li>'}</ol>
          </article>
        </aside>
      </div>
      <footer class="mp-foot">
        <button type="button" class="mp-link" data-act="solo">同一支手機輪流玩</button>
        <button type="button" class="mp-link" data-act="signout">登出</button>
      </footer>
    </div>`;

  wire(root, {
    continue: onContinue,
    create: onCreate,
    join: onJoin,
    stats: onStats,
    solo: onSolo,
    signout: onSignOut,
    rescue: onRescue,
    avatar: onAvatar,
  });
}

export function renderCreateRoom(root, vm) {
  const { defaults, onCancel, onSubmit, creating, error } = vm;
  root.innerHTML = `
    <div class="mp-shell mp-create">
      <header class="mp-top">
        <h1>開新牌桌</h1>
        <button type="button" class="mp-link" data-act="cancel">取消</button>
      </header>
      <form class="mp-form" id="createForm">
        <label class="mp-float">
          <span>牌桌名稱</span>
          <input name="name" maxlength="20" placeholder="週五牌局" value="${esc(defaults.name || '')}">
        </label>
        <fieldset class="mp-seg">
          <legend>盲注（小盲／大盲）</legend>
          <div class="mp-seg-row" role="radiogroup">
            ${[['5','10'],['10','20'],['25','50'],['50','100']].map(([sb,bb]) => `
              <label class="mp-seg-item">
                <input type="radio" name="blinds" value="${sb}/${bb}" ${defaults.sb==+sb?'checked':''}>
                <span>${sb}/${bb}</span>
              </label>`).join('')}
          </div>
        </fieldset>
        <label class="mp-affix">
          <span>新玩家起始籌碼</span>
          <div class="mp-affix-row">
            <em>送</em>
            <input name="chips" type="number" inputmode="numeric" min="1000" max="100000" step="500" value="${defaults.chips}">
            <em>籌碼</em>
          </div>
          <small>第一次來的人送這筆；回來的人用帳戶餘額。1,000–100,000，每次 500。</small>
        </label>
        ${error ? `<p class="mp-err">${esc(error)}</p>` : ''}
        <div class="mp-rules">
          <h3>固定規則</h3>
          <ul>
            <li>思考時間 30 秒</li>
            <li>補碼 2,000，需房主核准</li>
            <li>斷線 60 秒標暫離</li>
          </ul>
        </div>
        <button type="submit" class="mp-b1" ${creating ? 'disabled' : ''}>${creating ? '開房中…' : '開房'}</button>
      </form>
    </div>`;
  $('[data-act="cancel"]', root)?.addEventListener('click', onCancel);
  $('#createForm', root)?.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const [sb, bb] = String(fd.get('blinds') || '10/20').split('/').map(Number);
    const chips = Number(fd.get('chips'));
    const name = String(fd.get('name') || '').trim();
    onSubmit({ name, sb, bb, newPlayerChips: chips });
  });
}

export function renderShareRoom(root, vm) {
  const { name, code, roomId, onShare, onCopy, onEnter } = vm;
  const url = shareUrl(code, roomId);
  root.innerHTML = `
    <div class="mp-shell mp-share">
      <header class="mp-top"><h1>牌桌開好了</h1></header>
      <p class="mp-table-name">${esc(name)}</p>
      <button type="button" class="mp-code" data-act="copy" aria-label="複製房號">${esc(formatCode(code))}</button>
      <p class="mp-meta">點連結加入，或在大廳輸入房號。房號 24 小時有效。</p>
      <button type="button" class="mp-b1" data-act="share">分享連結</button>
      <button type="button" class="mp-b2" data-act="copy">複製連結</button>
      <button type="button" class="mp-b4" data-act="enter">進入牌桌</button>
      <p class="mp-url">${esc(url)}</p>
    </div>`;
  wire(root, { share: () => onShare(url), copy: () => onCopy(url), enter: onEnter });
}

export function renderJoinCode(root, vm) {
  const { digits = '', joining, error, ended, onBack, onChange, onJoin, onLobby } = vm;
  if (ended) {
    root.innerHTML = `
      <div class="mp-shell mp-join">
        <div class="mp-ended">
          <p>牌桌已結束。這桌已經收了。可以回大廳開新的一桌。</p>
          <button type="button" class="mp-b1" data-act="lobby">回大廳</button>
        </div>
      </div>`;
    wire(root, { lobby: onLobby });
    return;
  }
  const cells = Array.from({ length: 6 }, (_, i) => {
    const d = digits[i] || '';
    const focus = i === digits.length && digits.length < 6;
    return `<input class="mp-digit ${focus ? 'is-focus' : ''}" maxlength="1" inputmode="numeric" pattern="[0-9]*" value="${esc(d)}" data-i="${i}" aria-label="第 ${i + 1} 位">`;
  }).join('');
  root.innerHTML = `
    <div class="mp-shell mp-join">
      <header class="mp-top">
        <h1>輸入房號</h1>
        <button type="button" class="mp-link" data-act="back">返回</button>
      </header>
      <p class="mp-lead">請輸入 6 位數房號</p>
      <div class="mp-digits" id="digitBox">${cells}</div>
      ${error ? `<p class="mp-err">${esc(error)}</p>` : ''}
      <button type="button" class="mp-b1" data-act="join" ${digits.length < 6 || joining ? 'disabled' : ''}>
        ${joining ? '加入中…' : '加入'}
      </button>
      <p class="mp-hint">也可以直接貼上連結</p>
    </div>`;
  wire(root, { back: onBack, join: onJoin });
  const box = $('#digitBox', root);
  box?.addEventListener('input', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement)) return;
    let v = t.value.replace(/\D/g, '').slice(-1);
    t.value = v;
    const next = [...box.querySelectorAll('input')].map((el) => el.value).join('');
    onChange(next);
  });
  box?.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = (e.clipboardData?.getData('text') || '').trim();
    const m = text.match(/room=(\d{6})/i) || text.match(/(\d{6})/);
    if (m) onChange(m[1]);
  });
  box?.addEventListener('keydown', (e) => {
    if (e.key !== 'Backspace') return;
    const t = e.target;
    if (!(t instanceof HTMLInputElement)) return;
    if (!t.value) {
      const i = Number(t.dataset.i);
      const prev = box.querySelector(`input[data-i="${i - 1}"]`);
      if (prev) {
        prev.value = '';
        prev.focus();
        const next = [...box.querySelectorAll('input')].map((el) => el.value).join('');
        onChange(next);
      }
    }
  });
}

function avatarHtml(user) {
  if (user?.photoURL) {
    return `<img src="${esc(user.photoURL)}" alt="" width="36" height="36" onerror="this.outerHTML='<span class=mp-av-fallback>${esc((user.displayName||'?')[0])}</span>'">`;
  }
  return `<span class="mp-av-fallback">${esc((user?.displayName || '?')[0])}</span>`;
}

function wire(root, map) {
  root.querySelectorAll('[data-act]').forEach((el) => {
    el.addEventListener('click', () => {
      const fn = map[el.getAttribute('data-act')];
      fn?.();
    });
  });
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
