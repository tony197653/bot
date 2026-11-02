/**
 * Emulator 驗收（v1.4.1）：attempts、reports、qstats／favorites 拒絕。
 */
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  addDoc,
  collection,
  serverTimestamp,
  setLogLevel,
} from 'firebase/firestore';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeByUnit } from '../js/stats.js';

setLogLevel('silent');

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RULES = path.join(root, 'firebase/firestore.rules');
const FS_PORT = Number(process.env.FIRESTORE_EMULATOR_PORT || 8295);

const env = await initializeTestEnvironment({
  projectId: 'demo-quiz-bank-acc',
  firestore: {
    host: '127.0.0.1',
    port: FS_PORT,
    rules: fs.readFileSync(RULES, 'utf8'),
  },
});

const results = [];
function pass(name) {
  results.push({ name, ok: true });
  console.log('PASS', name);
}
function fail(name, err) {
  results.push({ name, ok: false, err: String(err) });
  console.error('FAIL', name, err);
}

function authCtx(uid, email) {
  return env.authenticatedContext(uid, { email, email_verified: true });
}

{
  const qs = [
    { unitCode: 'M9-1', unit: '單元', subject: 'math', answer: 1 },
    { unitCode: 'M9-1', unit: '單元', subject: 'math', answer: 0 },
  ];
  const by = computeByUnit(qs, [1, 1]);
  if (by['M9-1']?.correct !== 1 || by['M9-1']?.total !== 2) fail('byUnit', by);
  else pass('computeByUnit for attempts.byUnit');
}

{
  const memKey = path.join(root, 'test-artifacts', 'pending-smoke.json');
  fs.mkdirSync(path.dirname(memKey), { recursive: true });
  fs.writeFileSync(
    memKey,
    JSON.stringify([{ attemptId: 'uuid-1', result: { score: 50 }, meta: { scope: { type: 'round' } }, savedAt: Date.now() }]),
  );
  const read = JSON.parse(fs.readFileSync(memKey, 'utf8'));
  if (!read[0]?.attemptId || !read[0]?.result || !read[0]?.meta) fail('§9.13');
  else pass('pending queue payload shape (attemptId)');
}

async function seed() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'allow', 'admin@test.local'), { role: 'admin', name: 'A' });
    await setDoc(doc(db, 'allow', 'student@test.local'), { role: 'student', name: 'S' });
    await setDoc(doc(db, 'banks', 'b1'), {
      title: '書',
      subject: 'math',
      grade: 9,
      questionIds: ['q1'],
      units: [],
    });
    await setDoc(doc(db, 'reports', 'q1__student1'), {
      qid: 'q1',
      uid: 'student1',
      reason: 'typo',
      note: 'x',
      status: 'open',
      at: new Date(),
    });
  });
}

await seed();
try {
  await addDoc(collection(authCtx('admin1', 'admin@test.local').firestore(), 'users', 'admin1', 'attempts'), {
    scope: { type: 'round', bookId: 'b1', unitCode: 'M9-1', round: 1 },
    mode: 'instant',
    qids: ['q1'],
    answers: [0],
    correct: 0,
    total: 1,
    score: 0,
    byUnit: { 'M9-1': { unit: '單元', subject: 'math', correct: 0, total: 1 } },
    startedAt: new Date(Date.now() - 1000),
    endedAt: new Date(),
    at: serverTimestamp(),
  });
  pass('admin 可寫自己 attempts');
} catch (e) {
  fail('admin attempts', e.message);
}

await seed();
try {
  await setDoc(doc(authCtx('student1', 'student@test.local').firestore(), 'users', 'student1', 'qstats', 'q1'), {
    unitCode: 'M9-1',
    subject: 'math',
    tries: 1,
    correct: 0,
    wrong: 1,
    streak: 0,
    inWrongBook: true,
    manualOut: false,
    lastAnswer: 0,
    lastAt: serverTimestamp(),
  });
  fail('qstats write should deny', 'ok');
} catch {
  pass('寫 qstats 被拒');
}

await seed();
try {
  await setDoc(doc(authCtx('student1', 'student@test.local').firestore(), 'users', 'student1', 'favorites', 'q1'), {
    bookId: 'b1',
    subject: 'math',
    unitCode: 'M9-1',
    addedAt: serverTimestamp(),
  });
  fail('favorites write should deny', 'ok');
} catch {
  pass('寫 favorites 被拒');
}

await seed();
try {
  const snap = await getDoc(
    doc(authCtx('student1', 'student@test.local').firestore(), 'reports', 'q1__student1'),
  );
  if (!snap.exists()) throw new Error('missing own report');
  pass('學生可讀自己的回報');
} catch (e) {
  fail('student read report', e.message);
}

await seed();
try {
  await updateDoc(
    doc(authCtx('student1', 'student@test.local').firestore(), 'reports', 'q1__student1'),
    { status: 'done' },
  );
  fail('student update should deny', 'ok');
} catch {
  pass('學生不可改 status');
}

await seed();
try {
  await updateDoc(
    doc(authCtx('admin1', 'admin@test.local').firestore(), 'reports', 'q1__student1'),
    { status: 'done' },
  );
  pass('admin 可標 done');
} catch (e) {
  fail('admin done', e.message);
}

await seed();
try {
  await setDoc(doc(authCtx('student1', 'student@test.local').firestore(), 'reports', 'q2__student1'), {
    qid: 'q2',
    uid: 'student1',
    reason: 'answer',
    note: '',
    status: 'open',
    at: serverTimestamp(),
  });
  pass('學生可建立回報');
} catch (e) {
  fail('student create report', e.message);
}

await seed();
try {
  const d = authCtx('student1', 'student@test.local').firestore();
  const ref = doc(d, 'reports', 'fresh-q__student1');
  const first = await getDoc(ref);
  if (first.exists()) throw new Error('expected missing');
  await setDoc(ref, {
    qid: 'fresh-q',
    uid: 'student1',
    reason: 'typo',
    note: 'first',
    status: 'open',
    at: serverTimestamp(),
  });
  const second = await getDoc(ref);
  if (!second.exists()) throw new Error('expected created');
  if (second.data()?.status !== 'open') throw new Error('bad status');
  pass('首次 getDoc→create 與重複讀取');
} catch (e) {
  fail('first-time report flow', e.message);
}

await seed();
try {
  const d = authCtx('student1', 'student@test.local').firestore();
  const id = 'att_uuid_like_1';
  const payload = {
    scope: { type: 'round', bookId: 'b1', unitCode: 'M9-1', round: 1 },
    mode: 'instant',
    qids: ['q1'],
    answers: [0],
    correct: 0,
    total: 1,
    score: 0,
    byUnit: { 'M9-1': { unit: '單元', subject: 'math', correct: 0, total: 1 } },
    startedAt: new Date(1000),
    endedAt: new Date(2000),
    at: serverTimestamp(),
  };
  await setDoc(doc(d, 'users', 'student1', 'attempts', id), payload);
  const snap = await getDoc(doc(d, 'users', 'student1', 'attempts', id));
  if (!snap.exists()) throw new Error('missing attempt');
  let denied = false;
  try {
    await setDoc(doc(d, 'users', 'student1', 'attempts', id), { ...payload, score: 50 });
  } catch {
    denied = true;
  }
  if (!denied) throw new Error('overwrite should deny');
  pass('attempt fixed-id create ok, overwrite deny');
} catch (e) {
  fail('attempt fixed-id', e.message);
}

await env.cleanup();

const failed = results.filter((r) => !r.ok);
console.log(`\nemu-acceptance ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
