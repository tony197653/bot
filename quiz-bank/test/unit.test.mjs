/**
 * 單元測試：§5.6 摘要、強弱門檻、錯題本文案、合併尚未練習。
 */
import { formatRoundSummary, taipeiStamp, shortenWrongIds } from '../js/summary.js';
import {
  computeStrength,
  mergeKnownUnits,
  sortStrengthRows,
  attemptIdFor,
  enqueueAttempt,
  listPending,
  hasPending,
  flushPending,
  pendingKey,
} from '../js/stats.js';
import { wrongPracticeLabel, formatUnitsExportText, SUBJECT_LABELS } from '../js/views.js';

let failed = 0;
function pass(n) {
  console.log('PASS', n);
}
function fail(n, e) {
  failed++;
  console.error('FAIL', n, e);
}

// §5.6 copy
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

  // answers wrong on idx 1,2,3 → 第 2、3、4 題（…q02、q04、q09）
  if (!lines[3].includes('（hl-m9a-m9-2-r3-q02、q04、q09）')) fail('summary wrong short ids', lines[3]);
  else pass('§5.6 錯題 short ids');
}

// strength thresholds §9.11
{
  const attempts = [
    {
      total: 10,
      correct: 5,
      byUnit: {
        A: { unit: 'A', subject: 'math', correct: 5, total: 10 }, // 50% weak
        B: { unit: 'B', subject: 'math', correct: 6, total: 10 }, // 60% mid
        C: { unit: 'C', subject: 'math', correct: 9, total: 10 }, // 90% good
        D: { unit: 'D', subject: 'math', correct: 2, total: 3 }, // low sample
      },
    },
  ];
  const rows = computeStrength(attempts);
  const by = Object.fromEntries(rows.map((r) => [r.unitCode, r]));
  if (by.A.label !== '需加強' || by.B.label !== '部分掌握' || by.C.label !== '掌握') {
    fail('strength labels', rows);
  } else pass('§9.11 strength thresholds');
  if (!by.D.lowSample) fail('lowSample', by.D);
  else pass('§9.11 題數少 <5');

  const merged = mergeKnownUnits(rows, [
    { unitCode: 'E', name: '未練單元', subject: 'math', bookId: 'b1' },
  ]);
  const e = merged.find((r) => r.unitCode === 'E');
  if (!e || e.label !== '尚未練習') fail('尚未練習', e);
  else pass('尚未練習 from known units');

  const sorted = sortStrengthRows(merged, 'rate', 'asc');
  const last = sorted[sorted.length - 1];
  if (last.unitCode !== 'E') fail('unpracticed last', sorted.map((s) => s.unitCode));
  else pass('sort unpracticed last');
}

// wrong book label §9.19
{
  if (wrongPracticeLabel(0) !== '目前沒有錯題') fail('label0');
  else if (wrongPracticeLabel(7) !== '練這 7 題') fail('label7');
  else if (wrongPracticeLabel(12) !== '練 10 題（共 12 題）') fail('label12');
  else pass('§9.19 wrong practice label');
}

// §9.12 複製給家教：理化＋最常錯的 5 題
{
  if (SUBJECT_LABELS.sci !== '理化') fail('sci label', SUBJECT_LABELS.sci);
  else pass('§9.12 subject 理化');
  const text = formatUnitsExportText({
    strengthRows: [
      {
        subject: 'sci',
        unitCode: 'P9-3',
        unit: '功與能',
        total: 10,
        correct: 4,
        rate: 0.4,
        status: 'weak',
        lowSample: false,
        label: '需加強',
      },
    ],
    wrongBySubject: { sci: 2 },
    recentAttempts: [],
    topWrong: [
      { qid: 'hl-p9a-p9-3-r2-q05', wrong: 3 },
      { qid: 'hl-p9a-p9-3-r2-q06', wrong: 2 },
    ],
  });
  if (!text.includes('理化')) fail('export missing 理化', text);
  else if (!text.includes('最常錯的 5 題：hl-p9a-p9-3-r2-q05（錯 3 次）')) fail('export top wrong', text);
  else pass('§9.12 export 最常錯的 5 題');
}

// I-3b：固定 attemptId＋入隊去重；空 flush 不算成功
{
  const uid = 'unit-test-uid';
  try {
    localStorage?.clear?.();
  } catch {
    /* node：用假 storage */
  }
  // Node 無 localStorage：shim
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
  const id1 = attemptIdFor(result);
  const id2 = attemptIdFor({ ...result });
  if (id1 !== id2 || !id1.startsWith('att_')) fail('attemptIdFor stable', id1);
  else pass('I-3b attemptIdFor stable');

  const meta = { scope: { type: 'round' }, mode: 'instant', questions: [] };
  const p1 = enqueueAttempt(uid, result, meta);
  const p2 = enqueueAttempt(uid, result, meta);
  const list = listPending(uid);
  if (list.length !== 1 || p1.attemptId !== p2.attemptId) fail('enqueue dedupe', list);
  else if (!hasPending(uid, p1.attemptId)) fail('hasPending');
  else pass('I-3b enqueueAttempt dedupe by attemptId');

  // 空佇列 flush（清掉後）
  localStorage.setItem(pendingKey(uid), '[]');
  const empty = await flushPending(uid);
  if (empty.flushed !== 0 || empty.failed !== 0) fail('empty flush', empty);
  else pass('I-3 empty flush is not success (flushed=0)');
}

console.log(`\nunit.test ${failed ? 'FAILED' : 'OK'} (${failed} failed)`);
process.exit(failed ? 1 : 0);
