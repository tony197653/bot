// C1: personal stats overlay (Page ring layout). Reads only pokerStatsPublic/{uid}, once, no polling.
// Overlay keeps the source screen mounted, so table play/timers continue and back restores scroll/tab/filter.
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
    <circle cx="${cx}" cy="${y}" r="${r}" fill="none" stroke="#4B505C" stroke-width="${w}"/>
    ${d > 0 ? `<circle cx="${cx}" cy="${y}" r="${r}" fill="none" stroke="${color}" stroke-width="${w}" pathLength="100" stroke-dasharray="${d} ${100 - d}" transform="rotate(-90 ${cx} ${y})"/>` : ''}
    <text x="${cx}" y="${y}" text-anchor="middle" dominant-baseline="central" class="ps-rv">${pctTxt(v)}</text>`;
}
export function personalStatsHtml({ name, isMe, view, chips }) {
  const title = isMe ? `${esc(name)}（你）` : esc(name);
  const msg = { loading: '讀取中…', error: '統計讀取失敗，請重試', disabled: '尚未開始記錄', missing: '資料尚未完整' }[view.state];
  const v = view.state === 'ok' ? view : {};
  const net = v.net;
  return `<div class="ps-scrim" data-ps="scrim"></div>
  <section class="ps-sheet" role="dialog" aria-modal="true" aria-label="${title}的統計">
    <header class="ps-head"><div class="ps-id"><span class="ps-av" aria-hidden="true">${esc((name || '?')[0])}</span><h2 class="ps-title">${title}</h2></div>
      <button type="button" class="mp-btn-ghost" data-ps="back">返回</button></header>
    ${msg ? `<p class="ps-msg" role="status">${msg}${view.state === 'error' ? ' <button type="button" class="mp-btn-ghost" data-ps="retry">重試</button>' : ''}</p>` : ''}
    <div class="ps-r1"><div><div class="ps-l">勝率</div><svg viewBox="0 0 132 132" width="132" height="132" role="img" aria-label="勝率 ${pctTxt(v.win)}">${ring(v.win, { size: 132, r: 58, w: 16, color: '#60BF88' }).replace('class="ps-rv"', 'class="ps-rv ps-big"')}</svg></div>
      <div><div class="ps-l">總手數</div><div class="ps-n ps-big">${fmt(v.hands)}</div></div></div>
    <div class="ps-r2"><div><div class="ps-l">淨贏籌碼</div><div class="ps-n${net < 0 ? ' ps-neg' : ''}">${fmt(net)}</div></div>
      <div><div class="ps-l">目前籌碼</div><div class="ps-n">${fmt(chips)}</div></div></div>
    <div class="ps-r3">${[['VPIP', v.vpip, '#49B6F5'], ['PFR', v.pfr, '#E8C547'], ['3-bet', v.tb, '#ff7566']].map(([l, val, c]) => `<svg viewBox="0 0 96 132" width="96" height="132" role="img" aria-label="${l} ${pctTxt(val)}">${ring(val, { size: 96, r: 42, w: 12, color: c, cy: 82, label: l })}</svg>`).join('')}</div>
  </section>`;
}
const CSS = `.ps-host{position:fixed;inset:0;z-index:60}.ps-scrim{position:absolute;inset:0;background:rgba(0,0,0,.55)}
.ps-sheet{position:absolute;left:50%;top:0;transform:translateX(-50%);width:min(100%,420px);min-height:472px;max-height:100%;overflow:auto;background:#13231a;color:#f3ead2;padding:12px;border-radius:0 0 12px 12px;font-variant-numeric:tabular-nums}
.ps-head{height:48px;display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}.ps-id{display:flex;align-items:center;gap:8px;min-width:0}
.ps-av{width:40px;height:40px;border-radius:50%;background:#21392c;display:flex;align-items:center;justify-content:center;flex-shrink:0}.ps-title{font-size:1.125rem;font-weight:600;margin:0;overflow-wrap:anywhere}
.ps-msg{color:#c9bf9f;margin:0 0 8px}.ps-r1,.ps-r2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;text-align:center;align-items:center}.ps-r1{height:164px}.ps-r2{height:96px;padding:24px 0}
.ps-r1>*,.ps-r2>*,.ps-r3>*{min-width:0}.ps-r1 svg{display:block;margin:0 auto}.ps-l{font-size:17px;line-height:24px;color:#c9bf9f;margin-bottom:8px}.ps-r2 .ps-l{margin:0}
.ps-n{font-size:1.25rem;line-height:24px;font-weight:600;white-space:nowrap}.ps-big{font-size:28px;line-height:36px}.ps-neg{color:#ff7566}
.ps-r3{height:132px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;justify-items:center}.ps-rl{fill:#f3ead2;font-size:17px}.ps-rv{fill:#f3ead2;font-size:20px;font-weight:600}.ps-rv.ps-big{font-size:28px}`;
/**
 * Open overlay for uid. load(): Promise<agg|null>. Returns close().
 * Browser back closes the overlay (one history entry per open; replaced, never stacked on refresh).
 */
export function openPersonalStats({ uid, name, myUid, enabled, load, chips = null, doc = document, win = window }) {
  if (!uid) return () => {};
  doc.getElementById('psHost')?.remove();
  if (!doc.getElementById('psCss')) { const st = doc.createElement('style'); st.id = 'psCss'; st.textContent = CSS; doc.head.appendChild(st); }
  const host = doc.createElement('div'); host.id = 'psHost'; host.className = 'ps-host'; doc.body.appendChild(host);
  const focusBack = doc.activeElement;
  let closed = false; let view = { state: enabled ? 'loading' : 'disabled' };
  const render = () => { if (!closed) host.innerHTML = personalStatsHtml({ name, isMe: uid === myUid, view, chips }); };
  const fetchOnce = async () => {
    if (!enabled) return;
    view = { state: 'loading' }; render();
    try { const agg = await load(uid); view = statsView(agg, { enabled }); } catch { view = { state: 'error' }; }
    render();
  };
  const onPop = () => close(true);
  function close(fromPop = false) {
    if (closed) return; closed = true; host.remove(); win.removeEventListener('popstate', onPop);
    if (!fromPop && win.history?.state?.ps) win.history.back();
    focusBack?.focus?.();
  }
  host.addEventListener('click', (e) => {
    const act = e.target.closest?.('[data-ps]')?.dataset.ps;
    if (act === 'back' || act === 'scrim') close();
    else if (act === 'retry') void fetchOnce();
  });
  win.history?.pushState?.({ ...(win.history.state || {}), ps: 1 }, '');
  win.addEventListener('popstate', onPop);
  render(); void fetchOnce();
  return close;
}
