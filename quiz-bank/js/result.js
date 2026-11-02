/**
 * 結算頁模組。模板 — 不可寫死書名／科目／專有名詞；標題與摘要開頭由參數傳入。
 */
import { renderMath, escHtml, ICON } from './render.js';

const RM = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function fmtT(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m} 分 ${s % 60} 秒` : `${s} 秒`;
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
 *  result: {
 *    title: string,
 *    qids: string[],
 *    answers: number[],
 *    correct: number,
 *    total: number,
 *    score: number,
 *    startedAt: number,
 *    endedAt: number,
 *    byUnit: Array<{unitCode:string,unit:string,correct:number,total:number}>,
 *    questions: object[],
 *    mode: string,
 *  },
 *  summaryPrefix?: string,
 *  wrongBookDelta?: number,
 *  cloudStatus?: 'ok'|'pending'|'error',
 *  onRetryWrong: () => void,
 *  onRestart: () => void,
 *  onHome: () => void,
 *  onCopySummary?: (text: string) => void,
 *  onRetryCloud?: () => void,
 * }} opts
 */
export function showResult(opts) {
  const r = opts.result;
  const qs = r.questions;
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
        ? `+${wrongN} 題加入`
        : '沒有變化'
      : opts.wrongBookDelta > 0
        ? `+${opts.wrongBookDelta} 題加入`
        : opts.wrongBookDelta < 0
          ? `${opts.wrongBookDelta} 題移出`
          : '沒有變化';

  const cloudBanner =
    opts.cloudStatus === 'pending' || opts.cloudStatus === 'error'
      ? `<p class="cloud-warn" role="status">還沒存到雲端，<button type="button" class="btn b5" data-act="retry-cloud">重試</button></p>`
      : '';

  // 題目回顧預設「只看錯題」；全對時才預設「全部」（對齊樣張 core.js）
  const showWrongOnly = wrongN > 0;

  const html = `<section class="result${showWrongOnly ? ' only-wrong' : ''}" data-el="result">
    <div class="r-hero">
      <p class="eyebrow">${escHtml(r.title)}・結果</p>
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
              return `<li class="rv ${ok ? 'ok' : 'bad'}">
                <p class="rv-q"><span class="rv-st">${ok ? ICON.ok : ICON.bad}<span>${ok ? '對' : '錯'}</span></span>
                  <span class="rv-n">第 ${n + 1} 題</span></p>
                <div class="rv-stem">${escHtml(q.stem)}</div>
                <p class="rv-a">你選：${a < 0 ? '未作答' : `(${L[a]}) ${escHtml(q.options[a])}`}${
                  ok ? '' : `　正確：(${L[q.answer]}) ${escHtml(q.options[q.answer])}`
                }</p>
                ${ok ? '' : `<div class="rv-ex">${escHtml(q.explain)}</div>`}
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

  // bubble row horizontal scroll if many
  const segs = opts.mount.querySelector('.segs');
  if (segs && qs.length > 12) segs.classList.add('strip-scroll');

  function summaryText() {
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

  const onClick = async (e) => {
    const t = e.target.closest('button');
    if (!t || !opts.mount.contains(t)) return;
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
  opts.mount.addEventListener('click', onClick);
  return {
    summaryText,
    destroy() {
      opts.mount.removeEventListener('click', onClick);
    },
  };
}

export { unitStatus, fmtT };
