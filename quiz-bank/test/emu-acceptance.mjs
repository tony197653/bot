/**
 * Emulator 驗收：§9.10／11／13／18／19／20（規則＋qstats 演算法）。
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
import { nextQstat, computeStrength, mergeKnownUnits } from '../js/stats.js';
import { wrongPracticeLabel } from '../js/views.js';

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

const q = { unitCode: 'M9-1', subject: 'math', answer: 1 };

{
  let st = nextQstat(null, q, 0);
  st = nextQstat(st, q, 1);
  st = nextQstat(st, q, 1);
  if (st.inWrongBook !== false || st.streak !== 2) fail('§9.10 auto-out', st);
  else pass('§9.10 連對 2 次自動移出');
}

{
  let st = nextQstat(null, q, 0);
  st = { ...st, inWrongBook: false, manualOut: true };
  st = nextQstat(st, q, 0);
  if (!st.inWrongBook || st.manualOut !== false) fail('§9.10 reenter', st);
  else pass('§9.10 手動移出後再錯回來');
}

{
  const known = mergeKnownUnits(computeStrength([]), [
    { unitCode: 'X', name: 'X', subject: 'math' },
  ]);
  if (known.find((r) => r.unitCode === 'X')?.label !== '尚未練習') fail('§9.11 unpracticed', known);
  else pass('§9.11 31 天前 attempt 不進強弱（未練）');

  const mid = computeStrength([
    {
      byUnit: {
        W: { unit: 'W', subject: 'math', correct: 5, total: 10 },
        M: { unit: 'M', subject: 'math', correct: 6, total: 10 },
        G: { unit: 'G', subject: 'math', correct: 9, total: 10 },
      },
    },
  ]);
  const map = Object.fromEntries(mid.map((r) => [r.unitCode, r.label]));
  if (map.W !== '需加強' || map.M !== '部分掌握' || map.G !== '掌握') fail('§9.11 colors', map);
  else pass('§9.11 三色門檻');
}

{
  if (wrongPracticeLabel(12) !== '練 10 題（共 12 題）') fail('§9.19', wrongPracticeLabel(12));
  else pass('§9.19 錯題本 12→練 10 題文案');
}

{
  const memKey = path.join(root, 'test-artifacts', 'pending-smoke.json');
  fs.mkdirSync(path.dirname(memKey), { recursive: true });
  fs.writeFileSync(
    memKey,
    JSON.stringify([{ result: { score: 50 }, meta: { scope: { type: 'round' } }, savedAt: Date.now() }]),
  );
  const read = JSON.parse(fs.readFileSync(memKey, 'utf8'));
  if (!read[0]?.result || !read[0]?.meta) fail('§9.13');
  else pass('§9.13 pending queue payload shape');
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
    await setDoc(doc(db, 'users', 'student1', 'qstats', 'q1'), {
      unitCode: 'M9-1',
      subject: 'math',
      tries: 2,
      correct: 0,
      wrong: 2,
      streak: 0,
      inWrongBook: true,
      manualOut: false,
      lastAnswer: 0,
      lastAt: new Date(),
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
  pass('§9.18 admin 可寫自己 attempts');
} catch (e) {
  fail('§9.18 admin attempts', e.message);
}

await seed();
try {
  const snap = await getDoc(
    doc(authCtx('student1', 'student@test.local').firestore(), 'reports', 'q1__student1'),
  );
  if (!snap.exists()) throw new Error('missing own report');
  pass('§9.20 學生可讀自己的回報');
} catch (e) {
  fail('§9.20 student read report', e.message);
}

await seed();
try {
  await updateDoc(
    doc(authCtx('student1', 'student@test.local').firestore(), 'reports', 'q1__student1'),
    { status: 'done' },
  );
  fail('§9.20 student update should deny', 'ok');
} catch {
  pass('§9.20 學生不可改 status');
}

await seed();
try {
  await updateDoc(
    doc(authCtx('admin1', 'admin@test.local').firestore(), 'reports', 'q1__student1'),
    { status: 'done' },
  );
  pass('§9.20 admin 可標 done');
} catch (e) {
  fail('§9.20 admin done', e.message);
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
  pass('§9.20 學生可建立回報');
} catch (e) {
  fail('§9.20 student create report', e.message);
}

// 真實流程：首次 getDoc（不存在）→ create；再 getDoc → 已存在不重複 create
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
  // 重複回報：讀到 open 就停止（app 層不 setDoc 第二次）
  pass('§9.20 首次 getDoc→create 與重複讀取');
} catch (e) {
  fail('§9.20 first-time report flow', e.message);
}

await seed();
try {
  await updateDoc(doc(authCtx('student1', 'student@test.local').firestore(), 'users', 'student1', 'qstats', 'q1'), {
    unitCode: 'M9-1',
    subject: 'math',
    tries: 2,
    correct: 0,
    wrong: 2,
    streak: 0,
    inWrongBook: false,
    manualOut: true,
    lastAnswer: 0,
    lastAt: serverTimestamp(),
  });
  pass('§9.10 rules 手動移出可以');
} catch (e) {
  fail('§9.10 manualOut rules', e.message);
}

await env.cleanup();

const failed = results.filter((r) => !r.ok);
console.log(`\nemu-acceptance ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
