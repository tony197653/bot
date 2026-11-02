/**
 * 結算頁模組。模板 — 不可寫死書名／科目／專有名詞；標題與摘要開頭由參數傳入。
 */
import {
  renderMath,
  escHtml,
  ICON,
  stemHtml,
  groupPassageHtml,
  setAccordionOpen,
} from './render.js';

const RM = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function fmtT(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m && rem === 0) return `${m} 分`;
  if (m) return `${m} 分 ${rem} 秒`;
  return `${Math.max(1, s)} 秒`;
}

function unitStatus(correct, total) {
  if (!total) return ['none', '未練'];
  const p = correct / total;
  if (p >= 0.85) return ['good', '掌握'];
  if (p >= 0.6) return ['mid', '部分掌握'];
  return ['weak', '需加強'];
}

/**
 * @param {{
 *  mount: HTMLElement,
 *  result: object,
 *  summaryPrefix?: string,
 *  getSummaryText?: () => string,
 *  summaryTextFn?: () => string,
 *  wrongBookDelta?: number,
 *  cloudStatus?: 'ok'|'pending'|'error',
 *  onRetryWrong: () => void,
 *  onRestart: () => void,
 *  onHome: () => void,
 *  onCopySummary?: (text: string) => void,
 *  onRetryCloud?: () => void,
 *  onReport?: (payload: {qid:string, reason:string, note:string}) => Promise<void>|void,
 *  reportedIds?: Set<string>|string[],
 * }} opts
 */
export function showResult(opts) {
  const r = opts.result;
  const qs = r.questions;
  const groupsMap = Object.fromEntries((r.groups || []).map((g) => [g.groupId, g]));
  const reported = new Set(opts.reportedIds || []);
  const ms = Math.max(0, (r.endedAt || Date.now()) - (r.startedAt || Date.now()));
  const wrongN = qs.filter((q, n) => r.answers[n] !== q.answer).length;
  const msg =
    r.score === 100
      ? '全部答對，這回很穩。'
      : r.score >= 80
        ? '觀念很清楚，錯的那幾題看一下詳解就好。'
        : r.score >= 60
          ? '及格了，把錯題再練一次會更穩。'
          : '先看下面的詳解，再練一次錯題。';

  const delta =
    opts.wrongBookDelta == null
      ? wrongN
        ? `${wrongN} 題加入`
        : '沒有變化'
      : opts.wrongBookDelta > 0
        ? `${opts.wrongBookDelta} 題加入`
        : opts.wrongBookDelta < 0
          ? `${Math.abs(opts.wrongBookDelta)} 題移出`
          : '沒有變化';

  const cloudBanner =
    opts.cloudStatus === 'pending' || opts.cloudStatus === 'error'
      ? `<p class="cloud-warn" role="status">還沒存到雲端，<button type="button" class="btn b5" data-act="retry-cloud">重試</button></p>`
      : '';

  const showWrongOnly = wrongN > 0;
  const showExamReport = r.mode === 'exam' && typeof opts.onReport === 'function';

  const html = `<section class="result${showWrongOnly ? ' only-wrong' : ''}" data-el="result">
    <div class="r-hero">
      <h1 class="eyebrow">${escHtml(r.title)}・結果</h1>
      <p class="score" aria-label="${r.score} 分"><span class="num">${r.score}</span><span class="unit">分</span></p>
      <div class="segs bub-result" aria-label="各題對錯">
        ${qs
          .map((q, n) => {
            const ok = r.answers[n] === q.answer;
            return `<i class="${ok ? 'ok' : 'bad'}" title="第 ${n + 1} 題"></i>`;
          })
          .join('')}
      </div>
      <p class="msg">${msg}</p>
      ${cloudBanner}
    </div>
    <div class="stats">
      <div class="stat"><span>答對</span><b>${r.correct} / ${r.total}</b></div>
      <div class="stat"><span>用時</span><b>${fmtT(ms)}</b></div>
      <div class="stat"><span>錯題本</span><b>${delta}</b></div>
    </div>
    <div class="r-grid">
      <section class="panel units">
        <h2>本回單元</h2>
        <table class="t1">
          <thead><tr><th scope="col">單元</th><th scope="col" class="r">答對</th><th scope="col">狀態</th></tr></thead>
          <tbody>
            ${(r.byUnit || [])
              .map((u) => {
                const [s, t] = unitStatus(u.correct, u.total);
                return `<tr>
                  <td><span class="ucode">${escHtml(u.unitCode)}</span><span class="uname">${escHtml(u.unit)}</span></td>
                  <td class="r num">${u.correct}/${u.total}</td>
                  <td><span class="l2 ${s}"><i></i>${t}</span>${u.total < 3 ? '<span class="l3">題數少</span>' : ''}</td>
                </tr>`;
              })
              .join('')}
          </tbody>
        </table>
      </section>
      <section class="panel review">
        <div class="rv-head">
          <h2>題目回顧</h2>
          <div class="g1${showWrongOnly ? ' two' : ''}" role="tablist" aria-label="篩選">
            <span class="g1-thumb" aria-hidden="true"></span>
            <button type="button" role="tab" aria-selected="${showWrongOnly ? 'false' : 'true'}" data-f="all">全部</button>
            <button type="button" role="tab" aria-selected="${showWrongOnly ? 'true' : 'false'}" data-f="wrong">只看錯題</button>
          </div>
        </div>
        <ol class="rv-list">
          ${qs
            .map((q, n) => {
              const a = r.answers[n];
              const ok = a === q.answer;
              const L = 'ABCD';
              const group = q.groupId ? groupsMap[q.groupId] : null;
              const reportBtn =
                showExamReport && !ok
                  ? `<button type="button" class="btn b5 report" data-report-qid="${escHtml(q.id)}" data-report-n="${n}"${
                      reported.has(q.id) ? ' disabled' : ''
                    }>${reported.has(q.id) ? '已回報' : '回報題目有誤'}</button>`
                  : '';
              return `<li class="rv ${ok ? 'ok' : 'bad'}" data-rv-n="${n}">
                <p class="rv-q"><span class="rv-st">${ok ? ICON.ok : ICON.bad}<span>${ok ? '對' : '錯'}</span></span>
                  <span class="rv-n">第 ${n + 1} 題</span></p>
                ${groupPassageHtml(group, { collapsed: true })}
                <div class="rv-stem">${stemHtml(q)}</div>
                <p class="rv-a">你選：${a < 0 ? '未作答' : `(${L[a]}) ${escHtml(q.options[a])}`}${
                  ok ? '' : `　正確：(${L[q.answer]}) ${escHtml(q.options[q.answer])}`
                }</p>
                ${ok ? '' : `<div class="rv-ex">${escHtml(q.explain).replace(/\n/g, '<br>')}</div>`}
                ${reportBtn}
              </li>`;
            })
            .join('')}
        </ol>
      </section>
    </div>
    <div class="r-actions">
      <button type="button" class="btn b1" data-act="retry">${
        wrongN ? `再練錯的 ${wrongN} 題` : '再做一回'
      }</button>
      <button type="button" class="btn b2" data-act="restart">從頭再做</button>
      <button type="button" class="btn b2" data-act="copy">複製摘要</button>
      <button type="button" class="btn b5" data-act="home">回首頁</button>
    </div>
    <dialog class="report-dlg" data-el="resultReportDlg">
      <form method="dialog" class="report-form">
        <h2>回報題目有誤</h2>
        <input type="hidden" name="qid" value="">
        <label>原因
          <select name="reason">
            <option value="answer">答案錯</option>
            <option value="typo">題目打錯</option>
            <option value="figure">圖有問題</option>
            <option value="other">其他</option>
          </select>
        </label>
        <label>補充說明（選填）
          <input name="note" maxlength="200" placeholder="一句話說明…">
        </label>
        <div class="report-actions">
          <button type="submit" class="btn b1" value="ok">送出</button>
          <button type="submit" class="btn b2" value="cancel">取消</button>
        </div>
      </form>
    </dialog>
  </section>`;

  opts.mount.innerHTML = html;
  document.body.dataset.view = 'result';
  const resultEl = opts.mount.querySelector('[data-el="result"]');
  renderMath(resultEl);
  window.scrollTo(0, 0);
  if (!RM()) {
    resultEl?.classList.add('in');
    setTimeout(() => resultEl?.classList.remove('in'), 1600);
  }

  const segs = opts.mount.querySelector('.segs');
  if (segs && qs.length > 12) segs.classList.add('strip-scroll');

  const reportDlg = opts.mount.querySelector('[data-el="resultReportDlg"]');

  function defaultSummaryText() {
    const d = new Date(r.endedAt || Date.now());
    const p = (x) => String(x).padStart(2, '0');
    const prefix = opts.summaryPrefix || r.title || '測驗';
    const weak = (r.byUnit || []).filter((u) => u.correct / u.total < 0.85);
    const wrongIds = qs
      .map((q, n) => (r.answers[n] !== q.answer ? n : -1))
      .filter((n) => n >= 0);
    const modeLabel = r.mode === 'exam' ? '交卷才對' : '當場對';
    return `${prefix}（${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}）
${modeLabel}｜${r.score} 分（${r.correct}/${r.total}）｜用時 ${fmtT(ms)}
弱點單元：${weak.length ? weak.map((u) => `${u.unitCode} ${u.unit} ${u.correct}/${u.total}`).join('、') : '無'}
錯題：${
      wrongIds.length
        ? wrongIds.map((n) => `第 ${n + 1} 題（${qs[n].id}）`).join('、')
        : '無'
    }`;
  }

  function summaryText() {
    if (typeof opts.getSummaryText === 'function') return opts.getSummaryText();
    if (typeof opts.summaryTextFn === 'function') return opts.summaryTextFn();
    return defaultSummaryText();
  }

  async function submitResultReport(qid, reason, note) {
    if (!opts.onReport || reported.has(qid)) return;
    try {
      await opts.onReport({ qid, reason, note });
      reported.add(qid);
      opts.mount.querySelectorAll(`[data-report-qid="${CSS.escape(qid)}"]`).forEach((btn) => {
        btn.disabled = true;
        btn.textContent = '已回報';
      });
      const toast = document.getElementById('app-toast');
      if (toast) {
        toast.textContent = '已回報，謝謝';
        toast.classList.add('on');
        setTimeout(() => toast.classList.remove('on'), 2000);
      }
    } catch (err) {
      const toast = document.getElementById('app-toast');
      if (toast) {
        toast.textContent = err?.message || '回報失敗，請稍後再試';
        toast.classList.add('on');
        setTimeout(() => toast.classList.remove('on'), 2200);
      }
    }
  }

  const onClick = async (e) => {
    const t = e.target.closest('button');
    if (!t || !opts.mount.contains(t)) return;
    if (t.matches('.acc-b')) {
      const item = t.closest('.acc-i');
      const open = !item?.classList.contains('open');
      setAccordionOpen(item, open);
      const label = t.querySelector('.t');
      if (label && !t.classList.contains('group-toggle')) {
        label.textContent = open ? '收起詳解' : '看詳解';
      }
      return;
    }
    if (t.matches('.report[data-report-qid]')) {
      const qid = t.dataset.reportQid;
      if (reportDlg && typeof reportDlg.showModal === 'function') {
        reportDlg.querySelector('[name=qid]').value = qid;
        reportDlg.showModal();
      }
      return;
    }
    const act = t.dataset.act;
    if (t.dataset.f) {
      const w = t.dataset.f === 'wrong';
      opts.mount.querySelectorAll('.g1 button').forEach((b) => b.setAttribute('aria-selected', b === t ? 'true' : 'false'));
      opts.mount.querySelector('.g1')?.classList.toggle('two', w);
      resultEl?.classList.toggle('only-wrong', w);
      return;
    }
    if (act === 'retry') opts.onRetryWrong();
    else if (act === 'restart') opts.onRestart();
    else if (act === 'home') opts.onHome();
    else if (act === 'retry-cloud') opts.onRetryCloud?.();
    else if (act === 'copy') {
      const text = summaryText();
      try {
        await navigator.clipboard.writeText(text);
        opts.onCopySummary?.(text);
        const toast = document.getElementById('app-toast');
        if (toast) {
          toast.textContent = '已複製';
          toast.classList.add('on');
          setTimeout(() => toast.classList.remove('on'), 2000);
        }
      } catch {
        opts.onCopySummary?.(text);
      }
    }
  };

  async function onReportSubmit(e) {
    const val = e.submitter?.value;
    if (val === 'ok') {
      const btn = e.submitter;
      if (btn?.dataset.busy === '1') {
        e.preventDefault();
        return;
      }
      if (btn) {
        btn.dataset.busy = '1';
        btn.style.width = `${btn.getBoundingClientRect().width}px`;
        btn.disabled = true;
        const prev = btn.textContent;
        btn.textContent = '送出中…';
        btn.dataset.prevLabel = prev || '送出';
      }
      const fd = new FormData(e.target);
      try {
        await submitResultReport(
          String(fd.get('qid') || ''),
          String(fd.get('reason') || 'other'),
          String(fd.get('note') || '').slice(0, 200),
        );
      } finally {
        if (btn) {
          btn.dataset.busy = '';
          btn.style.width = '';
          btn.disabled = false;
          btn.textContent = btn.dataset.prevLabel || '送出';
        }
      }
    }
  }

  opts.mount.addEventListener('click', onClick);
  reportDlg?.addEventListener('submit', onReportSubmit);

  return {
    summaryText,
    destroy() {
      opts.mount.removeEventListener('click', onClick);
      reportDlg?.removeEventListener('submit', onReportSubmit);
    },
  };
}

export { unitStatus, fmtT };
