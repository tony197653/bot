// 房主管理頁（SPEC v1.1）。只改帳戶 bank；牌桌籌碼只透過既有斷線收桌退回。
import { loadFirebase } from '../../lib/firebase/load.js';
import { FIREBASE_CONFIG, EMU_FIREBASE_CONFIG, EMU_PORTS, isEmuMode } from '../js/net/firebase-config.js';
import { closeDisconnectedRoom, disconnectState, hostLivenessMs, refundAtSeat } from '../js/net/host-disconnect.js';

export const ADMIN_EMAIL = 'tony197653@gmail.com';
const MAX_DELTA = 100000;
const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let fb = null;
let me = null;
let players = [];
let rooms = [];
let beats = {};
let sel = null;
let op = 1;
let busy = false;
let unsubs = [];
let tab = location.hash === '#tables' ? 'tables' : 'players';

function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2600);
}

function gate(state, extra = '') {
  $('app').hidden = true; $('gate').hidden = false;
  const btn = $('gateBtn'); const back = $('gateBack');
  btn.hidden = true; back.hidden = true; btn.disabled = false;
  const map = {
    loading: ['載入中…', '\u00a0'],
    login: ['管理員專用', '請用管理員的 Google 帳號登入'],
    noaccess: ['這個帳號沒有權限', `目前登入：${extra}`],
    error: ['讀不到資料', '請檢查網路後再試一次'],
  };
  const [t, p] = map[state];
  $('gateTitle').textContent = t; $('gateText').textContent = p;
  if (state === 'login') { btn.textContent = '用 Google 登入'; btn.hidden = false; btn.onclick = signIn; }
  if (state === 'noaccess') { btn.textContent = '換帳號'; btn.hidden = false; back.hidden = false; btn.onclick = switchAccount; }
  if (state === 'error') { btn.textContent = '重試'; btn.hidden = false; btn.onclick = () => location.reload(); }
  $('logout').hidden = !me;
}

async function signIn() {
  $('gateBtn').disabled = true;
  const { auth, authApi } = fb;
  if (isEmuMode()) {
    // 僅 localhost 模擬器：用假 Google 憑證登入（?as=email）
    const email = new URLSearchParams(location.search).get('as') || ADMIN_EMAIL;
    const cred = authApi.GoogleAuthProvider.credential(JSON.stringify({ sub: 'g-' + email, email, email_verified: true }));
    await authApi.signInWithCredential(auth, cred);
    return;
  }
  const provider = new authApi.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  await authApi.signInWithRedirect(auth, provider);
}
async function switchAccount() { await fb.authApi.signOut(fb.auth); await signIn(); }

function isAdminUser(u) {
  return !!u && u.email === ADMIN_EMAIL && u.emailVerified
    && u.providerData.some((p) => p.providerId === 'google.com');
}

/* ---------- 列表 ---------- */
function setTab(t) {
  tab = t;
  $('tabPlayers').setAttribute('aria-selected', String(t === 'players'));
  $('tabTables').setAttribute('aria-selected', String(t === 'tables'));
  $('players').hidden = t !== 'players';
  $('tables').hidden = t !== 'tables';
  $('drawer').hidden = t !== 'players';
  history.replaceState(null, '', t === 'tables' ? '#tables' : location.pathname + location.search);
  if (t === 'tables') closeDrawer();
}

function seatLabel(p) {
  if (!p.tableRoomId) return '沒坐桌';
  const r = rooms.find((x) => x.id === p.tableRoomId);
  return r ? `在「${r.name}」` : '在牌桌上';
}

function renderPlayers() {
  const el = $('players');
  $('nPlayers').textContent = players.length;
  if (!players.length) { el.innerHTML = '<p class="empty">還沒有玩家</p>'; return; }
  el.innerHTML = players.map((p) => `<button type="button" class="row${sel === p.id ? ' sel' : ''}" data-uid="${esc(p.id)}">
    <span><span class="nm">${esc(p.displayName || '玩家')}</span><span class="sub">${esc(seatLabel(p))}</span></span>
    <span class="num">${fmt(p.bank)}<span class="sub">${p.inPlay ? '桌上 ' + fmt(p.inPlay) : '\u00a0'}</span></span></button>`).join('')
    + `<p class="foot">已載入 ${players.length} 位 · 依籌碼排序</p>`;
  el.querySelectorAll('.row').forEach((b) => b.addEventListener('click', () => openDrawer(b.dataset.uid)));
}

function roomStuck(r) {
  const live = hostLivenessMs(r, beats[r.id] ?? null);
  return { live, stuck: Number.isFinite(live) && disconnectState(live).reclaim };
}
function ago(ms) {
  if (!Number.isFinite(ms)) return '沒有心跳';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `心跳 ${s} 秒前` : s < 3600 ? `心跳 ${Math.floor(s / 60)} 分鐘前` : `心跳 ${Math.floor(s / 3600)} 小時前`;
}
function nameOf(uid) { return players.find((p) => p.id === uid)?.displayName || '玩家'; }

function renderTables() {
  const el = $('tables');
  $('nTables').textContent = rooms.length;
  if (!rooms.length) { el.innerHTML = '<p class="empty">現在沒有開著的牌桌</p>'; return; }
  const list = rooms.map((r) => ({ r, ...roomStuck(r) })).sort((a, b) => Number(b.stuck) - Number(a.stuck));
  el.innerHTML = list.map(({ r, live, stuck }) => `<div class="row trow">
    <span><span class="nm">${esc(r.name)}</span>${stuck ? '<span class="tag">卡住</span>' : ''}
    <span class="sub">房號 ${esc(r.code)} · 房主 ${esc(r.lobby?.hostName || nameOf(r.hostUid))}</span>
    <span class="sub">在座 ${r.seatUids.filter(Boolean).length} · ${ago(live)}</span></span>
    ${stuck ? `<button type="button" class="btn" data-room="${esc(r.id)}">收桌</button>` : '<span class="ok">正常</span>'}</div>`).join('')
    + '<p class="foot">房主心跳超過 60 秒＝卡住</p>';
  el.querySelectorAll('[data-room]').forEach((b) => b.addEventListener('click', () => askClose(b.dataset.room)));
}

/* ---------- 抽屜：加減帳戶 ---------- */
let statsExist = false;
async function openDrawer(uid) {
  sel = uid; op = 1;
  $('amt').value = ''; $('reason').value = '';
  $('drawerEmpty').hidden = true; $('drawerBody').hidden = false;
  $('drawer').classList.add('open');
  if (!matchMedia('(min-width:1024px)').matches) $('backdrop').hidden = false;
  renderPlayers(); fillDrawer();
  statsExist = true; $('clearBtn').disabled = false; $('clearBtn').textContent = '清除個人紀錄';
  try {
    const s = await fb.fs.getDoc(fb.fs.doc(fb.db, 'pokerStatsPublic', uid));
    statsExist = s.exists();
  } catch { statsExist = true; }
  if (sel === uid) { $('clearBtn').disabled = !statsExist; $('clearBtn').textContent = statsExist ? '清除個人紀錄' : '沒有紀錄'; }
}
function closeDrawer() {
  sel = null; $('drawer').classList.remove('open'); $('backdrop').hidden = true;
  $('drawerEmpty').hidden = false; $('drawerBody').hidden = true; renderPlayers();
}
function fillDrawer() {
  const p = players.find((x) => x.id === sel);
  if (!p) return;
  $('dName').textContent = p.displayName || '玩家';
  $('dBank').textContent = '帳戶 ' + fmt(p.bank);
  $('dSeat').hidden = !p.tableRoomId;
  $('dSeat').textContent = `${seatLabel(p)} · 只改帳戶，桌上 ${fmt(p.inPlay)} 不動`;
  $('opAdd').setAttribute('aria-pressed', String(op === 1));
  $('opSub').setAttribute('aria-pressed', String(op === -1));
  validate();
}
function validate() {
  const p = players.find((x) => x.id === sel);
  const raw = $('amt').value.replace(/[,\s]/g, '');
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  const reason = $('reason').value.trim();
  const pv = $('preview'); pv.classList.remove('err');
  let ok = false;
  if (!p || !raw) pv.textContent = '\u00a0';
  else if (!Number.isInteger(n) || n < 1 || n > MAX_DELTA) { pv.textContent = '數量要在 1–100,000'; pv.classList.add('err'); }
  else if (op === -1 && n > p.bank) { pv.textContent = `帳戶只有 ${fmt(p.bank)}`; pv.classList.add('err'); }
  else { pv.textContent = `改完帳戶：${fmt(p.bank + op * n)} · 會記入帳本`; ok = !!reason; }
  const b = $('confirmAdj');
  b.textContent = Number.isInteger(n) && n > 0 ? `確認${op === 1 ? '加' : '減'} ${fmt(n)}` : '確認';
  b.disabled = !ok || busy || !navigator.onLine;
  return ok ? { p, delta: op * n, reason } : null;
}
function adjId() { return `adj_${Date.now()}_${Math.random().toString(36).slice(2, 6).padEnd(4, '0')}`; }

async function doAdjust() {
  const v = validate(); if (!v) return;
  busy = true; validate(); $('confirmAdj').textContent = '處理中…';
  const { db, fs } = fb;
  const id = adjId();
  try {
    await fs.runTransaction(db, async (tx) => {
      const ref = fs.doc(db, 'pokerPlayers', v.p.id);
      const cur = (await tx.get(ref)).data();
      const bank = cur.bank + v.delta;
      if (!Number.isInteger(bank) || bank < 0) throw Error('餘額不足');
      tx.update(ref, { bank, total: bank + (cur.inPlay || 0), lastAdjustId: id, updatedAt: fs.serverTimestamp() });
      tx.set(fs.doc(db, 'pokerPlayers', v.p.id, 'ledger', id), {
        type: 'adjust', amount: Math.abs(v.delta), delta: v.delta, reason: v.reason,
        roomId: '', sessionNo: 0, bankAfter: bank, by: me.uid, at: fs.serverTimestamp(),
      });
    });
    $('amt').value = ''; $('reason').value = '';
    toast('已記入帳本');
  } catch (e) {
    console.warn('[admin] adjust', e);
    toast('沒有寫進去，畫面已更新');
  } finally { busy = false; fillDrawer(); }
}

/* ---------- 確認框 ---------- */
let onOk = null;
function modal(title, html, okText, fn) {
  $('mTitle').textContent = title; $('mBody').innerHTML = html; $('mOk').textContent = okText;
  $('mOk').disabled = false; onOk = fn; $('modal').hidden = false; $('mCancel').focus();
}
function closeModal() { $('modal').hidden = true; onOk = null; }

function askClose(roomId) {
  const r = rooms.find((x) => x.id === roomId); if (!r) return;
  const rows = [];
  r.seatUids.forEach((u, i) => { if (u) { let a = 0; try { a = refundAtSeat(r, i); } catch { a = NaN; } rows.push(`${esc(nameOf(u))} ${Number.isFinite(a) ? fmt(a) : '—'}`); } });
  const mid = !['lobby', 'hand_over'].includes(r.pub?.phase);
  modal(`收掉「${r.name}」？`,
    rows.length ? `<p>${rows.length} 位的籌碼會退回帳戶：</p><div class="refund">${rows.join('<br>')}</div>${mid ? '<p>這一手作廢，照桌上籌碼退。</p>' : ''}` : '<p>桌上沒有人，直接收掉。</p>',
    '收桌', async () => {
      try {
        const ok = await closeDisconnectedRoom({ ...fb, uid: me.uid }, roomId);
        await fb.fs.deleteDoc(fb.fs.doc(fb.db, 'pokerLobby', roomId)).catch(() => {});
        toast(ok ? '已收桌，籌碼已退回' : '這桌已經收了');
      } catch (e) { console.warn('[admin] close', e); toast('沒有收成，畫面已更新'); }
    });
}

function askClear() {
  const p = players.find((x) => x.id === sel); if (!p || !statsExist) return;
  modal(`清除${p.displayName || '玩家'}的個人紀錄？`,
    `<p>局數、勝率、入池率會歸零。</p><p>籌碼、帳本、每晚戰績都不動。</p>${p.tableRoomId ? '<p>在打牌中也能清，最多差 1 手。</p>' : ''}<p>清掉就找不回來。</p>`,
    '清除', async () => {
      try { await clearStats(p.id); statsExist = false; toast('已清除'); }
      catch (e) { console.warn('[admin] clear', e); toast('沒有清完，請再試一次'); }
      if (sel === p.id) { $('clearBtn').disabled = !statsExist; $('clearBtn').textContent = statsExist ? '清除個人紀錄' : '沒有紀錄'; }
    });
}
// 先刪 hands/*，最後同一批刪累計＋公開；再掃一輪（最多 2 輪）
export async function clearStats(uid, f = fb) {
  const { db, fs } = f;
  const wipeHands = async () => {
    const snap = await fs.getDocs(fs.collection(db, 'pokerStats', uid, 'hands'));
    for (let i = 0; i < snap.docs.length; i += 400) {
      const b = fs.writeBatch(db);
      snap.docs.slice(i, i + 400).forEach((d) => b.delete(d.ref));
      await b.commit();
    }
    return snap.size;
  };
  await wipeHands();
  const b = fs.writeBatch(db);
  b.delete(fs.doc(db, 'pokerStats', uid));
  b.delete(fs.doc(db, 'pokerStatsPublic', uid));
  await b.commit();
  await wipeHands();
}

/* ---------- 監聽 ---------- */
function listen() {
  const { db, fs } = fb;
  $('players').innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div>';
  unsubs.push(fs.onSnapshot(fs.query(fs.collection(db, 'pokerPlayers'), fs.orderBy('total', 'desc'), fs.limit(50)), (s) => {
    players = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderPlayers(); if (sel) fillDrawer();
  }, (e) => { console.warn('[admin] players', e); gate('error'); }));
  unsubs.push(fs.onSnapshot(fs.query(fs.collection(db, 'pokerRooms'), fs.where('status', 'in', ['lobby', 'playing']), fs.limit(20)), async (s) => {
    rooms = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    await refreshBeats(); renderTables(); renderPlayers();
  }, (e) => { console.warn('[admin] rooms', e); $('tables').innerHTML = '<p class="empty">讀不到資料</p>'; }));
  setInterval(async () => { await refreshBeats(); renderTables(); }, 15000);
}
async function refreshBeats() {
  const { db, fs } = fb;
  await Promise.all(rooms.map(async (r) => {
    try {
      const s = await fs.getDoc(fs.doc(db, 'pokerRooms', r.id, 'presence', r.hostUid));
      beats[r.id] = s.exists() ? s.data().beat?.toMillis?.() ?? null : null;
    } catch { beats[r.id] = null; }
  }));
}

/* ---------- 啟動 ---------- */
function bind() {
  $('tabPlayers').onclick = () => setTab('players');
  $('tabTables').onclick = () => setTab('tables');
  $('opAdd').onclick = () => { op = 1; fillDrawer(); };
  $('opSub').onclick = () => { op = -1; fillDrawer(); };
  $('amt').oninput = validate; $('reason').oninput = validate;
  $('confirmAdj').onclick = doAdjust;
  $('clearBtn').onclick = askClear;
  $('backdrop').onclick = closeDrawer;
  $('mCancel').onclick = closeModal;
  $('mOk').onclick = async () => { const fn = onOk; if (!fn) return; $('mOk').disabled = true; $('mOk').textContent = '處理中…'; await fn(); closeModal(); };
  $('logout').onclick = async () => { unsubs.forEach((u) => u()); unsubs = []; await fb.authApi.signOut(fb.auth); };
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('modal').hidden) closeModal(); else if (sel) closeDrawer();
  });
  const net = () => { $('offline').hidden = navigator.onLine; validate(); };
  addEventListener('online', net); addEventListener('offline', net); net();
}

async function main() {
  bind(); gate('loading');
  try {
    const emu = isEmuMode();
    fb = await loadFirebase(emu ? EMU_FIREBASE_CONFIG : FIREBASE_CONFIG);
    if (emu && !main.connected) {
      fb.authApi.connectAuthEmulator(fb.auth, `http://127.0.0.1:${EMU_PORTS.auth}`, { disableWarnings: true });
      fb.fs.connectFirestoreEmulator(fb.db, '127.0.0.1', EMU_PORTS.firestore);
      main.connected = true;
    }
    try { fb.fs.setLogLevel?.('silent'); } catch {}
    if (!emu) fb.authApi.getRedirectResult(fb.auth).catch((e) => console.warn('[admin] redirect', e));
  } catch (e) { console.warn('[admin] sdk', e); gate('error'); return; }
  fb.authApi.onAuthStateChanged(fb.auth, (u) => {
    me = u; unsubs.forEach((x) => x()); unsubs = [];
    if (!u) return gate('login');
    if (!isAdminUser(u)) return gate('noaccess', u.email || '匿名');
    $('gate').hidden = true; $('app').hidden = false; $('logout').hidden = false;
    setTab(tab); listen();
    if (matchMedia('(min-width:1024px)').matches) $('drawer').classList.add('open');
  });
}
main();
