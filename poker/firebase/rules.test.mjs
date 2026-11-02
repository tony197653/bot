// Firestore 規則模擬器測試（只連本機 emulator，專案 demo-poker）
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp, Timestamp, runTransaction, setLogLevel } from 'firebase/firestore';
import fs from 'node:fs';
setLogLevel('silent');

const RULES = process.env.RULES || 'firestore.rules';
const env = await initializeTestEnvironment({
  projectId: 'demo-poker',
  firestore: { host: '127.0.0.1', port: 8195, rules: fs.readFileSync(RULES, 'utf8') },
});

const R = 'R1', CODE = '123456', NK = '20261101';
const ago = (ms) => Timestamp.fromMillis(Date.now() - ms);
const MIN = 60000;
const sessOf = (uid, no, buyIn, extra = {}) => ({ uid, sessionNo: no, buyIn, topUps: 0, topUpChips: 0, hands: 3, nightKey: NK, startAt: ago(60 * MIN), ...extra });
function baseRoom(o = {}) {
  return {
    name: '家庭桌', code: CODE, hostUid: 'H', hostSince: ago(60 * MIN), members: ['H', 'A', 'B', 'C', 'D'],
    seatUids: ['H', 'A', '', '', '', ''], status: 'open',
    config: { sb: 10, bb: 20, newPlayerChips: 5000, actionMs: 30000, topUpAmount: 2000 },
    rev: 5, createdAt: ago(60 * MIN), updatedAt: ago(5000), pub: { phase: 'hand_over', handNo: 3, actionSeq: 10 },
    deadlineAt: null, stacks: [7000, 3000, 0, 0, 0, 0], chipTotal: 10000,
    sess: [sessOf('H', 1, 5000), sessOf('A', 1, 5000), null, null, null, null], lastMoneyEvent: null, ...o,
  };
}
const player = (o = {}) => ({ displayName: 'x', photoURL: null, bank: 0, inPlay: 5000, total: 5000, tableRoomId: R, sessionNo: 1,
  topUps: 0, topUpChips: 0, handsPlayed: 0, lastRoomId: R, createdAt: ago(60 * MIN), updatedAt: ago(60 * MIN), ...o });

async function seed({ room = {}, players = {}, extra } = {}) {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'pokerRooms', R), baseRoom(room));
    await setDoc(doc(db, 'pokerCodes', CODE), { roomId: R, hostUid: 'H', createdAt: ago(MIN), expiresAt: Timestamp.fromMillis(Date.now() + 23 * 3600e3) });
    const ps = { H: player(), A: player(), B: player({ bank: 5000, inPlay: 0, tableRoomId: null, sessionNo: 0 }), ...players };
    for (const [u, p] of Object.entries(ps)) if (p) await setDoc(doc(db, 'pokerPlayers', u), p);
    await setDoc(doc(db, 'pokerRooms', R, 'presence', 'H'), { beat: ago(5000), vis: true });
    await setDoc(doc(db, 'pokerRooms', R, 'hole', 'A'), { cards: ['As', 'Kd'], handNo: 3, updatedAt: ago(5000) });
    await setDoc(doc(db, 'pokerPlayers', 'A', 'ledger', R + '_1_buyin'), { type: 'buyin', amount: 5000, roomId: R, sessionNo: 1, bankAfter: 0, by: 'A', at: ago(60 * MIN) });
    if (extra) await extra(db);
  });
}
const db = (uid) => env.authenticatedContext(uid).firestore();
const cur = async () => { let r; await env.withSecurityRulesDisabled(async (c) => { r = (await getDoc(doc(c.firestore(), 'pokerRooms', R))).data(); }); return r; };
const curP = async (u) => { let r; await env.withSecurityRulesDisabled(async (c) => { r = (await getDoc(doc(c.firestore(), 'pokerPlayers', u))).data(); }); return r; };
const roomRef = (d) => doc(d, 'pokerRooms', R);
const hostUpd = async (d, room, ch) => updateDoc(roomRef(d), { rev: room.rev + 1, updatedAt: serverTimestamp(), ...ch });

// ---- 帳務 batch 產生器 ----
const START_AT = () => (process.env.STARTAT === 'ts' ? Timestamp.now() : serverTimestamp());
async function buyinBatch(uid, roomId = R, o = {}) {
  const d = db(uid); const p = await curP(uid); const no = p.sessionNo + 1;
  const b = writeBatch(d);
  b.update(doc(d, 'pokerPlayers', uid), { bank: 0, inPlay: p.bank, tableRoomId: roomId, sessionNo: no, lastRoomId: roomId, updatedAt: serverTimestamp(), ...o.player });
  b.set(doc(d, 'pokerPlayers', uid, 'ledger', `${roomId}_${no}_buyin`), { type: 'buyin', amount: p.bank, roomId, sessionNo: no, bankAfter: 0, by: uid, at: serverTimestamp(), ...o.ledger });
  return b.commit();
}
async function seatBatch(seat, uid, amount, o = {}) {
  const d = db('H'); const r = await cur(); const p = await curP(uid);
  const seatUids = [...r.seatUids]; seatUids[seat] = uid; const stacks = [...r.stacks]; stacks[seat] = amount;
  const sess = [...r.sess]; sess[seat] = { uid, sessionNo: p.sessionNo, buyIn: amount, topUps: 0, topUpChips: 0, hands: 0, nightKey: NK, startAt: START_AT() };
  return hostUpd(d, r, { seatUids, stacks, chipTotal: r.chipTotal + amount, sess,
    lastMoneyEvent: { uid, id: `${R}_${p.sessionNo}_buyin`, seat, type: 'buyin', amount }, ...o });
}
// 房主替 uid（座位 seat）結帳：房間＋帳本＋帳戶＋每晚戰績
async function hostCashout(seat, uid, o = {}) {
  const d = db(o.by || 'H'); const r = await cur(); const p = await curP(uid); const s = r.sess[seat]; const amt = r.stacks[seat];
  const id = `${R}_${s.sessionNo}_cashout`;
  const seatUids = [...r.seatUids]; seatUids[seat] = ''; const stacks = [...r.stacks]; stacks[seat] = 0; const sess = [...r.sess]; sess[seat] = null;
  const b = writeBatch(d);
  if (!o.skipRoom) b.update(roomRef(d), { rev: r.rev + 1, updatedAt: serverTimestamp(), seatUids, stacks, chipTotal: r.chipTotal - amt, sess,
    lastMoneyEvent: { uid, id, seat, type: 'cashout', amount: amt }, ...o.room });
  b.set(doc(d, 'pokerPlayers', uid, 'ledger', id), { type: 'cashout', amount: amt, roomId: R, sessionNo: s.sessionNo, seat, buyIn: s.buyIn,
    topUps: s.topUps, topUpChips: s.topUpChips, hands: s.hands, nightKey: s.nightKey, bankAfter: p.bank + amt, by: o.by || 'H', at: serverTimestamp() });
  b.update(doc(d, 'pokerPlayers', uid), { bank: p.bank + amt, inPlay: 0, total: p.bank + amt, tableRoomId: null, topUps: p.topUps + s.topUps,
    topUpChips: p.topUpChips + s.topUpChips, handsPlayed: p.handsPlayed + s.hands, updatedAt: serverTimestamp() });
  b.set(doc(d, 'pokerPlayers', uid, 'nights', s.nightKey), { nightKey: s.nightKey, uid, name: 'x', buyIn: s.buyIn + s.topUpChips, cashOut: amt,
    net: amt - s.buyIn - s.topUpChips, topUps: s.topUps, hands: s.hands, lastEntry: id, updatedAt: serverTimestamp() });
  return b.commit();
}
// 本人取消帶入（沒座位）
async function cancelBuyin(uid) {
  const d = db(uid); const p = await curP(uid); const id = `${R}_${p.sessionNo}_cashout`;
  const b = writeBatch(d);
  b.set(doc(d, 'pokerPlayers', uid, 'ledger', id), { type: 'cashout', amount: p.inPlay, roomId: R, sessionNo: p.sessionNo, buyIn: p.inPlay,
    topUps: 0, topUpChips: 0, hands: 0, nightKey: NK, bankAfter: p.bank + p.inPlay, by: uid, at: serverTimestamp() });
  b.update(doc(d, 'pokerPlayers', uid), { bank: p.bank + p.inPlay, inPlay: 0, total: p.bank + p.inPlay, tableRoomId: null, updatedAt: serverTimestamp() });
  b.set(doc(d, 'pokerPlayers', uid, 'nights', NK), { nightKey: NK, uid, name: 'x', buyIn: p.inPlay, cashOut: p.inPlay, net: 0, topUps: 0, hands: 0, lastEntry: id, updatedAt: serverTimestamp() });
  return b.commit();
}
async function topupBatch(seat, uid, o = {}) {
  const d = db(o.by || 'H'); const r = await cur(); const s = r.sess[seat]; const n = o.n ?? s.topUps + 1; const amt = o.amount ?? 2000;
  const id = `${R}_${s.sessionNo}_topup${n}`;
  const stacks = [...r.stacks]; stacks[seat] += amt; const sess = [...r.sess]; sess[seat] = { ...s, topUps: s.topUps + 1, topUpChips: s.topUpChips + amt };
  const b = writeBatch(d);
  b.update(roomRef(d), { rev: r.rev + 1, updatedAt: serverTimestamp(), stacks, chipTotal: r.chipTotal + amt, sess,
    lastMoneyEvent: { uid, id, seat, type: 'topup', amount: amt }, ...o.room });
  b.set(doc(d, 'pokerPlayers', uid, 'ledger', id), { type: 'topup', amount: amt, roomId: R, sessionNo: s.sessionNo, seat, topUps: n, by: o.by || 'H', at: serverTimestamp() });
  return b.commit();
}

// ---- harness ----
const results = [];
async function t(group, name, expect, setup, fn) {
  if (process.env.FILTER && !name.includes(process.env.FILTER)) return;
  let ok, err = '';
  try { await setup(); } catch (e) { results.push({ group, name, expect, got: 'SETUP-ERR', pass: false, err: e.message }); return; }
  try { await fn(); ok = 'ok'; } catch (e) { ok = /PERMISSION_DENIED|permission-denied|false for/i.test(e.code + e.message) ? 'deny' : 'error'; err = (e.code || '') + ' ' + e.message.split('\n')[0].slice(0, 160); }
  const pass = ok === expect;
  results.push({ group, name, expect, got: ok, pass, err });
}
const S = () => seed();

// #3 手牌
await t('#3', 'B 讀 A 的 hole/A', 'deny', S, () => getDoc(doc(db('B'), 'pokerRooms', R, 'hole', 'A')));
await t('#3', '觀眾 C（成員未入座）讀 hole/A', 'deny', S, () => getDoc(doc(db('C'), 'pokerRooms', R, 'hole', 'A')));
await t('#3', '非成員 X 讀 hole/A', 'deny', S, () => getDoc(doc(db('X'), 'pokerRooms', R, 'hole', 'A')));
await t('#3', '房主 H 讀 hole/A', 'deny', S, () => getDoc(doc(db('H'), 'pokerRooms', R, 'hole', 'A')));
await t('#3', 'A 讀自己的 hole/A', 'ok', S, () => getDoc(doc(db('A'), 'pokerRooms', R, 'hole', 'A')));
await t('#3', '非房主 B 寫 hole/A', 'deny', S, () => setDoc(doc(db('B'), 'pokerRooms', R, 'hole', 'A'), { cards: ['2c'], handNo: 4, updatedAt: serverTimestamp() }));
await t('#3', '房主寫 hole/A', 'ok', S, () => setDoc(doc(db('H'), 'pokerRooms', R, 'hole', 'A'), { cards: ['2c', '3c'], handNo: 4, updatedAt: serverTimestamp() }));

// #4 籌碼帳戶
await t('#4', '正常：第一次來 D 建帳戶＋grant', 'ok', S, async () => {
  const d = db('D'); const b = writeBatch(d);
  b.set(doc(d, 'pokerPlayers', 'D'), { displayName: 'D', photoURL: null, bank: 5000, inPlay: 0, total: 5000, tableRoomId: null, sessionNo: 0, topUps: 0, topUpChips: 0, handsPlayed: 0, lastRoomId: R, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  b.set(doc(d, 'pokerPlayers', 'D', 'ledger', R + '_0_grant'), { type: 'grant', amount: 5000, roomId: R, sessionNo: 0, bankAfter: 5000, by: 'D', at: serverTimestamp() });
  return b.commit();
});
await t('#4', '第一次來 bank 灌成 99999', 'deny', S, async () => {
  const d = db('D'); const b = writeBatch(d);
  b.set(doc(d, 'pokerPlayers', 'D'), { displayName: 'D', photoURL: null, bank: 99999, inPlay: 0, total: 99999, tableRoomId: null, sessionNo: 0, topUps: 0, topUpChips: 0, handsPlayed: 0, lastRoomId: R, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  b.set(doc(d, 'pokerPlayers', 'D', 'ledger', R + '_0_grant'), { type: 'grant', amount: 99999, roomId: R, sessionNo: 0, bankAfter: 99999, by: 'D', at: serverTimestamp() });
  return b.commit();
});
await t('#4', '本人直接改自己的 bank', 'deny', S, () => updateDoc(doc(db('B'), 'pokerPlayers', 'B'), { bank: 99999, total: 99999, updatedAt: serverTimestamp() }));
await t('#4', '本人直接改自己的 inPlay', 'deny', S, () => updateDoc(doc(db('A'), 'pokerPlayers', 'A'), { inPlay: 99999, updatedAt: serverTimestamp() }));
await t('#4', '正常：B 帶入（帳戶＋帳本 buyin）', 'ok', S, () => buyinBatch('B'));
await t('#4', '帶入時 bank 沒歸 0', 'deny', S, () => buyinBatch('B', R, { player: { bank: 5000 } }));
await t('#4', '帶入時 inPlay ≠ 原 bank', 'deny', S, () => buyinBatch('B', R, { player: { inPlay: 4000 }, ledger: { amount: 4000 } }));
await t('#4', '帶入沒附帳本', 'deny', S, async () => { const d = db('B'); return updateDoc(doc(d, 'pokerPlayers', 'B'), { bank: 0, inPlay: 5000, tableRoomId: R, sessionNo: 1, lastRoomId: R, updatedAt: serverTimestamp() }); });
await t('#4', 'A 已坐 R1，再帶入 R2', 'deny', async () => { await seed({ extra: (d) => setDoc(doc(d, 'pokerRooms', 'R2'), baseRoom({ code: '654321', members: ['H', 'A'] })) }); }, () => buyinBatch('A', 'R2'));
await t('#4', '正常：房主讓 B 坐下（金額＝帳本 buyin）', 'ok', async () => { await S(); await buyinBatch('B'); }, () => seatBatch(2, 'B', 5000));
await t('#4', '房主讓 B 坐下金額 ≠ 帳本 buyin', 'deny', async () => { await S(); await buyinBatch('B'); }, () => seatBatch(2, 'B', 6000));
await t('#4', '房主寫 Σstacks ≠ chipTotal', 'deny', S, async () => { const r = await cur(); return hostUpd(db('H'), r, { stacks: [8000, 3000, 0, 0, 0, 0] }); });
await t('#4', '房主沒帳務事件改 chipTotal（stacks 也跟著改）', 'deny', S, async () => { const r = await cur(); return hostUpd(db('H'), r, { stacks: [9000, 3000, 0, 0, 0, 0], chipTotal: 12000 }); });
await t('#4', '房主沒帳務事件改座位', 'deny', S, async () => { const r = await cur(); return hostUpd(db('H'), r, { seatUids: ['H', '', 'A', '', '', ''], stacks: [7000, 0, 3000, 0, 0, 0], sess: [r.sess[0], null, r.sess[1], null, null, null] }); });
await t('#4', '正常：每手結束（stacks 重分配、hands+1、空位 sess 維持 null）', 'ok', S, async () => { const r = await cur();
  return hostUpd(db('H'), r, { stacks: [6000, 4000, 0, 0, 0, 0], sess: [{ ...r.sess[0], hands: 4 }, { ...r.sess[1], hands: 4 }, null, null, null, null], pub: { phase: 'hand_over', handNo: 4 } }); });
await t('#4', '房主改別人 sess 的 buyIn', 'deny', S, async () => { const r = await cur(); return hostUpd(db('H'), r, { sess: [r.sess[0], { ...r.sess[1], buyIn: 1 }, null, null, null, null] }); });
await t('#4', '房主改別人 sess 的 topUps', 'deny', S, async () => { const r = await cur(); return hostUpd(db('H'), r, { sess: [r.sess[0], { ...r.sess[1], topUps: 5 }, null, null, null, null] }); });
await t('#4', '房主把空位 sess 從 null 改成資料（無帳務事件）', 'deny', S, async () => { const r = await cur(); return hostUpd(db('H'), r, { sess: [r.sess[0], r.sess[1], sessOf('B', 1, 0), null, null, null] }); });
await t('#4', '正常：房主替 A 結帳（房間＋帳本＋帳戶＋戰績）', 'ok', S, () => hostCashout(1, 'A'));
await t('#4', '正常：房主替自己結帳（房主自己的座位）', 'ok', S, () => hostCashout(0, 'H'));
await t('#4', '同一個 sessionNo 結帳兩次', 'deny', async () => { await S(); await hostCashout(1, 'A'); await env.withSecurityRulesDisabled(async (c) => { await updateDoc(doc(c.firestore(), 'pokerRooms', R), { seatUids: ['H', 'A', '', '', '', ''], stacks: [7000, 3000, 0, 0, 0, 0], chipTotal: 10000, sess: [sessOf('H', 1, 5000), sessOf('A', 1, 5000), null, null, null, null] }); }); }, () => hostCashout(1, 'A'));
await t('#4', '帳本 update', 'deny', S, () => updateDoc(doc(db('A'), 'pokerPlayers', 'A', 'ledger', R + '_1_buyin'), { amount: 99999 }));
await t('#4', '帳本 delete', 'deny', S, () => deleteDoc(doc(db('A'), 'pokerPlayers', 'A', 'ledger', R + '_1_buyin')));
await t('#4', '牌局中（phase=flop）結帳', 'deny', () => seed({ room: { pub: { phase: 'flop', handNo: 3 } } }), () => hostCashout(1, 'A', { room: { pub: { phase: 'flop', handNo: 3 } } }));

// #9 搶房主
const stale = () => seed({ room: { updatedAt: ago(60000), seatUids: ['H', 'A', 'B', '', '', ''], stacks: [7000, 3000, 5000, 0, 0, 0], chipTotal: 15000,
  sess: [sessOf('H', 1, 5000), sessOf('A', 1, 5000), sessOf('B', 1, 5000), null, null, null] },
  extra: (d) => setDoc(doc(d, 'pokerRooms', R, 'presence', 'H'), { beat: ago(60000), vis: false }) });
const takeover = async (uid, r) => updateDoc(roomRef(db(uid)), { rev: r.rev + 1, updatedAt: serverTimestamp(), hostUid: uid, hostSince: serverTimestamp(), pub: { phase: 'hand_over', handNo: r.pub.handNo + 1, voided: true } });
await t('#9', '房主失聯 60 秒，A 接手', 'ok', stale, async () => takeover('A', await cur()));
await t('#9', '房主失聯 20 秒（未滿 30 秒），A 接手', 'deny', () => seed({ room: { updatedAt: ago(20000), seatUids: ['H', 'A', 'B', '', '', ''], stacks: [7000, 3000, 5000, 0, 0, 0], chipTotal: 15000, sess: [sessOf('H', 1, 5000), sessOf('A', 1, 5000), sessOf('B', 1, 5000), null, null, null] } }), async () => takeover('A', await cur()));
await t('#9', '房間 60 秒沒更新但房主心跳 5 秒前，A 接手', 'deny', () => seed({ room: { updatedAt: ago(60000), seatUids: ['H', 'A', 'B', '', '', ''], stacks: [7000, 3000, 5000, 0, 0, 0], chipTotal: 15000, sess: [sessOf('H', 1, 5000), sessOf('A', 1, 5000), sessOf('B', 1, 5000), null, null, null] } }), async () => takeover('A', await cur()));
await t('#9', '觀眾 C（未入座）接手', 'deny', stale, async () => takeover('C', await cur()));
await t('#9', 'A、B 用同一份舊資料先後接手：B 被拒', 'deny', async () => { await stale(); const r = await cur(); globalThis.__r = r; await takeover('A', r); }, () => takeover('B', globalThis.__r));
let raceInfo = '';
await t('#9', 'A 單獨用交易接手（對照組）', 'ok', stale, async () => { const f = db('A'); return runTransaction(f, async (x) => { const s = (await x.get(roomRef(f))).data();
    x.update(roomRef(f), { rev: s.rev + 1, updatedAt: serverTimestamp(), hostUid: 'A', hostSince: serverTimestamp(), pub: { phase: 'hand_over', handNo: 4, voided: true } }); }); });
await t('#9', 'A、B 同時用交易接手：只有一人成功、rev 只加 1', 'ok', stale, async () => {
  const tx = (uid) => { const f = db(uid); return runTransaction(f, async (x) => { const s = (await x.get(roomRef(f))).data();
    x.update(roomRef(f), { rev: s.rev + 1, updatedAt: serverTimestamp(), hostUid: uid, hostSince: serverTimestamp(), pub: { phase: 'hand_over', handNo: 4, voided: true } }); return uid; }); };
  const rs = await Promise.allSettled([tx('A'), tx('B')]);
  const r = await cur(); const okN = rs.filter((x) => x.status === 'fulfilled').length;
  raceInfo = `成功 ${okN} 人（${rs.map((x) => x.status === 'fulfilled' ? x.value : 'deny:' + (x.reason?.code || x.reason?.message || '').toString().slice(0, 40)).join('/')}），rev ${r.rev}，hostUid ${r.hostUid}`;
  if (okN !== 1 || r.rev !== 6) throw new Error('race failed: ' + raceInfo);
});

// #10 補碼
const broke = (seat) => () => seed({ room: { stacks: seat === 1 ? [10000, 0, 0, 0, 0, 0] : [0, 10000, 0, 0, 0, 0] } });
await t('#10', '正常：A 輸光，房主核准補碼', 'ok', broke(1), () => topupBatch(1, 'A'));
await t('#10', '正常：房主自己輸光，自己核准', 'ok', broke(0), () => topupBatch(0, 'H'));
await t('#10', '正常：第二次補碼（topup2）', 'ok', async () => { await broke(1)(); await topupBatch(1, 'A'); await env.withSecurityRulesDisabled(async (c) => { const r = (await getDoc(doc(c.firestore(), 'pokerRooms', R))).data(); await updateDoc(doc(c.firestore(), 'pokerRooms', R), { stacks: [12000, 0, 0, 0, 0, 0] }); }); }, () => topupBatch(1, 'A'));
await t('#10', '籌碼不是 0 時補', 'deny', S, () => topupBatch(1, 'A'));
await t('#10', '金額不是 2000（3000）', 'deny', broke(1), () => topupBatch(1, 'A', { amount: 3000 }));
await t('#10', '牌局中補（phase=turn）', 'deny', () => seed({ room: { stacks: [10000, 0, 0, 0, 0, 0], pub: { phase: 'turn' } } }), () => topupBatch(1, 'A', { room: { pub: { phase: 'turn' } } }));
await t('#10', '帳本編號 n 跳號（topup2 但 topUps 原本 0）', 'deny', broke(1), () => topupBatch(1, 'A', { n: 2 }));
await t('#10', '非房主 B 核准補碼', 'deny', broke(1), () => topupBatch(1, 'A', { by: 'B' }));
await t('#10', '補碼只寫房間、沒寫帳本', 'deny', broke(1), async () => { const r = await cur(); const s = r.sess[1];
  return hostUpd(db('H'), r, { stacks: [10000, 2000, 0, 0, 0, 0], chipTotal: 12000, sess: [r.sess[0], { ...s, topUps: 1, topUpChips: 2000 }, null, null, null, null], lastMoneyEvent: { uid: 'A', id: R + '_1_topup1', seat: 1, type: 'topup', amount: 2000 } }); });

// #25 冪等與重送
await t('#25', '帶入 batch 送兩次：第二次被拒', 'deny', async () => { await S(); await buyinBatch('B'); }, async () => {
  const d = db('B'); const b = writeBatch(d);
  b.update(doc(d, 'pokerPlayers', 'B'), { bank: 0, inPlay: 5000, tableRoomId: R, sessionNo: 1, lastRoomId: R, updatedAt: serverTimestamp() });
  b.set(doc(d, 'pokerPlayers', 'B', 'ledger', R + '_1_buyin'), { type: 'buyin', amount: 5000, roomId: R, sessionNo: 1, bankAfter: 0, by: 'B', at: serverTimestamp() });
  return b.commit(); });
await t('#25', '帶入被拒後讀帳本（客戶端當成功）', 'ok', async () => { await S(); await buyinBatch('B'); }, async () => { const s = await getDoc(doc(db('B'), 'pokerPlayers', 'B', 'ledger', R + '_1_buyin')); if (!s.exists()) throw new Error('no ledger'); });
let retry = {};
await t('#25', '房主結帳 batch 成功後重送同一份：被拒、籌碼不變', 'deny', async () => { await S(); await hostCashout(1, 'A'); retry.before = await curP('A'); }, async () => {
  // 重送「完全一樣」的 batch（用結帳前的資料）
  const d = db('H'); const b = writeBatch(d); const id = R + '_1_cashout';
  b.update(roomRef(d), { rev: 6, updatedAt: serverTimestamp(), seatUids: ['H', '', '', '', '', ''], stacks: [7000, 0, 0, 0, 0, 0], chipTotal: 7000, sess: [sessOf('H', 1, 5000), null, null, null, null, null], lastMoneyEvent: { uid: 'A', id, seat: 1, type: 'cashout', amount: 3000 } });
  b.set(doc(d, 'pokerPlayers', 'A', 'ledger', id), { type: 'cashout', amount: 3000, roomId: R, sessionNo: 1, seat: 1, buyIn: 5000, topUps: 0, topUpChips: 0, hands: 3, nightKey: NK, bankAfter: 3000, by: 'H', at: serverTimestamp() });
  b.update(doc(d, 'pokerPlayers', 'A'), { bank: 3000, inPlay: 0, total: 3000, tableRoomId: null, topUps: 0, topUpChips: 0, handsPlayed: 3, updatedAt: serverTimestamp() });
  return b.commit(); });
retry.after = await curP('A');
await t('#25', '意圖同一個 turn 送兩次（第二次新 seq）：規則允許，去重靠房主看 turn', 'ok', async () => { await S(); await setDoc(doc(db('A'), 'pokerRooms', R, 'intents', 'A'), { type: 'CALL', seq: 1, handNo: 3, turn: 10, at: serverTimestamp() }); },
  () => setDoc(doc(db('A'), 'pokerRooms', R, 'intents', 'A'), { type: 'CALL', seq: 2, handNo: 3, turn: 10, at: serverTimestamp() }));
await t('#25', '意圖 seq 沒變大', 'deny', async () => { await S(); await setDoc(doc(db('A'), 'pokerRooms', R, 'intents', 'A'), { type: 'CALL', seq: 2, handNo: 3, turn: 10, at: serverTimestamp() }); },
  () => setDoc(doc(db('A'), 'pokerRooms', R, 'intents', 'A'), { type: 'CALL', seq: 2, handNo: 3, turn: 10, at: serverTimestamp() }));

// #26 自救結帳
const gone = (ms, presence = true, o = {}) => () => seed({ room: { updatedAt: ago(ms), ...o }, extra: presence ? (d) => setDoc(doc(d, 'pokerRooms', R, 'presence', 'H'), { beat: ago(ms), vis: false }) : null });
const selfRescue = () => hostCashout(1, 'A', { by: 'A', skipRoom: true });
await t('#26', '房主失聯 11 分鐘：A 自救結帳（金額＝stacks[1]）', 'ok', gone(11 * MIN), selfRescue);
await t('#26', '房主失聯 11 分鐘且沒有心跳文件：A 自救', 'ok', async () => { await gone(11 * MIN, false)(); await env.withSecurityRulesDisabled((c) => deleteDoc(doc(c.firestore(), 'pokerRooms', R, 'presence', 'H'))); }, selfRescue);
await t('#26', '房主失聯 9 分鐘：A 自救被拒', 'deny', gone(9 * MIN), selfRescue);
await t('#26', '房間 11 分鐘沒更新但房主心跳 1 分鐘前：被拒', 'deny', async () => { await gone(11 * MIN)(); await env.withSecurityRulesDisabled((c) => setDoc(doc(c.firestore(), 'pokerRooms', R, 'presence', 'H'), { beat: ago(MIN), vis: true })); }, selfRescue);
await t('#26', '房間已收桌（closed）：A 立即自救', 'ok', gone(5000, true, { status: 'closed' }), selfRescue);
await t('#26', '自救金額不等於 stacks[1]（灌成 9999）', 'deny', gone(11 * MIN), async () => { await env.withSecurityRulesDisabled(() => null); const d = db('A'); const id = R + '_1_cashout'; const b = writeBatch(d);
  b.set(doc(d, 'pokerPlayers', 'A', 'ledger', id), { type: 'cashout', amount: 9999, roomId: R, sessionNo: 1, seat: 1, buyIn: 5000, topUps: 0, topUpChips: 0, hands: 3, nightKey: NK, bankAfter: 9999, by: 'A', at: serverTimestamp() });
  b.update(doc(d, 'pokerPlayers', 'A'), { bank: 9999, inPlay: 0, total: 9999, tableRoomId: null, topUps: 0, topUpChips: 0, handsPlayed: 3, updatedAt: serverTimestamp() }); return b.commit(); });
await t('#26', '自救後房主回來：只空出座位（只寫房間）', 'ok', async () => { await gone(11 * MIN)(); await selfRescue(); }, async () => { const r = await cur();
  return hostUpd(db('H'), r, { seatUids: ['H', '', '', '', '', ''], stacks: [7000, 0, 0, 0, 0, 0], chipTotal: 7000, sess: [r.sess[0], null, null, null, null, null], lastMoneyEvent: { uid: 'A', id: R + '_1_cashout', seat: 1, type: 'cashout', amount: 3000 } }); });
await t('#26', '自救後房主回來又想替 A 入帳一次', 'deny', async () => { await gone(11 * MIN)(); await selfRescue(); }, () => hostCashout(1, 'A'));
await t('#26', '自救後房主只改 A 帳戶 bank（不新增帳本）', 'deny', async () => { await gone(11 * MIN)(); await selfRescue(); }, () => updateDoc(doc(db('H'), 'pokerPlayers', 'A'), { bank: 6000, total: 6000, updatedAt: serverTimestamp() }));

// #27 取消帶入
await t('#27', 'B 帶入未入座、房主失聯 11 分鐘：取消帶入退回原數', 'ok', async () => { await gone(11 * MIN)(); await buyinBatch('B'); }, () => cancelBuyin('B'));
await t('#27', '同上，房主只失聯 3 分鐘：被拒', 'deny', async () => { await gone(3 * MIN)(); await buyinBatch('B'); }, () => cancelBuyin('B'));
let cancelBack = '';
{ await gone(11 * MIN)(); await buyinBatch('B'); await cancelBuyin('B'); const p = await curP('B'); cancelBack = `bank ${p.bank} inPlay ${p.inPlay} total ${p.total} tableRoomId ${p.tableRoomId}`; }

// sessSame / null 額外
await t('sessSame', '空位 null→null、其他不變的一般寫入（只改 pub）', 'ok', S, async () => { const r = await cur(); return hostUpd(db('H'), r, { pub: { phase: 'lobby' } }); });
await t('sessSame', '有人的座位 sess 改成 null（無帳務事件）', 'deny', S, async () => { const r = await cur(); return hostUpd(db('H'), r, { sess: [r.sess[0], null, null, null, null, null] }); });

// moneyOk let/getAfter：lastMoneyEvent 指向不存在的帳本
await t('moneyOk', 'lastMoneyEvent 指向不存在的帳本（getAfter 回 null）', 'deny', async () => { await S(); await buyinBatch('B'); }, async () => { const r = await cur();
  return hostUpd(db('H'), r, { seatUids: ['H', 'A', 'B', '', '', ''], stacks: [7000, 3000, 5000, 0, 0, 0], chipTotal: 15000, sess: [r.sess[0], r.sess[1], { uid: 'B', sessionNo: 1, buyIn: 5000, topUps: 0, topUpChips: 0, hands: 0, nightKey: NK, startAt: START_AT() }, null, null, null],
    lastMoneyEvent: { uid: 'B', id: R + '_9_buyin', seat: 2, type: 'buyin', amount: 5000 } }); });
await t('moneyOk', 'lastMoneyEvent 改回 null', 'deny', async () => { await seed({ room: { lastMoneyEvent: { uid: 'A', id: R + '_1_buyin', seat: 1, type: 'buyin', amount: 5000 } } }); }, async () => { const r = await cur(); return hostUpd(db('H'), r, { lastMoneyEvent: null }); });


// ---- 滿桌最壞情況（運算式上限 1000） ----
const full = (o = {}) => () => seed({ room: { members: ['H','A','B','C','D','E','F','G'], seatUids: ['H','A','C','D','E','F'], stacks: [5000,5000,5000,5000,5000,5000], chipTotal: 30000,
  sess: ['H','A','C','D','E','F'].map((u) => sessOf(u, 1, 5000)), ...o },
  players: { C: player(), D: player(), E: player(), F: player() } });
await t('worst', '6 人滿桌：每手結束（6 格 stacks 和 hands 都變）', 'ok', full(), async () => { const r = await cur();
  return hostUpd(db('H'), r, { stacks: [10000, 0, 2500, 2500, 7500, 7500], sess: r.sess.map((x) => ({ ...x, hands: x.hands + 1 })), pub: { phase: 'hand_over', handNo: 4 } }); });
await t('worst', '6 人滿桌：房主替 F（5 號位）結帳', 'ok', full(), () => hostCashout(5, 'F'));
await t('worst', '6 人滿桌：房主替自己結帳＋交棒給 A', 'ok', full(), () => hostCashout(0, 'H', { room: { hostUid: 'A', hostSince: serverTimestamp() } }));
await t('worst', '6 人滿桌：A 接手（房主失聯 60 秒）', 'ok', async () => { await full({ updatedAt: ago(60000) })(); await env.withSecurityRulesDisabled((c) => setDoc(doc(c.firestore(), 'pokerRooms', R, 'presence', 'H'), { beat: ago(60000), vis: false })); },
  async () => takeover('A', await cur()));
await t('worst', '5 人在座：第 6 人 G 坐下（5 號位）', 'ok', async () => {
  await seed({ room: { members: ['H','A','B','C','D','E','G'], seatUids: ['H','A','C','D','E',''], stacks: [5000,5000,5000,5000,5000,0], chipTotal: 25000,
    sess: [...['H','A','C','D','E'].map((u) => sessOf(u, 1, 5000)), null] }, players: { C: player(), D: player(), E: player(), G: player({ bank: 5000, inPlay: 0, tableRoomId: null, sessionNo: 0 }) } });
  await buyinBatch('G'); }, () => seatBatch(5, 'G', 5000));
await t('worst', '6 人滿桌：補碼（5 號位 F 輸光）', 'ok', full({ stacks: [10000,5000,5000,5000,5000,0] }), () => topupBatch(5, 'F'));

await t('worst', '帳務事件同一筆順便改別格（結帳 F＋C 的 hands+1）', 'deny', full(), async () => { const r = await cur(); const sess = [...r.sess]; sess[5] = null; sess[2] = { ...sess[2], hands: sess[2].hands + 1 }; return hostCashout(5, 'F', { room: { sess } }); });
await t('worst', '帳務事件同一筆順便清掉別人座位（結帳 F＋清 E）', 'deny', full(), async () => { const r = await cur(); const seatUids = [...r.seatUids]; seatUids[5] = ''; seatUids[4] = ''; return hostCashout(5, 'F', { room: { seatUids } }); });
fs.writeFileSync(process.env.OUT || 'results.json', JSON.stringify({ rules: RULES, startAt: process.env.STARTAT || 'serverTimestamp', results, raceInfo, retry, cancelBack }, null, 1));
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.group} ${r.name} | 預期 ${r.expect} 實際 ${r.got} ${r.pass ? '' : r.err}`);
console.log('race:', raceInfo, '\ncancelBack:', cancelBack, '\nretry before/after A bank:', retry.before?.bank, retry.after?.bank);
console.log(`TOTAL ${results.filter((r) => r.pass).length}/${results.length}`);
await env.cleanup();
