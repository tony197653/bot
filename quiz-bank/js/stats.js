/**
 * 作答紀錄、錯題本 qstats、強弱表（30 天 attempts.byUnit）、待傳佇列。
 */
import { getFirebase } from './auth.js';
import { initFirebase } from './fb.js';

const PENDING_PREFIX = 'quizbank:v1:pending:';
const PROGRESS_PREFIX = 'quizbank:v1:progress:';

/** @type {any[]|null} */
let cachedAttempts30d = null;
/** @type {string|null} */
let cachedAttemptsUid = null;

async function ensureFb() {
  let fb = getFirebase();
  if (!fb) fb = await initFirebase();
  return fb;
}

export function pendingKey(uid) {
  return `${PENDING_PREFIX}${uid}`;
}

export function progressKey(uid) {
  return `${PROGRESS_PREFIX}${uid}`;
}

function readPending(uid) {
  try {
    const raw = localStorage.getItem(pendingKey(uid));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writePending(uid, items) {
  try {
    localStorage.setItem(pendingKey(uid), JSON.stringify(items));
  } catch {
    /* ignore */
  }
}

export function clearProgress(uid) {
  try {
    localStorage.removeItem(progressKey(uid));
  } catch {
    /* ignore */
  }
}

/**
 * 由題目與答案（-1＝未答）算出 Firestore byUnit map。
 * @param {object[]} questions
 * @param {number[]} answers
 */
export function computeByUnit(questions, answers) {
  /** @type {Record<string,{unit:string,subject:string,correct:number,total:number}>} */
  const map = {};
  questions.forEach((q, idx) => {
    const code = q.unitCode || 'UNKNOWN';
    if (!map[code]) {
      map[code] = {
        unit: q.unit || code,
        subject: q.subject || 'math',
        correct: 0,
        total: 0,
      };
    }
    map[code].total++;
    const a = answers[idx];
    if (a === q.answer) map[code].correct++;
  });
  return map;
}

/**
 * @param {Array<{byUnit?:Record<string,{correct:number,total:number,unit?:string,subject?:string}>}>} attempts
 */
export function computeStrength(attempts) {
  /** @type {Record<string,{unitCode:string,unit:string,subject:string,correct:number,total:number}>} */
  const agg = {};
  for (const att of attempts || []) {
    const bu = att.byUnit || {};
    for (const [code, u] of Object.entries(bu)) {
      if (!agg[code]) {
        agg[code] = {
          unitCode: code,
          unit: u.unit || code,
          subject: u.subject || 'math',
          correct: 0,
          total: 0,
        };
      }
      agg[code].correct += u.correct || 0;
      agg[code].total += u.total || 0;
    }
  }
  return Object.values(agg)
    .map((row) => {
      const rate = row.total ? row.correct / row.total : 0;
      let status = 'none';
      let label = '30 天內未練';
      if (row.total > 0) {
        if (rate >= 0.85) {
          status = 'good';
          label = '掌握';
        } else if (rate >= 0.6) {
          status = 'mid';
          label = '部分掌握';
        } else {
          status = 'weak';
          label = '需加強';
        }
      }
      return { ...row, rate, status, label, lowSample: row.total > 0 && row.total < 5 };
    })
    .sort((a, b) => {
      if (!a.total && !b.total) return a.unitCode.localeCompare(b.unitCode);
      if (!a.total) return 1;
      if (!b.total) return -1;
      return a.rate - b.rate;
    });
}

function cutoff30d() {
  return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
}

/**
 * @param {string} uid
 * @param {boolean} [force]
 */
export async function loadAttempts30d(uid, force = false) {
  if (!force && cachedAttemptsUid === uid && cachedAttempts30d) return cachedAttempts30d.slice();
  const { db, fs } = await ensureFb();
  const q = fs.query(
    fs.collection(db, 'users', uid, 'attempts'),
    fs.where('at', '>=', fs.Timestamp.fromDate(cutoff30d())),
    fs.orderBy('at', 'asc'),
  );
  const snap = await fs.getDocs(q);
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  cachedAttemptsUid = uid;
  cachedAttempts30d = rows;
  return rows.slice();
}

export function appendAttemptCache(att) {
  if (!cachedAttempts30d) cachedAttempts30d = [];
  cachedAttempts30d.push(att);
}

/**
 * @param {string} uid
 */
export async function loadQstatsWrong(uid) {
  const { db, fs } = await ensureFb();
  const q = fs.query(
    fs.collection(db, 'users', uid, 'qstats'),
    fs.where('inWrongBook', '==', true),
  );
  const snap = await fs.getDocs(q);
  const rows = snap.docs.map((d) => ({ qid: d.id, ...d.data() }));
  rows.sort((a, b) => {
    const ta = a.lastAt?.toMillis?.() ?? 0;
    const tb = b.lastAt?.toMillis?.() ?? 0;
    return ta - tb;
  });
  return rows;
}

/**
 * @param {string} uid
 */
export async function loadAttemptSummary(uid) {
  const { db, fs } = await ensureFb();
  const q = fs.query(
    fs.collection(db, 'users', uid, 'attempts'),
    fs.orderBy('at', 'desc'),
    fs.limit(200),
  );
  const snap = await fs.getDocs(q);
  const attempts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  /** @type {Record<string,{count:number,best:number,lastAt:number}>} */
  const byRound = {};
  for (const a of attempts) {
    const sc = a.scope || {};
    if (sc.type !== 'round') continue;
    const key = `${sc.bookId}|${sc.unitCode}|${sc.round}`;
    const at = a.at?.toMillis?.() ?? 0;
    if (!byRound[key]) byRound[key] = { count: 0, best: 0, lastAt: 0 };
    byRound[key].count++;
    byRound[key].best = Math.max(byRound[key].best, a.score || 0);
    byRound[key].lastAt = Math.max(byRound[key].lastAt, at);
  }
  const recent = attempts.slice(0, 3).map((a) => ({
    at: a.at,
    score: a.score,
    scope: a.scope,
  }));
  return { byRound, recent, totalAttempts: attempts.length };
}

/**
 * @param {object|null} prev
 * @param {object} q
 * @param {number} answer -1..3
 */
function nextQstat(prev, q, answer) {
  const ok = answer === q.answer;
  const base = prev || {
    unitCode: q.unitCode,
    subject: q.subject,
    tries: 0,
    correct: 0,
    wrong: 0,
    streak: 0,
    inWrongBook: false,
    manualOut: false,
    lastAnswer: -1,
  };
  const tries = base.tries + 1;
  let correct = base.correct;
  let wrong = base.wrong;
  let streak = base.streak;
  let inWrongBook = base.inWrongBook;
  let manualOut = base.manualOut;

  if (ok) {
    correct++;
    streak++;
    if (inWrongBook && streak >= 2) inWrongBook = false;
  } else {
    wrong++;
    streak = 0;
    inWrongBook = true;
    manualOut = false;
  }

  return {
    unitCode: q.unitCode,
    subject: q.subject,
    tries,
    correct,
    wrong,
    streak,
    inWrongBook,
    manualOut,
    lastAnswer: answer < 0 ? -1 : answer,
  };
}

/**
 * @param {string} uid
 * @param {object} result startQuiz / buildResult 輸出
 * @param {{scope:object, mode:'instant'|'exam', questions:object[]}} meta
 */
export async function saveAttempt(uid, result, meta) {
  const payload = { result, meta, savedAt: Date.now() };
  try {
    const delta = await writeSettlement(uid, result, meta);
    clearProgress(uid);
    removePendingEntry(uid, payload);
    const att = await buildAttemptDoc(result, meta);
    att.at = { toMillis: () => Date.now() };
    appendAttemptCache(att);
    return { ok: true, wrongBookDelta: delta };
  } catch (e) {
    enqueuePending(uid, payload);
    return { ok: false, error: e, wrongBookDelta: 0 };
  }
}

function enqueuePending(uid, entry) {
  const list = readPending(uid);
  list.push(entry);
  writePending(uid, list);
}

function removePendingEntry(uid, entry) {
  const list = readPending(uid).filter((x) => x.savedAt !== entry.savedAt);
  writePending(uid, list);
}

async function buildAttemptDoc(result, meta) {
  const byUnit = computeByUnit(meta.questions || [], result.answers || []);
  return {
    scope: meta.scope,
    mode: meta.mode,
    qids: result.qids,
    answers: result.answers,
    correct: result.correct,
    total: result.total,
    score: result.score,
    byUnit,
    startedAt: new Date(result.startedAt),
    endedAt: new Date(result.endedAt),
  };
}

async function writeSettlement(uid, result, meta, retries = 3) {
  const { db, fs } = await ensureFb();
  const questions = meta.questions || [];
  const qById = Object.fromEntries(questions.map((q) => [q.id, q]));
  let wrongBookDelta = 0;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      wrongBookDelta = await fs.runTransaction(db, async (tx) => {
        let delta = 0;
        /** @type {Record<string,object>} */
        const nextStats = {};
        for (let i = 0; i < result.qids.length; i++) {
          const qid = result.qids[i];
          const q = qById[qid];
          if (!q) continue;
          const ref = fs.doc(db, 'users', uid, 'qstats', qid);
          const snap = await tx.get(ref);
          const prev = snap.exists() ? snap.data() : null;
          const wasIn = !!prev?.inWrongBook;
          const next = nextQstat(prev, q, result.answers[i]);
          if (!wasIn && next.inWrongBook) delta++;
          if (wasIn && !next.inWrongBook) delta--;
          nextStats[qid] = next;
        }
        for (const [qid, data] of Object.entries(nextStats)) {
          const ref = fs.doc(db, 'users', uid, 'qstats', qid);
          tx.set(ref, { ...data, lastAt: fs.serverTimestamp() }, { merge: false });
        }
        const byUnit = computeByUnit(questions, result.answers);
        const attRef = fs.doc(fs.collection(db, 'users', uid, 'attempts'));
        tx.set(attRef, {
          scope: meta.scope,
          mode: meta.mode,
          qids: result.qids,
          answers: result.answers,
          correct: result.correct,
          total: result.total,
          score: result.score,
          byUnit,
          startedAt: fs.Timestamp.fromMillis(result.startedAt),
          endedAt: fs.Timestamp.fromMillis(result.endedAt),
          at: fs.serverTimestamp(),
        });
        return delta;
      });
      return wrongBookDelta;
    } catch (e) {
      if (attempt === retries - 1) throw e;
    }
  }
  return wrongBookDelta;
}

/**
 * @param {string} uid
 */
export async function flushPending(uid) {
  const list = readPending(uid);
  if (!list.length) return { flushed: 0, failed: 0 };
  let flushed = 0;
  let failed = 0;
  const remain = [];
  for (const item of list) {
    try {
      await writeSettlement(uid, item.result, item.meta);
      clearProgress(uid);
      flushed++;
    } catch {
      failed++;
      remain.push(item);
    }
  }
  writePending(uid, remain);
  if (flushed) cachedAttempts30d = null;
  return { flushed, failed };
}

/**
 * @param {string} uid
 * @param {string} qid
 */
export async function updateQstatManualOut(uid, qid) {
  const { db, fs } = await ensureFb();
  const ref = fs.doc(db, 'users', uid, 'qstats', qid);
  const snap = await fs.getDoc(ref);
  if (!snap.exists()) return false;
  const prev = snap.data();
  await fs.updateDoc(ref, {
    unitCode: prev.unitCode,
    subject: prev.subject,
    tries: prev.tries,
    correct: prev.correct,
    wrong: prev.wrong,
    streak: prev.streak,
    inWrongBook: false,
    manualOut: true,
    lastAnswer: prev.lastAnswer,
    lastAt: fs.serverTimestamp(),
  });
  return true;
}

export function invalidateAttemptsCache() {
  cachedAttempts30d = null;
  cachedAttemptsUid = null;
}
