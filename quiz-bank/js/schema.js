/**
 * 匯入批次檢查：對齊 plan/schema.json 結構＋§5.5 紅標（與 validate_batch.py 相同）。
 */

const SUBJECTS = new Set(['math', 'sci', 'chi', 'eng', 'soc']);
const LEVELS = new Set(['易', '中', '難']);
const FLAGS = new Set([
  'COUNT_MISMATCH',
  'EXPLAIN_MISSING',
  'EXPLAIN_MISMATCH',
  'ANSWER_MISSING',
  'OPTION_COUNT',
  'FORMULA_CHECK',
  'FIGURE_MISSING',
  'LOW_CONFIDENCE',
  'DUPLICATE_ID',
  'GROUP_BROKEN',
  'IMAGE_TOO_BIG',
]);
const FIG_WORDS = /如圖|下圖|右圖|左圖|上圖|附圖|圖[（(一二三四五六七八九十0-9]|如表|下表|右表|附表/;
const BATCH_ID_RE = /^[0-9]{8}-[a-z0-9-]+$/;
const BOOK_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const UNIT_CODE_RE = /^[A-Z]+[0-9]-[0-9]+$/;
const QID_RE = /^[a-z0-9]+(-[a-z0-9]+)*-r[0-9]+-q[0-9]{2,3}$/;
const MATCH_KEY_RE = /^[A-Z]+[0-9]-[0-9]+\|[0-9]+\|[0-9]+$/;
const FIG_ID_RE = /^fig[0-9]+$/;
const WEBP_RE = /^data:image\/webp;base64,/;

/**
 * @param {unknown} d
 * @returns {{ok:false, errors:string[]}|{ok:true, errors:[]}}
 */
export function validateSchemaStructure(d) {
  const errors = [];
  if (!d || typeof d !== 'object') return { ok: false, errors: ['(根)：必須是物件'] };
  if (d.schemaVersion !== 1) errors.push('schemaVersion：必須是 1');
  if (!d.batch || typeof d.batch !== 'object') errors.push('batch：必填');
  else {
    const b = d.batch;
    if (!BATCH_ID_RE.test(b.batchId || '')) errors.push('batch/batchId：格式不符');
    if (!b.createdAt) errors.push('batch/createdAt：必填');
    if (!b.createdBy) errors.push('batch/createdBy：必填');
    if (!Array.isArray(b.photos) || b.photos.length < 1) errors.push('batch/photos：至少 1 筆');
    if (!Number.isInteger(b.expectedCount) || b.expectedCount < 1) {
      errors.push('batch/expectedCount：必須是 ≥1 的整數');
    }
  }
  if (!d.book || typeof d.book !== 'object') errors.push('book：必填');
  else {
    const book = d.book;
    if (!BOOK_ID_RE.test(book.bookId || '')) errors.push('book/bookId：格式不符');
    if (!book.title) errors.push('book/title：必填');
    if (!SUBJECTS.has(book.subject)) errors.push('book/subject：不在允許值');
    if (![7, 8, 9].includes(book.grade)) errors.push('book/grade：必須是 7／8／9');
  }
  if (!Array.isArray(d.groups)) errors.push('groups：必須是陣列');
  if (!Array.isArray(d.questions) || d.questions.length < 1) {
    errors.push('questions：至少 1 題');
  } else {
    d.questions.forEach((q, i) => {
      const p = `questions/${i}`;
      if (!q || typeof q !== 'object') {
        errors.push(`${p}：必須是物件`);
        return;
      }
      if (!QID_RE.test(q.id || '')) errors.push(`${p}/id：格式不符`);
      if (!SUBJECTS.has(q.subject)) errors.push(`${p}/subject：不在允許值`);
      if (!q.unit) errors.push(`${p}/unit：必填`);
      if (!UNIT_CODE_RE.test(q.unitCode || '')) errors.push(`${p}/unitCode：格式不符`);
      if (!LEVELS.has(q.level)) errors.push(`${p}/level：必須是 易／中／難`);
      if (q.type !== 'single') errors.push(`${p}/type：必須是 single`);
      if (!(typeof q.groupId === 'string' || q.groupId === null)) {
        errors.push(`${p}/groupId：必須是字串或 null`);
      }
      if (typeof q.stem !== 'string' || q.stem.length < 2) errors.push(`${p}/stem：太短`);
      if (!Array.isArray(q.figures)) errors.push(`${p}/figures：必須是陣列`);
      if (!Array.isArray(q.options) || q.options.length !== 4) {
        errors.push(`${p}/options：必須正好 4 個`);
      } else if (q.options.some((o) => typeof o !== 'string' || o.length < 1)) {
        errors.push(`${p}/options：每個選項至少 1 字`);
      }
      if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer > 3) {
        errors.push(`${p}/answer：必須是 0–3`);
      }
      if (typeof q.explain !== 'string') errors.push(`${p}/explain：必須是字串`);
      if (!q.source || typeof q.source !== 'object') errors.push(`${p}/source：必填`);
      else {
        const s = q.source;
        if (!s.bookId) errors.push(`${p}/source/bookId：必填`);
        if (!Number.isInteger(s.round) || s.round < 1) errors.push(`${p}/source/round：≥1`);
        if (!Number.isInteger(s.number) || s.number < 1) errors.push(`${p}/source/number：≥1`);
        if (!Number.isInteger(s.page) || s.page < 1) errors.push(`${p}/source/page：≥1`);
        if (!MATCH_KEY_RE.test(s.matchKey || '')) errors.push(`${p}/source/matchKey：格式不符`);
      }
      if (!q.review || typeof q.review !== 'object') errors.push(`${p}/review：必填`);
      else {
        if (!['draft', 'flagged', 'checked'].includes(q.review.status)) {
          errors.push(`${p}/review/status：不合法`);
        }
        if (!Array.isArray(q.review.flags)) errors.push(`${p}/review/flags：必須是陣列`);
        else if (q.review.flags.some((f) => !FLAGS.has(f))) {
          errors.push(`${p}/review/flags：含未知代碼`);
        }
      }
      if (!q.extract || typeof q.extract !== 'object') errors.push(`${p}/extract：必填`);
      else {
        if (typeof q.extract.confidence !== 'number' || q.extract.confidence < 0 || q.extract.confidence > 1) {
          errors.push(`${p}/extract/confidence：0–1`);
        }
        if (!Array.isArray(q.extract.uncertain)) errors.push(`${p}/extract/uncertain：必須是陣列`);
      }
      for (const fig of q.figures || []) {
        if (!FIG_ID_RE.test(fig?.id || '')) errors.push(`${p}/figures：id 格式`);
        if (!WEBP_RE.test(fig?.src || '')) errors.push(`${p}/figures：src 必須是 webp data URL`);
        if (typeof fig?.alt !== 'string' || fig.alt.length < 4) errors.push(`${p}/figures：alt 太短`);
      }
    });
  }
  if (Array.isArray(d.groups)) {
    d.groups.forEach((g, i) => {
      const p = `groups/${i}`;
      if (!g?.groupId) errors.push(`${p}/groupId：必填`);
      if (typeof g?.passage !== 'string') errors.push(`${p}/passage：必填`);
      if (!Array.isArray(g?.figures)) errors.push(`${p}/figures：必須是陣列`);
      if (!Array.isArray(g?.questionIds) || g.questionIds.length < 2) {
        errors.push(`${p}/questionIds：至少 2 題`);
      }
    });
  }
  return { ok: errors.length === 0, errors };
}

/**
 * base64 data URL → 解碼後位元組數（近似，對齊 Python b64decode）。
 * @param {string} src
 */
export function figureByteSize(src) {
  try {
    const raw = String(src).split(',', 2)[1] || '';
    // atob length ≈ decoded size; strip padding
    const clean = raw.replace(/\s/g, '');
    const padding = (clean.match(/=+$/) || [''])[0].length;
    return Math.floor((clean.length * 3) / 4) - padding;
  } catch {
    return 0;
  }
}

/**
 * §5.5 紅標檢查（假設結構已通過）。
 * @param {object} d
 * @param {{existingIds?:Set<string>}} [opts]
 * @returns {{batchFlags:string[], flags:Record<string,string[]>, uncertain:Record<string,string[]>}}
 */
export function collectFlags(d, opts = {}) {
  const qs = d.questions;
  const groups = Object.fromEntries((d.groups || []).map((g) => [g.groupId, g]));
  /** @type {Record<string, Set<string>>} */
  const flags = {};
  for (const q of qs) flags[q.id] = new Set();
  /** @type {string[]} */
  const batchFlags = [];
  /** @type {Record<string, string[]>} */
  const uncertain = {};

  if (qs.length !== d.batch.expectedCount) {
    batchFlags.push(`COUNT_MISMATCH：照片 ${d.batch.expectedCount} 題，JSON ${qs.length} 題`);
  }

  const seen = new Set();
  for (const q of qs) {
    const f = flags[q.id];
    const s = q.source;
    if (seen.has(q.id)) f.add('DUPLICATE_ID');
    seen.add(q.id);
    if (opts.existingIds?.has(q.id)) {
      // 跟題庫已有的 id 相同 → 前端標「將覆蓋」，不算紅標（§5.5）
    }
    const wantId = `${s.bookId}-${q.unitCode.toLowerCase()}-r${s.round}-q${String(s.number).padStart(2, '0')}`;
    const wantKey = `${q.unitCode}|${s.round}|${s.number}`;
    if (q.id !== wantId || s.matchKey !== wantKey || s.bookId !== d.book.bookId) {
      f.add('EXPLAIN_MISMATCH');
    }
    if (!String(q.explain || '').trim()) f.add('EXPLAIN_MISSING');
    if (q.extract.confidence < 0.8) f.add('LOW_CONFIDENCE');
    if (
      q.stem.split('\\(').length - 1 !== q.stem.split('\\)').length - 1 ||
      q.explain.split('\\(').length - 1 !== q.explain.split('\\)').length - 1
    ) {
      f.add('FORMULA_CHECK');
    }
    const g = q.groupId ? groups[q.groupId] : null;
    if (q.groupId && (!g || !(g.questionIds || []).includes(q.id))) f.add('GROUP_BROKEN');
    const text = q.stem + (g ? g.passage : '');
    const hasFig = (q.figures && q.figures.length) || (g && g.figures && g.figures.length);
    if (FIG_WORDS.test(text) && !hasFig) f.add('FIGURE_MISSING');
    const allFigs = [...(q.figures || []), ...(g?.figures || [])];
    for (const fig of allFigs) {
      const size = figureByteSize(fig.src);
      if (size > 150 * 1024) f.add('IMAGE_TOO_BIG');
      if (size < 200) f.add('FIGURE_MISSING');
    }
    for (const fl of q.review?.flags || []) f.add(fl);
    uncertain[q.id] = [...(q.extract?.uncertain || [])];
  }

  for (const [gid, g] of Object.entries(groups)) {
    for (const qid of g.questionIds || []) {
      if (!flags[qid]) batchFlags.push(`GROUP_BROKEN：${gid} 指到不存在的 ${qid}`);
    }
  }

  /** @type {Record<string,string[]>} */
  const out = {};
  for (const [id, set] of Object.entries(flags)) out[id] = [...set].sort();
  return { batchFlags, flags: out, uncertain };
}

/**
 * 完整檢查：結構 → 紅標。
 * @param {unknown} d
 * @param {{existingIds?:Set<string>}} [opts]
 */
export function validateBatch(d, opts = {}) {
  const struct = validateSchemaStructure(d);
  if (!struct.ok) {
    return {
      ok: false,
      schemaErrors: struct.errors,
      batchFlags: [],
      flags: {},
      uncertain: {},
      exitCode: 2,
    };
  }
  const { batchFlags, flags, uncertain } = collectFlags(/** @type {object} */ (d), opts);
  const flaggedCount = Object.values(flags).filter((f) => f.length).length;
  const hasFlags = flaggedCount > 0 || batchFlags.length > 0;
  return {
    ok: !hasFlags,
    schemaErrors: [],
    batchFlags,
    flags,
    uncertain,
    flaggedCount,
    exitCode: hasFlags ? 1 : 0,
  };
}

export { FIG_WORDS, FLAGS };
