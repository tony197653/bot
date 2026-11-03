/**
 * Milestone-2 lobby / create / share (附錄 L2/L7 + BD 大廳定稿 B 三格).
 * 我的牌桌 state classes (.mp-mine.is-host / .is-guest / .is-settle) for BD restyle.
 */

import { formatCode, shareUrl, ROOM_CONST } from '../net/room.js';

const $ = (sel, el = document) => el.querySelector(sel);
const CODE_DIGITS = ROOM_CONST.CODE_DIGITS;

const EMPTY_SVG = `<svg viewBox="0 0 132 88" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <ellipse cx="66" cy="80" rx="46" ry="4.5" fill="rgba(16,27,20,.9)"/>
  <ellipse cx="66" cy="46" rx="48" ry="24" stroke="rgba(214,180,90,.55)" stroke-width="1.6" fill="rgba(33,57,44,.55)"/>
  <ellipse cx="66" cy="46" rx="38" ry="17" stroke="rgba(214,180,90,.22)" stroke-width="1.2"/>
  <circle cx="56" cy="44" r="6" stroke="rgba(230,191,90,.75)" stroke-width="1.4"/><circle cx="56" cy="44" r="2.4" stroke="rgba(230,191,90,.45)" stroke-width="1.2"/>
  <rect x="68" y="37" width="12" height="16" rx="2" stroke="rgba(243,234,210,.6)" stroke-width="1.4"/>
  <path d="M108 16v6M105 19h6" stroke="rgba(230,191,90,.7)" stroke-width="1.4"/><circle cx="22" cy="20" r="2.5" stroke="rgba(201,191,159,.6)" stroke-width="1.3"/>
</svg>`;

const PLUS_SVG = `<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 3.5v11M3.5 9h11"/></svg>`;
const CHEV_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>`;
const ERR_ICO = `<svg class="mp-join-ico" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="5.6"/><path d="M7 4.2v3.4M7 9.7v.1"/></svg>`;
const INFO_ICO = `<svg class="mp-ntc-i" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="10" cy="10" r="7.6"/><path d="M10 9v4.6M10 6.3v.1"/></svg>`;
const X_ICO = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;

const NTC_MS = 5000;
let ntcTimer = 0;
let ntcAction = null;
/** BD r5: sticky when action button present, or opt.sticky. */
let ntcSticky = false;

/** §2.2 gold info toast — plain 5s auto-hide; sticky when action / opt.sticky. */
export function ensureLobbyNotify() {
  let el = document.getElementById('mpNtc');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'mpNtc';
  el.className = 'mp-ntc';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-atomic', 'true');
  el.innerHTML = `${INFO_ICO}
    <div class="mp-ntc-b">
      <p class="mp-ntc-t" id="mpNtcT"></p>
      <p class="mp-ntc-d" id="mpNtcD"></p>
      <button type="button" class="mp-ntc-a" id="mpNtcA" hidden></button>
    </div>
    <button type="button" class="mp-ntc-x" id="mpNtcX" aria-label="關閉通知">${X_ICO}</button>`;
  document.body.appendChild(el);
  const hide = () => hideLobbyNotify();
  $('#mpNtcX', el)?.addEventListener('click', hide);
  $('#mpNtcA', el)?.addEventListener('click', () => {
    const run = ntcAction;
    hide();
    run?.();
  });
  el.addEventListener('pointerenter', () => clearTimeout(ntcTimer));
  el.addEventListener('pointerleave', () => {
    if (el.classList.contains('on')) armNtc();
  });
  el.addEventListener('focusin', () => clearTimeout(ntcTimer));
  el.addEventListener('focusout', (e) => {
    if (!el.contains(e.relatedTarget) && el.classList.contains('on')) armNtc();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && el.classList.contains('on')) hide();
  });
  return el;
}

function armNtc() {
  clearTimeout(ntcTimer);
  if (!ntcSticky) ntcTimer = setTimeout(() => hideLobbyNotify(), NTC_MS);
}

export function hideLobbyNotify() {
  clearTimeout(ntcTimer);
  const el = document.getElementById('mpNtc');
  el?.classList.remove('on');
  if (el) el.dataset.sticky = '';
  ntcAction = null;
  ntcSticky = false;
}

/**
 * @param {string} title
 * @param {string} [desc]
 * @param {{ label:string, run?:()=>void }|null} [action]
 * @param {{ sticky?: boolean }} [opt]
 */
export function showLobbyNotify(title, desc = '', action = null, opt = {}) {
  const el = ensureLobbyNotify();
  const t = $('#mpNtcT', el);
  const d = $('#mpNtcD', el);
  const a = $('#mpNtcA', el);
  if (t) t.textContent = title;
  if (d) d.textContent = desc || '';
  ntcAction = action?.run || null;
  ntcSticky = !!opt.sticky || !!action;
  el.dataset.sticky = ntcSticky ? '1' : '';
  if (a) {
    a.hidden = !action;
    if (action) a.textContent = action.label;
  }
  el.classList.add('on');
  // BD r5 / 紅線 4: actionable or sticky notices never auto-close
  if (ntcSticky) clearTimeout(ntcTimer);
  else armNtc();
}

/** Flash「我的牌桌」border 1.6s (opacity/shadow only). */
export function flashMyTableAttn(root) {
  const mine = $('.mp-mine', root);
  if (!mine) return;
  mine.classList.add('mp-attn');
  setTimeout(() => mine.classList.remove('mp-attn'), 1600);
}

function buildMyCard(vm) {
  const {
    myTable,
    player,
    needRescue,
    rescueReason,
    settleAmt,
    inPlay,
  } = vm;
  if (!needRescue && !myTable) {
    return { html: '', kind: 'none', showCreate: true, statusWord: '在大廳' };
  }

  const isHost =
    !!(player?.hostRoomId && myTable && player.hostRoomId === myTable.roomId);
  const kind = needRescue ? 'settle' : isHost ? 'host' : 'guest';
  const showCreate = kind !== 'host';
  const statusWord =
    kind === 'settle' ? '待結帳' : kind === 'host' ? '我是房主' : '已入座';

  const name = myTable?.name || '牌桌';
  const code = formatCode(myTable?.code || '');
  const blinds = myTable?.blinds || '10/20';
  const seated = myTable?.seated != null ? myTable.seated : '—';
  const seatLabel =
    myTable?.seat != null && myTable.seat >= 0 ? myTable.seat + 1 : '—';
  const chips = fmtChips(
    needRescue ? settleAmt : (myTable?.chips ?? inPlay),
  );
  const hostName = myTable?.hostName || '房主';

  let tag;
  let meta;
  let chipL;
  let note;
  let actHtml;
  let aria;
  let stateClass;

  if (kind === 'settle') {
    tag = '已收桌';
    meta =
      rescueReason === 'closed'
        ? '沒人在線 30 分鐘，已自動收桌'
        : '房主失聯超過 10 分鐘，請結帳離開';
    chipL = '可帶回';
    note = '結帳後籌碼回到帳戶';
    actHtml = `<span>結帳離開（帶回 <span class="mp-act-num">${chips}</span>）</span>`;
    aria = `${name}，已自動收桌。結帳離開，帶回 ${chips} 籌碼`;
    stateClass = 'is-settle';
  } else if (kind === 'host') {
    tag = '房主';
    meta = `房號 ${code} · 盲注 ${blinds} · ${seated}/6 人 · 座位 ${seatLabel}`;
    chipL = '我的籌碼';
    note = '點一下回到牌桌';
    actHtml = `回到牌桌${CHEV_SVG}`;
    aria = `回到牌桌：${name}，房主，${meta}，我的籌碼 ${chips}`;
    stateClass = 'is-host';
  } else {
    tag = '入座中';
    meta = `房主 ${hostName} · 房號 ${code} · 盲注 ${blinds} · ${seated}/6 人`;
    chipL = '我的籌碼';
    note = '點一下回到牌桌';
    actHtml = `回到牌桌${CHEV_SVG}`;
    aria = `回到牌桌：${name}，入座中，${meta}，我的籌碼 ${chips}`;
    stateClass = 'is-guest';
  }

  const act = kind === 'settle' ? 'rescue' : 'continue';
  const html = `<section class="mp-panel mp-mine ${stateClass}" aria-labelledby="mpMyH" data-mine-k="${kind === 'settle' ? 'settle' : 'seat'}">
    <div class="mp-panel-h"><h2 id="mpMyH">我的牌桌</h2><span>${esc(note)}</span></div>
    <button type="button" class="mp-my" data-act="${act}" data-k="${kind === 'settle' ? 'settle' : 'seat'}"
      data-name="${esc(name)}" aria-label="${esc(aria)}">
      <span class="mp-mt">
        <span class="mp-txt">
          <span class="mp-l1">
            <span class="mp-dot" aria-hidden="true"></span>
            <b>${esc(name)}</b>
            <span class="mp-lbl3">${esc(tag)}</span>
          </span>
          <em>${esc(meta)}</em>
        </span>
        <span class="mp-chips-n"><small>${esc(chipL)}</small><strong>${chips}</strong></span>
      </span>
      <span class="mp-act">${actHtml}</span>
    </button>
  </section>`;

  return { html, kind, showCreate, statusWord };
}

export function fmtChips(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function pipsHtml(n) {
  return Array.from({ length: 6 }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('');
}

function rowHostName(t) {
  return t.hostName || t.lobby?.hostName || '房主';
}
function rowHostPhoto(t) {
  return t.hostPhoto || t.lobby?.hostPhoto || '';
}
function rowName(t) {
  return t.name || t.lobby?.name || '牌桌';
}
function rowBlinds(t) {
  return t.blinds || t.lobby?.blinds || `${t.config?.sb || 10}/${t.config?.bb || 20}`;
}

function openRowLabel(t, seated, full) {
  const name = rowName(t);
  const host = rowHostName(t);
  const blinds = rowBlinds(t);
  const code = formatCode(t.code || '');
  return `${name}，房主 ${host}，盲注 ${blinds}，${seated} / 6 人，房號 ${code}${full ? '，已滿，可觀戰' : ''}`;
}

function hostAvHtml(hostName, hostPhoto) {
  if (hostPhoto) {
    return `<img class="mp-hav" src="${esc(hostPhoto)}" alt="" width="36" height="36">`;
  }
  return `<span class="mp-hav" aria-hidden="true">${esc((hostName || '?')[0])}</span>`;
}

function seatedCountOf(t) {
  const raw =
    t.seated ?? t.lobby?.seated ?? (t.seatUids || []).filter(Boolean).length;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(6, Math.trunc(n)));
}

/** @param {object} t open-table row (pokerLobby flat or legacy room) */
export function openRowHtml(t) {
  const seated = seatedCountOf(t);
  const full = seated >= 6;
  const hostName = rowHostName(t);
  const blinds = rowBlinds(t);
  const name = rowName(t);
  const code = formatCode(t.code || '');
  return `<li>
    <button type="button" class="mp-row${full ? ' full' : ''}" data-act="open-table" data-rid="${esc(t.id)}"
      aria-label="${esc(openRowLabel(t, seated, full))}">
      ${hostAvHtml(hostName, rowHostPhoto(t))}
      <span class="mp-txt" aria-hidden="true">
        <span class="mp-l1"><b>${esc(name)}</b><span class="mp-tag">已滿，可觀戰</span></span>
        <em>${esc(hostName)} 開桌 · 房號 ${esc(code)}</em>
      </span>
      <span class="mp-row-side" aria-hidden="true">
        <span class="mp-blinds"><small>盲注</small>${esc(blinds)}</span>
        <span class="mp-seats"><span class="mp-pips">${pipsHtml(seated)}</span><span class="mp-n">${esc(seated)}/6</span></span>
        <span class="mp-go">${full ? '觀戰' : '加入'}${CHEV_SVG}</span>
      </span>
    </button>
  </li>`;
}

function patchOneOpenRow(row, t) {
  const seated = seatedCountOf(t);
  const full = seated >= 6;
  const hostName = rowHostName(t);
  const blinds = rowBlinds(t);
  const name = rowName(t);
  const code = formatCode(t.code || '');
  row.classList.toggle('full', full);
  row.setAttribute('aria-label', openRowLabel(t, seated, full));
  const bName = row.querySelector('.mp-l1 b');
  if (bName && bName.textContent !== name) bName.textContent = name;
  const em = row.querySelector('.mp-txt em');
  if (em) em.textContent = `${hostName} 開桌 · 房號 ${code}`;
  const blindsEl = row.querySelector('.mp-blinds');
  if (blindsEl) {
    const next = `<small>盲注</small>${esc(blinds)}`;
    if (blindsEl.innerHTML !== next) blindsEl.innerHTML = next;
  }
  const go = row.querySelector('.mp-go');
  if (go) {
    const label = full ? '觀戰' : '加入';
    if (!go.textContent.startsWith(label)) {
      go.innerHTML = `${label}${CHEV_SVG}`;
    }
  }
  row.querySelectorAll('.mp-pips i').forEach((p, i) => {
    p.classList.toggle('on', i < seated);
  });
  const num = row.querySelector('.mp-n');
  const seatLabel = `${seated}/6`;
  if (num && num.textContent !== seatLabel) {
    num.classList.add('swap');
    setTimeout(() => {
      num.textContent = seatLabel;
      num.classList.remove('swap');
    }, 110);
  }
}

/**
 * One delegated listener on #mpOpenList — covers full-paint rows and patch inserts.
 * Idempotent: re-paint updates the callback without stacking handlers.
 * @param {HTMLElement|null} listEl
 * @param {(roomId: string) => void} onOpenTable
 */
export function wireOpenTablesDelegate(listEl, onOpenTable) {
  if (!listEl || typeof onOpenTable !== 'function') return;
  listEl._mpOnOpenTable = onOpenTable;
  if (listEl.dataset.mpOpenWired === '1') return;
  listEl.dataset.mpOpenWired = '1';
  const activate = (ev) => {
    const btn = ev.target?.closest?.('[data-act="open-table"]');
    if (!btn || !listEl.contains(btn)) return;
    if (btn.getAttribute('aria-busy') === 'true' || btn.disabled) return;
    const rid = btn.getAttribute('data-rid');
    if (!rid) return;
    if (ev.type === 'keydown') {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
    }
    listEl._mpOnOpenTable?.(rid);
  };
  listEl.addEventListener('click', activate);
  listEl.addEventListener('keydown', activate);
}

/**
 * Row-level patch: update / insert / remove only; stable order preserved in DOM.
 * Full paint only when lobby shell (#mpOpenList) is missing.
 * @returns {boolean} true if DOM was patched; false if full re-render needed
 */
export function patchOpenTables(root, tables) {
  const list = $('#mpOpenList', root);
  const empty = $('#mpOpenEmpty', root);
  const countEl = $('#mpOpenN', root);
  if (!list || !empty) return false;

  const rows = tables || [];
  const idSet = new Set(rows.map((t) => t.id));

  if (countEl) countEl.textContent = String(rows.length);
  list.hidden = rows.length === 0;
  empty.hidden = rows.length !== 0;
  root.querySelector('.mp-lobby')?.classList.toggle('is-empty', rows.length === 0);

  // Remove gone rows
  for (const btn of [...list.querySelectorAll('.mp-row')]) {
    const id = btn.getAttribute('data-rid');
    if (!idSet.has(id)) btn.closest('li')?.remove();
  }

  // Update / insert in stable order
  let anchor = null;
  for (const t of rows) {
    let li = list
      .querySelector(`.mp-row[data-rid="${CSS.escape(t.id)}"]`)
      ?.closest('li');
    if (li) {
      patchOneOpenRow(li.querySelector('.mp-row'), t);
    } else {
      const tmp = document.createElement('ul');
      tmp.innerHTML = openRowHtml(t);
      li = tmp.firstElementChild;
      if (!li) continue;
    }
    if (!anchor) {
      if (list.firstChild !== li) list.insertBefore(li, list.firstChild);
    } else if (anchor.nextSibling !== li) {
      list.insertBefore(li, anchor.nextSibling);
    }
    anchor = li;
  }
  return true;
}

/**
 * @param {HTMLElement} root
 * @param {object} vm
 */
export function renderMpLobby(root, vm) {
  const {
    user,
    player,
    myTable = null,
    openTables = [],
    joinDigits = '',
    joinError = '',
    joining = false,
    offline = false,
    rescueReason = null,
    rescueChips = null,
    onContinue,
    onCreate,
    onJoinCode,
    onOpenTable,
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
  const settleAmt = rescueChips != null ? rescueChips : inPlay;
  const shownInPlay = needRescue ? settleAmt : inPlay;
  const shownTotal = needRescue ? bank + settleAmt : total;

  const mineCard = buildMyCard({
    myTable,
    player,
    needRescue,
    rescueReason,
    settleAmt,
    inPlay,
  });
  const myPanel = mineCard.html;
  const showCreateBtn = mineCard.showCreate;
  const statusWord = vm.lobbyStatus || mineCard.statusWord || '在大廳';
  const tableBal = shownInPlay > 0 ? fmtChips(shownInPlay) : '—';
  const tableBalZero = shownInPlay > 0 ? '' : ' zero';
  const menuPrimary =
    mineCard.kind === 'settle'
      ? { act: 'rescue', label: `結帳離開（帶回 <span class="mp-num">${fmtChips(settleAmt)}</span>）`, settle: true }
      : mineCard.kind === 'host' || mineCard.kind === 'guest'
        ? { act: 'continue', label: '回到牌桌', settle: false }
        : null;

  const openRows =
    openTables.length === 0
      ? ''
      : openTables.map((t) => openRowHtml(t)).join('');

  const openPanel = `<section class="mp-panel mp-open" aria-labelledby="mpOpenH">
    <div class="mp-panel-h">
      <h2 id="mpOpenH">可加入的牌桌</h2>
      <span id="mpOpenCount">${
        offline
          ? '離線，不是最新'
          : `<i class="mp-live-dot" aria-hidden="true"></i><span id="mpOpenN">${openTables.length}</span> 桌 · 即時`
      }</span>
    </div>
    <ul class="mp-rows" id="mpOpenList" ${openTables.length ? '' : 'hidden'}>${openRows}</ul>
    <div class="mp-empty" id="mpOpenEmpty" data-e1 ${openTables.length ? 'hidden' : ''}>
      ${EMPTY_SVG}
      <h3 id="mpEmH">${
        showCreateBtn ? '現在沒有牌桌，開一桌吧' : '現在沒有其他牌桌'
      }</h3>
      <p id="mpEmP">${
        showCreateBtn
          ? '開好之後，家人登入就會在這裡看到。'
          : '家人開桌後會出現在這裡；回你的牌桌請點上面的卡片。'
      }</p>
      ${
        showCreateBtn && !offline
          ? `<button type="button" class="mp-btn-primary" data-act="create" id="mpBtnCreateE">${PLUS_SVG}開新牌桌</button>`
          : ''
      }
    </div>
  </section>`;

  const createBtn = showCreateBtn
    ? offline
      ? `<button type="button" class="mp-btn-primary" data-act="create" id="mpBtnCreate" disabled aria-disabled="true">${PLUS_SVG}開新牌桌</button>
         <p class="mp-meta">沒有網路，連上後才能開桌或加入</p>`
      : `<button type="button" class="mp-btn-primary" data-act="create" id="mpBtnCreate">${PLUS_SVG}開新牌桌</button>`
    : '';

  const joinState = joining ? 'joining' : joinError ? 'error' : joinDigits ? 'typing' : 'empty';
  const remain = CODE_DIGITS - (joinDigits || '').length;
  const statusMsg = joining
    ? `<span class="mp-spin" aria-hidden="true"></span><span class="mp-join-msg">加入中…</span>`
    : joinError
      ? `${ERR_ICO}<span class="mp-join-msg">${esc(joinError)}</span>`
      : joinDigits
        ? `<span class="mp-join-msg">還差 ${remain} 位</span>`
        : `<span class="mp-join-msg">打滿 ${CODE_DIGITS} 位會自動加入，可直接貼上</span>`;

  const cells = [0, 1, 2]
    .map((i) => {
      const d = (joinDigits || '')[i] || '';
      const filled = d ? ' filled' : '';
      const cur =
        !joining && !joinError && (joinDigits || '').length < CODE_DIGITS && i === (joinDigits || '').length
          ? ' cur'
          : '';
      return `<span class="mp-cell${filled}${cur}"><span class="mp-digit">${esc(d)}</span><span class="mp-caret"></span></span>`;
    })
    .join('');

  const joinBox = `<section class="mp-join" aria-label="輸入房號加入">
    <div class="mp-jr">
      <div class="mp-jt">
        <label class="mp-lbl" for="mpJoinCode">有房號？</label>
        <span class="mp-sub">輸入 ${CODE_DIGITS} 位數直接加入</span>
      </div>
      <div class="mp-fb" id="mpJoinWrap" data-s="${joinState}">
        <div class="mp-cells" aria-hidden="true">${cells}</div>
        <input id="mpJoinCode" name="roomcode" type="text" inputmode="numeric" pattern="[0-9]*"
          maxlength="${CODE_DIGITS}" autocomplete="off" autocorrect="off" autocapitalize="off"
          spellcheck="false" enterkeyhint="go" value="${esc(joinDigits)}"
          ${joining || offline ? 'readonly' : ''} aria-busy="${joining ? 'true' : 'false'}"
          aria-invalid="${joinError ? 'true' : 'false'}" aria-describedby="mpJoinStatus"
          ${offline ? 'aria-disabled="true"' : ''}>
      </div>
    </div>
    <div class="mp-join-status" id="mpJoinStatus" data-s="${joinState}" aria-live="polite">${statusMsg}</div>
  </section>`;

  const ranks = (vm.leaderPreview || [])
    .slice(0, 3)
    .map(
      (r, i) =>
        `<li><span>${i + 1}. ${esc(r.displayName || '玩家')}</span><b>${fmtChips(r.total)}</b></li>`,
    )
    .join('');

  const menuIco = {
    back: `<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4.5 6.5 9 11 13.5"/></svg>`,
    settle: `<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 9.5h10M9 4.5v10"/></svg>`,
    stats: `<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M3.5 14.5v-4M9 14.5v-9M14.5 14.5v-6"/></svg>`,
    set: `<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="9" cy="9" r="2.4"/><path d="M9 2.5v2M9 13.5v2M2.5 9h2M13.5 9h2M4.4 4.4l1.4 1.4M12.2 12.2l1.4 1.4M4.4 13.6l1.4-1.4M12.2 5.8l1.4-1.4"/></svg>`,
    pass: `<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="2.5" width="8" height="13" rx="1.8"/><path d="M8 12.8h2"/></svg>`,
    out: `<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3.5H4.5v11H7M11 6l3 3-3 3M14 9H7.5"/></svg>`,
    /* M7 kebab glyph (components c81c4f2): solid dots, no morph */
    dots: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.5" cy="12" r="1.75"/><circle cx="12" cy="12" r="1.75"/><circle cx="18.5" cy="12" r="1.75"/></svg>`,
  };

  root.innerHTML = `
    <div class="mp-shell mp-lobby${openTables.length ? '' : ' is-empty'}">
      <header class="mp-top" data-status="${esc(statusWord)}">
        <button type="button" class="mp-av" data-act="avatar" aria-label="${esc(name)}的帳號">
          ${avatarHtml(user)}
        </button>
        <span class="mp-nm">${esc(name)}</span>
        <span class="mp-stl" id="mpStl">${esc(statusWord)}</span>
        <span class="mp-amt" id="mpAmtAcc" aria-label="帳戶 ${fmtChips(bank)}"><small>帳戶</small><b id="mpBAcc">${fmtChips(bank)}</b></span>
        <span class="mp-amt" id="mpAmtTab" aria-label="牌桌 ${shownInPlay ? fmtChips(shownInPlay) : 0}"><small>牌桌</small><b id="mpBTab" class="${tableBalZero}">${tableBal}</b></span>
        <div class="mp-mw">
          <button type="button" class="mp-mbtn m7" id="mpMenuBtn" aria-label="開啟選單"
            aria-haspopup="menu" aria-expanded="false" aria-controls="mpMenu">${menuIco.dots}</button>
          <div class="mp-menu" id="mpMenu" role="menu" aria-label="功能清單" hidden>
            ${
              menuPrimary
                ? `<button type="button" class="mp-mi pri${menuPrimary.settle ? ' settle' : ''}" role="menuitem" data-act="${menuPrimary.act}" tabindex="-1">${menuPrimary.settle ? menuIco.settle : menuIco.back}<span>${menuPrimary.label}</span></button>
            <div class="mp-sep" role="separator"></div>`
                : ''
            }
            <button type="button" class="mp-mi" role="menuitem" data-act="stats" tabindex="-1">${menuIco.stats}戰績</button>
            <button type="button" class="mp-mi" role="menuitem" data-act="settings" tabindex="-1">${menuIco.set}設定</button>
            <button type="button" class="mp-mi" role="menuitem" data-act="solo" tabindex="-1">${menuIco.pass}同一支手機輪流玩</button>
            <button type="button" class="mp-mi" role="menuitem" data-act="signout" tabindex="-1">${menuIco.out}登出</button>
          </div>
        </div>
      </header>
      ${offline ? '<p class="mp-offline">離線資料</p>' : ''}
      <div class="mp-cols">
        <div class="mp-main">
          ${myPanel}
          ${openPanel}
        </div>
        <div class="mp-side">
          ${createBtn}
          ${joinBox}
          <article class="mp-card mp-c1" data-act="stats" role="button" tabindex="0">
            <h3>戰績</h3>
            <ol class="mp-ranks">${ranks || '<li class="mp-mute">還沒有戰績</li>'}</ol>
          </article>
        </div>
      </div>
    </div>`;

  wire(root, {
    create: onCreate,
    rescue: onRescue,
    stats: onStats,
    solo: onSolo,
    signout: onSignOut,
    avatar: onAvatar,
    settings: () => vm.onSettings?.(),
    continue: onContinue,
  });

  wireLobbyMenu(root);

  // 我的牌桌：整卡按鈕（busy 防連點；固定高度只換動作文案）
  root.querySelectorAll('.mp-my[data-act="continue"], .mp-my[data-act="rescue"]').forEach((el) => {
    el.addEventListener('click', () => {
      if (el.getAttribute('aria-busy') === 'true') return;
      el.setAttribute('aria-busy', 'true');
      const act = el.querySelector('.mp-act');
      const settle = el.getAttribute('data-k') === 'settle';
      if (act) act.textContent = settle ? '結帳中…' : '回座中…';
      // sync top status busy word
      const stl = $('#mpStl', root);
      if (stl) stl.textContent = settle ? '結帳中…' : '回座中…';
      if (settle) onRescue?.();
      else onContinue?.();
    });
  });

  // Delegated: patched/inserted rows join without a full re-paint
  wireOpenTablesDelegate($('#mpOpenList', root), (rid) => onOpenTable?.(rid));

  // menu primary continue/rescue
  root.querySelectorAll('.mp-menu [data-act="continue"], .mp-menu [data-act="rescue"]').forEach((el) => {
    el.addEventListener('click', () => {
      closeLobbyMenu(root);
      const settle = el.getAttribute('data-act') === 'rescue';
      const stl = $('#mpStl', root);
      if (stl) stl.textContent = settle ? '結帳中…' : '回座中…';
      if (settle) onRescue?.();
      else onContinue?.();
    });
  });

  wireJoinBoxes(root, {
    digits: joinDigits,
    joining,
    error: joinError,
    onJoinCode,
  });
}

function closeLobbyMenu(root, focusBtn) {
  const btn = $('#mpMenuBtn', root);
  const menu = $('#mpMenu', root);
  if (!btn || !menu) return;
  menu.classList.remove('on', 'is-open');
  menu.hidden = true;
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-label', '開啟選單');
  if (focusBtn) btn.focus({ preventScroll: true });
}

function wireLobbyMenu(root) {
  const btn = $('#mpMenuBtn', root);
  const menu = $('#mpMenu', root);
  if (!btn || !menu) return;

  const items = () => [...menu.querySelectorAll('[role="menuitem"]')];
  const isOpen = () => btn.getAttribute('aria-expanded') === 'true';
  menu.tabIndex = -1;

  const setOpen = (o) => {
    btn.setAttribute('aria-expanded', o ? 'true' : 'false');
    btn.setAttribute('aria-label', o ? '關閉選單' : '開啟選單');
    if (o) {
      menu.hidden = false;
      requestAnimationFrame(() => {
        menu.classList.add('on', 'is-open');
      });
    } else {
      menu.classList.remove('on', 'is-open');
      menu.hidden = true;
    }
  };

  const open = (focusIdx) => {
    setOpen(true);
    const list = items();
    const target =
      focusIdx == null
        ? menu
        : focusIdx < 0
          ? list[list.length - 1]
          : list[focusIdx];
    target?.focus?.({ preventScroll: true });
  };
  const close = (focusBtn) => closeLobbyMenu(root, focusBtn);

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isOpen()) close(true);
    else open(e.detail === 0 ? 0 : null);
  });

  // M7: ArrowDown/Up on the button opens and focuses first/last item
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      open(0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      open(-1);
    }
  });

  root.addEventListener('keydown', (e) => {
    if (!isOpen()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (!menu.contains(e.target) && e.target !== menu) return;
    const list = items();
    const i = list.indexOf(document.activeElement);
    let j = null;
    if (e.key === 'ArrowDown') j = i < 0 ? 0 : (i + 1) % list.length;
    else if (e.key === 'ArrowUp') j = i < 0 ? list.length - 1 : (i - 1 + list.length) % list.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = list.length - 1;
    else if (e.key === 'Tab') {
      e.preventDefault();
      close(true);
      return;
    }
    if (j !== null) {
      e.preventDefault();
      list[j]?.focus({ preventScroll: true });
    }
  });

  items().forEach((it) => {
    it.addEventListener('pointermove', () => {
      if (document.activeElement !== it) it.focus({ preventScroll: true });
    });
  });

  // One document listener for outside-close (replace prior)
  if (typeof window.__mpMenuOutside === 'function') {
    document.removeEventListener('pointerdown', window.__mpMenuOutside, true);
  }
  window.__mpMenuOutside = (e) => {
    const b = document.getElementById('mpMenuBtn');
    const m = document.getElementById('mpMenu');
    if (!m || (!m.classList.contains('on') && !m.classList.contains('is-open'))) return;
    if (m.contains(e.target) || b?.contains(e.target)) return;
    closeLobbyMenu(document.getElementById('mpRoot') || document);
  };
  document.addEventListener('pointerdown', window.__mpMenuOutside, true);
}

function wireJoinBoxes(root, { digits, joining, error, onJoinCode }) {
  const input = $('#mpJoinCode', root);
  const wrap = $('#mpJoinWrap', root);
  if (!input || !wrap) return;

  const renderCells = () => {
    const v = input.value;
    const err = wrap.dataset.s === 'error';
    const all =
      err &&
      v.length === CODE_DIGITS &&
      input.selectionStart === 0 &&
      input.selectionEnd === CODE_DIGITS;
    wrap.classList.toggle('all', all);
    wrap.querySelectorAll('.mp-cell').forEach((c, i) => {
      const digit = c.querySelector('.mp-digit');
      if (digit) digit.textContent = v[i] || '';
      c.classList.toggle('filled', !!v[i]);
      c.classList.toggle('cur', !all && v.length < CODE_DIGITS && i === v.length);
    });
  };

  const sanitize = (raw) => String(raw || '').replace(/\D/g, '').slice(0, CODE_DIGITS);

  const setStatus = (s, html) => {
    wrap.dataset.s = s;
    const st = $('#mpJoinStatus', root);
    if (st) {
      st.dataset.s = s;
      st.innerHTML = html;
    }
    input.readOnly = s === 'joining' || s === 'success';
    input.setAttribute('aria-invalid', s === 'error' ? 'true' : 'false');
    input.setAttribute('aria-busy', s === 'joining' ? 'true' : 'false');
    renderCells();
  };

  const idle = () => {
    const n = input.value.length;
    if (!n) {
      setStatus(
        'empty',
        `<span class="mp-join-msg">打滿 ${CODE_DIGITS} 位會自動加入，可直接貼上</span>`,
      );
    } else {
      setStatus('typing', `<span class="mp-join-msg">還差 ${CODE_DIGITS - n} 位</span>`);
    }
  };

  input.addEventListener('input', () => {
    if (wrap.dataset.s === 'joining' || wrap.dataset.s === 'success') return;
    const v = sanitize(input.value);
    if (v !== input.value) input.value = v;
    if (v.length === CODE_DIGITS) {
      setStatus(
        'joining',
        `<span class="mp-spin" aria-hidden="true"></span><span class="mp-join-msg">加入中…</span>`,
      );
      onJoinCode?.(v);
    } else {
      idle();
    }
  });

  input.addEventListener('paste', (e) => {
    e.preventDefault();
    if (wrap.dataset.s === 'joining' || wrap.dataset.s === 'success') return;
    const t = e.clipboardData?.getData('text') || '';
    const m =
      t.match(new RegExp(`room=(\\d{${CODE_DIGITS}})(?!\\d)`, 'i')) ||
      t.match(new RegExp(`(?:^|\\D)(\\d{${CODE_DIGITS}})(?:\\D|$)`));
    if (m) input.value = m[1];
    else {
      const a = input.selectionStart ?? input.value.length;
      const b = input.selectionEnd ?? a;
      input.value = sanitize(input.value.slice(0, a) + t + input.value.slice(b));
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  input.addEventListener('keydown', (e) => {
    if (
      e.key === 'Enter' &&
      wrap.dataset.s === 'error' &&
      input.value.length === CODE_DIGITS
    ) {
      e.preventDefault();
      onJoinCode?.(input.value);
    }
  });

  const toEnd = () => {
    if (wrap.dataset.s !== 'error') {
      const n = input.value.length;
      input.setSelectionRange(n, n);
    }
    renderCells();
  };
  input.addEventListener('focus', () => {
    wrap.classList.add('focus');
    requestAnimationFrame(toEnd);
  });
  input.addEventListener('blur', () => wrap.classList.remove('focus'));
  input.addEventListener('click', toEnd);
  input.addEventListener('keyup', renderCells);

  // Sync initial state from vm
  if (joining) {
    setStatus(
      'joining',
      `<span class="mp-spin" aria-hidden="true"></span><span class="mp-join-msg">加入中…</span>`,
    );
  } else if (error) {
    setStatus('error', `${ERR_ICO}<span class="mp-join-msg">${esc(error)}</span>`);
    if (digits) {
      input.value = digits;
      requestAnimationFrame(() => {
        input.focus();
        input.select();
        renderCells();
      });
    }
  } else {
    idle();
  }
  renderCells();
}

export function renderCreateRoom(root, vm) {
  const { defaults, onCancel, onSubmit, onDraft, creating, error } = vm;
  const chipsHintId = 'mpCreateChipsHint';
  root.innerHTML = `
    <div class="mp-shell mp-create">
      <header class="mp-top">
        <h1>開新牌桌</h1>
        <button type="button" class="mp-btn-ghost" data-act="cancel">取消</button>
      </header>
      <form class="mp-form" id="createForm" novalidate>
        <label class="mp-float">
          <span>牌桌名稱 <em class="mp-opt">選填</em></span>
          <input name="name" maxlength="20" placeholder="週五牌局" value="${esc(defaults.name || '')}" autocomplete="off">
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
            <input name="chips" id="mpCreateChips" type="number" inputmode="numeric" min="1000" max="100000" step="500" value="${defaults.chips}" aria-describedby="${chipsHintId}">
            <em>籌碼</em>
          </div>
          <small id="${chipsHintId}">第一次來的人送這筆；回來的人用帳戶餘額。1,000–100,000，每次 500。</small>
        </label>
        <p class="mp-err" id="mpCreateLiveErr" ${error ? '' : 'hidden'}>${esc(error || '')}</p>
        <div class="mp-rules">
          <h3>固定規則</h3>
          <ul>
            <li>思考時間 30 秒</li>
            <li>補碼 2,000，需房主核准</li>
            <li>斷線 60 秒標暫離</li>
          </ul>
        </div>
        <button type="submit" class="mp-btn-primary" ${creating ? 'disabled aria-busy="true"' : ''}>${creating ? '<span class="mp-spin" aria-hidden="true"></span>開房中…' : '開房'}</button>
      </form>
    </div>`;
  $('[data-act="cancel"]', root)?.addEventListener('click', onCancel);
  const form = $('#createForm', root);
  const chipsIn = $('#mpCreateChips', root);
  const liveErr = $('#mpCreateLiveErr', root);
  const persist = () => {
    if (!form || !onDraft) return;
    const fd = new FormData(form);
    const [sb] = String(fd.get('blinds') || '10/20').split('/').map(Number);
    onDraft({
      name: String(fd.get('name') || ''),
      sb,
      chips: Number(fd.get('chips')) || defaults.chips,
    });
  };
  const validateChips = () => {
    const n = Number(chipsIn?.value);
    let msg = '';
    if (!Number.isFinite(n)) msg = '請輸入起始籌碼數字';
    else if (n < 1000 || n > 100000) msg = '起始籌碼要在 1,000–100,000 之間';
    else if (n % 500) msg = '起始籌碼必須是 500 的倍數';
    if (liveErr) {
      if (msg || error) {
        liveErr.hidden = false;
        liveErr.textContent = msg || error;
      } else {
        liveErr.hidden = true;
        liveErr.textContent = '';
      }
    }
    return !msg;
  };
  form?.addEventListener('input', () => {
    persist();
    validateChips();
  });
  form?.addEventListener('change', () => {
    persist();
    validateChips();
  });
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (creating) return;
    persist();
    if (!validateChips()) return;
    const fd = new FormData(e.target);
    const [sb, bb] = String(fd.get('blinds') || '10/20').split('/').map(Number);
    const chips = Number(fd.get('chips'));
    const name = String(fd.get('name') || '').trim(); // M4: blank → "{名字}的牌桌" in doCreate
    onSubmit({ name, sb, bb, newPlayerChips: chips });
  });
}

export function renderShareRoom(root, vm) {
  const { name, code, roomId, onShare, onCopy, onEnter, onLobby } = vm;
  const url = shareUrl(code, roomId);
  root.innerHTML = `
    <div class="mp-shell mp-share">
      <header class="mp-top">
        <h1>牌桌開好了</h1>
        <button type="button" class="mp-btn-ghost" data-act="lobby">回大廳</button>
      </header>
      <p class="mp-table-name">${esc(name)}</p>
      <button type="button" class="mp-code" data-act="copy" aria-label="複製房號">${esc(formatCode(code))}</button>
      <p class="mp-meta">點連結加入，或在大廳輸入房號。房號 24 小時有效。</p>
      <button type="button" class="mp-btn-primary" data-act="share">分享連結</button>
      <button type="button" class="mp-b2" data-act="copy">複製連結</button>
      <button type="button" class="mp-b4" data-act="enter">進入牌桌</button>
      <p class="mp-url">${esc(url)}</p>
    </div>`;
  wire(root, {
    share: () => onShare(url),
    copy: () => onCopy(url),
    enter: onEnter,
    lobby: onLobby,
  });
}

/** 附錄 L2/L7：舊 ③ 輸入頁已併入大廳；深連結失效時仍顯示結束態。 */
export function renderJoinCode(root, vm) {
  const { onLobby, ended, error } = vm;
  const lead = ended
    ? error || '這桌已經結束了，回大廳看看其他牌桌'
    : error
      ? error
      : `請在大廳輸入 ${CODE_DIGITS} 位房號。`;
  root.innerHTML = `
    <div class="mp-shell mp-join-page${ended ? ' mp-ended' : ''}">
      <p class="mp-lead">${esc(lead)}</p>
      <button type="button" class="mp-btn-primary" data-act="lobby">回大廳</button>
    </div>`;
  wire(root, { lobby: onLobby });
}

function avatarHtml(user) {
  if (user?.photoURL) {
    return `<img src="${esc(user.photoURL)}" alt="" width="40" height="40" onerror="this.outerHTML='<span class=mp-av-fallback>${esc((user.displayName||'?')[0])}</span>'">`;
  }
  return `<span class="mp-av-fallback">${esc((user?.displayName || '?')[0])}</span>`;
}

function wire(root, map) {
  root.querySelectorAll('[data-act]').forEach((el) => {
    el.addEventListener('click', () => {
      const act = el.getAttribute('data-act');
      // continue/rescue handled on .mp-my with busy state
      if (act === 'open-table' || act === 'continue' || act === 'rescue') return;
      map[act]?.();
    });
  });
}

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
