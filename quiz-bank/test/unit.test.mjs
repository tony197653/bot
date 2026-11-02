/**
 * 單元測試：§5.6 摘要、attemptId／待傳佇列、科目標籤（v1.4.1）。
 */
import { formatRoundSummary, taipeiStamp, shortenWrongIds } from '../js/summary.js';
import {
  newAttemptId,
  enqueueAttempt,
  listPending,
  hasPending,
  flushPending,
  pendingKey,
  computeByUnit,
} from '../js/stats.js';
import { SUBJECT_LABELS } from '../js/views.js';
import { flagLabel, reportReasonLabel } from '../js/schema.js';

let failed = 0;
function pass(n) {
  console.log('PASS', n);
}
function fail(n, e) {
  failed++;
  console.error('FAIL', n, e);
}

// §5.6 copy helpers（結算頁不再顯示複製鈕，摘要函式仍供待傳／除錯）
{
  if (
    shortenWrongIds(['hl-m9a-m9-2-r3-q04', 'hl-m9a-m9-2-r3-q09', 'hl-m9a-m9-2-r3-q15']) !==
    'hl-m9a-m9-2-r3-q04、q09、q15'
  ) {
    fail('shortenWrongIds', shortenWrongIds(['hl-m9a-m9-2-r3-q04', 'hl-m9a-m9-2-r3-q09', 'hl-m9a-m9-2-r3-q15']));
  } else pass('§5.6 shortenWrongIds');

  const endedAt = Date.parse('2026-11-02T12:15:00+08:00');
  const startedAt = endedAt - 18 * 60 * 1000;
  const qs = [
    { id: 'hl-m9a-m9-2-r3-q01', answer: 0, unitCode: 'M9-2', unit: '一元二次方程式', subject: 'math' },
    { id: 'hl-m9a-m9-2-r3-q02', answer: 1, unitCode: 'M9-2', unit: '一元二次方程式', subject: 'math' },
    { id: 'hl-m9a-m9-2-r3-q04', answer: 2, unitCode: 'M9-2', unit: '一元二次方程式', subject: 'math' },
    { id: 'hl-m9a-m9-2-r3-q09', answer: 0, unitCode: 'M9-2', unit: '一元二次方程式', subject: 'math' },
  ];
  const result = {
    mode: 'instant',
    score: 50,
    correct: 2,
    total: 4,
    startedAt,
    endedAt,
    answers: [0, 0, 1, 1],
    questions: qs,
    byUnit: [{ unitCode: 'M9-2', unit: '一元二次方程式', correct: 1, total: 4 }],
  };
  const text = formatRoundSummary({
    scope: { round: 3, unitCode: 'M9-2', unitName: '一元二次方程式' },
    result,
    bookTitle: '翰林數學九上',
    unitName: '一元二次方程式',
    round: 3,
  });
  const lines = text.split('\n');
  if (!lines[0].startsWith('羽蕎考題網・第 3 回結果（')) fail('summary header', lines[0]);
  else if (!lines[0].includes(taipeiStamp(new Date(endedAt)))) fail('summary tz', lines[0]);
  else pass('§5.6 header Asia/Taipei');

  if (
    !lines[1].startsWith('翰林數學九上｜M9-2 一元二次方程式｜當場對｜') ||
    !lines[1].includes('用時 18 分')
  ) {
    fail('summary line', lines[1]);
  } else pass('§5.6 書｜單元｜模式｜分數｜用時');

  if (!lines[3].includes('（hl-m9a-m9-2-r3-q02、q04、q09）')) fail('summary wrong short ids', lines[3]);
  else pass('§5.6 錯題 short ids');
}

{
  if (SUBJECT_LABELS.sci !== '理化') fail('sci label', SUBJECT_LABELS.sci);
  else pass('subject 理化');
}

{
  const qs = [
    { unitCode: 'M9-2', unit: '一元二次', subject: 'math', answer: 0 },
    { unitCode: 'M9-2', unit: '一元二次', subject: 'math', answer: 1 },
    { unitCode: 'P9-1', unit: '功', subject: 'sci', answer: 2 },
  ];
  const by = computeByUnit(qs, [0, 0, 2]);
  if (by['M9-2']?.correct !== 1 || by['M9-2']?.total !== 2) fail('byUnit M9-2', by);
  else if (by['P9-1']?.correct !== 1 || by['P9-1']?.total !== 1) fail('byUnit P9-1', by);
  else pass('computeByUnit');
}

// v1.4：UUID attemptId＋指紋去重；空 flush 不算成功
{
  if (typeof globalThis.localStorage === 'undefined') {
    const mem = new Map();
    globalThis.localStorage = {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
      clear: () => mem.clear(),
    };
  }
  localStorage.clear();
  const idA = newAttemptId();
  const idB = newAttemptId();
  if (!idA || idA === idB) fail('newAttemptId unique', { idA, idB });
  else pass('newAttemptId unique');

  const uid = 'unit-test-uid';
  const result = {
    startedAt: 1000,
    endedAt: 2000,
    score: 80,
    total: 5,
    correct: 4,
    qids: ['q1', 'q2'],
    answers: [0, 1],
    mode: 'instant',
  };
  const meta = { scope: { type: 'round' }, mode: 'instant', questions: [] };
  const p1 = enqueueAttempt(uid, result, meta);
  const p2 = enqueueAttempt(uid, result, meta);
  const list = listPending(uid);
  if (list.length !== 1 || p1.attemptId !== p2.attemptId) fail('enqueue dedupe', list);
  else if (!hasPending(uid, p1.attemptId)) fail('hasPending');
  else pass('enqueueAttempt fingerprint dedupe');

  localStorage.setItem(pendingKey(uid), '[]');
  const empty = await flushPending(uid);
  if (empty.flushed !== 0 || empty.failed !== 0) fail('empty flush', empty);
  else pass('empty flush is not success (flushed=0)');
}

{
  if (flagLabel('LOW_CONFIDENCE') !== 'TU 不太確定，請對照照片') fail('flagLabel');
  else if (
    flagLabel('COUNT_MISMATCH', { expected: 5, actual: 4 }) !==
    '題數對不上：這批應該有 5 題，實際 4 題，請 TU 檢查有沒有漏題'
  ) {
    fail('flagLabel COUNT_MISMATCH');
  } else if (reportReasonLabel('answer') !== '答案錯') fail('reportReasonLabel');
  else pass('UX#13 flag/reason plain labels');
}

console.log(`\nunit.test ${failed ? 'FAILED' : 'OK'} (${failed} failed)`);
process.exit(failed ? 1 : 0);
