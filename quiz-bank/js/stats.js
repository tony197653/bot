/**
 * 作答紀錄 attempts、待傳佇列（v1.4：只寫 attempt，不寫 qstats）。
 */
import { getFirebase } from './auth.js';
import { initFirebase } from './fb.js';

const PENDING_PREFIX = 'quizbank:v1:pending:';
const PROGRESS_PREFIX = 'quizbank:v1:progress:';
const RESULT_PREFIX = 'quizbank:v1:lastResult:';

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

export function resultKey(uid) {
  return `${RESULT_PREFIX}${uid}`;
}

/** 結算快照：離線／重整後還原結果頁 */
export function saveLastResult(uid, payload) {
  try {
    localStorage.setItem(resultKey(uid), JSON.stringify(payload));
  } catch {
    /* ignore quota */
  }
}

export function loadLastResult(uid) {
  try {
    const raw = localStorage.getItem(resultKey(uid));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearLastResult(uid) {
  try {
    localStorage.removeItem(resultKey(uid));
  } catch {
    /* ignore */
  }
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

/** 公開讀取待傳佇列（路由／重試判斷用） */
export function listPending(uid) {
  return readPending(uid);
}

export function hasPending(uid, attemptId) {
  const list = readPending(uid);
  if (!attemptId) return list.length > 0;
  return list.some((x) => x.attemptId === attemptId);
}

/** 前端產生固定 attemptId（idempotent set；重送不會變兩筆） */
export function newAttemptId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `att_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** @deprecated 舊佇列可能仍帶合成 id；新寫入一律用 newAttemptId() */
export function attemptIdFor(result) {
  const q0 = (result.qids && result.qids[0]) || 'x';
  return `att_${result.startedAt}_${result.endedAt}_${result.score}_${result.total}_${q0}`;
}

/** @type {Map<string, Promise<{ok:boolean, error?:unknown}>>} */
const inflightSaves = new Map();

function inflightKey(uid, attemptId) {
  return `${uid}::${attemptId}`;
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
 * @param {object} result
 * @param {object} meta
 */
export function buildPendingPayload(result, meta, existingAttemptId) {
  return {
    attemptId: existingAttemptId || newAttemptId(),
    result,
    meta,
    savedAt: Date.now(),
  };
}

export function enqueuePending(uid, entry) {
  const list = readPending(uid);
  if (
    list.some(
      (x) =>
        (entry.attemptId && x.attemptId === entry.attemptId) || x.savedAt === entry.savedAt,
    )
  ) {
    return;
  }
  list.push(entry);
  writePending(uid, list);
}

function sameResultFingerprint(a, b) {
  if (!a || !b) return false;
  return (
    a.startedAt === b.startedAt &&
    a.endedAt === b.endedAt &&
    a.score === b.score &&
    a.total === b.total &&
    JSON.stringify(a.qids || []) === JSON.stringify(b.qids || [])
  );
}

/** 先入隊（換頁前呼叫）；同回合指紋重用同一 attemptId，回傳 payload */
export function enqueueAttempt(uid, result, meta) {
  const list = readPending(uid);
  const existing = list.find((x) => sameResultFingerprint(x.result, result));
  if (existing) return existing;
  const payload = buildPendingPayload(result, meta);
  enqueuePending(uid, payload);
  return payload;
}

function removePendingEntry(uid, entry) {
  const list = readPending(uid).filter((x) => {
    if (entry.attemptId && x.attemptId === entry.attemptId) return false;
    if (entry.savedAt != null && x.savedAt === entry.savedAt) return false;
    return true;
  });
  writePending(uid, list);
}

/**
 * 背景上傳與重試共用：同 attemptId 只跑一趟；attempt 用固定 id set（已存在＝成功）。
 * @param {string} uid
 * @param {{attemptId:string, result:object, meta:object, savedAt:number}} payload
 */
export function settleOnce(uid, payload) {
  const attemptId = payload.attemptId || newAttemptId();
  const key = inflightKey(uid, attemptId);
  const existing = inflightSaves.get(key);
  if (existing) return existing;

  const work = (async () => {
    try {
      await writeSettlement(uid, payload.result, payload.meta, attemptId);
      clearProgress(uid);
      removePendingEntry(uid, { ...payload, attemptId });
      const att = await buildAttemptDoc(payload.result, payload.meta);
      att.id = attemptId;
      att.at = { toMillis: () => Date.now() };
      appendAttemptCache(att);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e };
    }
  })().finally(() => {
    inflightSaves.delete(key);
  });

  inflightSaves.set(key, work);
  return work;
}

/**
 * @param {string} uid
 * @param {object} result startQuiz / buildResult 輸出
 * @param {{scope:object, mode:'instant'|'exam', questions:object[]}} meta
 */
export async function saveAttempt(uid, result, meta) {
  const payload = enqueueAttempt(uid, result, meta);
  return settleOnce(uid, payload);
}

/**
 * 先入隊（若尚未），再嘗試寫入；逾時仍回 pending，背景繼續。與 flushPending 共用 inflight。
 * @param {string} uid
 * @param {object} result
 * @param {object} meta
 * @param {number} [ms]
 * @param {{onSuccess?:()=>void}} [hooks]
 * @param {{attemptId:string, result:object, meta:object, savedAt:number}} [existingPayload]
 */
export async function saveAttemptWithTimeout(
  uid,
  result,
  meta,
  ms = 8000,
  hooks = {},
  existingPayload = null,
) {
  const payload = existingPayload || enqueueAttempt(uid, result, meta);
  const work = settleOnce(uid, payload);

  const timed = await new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, timedOut: true }), ms);
    work.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve({ ok: false, timedOut: false });
      },
    );
  });

  if (timed.ok) {
    hooks.onSuccess?.();
  } else {
    work.then((r) => {
      if (r?.ok) hooks.onSuccess?.();
    });
  }

  return timed;
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

/**
 * 只寫一筆 attempt；文件已存在視為成功（idempotent）。
 * @param {string} uid
 * @param {object} result
 * @param {object} meta
 * @param {string} attemptId
 * @param {number} [retries]
 */
async function writeSettlement(uid, result, meta, attemptId, retries = 3) {
  const { db, fs } = await ensureFb();
  const questions = meta.questions || [];
  const id = attemptId || newAttemptId();
  const attRef = fs.doc(db, 'users', uid, 'attempts', id);

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const existing = await fs.getDoc(attRef);
      if (existing.exists()) return;

      const byUnit = computeByUnit(questions, result.answers);
      await fs.setDoc(attRef, {
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
      return;
    } catch (e) {
      // 競態：另一路已寫入 → 規則拒 update；視為成功
      try {
        const again = await fs.getDoc(attRef);
        if (again.exists()) return;
      } catch {
        /* ignore */
      }
      if (attempt === retries - 1) throw e;
    }
  }
}

/**
 * @param {string} uid
 */
export async function flushPending(uid) {
  const list = readPending(uid);
  if (!list.length) return { flushed: 0, failed: 0 };
  let flushed = 0;
  let failed = 0;
  /** @type {any[]} */
  const errors = [];
  for (const item of list) {
    const payload = {
      ...item,
      attemptId: item.attemptId || newAttemptId(),
    };
    const r = await settleOnce(uid, payload);
    if (r.ok) {
      flushed++;
    } else {
      failed++;
      if (r.error) errors.push(r.error);
    }
  }
  if (flushed) cachedAttempts30d = null;
  return { flushed, failed, errors };
}

export function invalidateAttemptsCache() {
  cachedAttempts30d = null;
  cachedAttemptsUid = null;
}
