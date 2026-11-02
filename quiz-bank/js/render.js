/**
 * 題目渲染：題幹、題組、圖、KaTeX。模板模組 — 不可寫死書名／科目／專有名詞。
 */

const DELIMS = [
  { left: '\\[', right: '\\]', display: true },
  { left: '\\(', right: '\\)', display: false },
];

/**
 * @param {HTMLElement|null} el
 */
export function renderMath(el) {
  if (!el || typeof window.renderMathInElement !== 'function') return;
  try {
    window.renderMathInElement(el, {
      delimiters: DELIMS,
      throwOnError: false,
      errorColor: 'inherit',
      strict: 'ignore',
      trust: false,
    });
    // 失敗時 KaTeX 會留下 .katex-error（內容為原始字串）；樣式改繼承、不顯示紅字
    el.querySelectorAll('.katex-error').forEach((node) => {
      node.style.color = 'inherit';
      node.style.background = 'none';
      node.removeAttribute('title');
    });
  } catch {
    /* 失敗時保留原始字串（已在 DOM） */
  }
}

/**
 * @param {string} s
 */
export function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {Array<{id:string,src:string,alt:string,caption?:string}>} figures
 * @param {string} [className]
 */
export function figuresHtml(figures, className = 'fig') {
  if (!figures?.length) return '';
  return figures
    .map(
      (f) =>
        `<figure class="${className}">
          <button type="button" class="fig-zoom" data-src="${escHtml(f.src)}" data-alt="${escHtml(f.alt)}" aria-label="放大圖片：${escHtml(f.alt)}">
            <img src="${escHtml(f.src)}" alt="${escHtml(f.alt)}" loading="lazy" decoding="async" width="640" height="360">
          </button>
          ${f.caption ? `<figcaption>${escHtml(f.caption)}</figcaption>` : ''}
        </figure>`,
    )
    .join('');
}

/**
 * 題組共用題幹（可收合）。
 * @param {object|null} group
 * @param {{collapsed?:boolean}} [opts]
 */
export function groupPassageHtml(group, opts = {}) {
  if (!group) return '';
  const open = opts.collapsed === false;
  // 收合時 inert／aria-hidden，避免 .fig-zoom 等可聚焦
  return `<div class="group-pass a1">
    <div class="acc-i${open ? ' open' : ''}">
      <h3 class="acc-h">
        <button type="button" class="acc-b group-toggle" aria-expanded="${open ? 'true' : 'false'}">
          <span class="t">${escHtml(group.title || '題組共用題幹')}</span>
          <svg class="chev" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </h3>
      <div class="acc-p" role="region"${open ? '' : ' inert aria-hidden="true"'}><div>
        <div class="acc-tx group-body">
          <div class="passage">${escHtml(group.passage).replace(/\n/g, '<br>')}</div>
          ${figuresHtml(group.figures || [], 'fig group-fig')}
        </div>
      </div></div>
    </div>
  </div>`;
}

/** 同步手風琴開合的 inert／aria-hidden */
export function setAccordionOpen(item, open) {
  if (!item) return;
  item.classList.toggle('open', open);
  const btn = item.querySelector('.acc-b');
  btn?.setAttribute('aria-expanded', open ? 'true' : 'false');
  const panel = item.querySelector('.acc-p');
  if (panel) {
    if (open) {
      panel.removeAttribute('inert');
      panel.removeAttribute('aria-hidden');
    } else {
      panel.setAttribute('inert', '');
      panel.setAttribute('aria-hidden', 'true');
    }
  }
}

/**
 * 題幹＋圖。
 * @param {object} q
 */
export function stemHtml(q) {
  return `<div class="stem" tabindex="-1">${escHtml(q.stem).replace(/\n/g, '<br>')}</div>
    ${figuresHtml(q.figures || [])}`;
}

/**
 * 選項區塊。
 * @param {object} q
 * @param {number|null} answer 使用者答案（-1／null＝未答）
 * @param {{revealed?:boolean, mode?:'instant'|'exam', letters?:string}} [opts]
 */
function optionLabelText(o) {
  return String(o ?? '')
    .replace(/\\[\[\(\)\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

export function optionsHtml(q, answer, opts = {}) {
  const L = opts.letters || 'ABCD';
  const revealed = !!opts.revealed;
  const mode = opts.mode || 'instant';
  const a = answer === undefined || answer === null ? null : answer;
  const answered = a !== null && a >= 0;
  const hi = answered ? a : 0;
  return `<div class="opts" role="radiogroup" aria-label="選項，用上下鍵選擇，空白鍵確定">${q.options
    .map((o, k) => {
      let cls = 'opt';
      if (answered) {
        if (k === a) cls += ' chosen';
        if (revealed && mode === 'instant') {
          if (k === q.answer) cls += ' ok';
          if (k === a && a !== q.answer) cls += ' bad';
          if (k !== a && k !== q.answer) cls += ' dim';
        }
      }
      const mk =
        revealed && mode === 'instant'
          ? k === q.answer
            ? ICON.ok
            : k === a
              ? ICON.bad
              : ''
          : '';
      const disabled = revealed && mode === 'instant';
      const ariaLab = `選項 ${L[k]}，${optionLabelText(o)}`;
      return `<button type="button" class="${cls}" role="radio" aria-checked="${answered && k === a}" tabindex="${k === hi ? 0 : -1}" data-k="${k}" style="--i:${k}"
        ${disabled ? 'aria-disabled="true"' : ''} aria-label="${escHtml(ariaLab)}">
        <span class="key">${L[k]}</span>
        <span class="txt"><span class="tx">${escHtml(o)}</span></span>
        <span class="mk" aria-hidden="true">${mk}</span>
      </button>`;
    })
    .join('')}</div>`;
}

export const ICON = {
  ok: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  bad: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

/**
 * 詳解／回饋區塊。
 * @param {object} q
 * @param {number} a
 * @param {{onReport?:boolean, reported?:boolean}} [opts]
 */
export function feedbackHtml(q, a, opts = {}) {
  const L = 'ABCD';
  const ok = a === q.answer;
  const reportBtn =
    opts.onReport === false
      ? ''
      : `<button type="button" class="b5 btn report"${opts.reported ? ' disabled' : ''}>${
          opts.reported ? '已回報' : '回報題目有誤'
        }</button>`;
  return `<div class="fb ${ok ? 'is-ok' : 'is-bad'}">
    <p class="verdict"><span class="vi">${ok ? ICON.ok : ICON.bad}</span>
      <span class="vt">${ok ? '答對了' : `答錯了，正確答案是 ${L[q.answer]}`}</span></p>
    <div class="acc a1"><div class="acc-i">
      <h3 class="acc-h"><button type="button" class="acc-b" aria-expanded="false" aria-controls="acc-p">
        <span class="t">看詳解</span>${ICON.chev}</button></h3>
      <div class="acc-p" id="acc-p" role="region"><div>
        <div class="acc-tx">${escHtml(q.explain).replace(/\n/g, '<br>')}</div>
      </div></div>
    </div></div>
    ${reportBtn}
  </div>`;
}
