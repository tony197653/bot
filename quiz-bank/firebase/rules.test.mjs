/**
 * Firestore 規則測試（只連本機 emulator，專案 demo-quiz-bank）。
 * 覆蓋規格 §12 項目 1：
 * - 學生讀 draft 被拒
 * - 刪 qstats 被拒
 * - tries 跳號被拒
 * - 手動移出可以
 * - admin 寫自己的 attempts 可以
 * - 學生讀 reports 被拒
 * - attempt 沒有 byUnit 被拒
 *
 * 注意：直接呼叫操作；permission-denied → deny（不要包 assertFails，會跟 harness 打架）。
 */
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  addDoc,
  serverTimestamp,
  setLogLevel,
} from 'firebase/firestore';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

setLogLevel('silent');

const __dir = path.dirname(fileURLToPath(import.meta.url));
const RULES = process.env.RULES || path.join(__dir, 'firestore.rules');
const PROJECT = 'demo-quiz-bank';
const FS_PORT = Number(process.env.FIRESTORE_EMULATOR_PORT || 8295);

const env = await initializeTestEnvironment({
  projectId: PROJECT,
  firestore: {
    host: '127.0.0.1',
    port: FS_PORT,
    rules: fs.readFileSync(RULES, 'utf8'),
  },
});

const results = [];
async function t(name, expect, setup, fn) {
  let got;
  let err = '';
  try {
    await setup();
  } catch (e) {
    results.push({ name, expect, got: 'SETUP-ERR', pass: false, err: e.message });
    console.log(`FAIL  ${name}  SETUP-ERR  ${e.message}`);
    return;
  }
  try {
    await fn();
    got = 'ok';
  } catch (e) {
    got = /PERMISSION_DENIED|permission-denied|false for/i.test(
      String(e.code) + ' ' + e.message,
    )
      ? 'deny'
      : 'error';
    err = `${e.code || ''} ${String(e.message).split('\n')[0].slice(0, 160)}`;
  }
  const pass = got === expect;
  results.push({ name, expect, got, pass, err });
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${name}  (expect ${expect}, got ${got})${pass ? '' : '  ' + err}`,
  );
}

function authCtx(uid, email, claims = {}) {
  return env.authenticatedContext(uid, {
    email,
    email_verified: true,
    ...claims,
  });
}

async function seedBase() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'allow', 'admin@test.local'), {
      role: 'admin',
      name: '管理員',
    });
    await setDoc(doc(db, 'allow', 'student@test.local'), {
      role: 'student',
      name: '學生',
    });
    await setDoc(doc(db, 'banks', 'demo'), {
      title: '示範',
      subject: 'math',
      grade: 9,
      units: [],
      updatedAt: new Date(),
    });
    await setDoc(doc(db, 'questions', 'demo-m8-1-r1-q01'), {
      id: 'demo-m8-1-r1-q01',
      bookId: 'demo-m8',
      unitCode: 'M8-1',
      review: { status: 'draft', flags: [] },
      stem: '草稿題',
    });
    await setDoc(doc(db, 'questions', 'demo-m8-1-r1-q02'), {
      id: 'demo-m8-1-r1-q02',
      bookId: 'demo-m8',
      unitCode: 'M8-1',
      review: { status: 'checked', flags: [] },
      stem: '已校對題',
    });
    await setDoc(doc(db, 'users', 'student1', 'qstats', 'demo-m8-1-r1-q02'), {
      unitCode: 'M8-1',
      subject: 'math',
      tries: 2,
      correct: 1,
      wrong: 1,
      streak: 1,
      inWrongBook: true,
      manualOut: false,
      lastAnswer: 0,
      lastAt: new Date(),
    });
    await setDoc(doc(db, 'reports', 'demo-m8-1-r1-q02__other'), {
      qid: 'demo-m8-1-r1-q02',
      uid: 'other',
      reason: 'typo',
      note: '別人的回報',
      status: 'open',
      at: new Date(),
    });
    await setDoc(doc(db, 'reports', 'demo-m8-1-r1-q02__student1'), {
      qid: 'demo-m8-1-r1-q02',
      uid: 'student1',
      reason: 'typo',
      note: '字打錯',
      status: 'open',
      at: new Date(),
    });
  });
}

function goodAttempt(extra = {}) {
  return {
    scope: { type: 'round', bookId: 'demo-m8', unitCode: 'M8-1', round: 1 },
    mode: 'instant',
    qids: ['demo-m8-1-r1-q02'],
    answers: [1],
    correct: 1,
    total: 1,
    score: 100,
    byUnit: {
      'M8-1': { unit: '示範單元', subject: 'math', correct: 1, total: 1 },
    },
    startedAt: new Date(Date.now() - 60000),
    endedAt: new Date(),
    at: serverTimestamp(),
    ...extra,
  };
}

function goodStat(extra = {}) {
  return {
    unitCode: 'M8-1',
    subject: 'math',
    tries: 1,
    correct: 0,
    wrong: 1,
    streak: 0,
    inWrongBook: true,
    manualOut: false,
    lastAnswer: 2,
    lastAt: serverTimestamp(),
    ...extra,
  };
}

await t('學生讀 draft 題目被拒', 'deny', seedBase, () =>
  getDoc(doc(authCtx('student1', 'student@test.local').firestore(), 'questions', 'demo-m8-1-r1-q01')),
);

await t('學生讀 checked 題目可以', 'ok', seedBase, () =>
  getDoc(doc(authCtx('student1', 'student@test.local').firestore(), 'questions', 'demo-m8-1-r1-q02')),
);

await t('刪 qstats 被拒', 'deny', seedBase, () =>
  deleteDoc(
    doc(
      authCtx('student1', 'student@test.local').firestore(),
      'users',
      'student1',
      'qstats',
      'demo-m8-1-r1-q02',
    ),
  ),
);

await t('tries 跳號被拒', 'deny', seedBase, async () => {
  const d = authCtx('student1', 'student@test.local').firestore();
  await updateDoc(doc(d, 'users', 'student1', 'qstats', 'demo-m8-1-r1-q02'), {
    unitCode: 'M8-1',
    subject: 'math',
    tries: 5,
    correct: 2,
    wrong: 3,
    streak: 0,
    inWrongBook: true,
    manualOut: false,
    lastAnswer: 1,
    lastAt: serverTimestamp(),
  });
});

await t('手動移出可以', 'ok', seedBase, async () => {
  const d = authCtx('student1', 'student@test.local').firestore();
  await updateDoc(doc(d, 'users', 'student1', 'qstats', 'demo-m8-1-r1-q02'), {
    unitCode: 'M8-1',
    subject: 'math',
    tries: 2,
    correct: 1,
    wrong: 1,
    streak: 1,
    inWrongBook: false,
    manualOut: true,
    lastAnswer: 0,
    lastAt: serverTimestamp(),
  });
});

await t('admin 寫自己的 attempts 可以', 'ok', seedBase, async () => {
  const d = authCtx('admin1', 'admin@test.local').firestore();
  await addDoc(collection(d, 'users', 'admin1', 'attempts'), goodAttempt());
});

await t('學生讀別人的 reports 被拒', 'deny', seedBase, () =>
  getDoc(
    doc(
      authCtx('student1', 'student@test.local').firestore(),
      'reports',
      'demo-m8-1-r1-q02__other',
    ),
  ),
);

await t('學生讀自己的 reports 可以', 'ok', seedBase, () =>
  getDoc(
    doc(
      authCtx('student1', 'student@test.local').firestore(),
      'reports',
      'demo-m8-1-r1-q02__student1',
    ),
  ),
);

await t('學生 get 不存在的 report 可以（首次回報檢查）', 'ok', seedBase, () =>
  getDoc(
    doc(
      authCtx('student1', 'student@test.local').firestore(),
      'reports',
      'brand-new-qid__student1',
    ),
  ),
);

await t('admin 讀 reports 可以', 'ok', seedBase, () =>
  getDoc(
    doc(
      authCtx('admin1', 'admin@test.local').firestore(),
      'reports',
      'demo-m8-1-r1-q02__student1',
    ),
  ),
);

await t('attempt 沒有 byUnit 被拒', 'deny', seedBase, async () => {
  const d = authCtx('student1', 'student@test.local').firestore();
  const bad = goodAttempt();
  delete bad.byUnit;
  await addDoc(collection(d, 'users', 'student1', 'attempts'), bad);
});

await t('學生可建立 qstats tries=1', 'ok', seedBase, async () => {
  const d = authCtx('student1', 'student@test.local').firestore();
  await setDoc(doc(d, 'users', 'student1', 'qstats', 'new-q'), goodStat());
});

await t('未驗證 email 被拒讀 banks', 'deny', seedBase, () =>
  getDoc(
    doc(
      env
        .authenticatedContext('x', {
          email: 'student@test.local',
          email_verified: false,
        })
        .firestore(),
      'banks',
      'demo',
    ),
  ),
);

await env.cleanup();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.error('FAILED:', failed.map((f) => f.name).join(', '));
  process.exit(1);
}
process.exit(0);
