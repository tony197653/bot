// C1: personal stats overlay (Page ring layout). Reads only pokerStatsPublic/{uid}, once, no polling.
// Overlay keeps the source screen mounted, so table play/timers continue and back restores scroll/tab/filter.
import { AVATAR_PRESETS, avatarInnerHtml, presetKeyOf, presetUrl } from './avatars.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US').replace('-', '−') : '—');
export function pct(num, den) {
  return Number.isInteger(num) && Number.isInteger(den) && den > 0 ? (num / den) * 100 : null;
}
/** Pure view model; state: 'loading'|'error'|'disabled'|'missing'|'ok'. */
export function statsView(agg, { enabled }) {
  if (!enabled) return { state: 'disabled' };
  if (!agg) return { state: 'missing' };
  return { state: 'ok', win: pct(agg.wonHands, agg.validHands), hands: agg.validHands ?? null, net: agg.netChips ?? null,
    vpip: pct(agg.vpipHands, agg.vpipOppHands), pfr: pct(agg.pfrHands, agg.pfrOppHands), tb: pct(agg.threeBetHands, agg.threeBetOppHands) };
}
const pctTxt = (v) => (v == null ? '—' : `${v.toFixed(1)}%`);
function ring(v, { size, r, w, color, cy, label }) {
  const d = v == null ? 0 : Math.max(0, Math.min(100, v));
  const cx = size / 2; const y = cy ?? cx;
  return `${label ? `<text x="${cx}" y="12" text-anchor="middle" dominant-baseline="central" class="ps-rl">${esc(label)}</text>` : ''}
    ${d < 100 ? `<circle cx="${cx}" cy="${y}" r="${r}" fill="none" stroke="#4B505C" stroke-width="${w}" pathLength="100" stroke-dasharray="${100 - d} ${d}" stroke-dashoffset="${-d}" transform="rotate(-90 ${cx} ${y})" data-ps-track/>` : ''}
    ${d > 0 ? `<circle cx="${cx}" cy="${y}" r="${r}" fill="none" stroke="${color}" stroke-width="${w}" pathLength="100" stroke-dasharray="${d} ${100 - d}" transform="rotate(-90 ${cx} ${y})"/>` : ''}
    <text x="${cx}" y="${y}" text-anchor="middle" dominant-baseline="central" class="ps-rv">${pctTxt(v)}</text>`;
}
export function personalStatsHtml({ name, isMe, view, chips, note = '', photoURL = null, canEdit = false }) {
  const title = isMe ? `${esc(name)}（你）` : esc(name);
  const msg = { loading: '讀取中…', error: '統計讀取失敗，請重試', disabled: '尚未開始記錄', missing: '資料尚未完整' }[view.state];
  const v = view.state === 'ok' ? view : {};
  const net = v.net;
  const avatar = avatarInnerHtml(photoURL, name, { size: 40 });
  const avatarHtml = isMe && canEdit
    ? `<button data-sfx="tap" type="button" class="ps-av" data-ps="avatar" aria-label="換頭像">${avatar}</button>`
    : `<span class="ps-av" aria-hidden="true">${avatar}</span>`;
  return `<div data-sfx="tap" class="ps-scrim" data-ps="scrim"></div>
  <section class="ps-sheet" role="dialog" aria-modal="true" aria-label="${title}的統計">
    <header class="ps-head"><div class="ps-id">${avatarHtml}<h2 class="ps-title">${title}</h2></div>
      <button data-sfx="tap" type="button" class="mp-btn-ghost" data-ps="back">返回</button></header>
    ${note ? `<p class="ps-msg" role="status">${esc(note)}</p>` : ''}
    ${msg ? `<p class="ps-msg" role="status">${msg}${view.state === 'error' ? ' <button data-sfx="tap" type="button" class="mp-btn-ghost" data-ps="retry">重試</button>' : ''}</p>` : ''}
    <div class="ps-r1"><div><div class="ps-l">勝率</div><svg viewBox="0 0 132 132" width="132" height="132" role="img" aria-label="勝率 ${pctTxt(v.win)}">${ring(v.win, { size: 132, r: 58, w: 16, color: '#60BF88' }).replace('class="ps-rv"', 'class="ps-rv ps-big"')}</svg></div>
      <div><div class="ps-l">總手數</div><div class="ps-n ps-big">${fmt(v.hands)}</div></div></div>
    <div class="ps-r2"><div><div class="ps-l">淨贏籌碼</div><div class="ps-n${net < 0 ? ' ps-neg' : ''}">${fmt(net)}</div></div>
      <div><div class="ps-l">目前籌碼</div><div class="ps-n">${fmt(chips)}</div></div></div>
    <div class="ps-r3">${[['VPIP', v.vpip, '#49B6F5'], ['PFR', v.pfr, '#E8C547'], ['3-bet', v.tb, '#ff7566']].map(([l, val, c]) => `<svg viewBox="0 0 96 132" width="96" height="132" role="img" aria-label="${l} ${pctTxt(val)}">${ring(val, { size: 96, r: 42, w: 12, color: c, cy: 82, label: l })}</svg>`).join('')}</div>
  </section>`;
}
export function avatarPickerHtml({ name, photoURL, googlePhotoURL, saving = false, failed = false }) {
  const selected = presetKeyOf(photoURL) || 'original';
  const options = [{ key: 'original', label: '原本頭像' }, ...AVATAR_PRESETS];
  const disabled = saving ? ' disabled' : '';
  return `<div data-sfx="tap" class="ps-scrim" data-ps="pick-cancel"></div>
    <section class="ps-pick" role="dialog" aria-modal="true" aria-label="選擇頭像">
      <h2>選擇頭像</h2>
      <div class="ps-pick-grid">${options.map(({ key, label }) => {
        const original = key === 'original';
        return `<button data-sfx="tap" type="button" class="ps-pick-option" data-ps="pick-choice" data-key="${key}" aria-label="${label}" title="${label}" aria-pressed="${key === selected}"${disabled}>
          <span class="ps-pick-av">${avatarInnerHtml(original ? googlePhotoURL : presetUrl(key), name, { size: 60 })}</span>
        </button>`;
      }).join('')}</div>
      ${failed ? '<p class="ps-msg" role="alert">儲存失敗，請重試</p>' : ''}
      <button data-sfx="tap" type="button" class="mp-btn-ghost" data-ps="pick-cancel"${disabled}>取消</button>
    </section>`;
}
const CSS = `.ps-host{position:fixed;inset:0;z-index:60}.ps-scrim{position:absolute;inset:0;background:rgba(0,0,0,.55)}
.ps-sheet{position:absolute;left:50%;top:0;transform:translateX(-50%);width:min(100%,420px);min-height:472px;max-height:100%;overflow:auto;background:#13231a;color:#f3ead2;padding:12px;border-radius:0 0 12px 12px;font-variant-numeric:tabular-nums}
.ps-head{height:48px;display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}.ps-id{display:flex;align-items:center;gap:8px;min-width:0}
.ps-av{width:40px;height:40px;border-radius:50%;background:#21392c;display:flex;align-items:center;justify-content:center;flex-shrink:0}.ps-title{font-size:1.125rem;font-weight:600;margin:0;overflow-wrap:anywhere}
.ps-msg{color:#c9bf9f;margin:0 0 8px}.ps-r1,.ps-r2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;text-align:center;align-items:center}.ps-r1{height:164px}.ps-r2{height:96px;padding:24px 0}
.ps-r1>*,.ps-r2>*,.ps-r3>*{min-width:0}.ps-r1 svg{display:block;margin:0 auto}.ps-l{font-size:17px;line-height:24px;color:#c9bf9f;margin-bottom:8px}.ps-r2 .ps-l{margin:0}
.ps-n{font-size:1.25rem;line-height:24px;font-weight:600;white-space:nowrap}.ps-big{font-size:28px;line-height:36px}.ps-neg{color:#ff7566}
.ps-r3{height:132px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;justify-items:center}.ps-rl{fill:#f3ead2;font-size:17px}.ps-rv{fill:#f3ead2;font-size:20px;font-weight:600}.ps-rv.ps-big{font-size:28px}
.ps-av .av-img,.ps-pick-av .av-img{display:block;border-radius:50%;object-fit:cover}
button.ps-av{width:44px;height:44px;padding:2px;border:0;background:none;color:inherit;font:inherit;cursor:pointer}
.ps-av .av-fallback{display:grid;place-items:center;width:40px;height:40px;border-radius:50%;background:#21392c}
.ps-pick{position:absolute;bottom:0;left:50%;transform:translateX(-50%);box-sizing:border-box;width:min(100%,420px);max-height:80vh;overflow:auto;padding:12px;border-radius:12px 12px 0 0;background:#13231a;color:#f3ead2}
.ps-pick h2{font-size:1.125rem;margin:0 0 12px}
.ps-pick-grid{display:grid;grid-template-columns:repeat(4,60px);grid-auto-rows:60px;gap:24px;justify-content:center;margin-bottom:12px}
.ps-pick-option{display:grid;place-items:center;width:60px;height:60px;padding:0;border:0;background:none;color:inherit;font:inherit;font-size:13px;cursor:pointer}
.ps-pick-av{display:grid;place-items:center;width:60px;height:60px;border-radius:50%;background:#21392c}
.ps-pick-option[aria-pressed="true"] .ps-pick-av{box-shadow:0 0 0 3px #E8C547}`;
/**
 * Open overlay for uid. load(): Promise<agg|null>. Returns close().
 * Browser back closes the overlay (one history entry per open; replaced, never stacked on refresh).
 */
const hhmm = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
/** Offline cache isolated per viewer uid + target uid (spec §2.3); never mixes accounts. */
export function cacheKey(myUid, uid) { return `pokerStats.view.v1:${JSON.stringify([myUid, uid])}`; }
export function openPersonalStats({ uid, name, myUid, enabled, load, chips = null, chipsOf = null, doc = document, win = window,
  storage = globalThis.localStorage, syncHint = () => '', onClose = () => {},
  photoURL = null, googlePhotoURL = null, onPickAvatar = null }) {
  if (!uid) return () => {};
  doc.getElementById('psHost')?.remove();
  if (!doc.getElementById('psCss')) { const st = doc.createElement('style'); st.id = 'psCss'; st.textContent = CSS; doc.head.appendChild(st); }
  const host = doc.createElement('div'); host.id = 'psHost'; host.className = 'ps-host'; doc.body.appendChild(host);
  const focusBack = doc.activeElement;
  let closed = false; let view = { state: enabled ? 'loading' : 'disabled' };
  let note = '';
  const isMe = uid === myUid;
  const canEdit = isMe && typeof onPickAvatar === 'function';
  let picking = false;
  let saving = false;
  let failed = false;
  const render = () => {
    if (closed) return;
    const stats = personalStatsHtml({ name, isMe, view, chips, note, photoURL, canEdit });
    host.innerHTML = picking
      ? `<div inert>${stats}</div>${avatarPickerHtml({ name, photoURL, googlePhotoURL, saving, failed })}`
      : stats;
  };
  const save = async (key) => {
    if (key !== 'original' && !AVATAR_PRESETS.some((preset) => preset.key === key)) return;
    const url = key === 'original' ? googlePhotoURL || null : presetUrl(key);
    saving = true;
    failed = false;
    render();
    try {
      await onPickAvatar(url);
      photoURL = url;
      picking = false;
    } catch {
      failed = true;
    } finally {
      saving = false;
      render();
      host.querySelector?.(picking ? '[aria-pressed="true"]' : '[data-ps="avatar"]')?.focus();
    }
  };
  const fetchOnce = async () => {
    if (!enabled) return;
    view = { state: 'loading' }; render();
    const key = cacheKey(myUid, uid);
    try {
      const agg = await load(uid); view = statsView(agg, { enabled }); if (chipsOf) chips = chipsOf(agg) ?? null;
      note = (uid === myUid && syncHint()) || '';
      try { if (agg) storage?.setItem(key, JSON.stringify({ agg, at: Date.now() })); } catch { /* quota: cache is optional */ }
    } catch {
      let cached = null; try { cached = JSON.parse(storage?.getItem(key) || 'null'); } catch { cached = null; }
      if (cached?.agg) { view = statsView(cached.agg, { enabled }); if (chipsOf) chips = chipsOf(cached.agg) ?? null;
        note = `${win.navigator?.onLine === false ? '連線中斷' : '統計讀取失敗'}・顯示最後更新 ${hhmm(cached.at)} 的資料`; }
      else view = { state: 'error' };
    }
    render();
  };
  const onPop = () => close(true);
  const onKey = (event) => {
    if (picking && event.key === 'Escape') close();
  };
  function close(fromPop = false) {
    if (closed) return; closed = true; host.remove(); win.removeEventListener('popstate', onPop);
    win.removeEventListener('keydown', onKey);
    if (!fromPop && win.history?.state?.ps) win.history.back();
    focusBack?.focus?.();
    onClose();
  }
  host.addEventListener('click', (e) => {
    const action = e.target.closest?.('[data-ps]')?.dataset;
    const act = action?.ps;
    if (picking) {
      if (saving) return;
      if (act === 'pick-choice') void save(action.key);
      else if (act === 'pick-cancel') {
        picking = false;
        render();
        host.querySelector?.('[data-ps="avatar"]')?.focus();
      }
      return;
    }
    if (act === 'avatar' && canEdit) {
      picking = true;
      failed = false;
      render();
      host.querySelector?.('[aria-pressed="true"]')?.focus();
    } else if (act === 'back' || act === 'scrim') close();
    else if (act === 'retry') void fetchOnce();
  });
  win.history?.pushState?.({ ...(win.history.state || {}), ps: 1 }, '');
  win.addEventListener('popstate', onPop);
  win.addEventListener('keydown', onKey);
  render(); void fetchOnce();
  return close;
}

/** PL rule: same table + same close event with its result card shown/dismissed → no toast; otherwise toast once. */
export function shouldToastClosedFallback({ fromRoom, roomId, status, gone, cardShownFor, cardDismissedFor, toastedFor }) {
  if (!fromRoom) return false;
  const ended = gone || !roomId || roomId !== fromRoom || status === 'closed';
  if (!ended) return false;
  if (cardShownFor === fromRoom || cardDismissedFor === fromRoom) return false;
  return toastedFor !== fromRoom;
}
