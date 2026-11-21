import { initSound } from '../js/ui/sound.js';
// 房主管理頁（SPEC v1.2）。只改帳戶 bank（補碼）和清除個人紀錄；不碰牌桌。
import { loadFirebase } from '../../lib/firebase/load.js';
import { FIREBASE_CONFIG, EMU_FIREBASE_CONFIG, EMU_PORTS, isEmuMode } from '../js/net/firebase-config.js';

initSound();

export const ADMIN_EMAIL = 'tony197653@gmail.com';
const MAX_DELTA = 100000;
const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let fb = null;
let me = null;
let players = [];
const ADMIN_APP = 'poker-admin';
let sel = null;
let op = 1;
let busy = false;
let unsubs = [];

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
function seatLabel(p) {
  return p.tableRoomId ? '在牌桌上' : '沒坐桌';
}

function renderPlayers() {
  const el = $('players');
  const focusUid = document.activeElement?.closest?.('#players .row')?.dataset.uid; // S4：重畫後焦點放回那一列
  if (!players.length) { el.innerHTML = '<p class="empty">還沒有玩家</p>'; return; }
  el.innerHTML = players.map((p) => `<button data-sfx="tap" type="button" class="row${sel === p.id ? ' sel' : ''}" data-uid="${esc(p.id)}">
    <span><span class="nm">${esc(p.displayName || '玩家')}</span><span class="sub">${esc(seatLabel(p))}</span></span>
    <span class="num">${fmt(p.bank)}<span class="sub">${p.inPlay ? '桌上 ' + fmt(p.inPlay) : '\u00a0'}</span></span></button>`).join('')
    + `<p class="foot">已載入 ${players.length} 位 · 依籌碼排序</p>`;
  el.querySelectorAll('.row').forEach((b) => b.addEventListener('click', () => openDrawer(b.dataset.uid)));
  if (focusUid) el.querySelector(`.row[data-uid="${CSS.escape(focusUid)}"]`)?.focus();
}

/* ---------- 抽屜：加減帳戶 ---------- */
let statsExist = false;
let drawerReturn = null;
async function openDrawer(uid) {
  sel = uid; op = 1;
  $('amt').value = ''; $('reason').value = '';
  $('drawerEmpty').hidden = true; $('drawerBody').hidden = false;
  $('drawer').classList.add('open');
  if (!matchMedia('(min-width:1024px)').matches) { $('backdrop').hidden = false; setInert(true, '#players', 'header.bar'); document.body.classList.add('sheet-open'); drawerReturn = uid; setTimeout(() => $('opAdd').focus(), 0); }
  renderPlayers(); fillDrawer();
  statsExist = true; $('clearBtn').disabled = false; $('clearBtn').textContent = '清除個人紀錄';
  try {
    const s = await fb.fs.getDoc(fb.fs.doc(fb.db, 'pokerStatsPublic', uid));
    statsExist = s.exists();
  } catch { statsExist = true; }
  if (sel === uid) { $('clearBtn').disabled = !statsExist; $('clearBtn').textContent = statsExist ? '清除個人紀錄' : '沒有紀錄'; }
}
function closeDrawer() {
  setInert(false, '#players', 'header.bar'); document.body.classList.remove('sheet-open');
  const ret = drawerReturn; drawerReturn = null;
  sel = null; $('drawer').classList.remove('open'); $('backdrop').hidden = true;
  $('drawerEmpty').hidden = false; $('drawerBody').hidden = true; renderPlayers();
  if (ret) document.querySelector(`#players .row[data-uid="${CSS.escape(ret)}"]`)?.focus();
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
    const done = await fs.runTransaction(db, async (tx) => {
      const ref = fs.doc(db, 'pokerPlayers', v.p.id);
      const cur = (await tx.get(ref)).data();
      const bank = cur.bank + v.delta;
      if (!Number.isInteger(bank) || bank < 0) throw Error('餘額不足');
      tx.update(ref, { bank, total: bank + (cur.inPlay || 0), lastAdjustId: id, updatedAt: fs.serverTimestamp() });
      tx.set(fs.doc(db, 'pokerPlayers', v.p.id, 'ledger', id), {
        type: 'adjust', amount: Math.abs(v.delta), delta: v.delta, reason: v.reason,
        roomId: '', sessionNo: 0, bankAfter: bank, by: me.uid, at: fs.serverTimestamp(),
      });
      return { bank, total: bank + (cur.inPlay || 0) };
    });
    // 寫入成功就先用算出的數字更新列表和抽屜（transaction 沒有本機預寫，不等推送；之後監聽的伺服器資料為準）
    players = players.map((p) => (p.id === v.p.id ? { ...p, ...done } : p)).sort((a, b) => (b.bank || 0) - (a.bank || 0));
    renderPlayers();
    $('amt').value = ''; $('reason').value = '';
    toast('已記入帳本');
  } catch (e) {
    console.warn('[admin] adjust', e);
    toast('沒有寫進去，畫面已更新');
  } finally { busy = false; fillDrawer(); }
}

/* ---------- 確認框 ---------- */
let onOk = null;
let modalReturn = null;
const setInert = (on, ...ids) => ids.forEach((id) => { const el = typeof id === 'string' ? document.querySelector(id) : id; if (el) el.inert = on; });
function modal(title, html, okText, fn) {
  modalReturn = document.activeElement;
  setInert(true, '#app', 'header.bar', '#offline');
  $('mTitle').textContent = title; $('mBody').innerHTML = html; $('mOk').textContent = okText;
  $('mOk').disabled = false; onOk = fn; $('modal').hidden = false; $('mCancel').focus();
}
function closeModal() {
  $('modal').hidden = true; onOk = null;
  setInert(false, '#app', 'header.bar', '#offline');
  if (sel && !$('backdrop').hidden) setInert(true, '#players', 'header.bar');
  const back = sel && !$('drawerBody').hidden ? $('clearBtn') : modalReturn;
  if (back && !back.disabled) back.focus(); else $('drawer').querySelector('button:not([disabled]),input')?.focus();
  modalReturn = null;
}
// 對話框內 Tab 只在可按的按鈕間循環（inert 之外的保險）
function trapTab(e) {
  if (e.key !== 'Tab') return;
  // 確認框優先；手機抽屜開著時（S3）在抽屜內循環，不停在 BODY
  const box = !$('modal').hidden ? $('modal') : document.body.classList.contains('sheet-open') ? $('drawer') : null;
  if (!box) return;
  const f = [...box.querySelectorAll('button:not([disabled]),input:not([disabled])')];
  if (!f.length) return;
  const i = f.indexOf(document.activeElement);
  e.preventDefault();
  f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
}

function askClear() {
  const p = players.find((x) => x.id === sel); if (!p || !statsExist) return;
  clearTimeout(toast.t); $('toast').hidden = true;
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
  unsubs.push(fs.onSnapshot(fs.query(fs.collection(db, 'pokerPlayers'), fs.orderBy('bank', 'desc'), fs.limit(50)), (s) => {
    players = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderPlayers(); if (sel) fillDrawer();
  }, (e) => { console.warn('[admin] players', e); gate('error'); }));
}
/* ---------- 啟動 ---------- */
function bind() {
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
    trapTab(e);
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
    // 獨立 app：登入狀態另存（大廳用 [DEFAULT] 且會把登入搬到 localStorage，共用時會把管理頁登出）
    fb = await loadFirebase(emu ? EMU_FIREBASE_CONFIG : FIREBASE_CONFIG, { appName: ADMIN_APP });
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
    listen();
    if (matchMedia('(min-width:1024px)').matches) $('drawer').classList.add('open');
  });
}
main();
