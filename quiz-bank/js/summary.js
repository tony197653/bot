/**
 * §5.6 回合摘要（羽蕎考題網專用格式）。app 層 — 不進 quiz/result/render 模板。
 */

function fmtT(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m && rem === 0) return `${m} 分`;
  if (m) return `${m} 分 ${rem} 秒`;
  return `${Math.max(1, s)} 秒`;
}

export function taipeiStamp(d = new Date()) {
  const fmt = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

/**
 * @param {{
 *  scope?: object,
 *  result: object,
 *  bookTitle?: string,
 *  unitName?: string,
 *  round?: number|string,
 * }} args
 */
export function formatRoundSummary({ scope, result, bookTitle, unitName, round }) {
  const ended = new Date(result.endedAt || Date.now());
  const nRound = round ?? scope?.round ?? '?';
  const header = `羽蕎考題網・第 ${nRound} 回結果（${taipeiStamp(ended)}）`;
  const modeLabel = result.mode === 'exam' ? '交卷才對' : '當場對';
  const ms = Math.max(0, (result.endedAt || Date.now()) - (result.startedAt || Date.now()));
  const unitPart =
    unitName || scope?.unitName
      ? `${scope?.unitCode || ''} ${unitName || scope?.unitName}`.trim()
      : scope?.unitCode || '—';
  const line = `${bookTitle || scope?.bookTitle || '—'}｜${unitPart}｜${modeLabel}｜${result.score} 分（${result.correct}/${result.total}）｜用時 ${fmtT(ms)}`;
  const weak = (result.byUnit || []).filter((u) => u.total && u.correct / u.total < 0.85);
  const weakLine = `弱點單元：${
    weak.length
      ? weak.map((u) => `${u.unitCode} ${u.unit} ${u.correct}/${u.total}`).join('、')
      : '無'
  }`;
  const qs = result.questions || [];
  const wrongIdx = qs
    .map((q, n) => (result.answers?.[n] !== q.answer ? n : -1))
    .filter((n) => n >= 0);
  const wrongLine = `錯題：${
    wrongIdx.length
      ? `第 ${wrongIdx.map((n) => n + 1).join('、')} 題（${wrongIdx
          .map((n) => qs[n].id)
          .join('、')}）`
      : '無'
  }`;
  return `${header}\n${line}\n${weakLine}\n${wrongLine}`;
}
