/**
 * 首頁、錯題本、收藏夾（Traditional Chinese UI；v1.2 強弱表已刪）。
 */
import { escHtml, renderMath } from './render.js';
import { ERR } from './errors.js';
import {
  loadQstatsWrong,
  loadAttemptSummary,
  updateQstatManualOut,
  progressKey,
} from './stats.js';
import {
  loadFavorites,
  favCount,
  scheduleFavoriteRemove,
  pruneMissingFavorites,
} from './fav.js';

export const SUBJECT_LABELS = {
  math: '數學',
  sci: '理化',
  chi: '國文',
  eng: '英文',
  soc: '社會',
};

const FILTER_KEY = 'quizbank:v1:filters';

function readFilters() {
  try {
    return JSON.parse(localStorage.getItem(FILTER_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function writeFilters(partial) {
  const next = { ...readFilters(), ...partial };
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}

async function ensureFb(ctx) {
  if (ctx.fb) return ctx.fb;
  const { initFirebase } = await import('./fb.js');
  ctx.fb = await initFirebase();
  return ctx.fb;
}

export async function fetchBanks(ctx) {
  const { db, fs } = await ensureFb(ctx);
  const snap = await fs.getDocs(fs.collection(db, 'banks'));
  return snap.docs.map((d) => ({ bookId: d.id, ...d.data() })).sort((a, b) => (a.title || '').localeCompare(b.title || ''));
}

export async function fetchQuestionsForRound(ctx, bookId, unitCode, round) {
  const { db, fs } = await ensureFb(ctx);
  const roundKey = `${bookId}|${unitCode}|${round}`;
  const q = fs.query(
    fs.collection(db, 'questions'),
    fs.where('roundKey', '==', roundKey),
    fs.where('review.status', '==', 'checked'),
  );
  const snap = await fs.getDocs(q);
  const qs = snap.docs.map((d) => d.data());
  qs.sort((a, b) => (a.source?.number || 0) - (b.source?.number || 0));
  const groupIds = [...new Set(qs.map((x) => x.groupId).filter(Boolean))];
  const groups = [];
  for (const gid of groupIds) {
    const gSnap = await fs.getDoc(fs.doc(db, 'groups', gid));
    if (gSnap.exists()) groups.push(gSnap.data());
  }
  return { questions: qs, groups };
}

export async function fetchQuestionsForUnit(ctx, bookId, unitCode, limit = 10) {
  const { db, fs } = await ensureFb(ctx);
  const q = fs.query(
    fs.collection(db, 'questions'),
    fs.where('bookId', '==', bookId),
    fs.where('unitCode', '==', unitCode),
    fs.where('review.status', '==', 'checked'),
  );
  const snap = await fs.getDocs(q);
  let qs = snap.docs.map((d) => d.data());
  for (let i = qs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [qs[i], qs[j]] = [qs[j], qs[i]];
  }
  if (limit && qs.length > limit) qs = qs.slice(0, limit);
  const groupIds = [...new Set(qs.map((x) => x.groupId).filter(Boolean))];
  const groups = [];
  for (const gid of groupIds) {
    const gSnap = await fs.getDoc(fs.doc(db, 'groups', gid));
    if (gSnap.exists()) groups.push(gSnap.data());
  }
  return { questions: qs, groups };
}

function stemSnippet(stem) {
  const t = String(stem || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '';
  return t.length > 56 ? `${t.slice(0, 56)}…` : t;
}

/** @returns {Promise<Record<string,string>>} */
async function loadStemSnippets(ctx, qids) {
  /** @type {Record<string,string>} */
  const out = {};
  const ids = [...new Set((qids || []).filter(Boolean))];
  if (!ids.length) return out;
  try {
    const { db, fs } = await ensureFb(ctx);
    for (let i = 0; i < ids.length; i += 30) {
      const chunk = ids.slice(i, i + 30);
      const q = fs.query(fs.collection(db, 'questions'), fs.where(fs.documentId(), 'in', chunk));
      const snap = await fs.getDocs(q);
      snap.forEach((d) => {
        const snip = stemSnippet(d.data()?.stem);
        if (snip) out[d.id] = snip;
      });
    }
  } catch {
    /* ignore — cards fall back */
  }
  return out;
}

export async function fetchWrongQuestions(ctx, uid, filterSubject) {
  const stats = await loadQstatsWrong(uid);
  let rows = stats;
  if (filterSubject) rows = rows.filter((r) => r.subject === filterSubject);
  const qids = rows.slice(0, 10).map((r) => r.qid);
  if (!qids.length) return { questions: [], groups: [], total: rows.length };
  const { db, fs } = await ensureFb(ctx);
  const questions = [];
  for (let i = 0; i < qids.length; i += 30) {
    const chunk = qids.slice(i, i + 30);
    const q = fs.query(
      fs.collection(db, 'questions'),
      fs.where('review.status', '==', 'checked'),
      fs.where(fs.documentId(), 'in', chunk),
    );
    const snap = await fs.getDocs(q);
    snap.forEach((d) => questions.push(d.data()));
  }
  const order = Object.fromEntries(qids.map((id, idx) => [id, idx]));
  questions.sort((a, b) => (order[a.id] ?? 0) - (order[b.id] ?? 0));
  const groupIds = [...new Set(questions.map((x) => x.groupId).filter(Boolean))];
  const groups = [];
  for (const gid of groupIds) {
    const gSnap = await fs.getDoc(fs.doc(db, 'groups', gid));
    if (gSnap.exists()) groups.push(gSnap.data());
  }
  return { questions, groups, total: rows.length, stats: rows };
}

function taipeiDateParts(d = new Date()) {
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
  return parts;
}

export function formatUnitsExportText({
  strengthRows,
  wrongBySubject,
  recentAttempts,
  topWrong = [],
  productName = '羽蕎考題網',
}) {
  const p = taipeiDateParts();
  const dateStr = `${p.year}/${p.month}/${p.day}`;
  const lines = [`${productName}學習摘要（${dateStr} 產生，統計最近 30 天）`];
  const bySub = {};
  for (const row of strengthRows) {
    if (!bySub[row.subject]) bySub[row.subject] = [];
    bySub[row.subject].push(row);
  }
  for (const [sub, rows] of Object.entries(bySub)) {
    const label = SUBJECT_LABELS[sub] || sub;
    const total = rows.reduce((n, r) => n + r.total, 0);
    const correct = rows.reduce((n, r) => n + r.correct, 0);
    const rate = total ? Math.round((correct / total) * 100) : 0;
    lines.push(`${label}（最近 30 天）：作答 ${total} 次，正確率 ${rate}%`);
    const weak = rows.filter((r) => r.status === 'weak' && r.total);
    const mid = rows.filter((r) => r.status === 'mid' && r.total);
    const good = rows.filter((r) => r.status === 'good' && r.total);
    const low = rows.filter((r) => r.lowSample);
    if (weak.length) lines.push(`　需加強：${weak.map((u) => `${u.unitCode} ${u.unit} ${Math.round(u.rate * 100)}%（${u.total} 次）`).join('、')}`);
    if (mid.length) lines.push(`　部分掌握：${mid.map((u) => `${u.unitCode} ${u.unit}`).join('、')}`);
    if (good.length) lines.push(`　掌握：${good.map((u) => `${u.unitCode} ${u.unit}`).join('、')}`);
    if (low.length) lines.push(`　題數少：${low.map((u) => `${u.unitCode}（${u.total} 次）`).join('、')}`);
  }
  const wb = Object.entries(wrongBySubject || {})
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${SUBJECT_LABELS[s] || s} ${n} 題`)
    .join('、');
  lines.push(`錯題本：${wb || '目前沒有'}`);
  if (recentAttempts?.length) {
    lines.push(
      `最近 3 回：${recentAttempts
        .map((a) => {
          const pp = taipeiDateParts(a.at?.toDate?.() || new Date());
          const sc = a.scope || {};
          return `${pp.month}/${pp.day} 第 ${sc.round || '?'} 回 ${a.score} 分`;
        })
        .join('；')}`,
    );
  }
  if (topWrong?.length) {
    lines.push(
      `最常錯的 5 題：${topWrong
        .slice(0, 5)
        .map((w) => `${w.qid || w.id}（錯 ${w.wrong || 0} 次）`)
        .join('、')}`,
    );
  } else {
    lines.push('最常錯的 5 題：目前沒有');
  }
  return lines.join('\n');
}

function wrongPracticeLabel(n) {
  if (n <= 0) return '目前沒有錯題';
  if (n <= 10) return `練這 ${n} 題`;
  return `練 10 題（共 ${n} 題）`;
}

/**
 * @param {HTMLElement} mount
 * @param {object} ctx { user, fb, navigate, startScope, toast, isAdmin }
 */
export async function renderHome(mount, ctx) {
  mount.innerHTML = `<div class="page home"><div class="e3 skel" aria-busy="true">載入中…</div></div>`;
  const uid = ctx.user.uid;
  try {
    const [banks, summary, wrongRows, favRows] = await Promise.all([
      fetchBanks(ctx),
      loadAttemptSummary(uid),
      loadQstatsWrong(uid),
      loadFavorites(uid).catch(() => []),
    ]);
    const filters = readFilters();
    const subject = filters.subject || '';
    const bookId = filters.bookId || '';
    let filtered = subject ? banks.filter((b) => b.subject === subject) : banks.slice();
    if (bookId) filtered = filtered.filter((b) => b.bookId === bookId);

    const wrongN = wrongRows.length;
    const favN = favRows.length || favCount();

    // §3 2-B：今日建議（續練／首回）＋錯題數；v1.2 不再顯示最弱單元
    let suggestHtml = '';
    let suggestAct = '';
    const progRaw = localStorage.getItem(progressKey(uid));
    if (progRaw) {
      try {
        const prog = JSON.parse(progRaw);
        const cur = (prog.idx || 0) + 1;
        const total = prog.qids?.length || '?';
        // R5-1：回數用 scope.round／roundLabel，不可把題號當回數
        const roundNum = prog.scope?.round;
        const roundLabel =
          prog.scope?.roundLabel ||
          (roundNum != null && roundNum !== '' ? `第 ${roundNum} 回` : null);
        const bits = [
          roundLabel
            ? `繼續${roundLabel}（${cur}/${total}）`
            : `繼續作答（${cur}/${total}）`,
        ];
        if (wrongN) bits.push(`錯題本 ${wrongN} 題`);
        if (favN) bits.push(`收藏夾 ${favN} 題`);
        suggestHtml = bits.join('｜');
        suggestAct = 'continue';
      } catch {
        /* ignore */
      }
    }
    if (!suggestHtml && filtered.length) {
      const book = filtered[0];
      const unit = book.units?.[0];
      const round = unit?.rounds?.[0];
      if (unit && round) {
        const bits = [
          `從「${book.title}」${unit.name} ${round.label || `第 ${round.round} 回`} 開始`,
        ];
        if (wrongN) bits.push(`錯題本 ${wrongN} 題`);
        if (favN) bits.push(`收藏夾 ${favN} 題`);
        suggestHtml = bits.join('｜');
        suggestAct = 'suggest-first';
      }
    }

    // 空狀態：線框 E1 純文字、無按鈕（宗良：去掉「去匯入」；§4.4 按鈕亦不放）
    const bookCards =
      filtered.length === 0
        ? `<p class="e1 home-empty" data-el="home-empty">${ERR.homeEmptyWire}</p>`
        : filtered
            .map((book) => {
              const units = book.units || [];
              return `<article class="card c1 book" data-book="${escHtml(book.bookId)}">
                <header><h2>${escHtml(book.title)}</h2><span class="l3">${SUBJECT_LABELS[book.subject] || book.subject}</span></header>
                <div class="unit-list">${units
                  .map((u) => {
                    const rounds = (u.rounds || [])
                      .filter((r) => r.count > 0)
                      .map((r) => {
                        const key = `${book.bookId}|${u.unitCode}|${r.round}`;
                        const stat = summary.byRound[key];
                        const meta = stat ? `已做 ${stat.count} 次・最高 ${stat.best}` : '';
                        const roundLabel = r.label || `第 ${r.round} 回`;
                        return `<button type="button" class="round a1" data-book="${escHtml(book.bookId)}" data-unit="${escHtml(u.unitCode)}" data-round="${r.round}" data-unit-name="${escHtml(u.name)}" data-round-label="${escHtml(roundLabel)}">
                            <span>${escHtml(roundLabel)}</span>
                            <small>${meta || `${r.count} 題`}</small>
                          </button>`;
                      })
                      .join('');
                    return `<div class="unit-block"><p class="unit-name">${escHtml(u.unitCode)} ${escHtml(u.name)}</p>${rounds || '<p class="mute">尚無題目</p>'}</div>`;
                  })
                  .join('')}</div>
              </article>`;
            })
            .join('');

    // §3 2-F：手機快速入口兩顆 B2（錯題本 N、收藏夾 N）；桌機靠頂部導覽
    const quickNav = `<nav class="home-quick" aria-label="快速入口">
      <a class="btn b2" href="#/wrong">錯題本${wrongN ? ` <span class="l5">${wrongN}</span>` : ''}</a>
      <a class="btn b2" href="#/fav">收藏夾${favN ? ` <span class="l5">${favN}</span>` : ''}</a>
    </nav>`;

    const bookOptions = banks
      .filter((b) => !subject || b.subject === subject)
      .map(
        (b) =>
          `<option value="${escHtml(b.bookId)}"${bookId === b.bookId ? ' selected' : ''}>${escHtml(b.title)}</option>`,
      )
      .join('');

    mount.innerHTML = `<div class="page home">
      ${
        suggestHtml
          ? `<button type="button" class="card suggest" data-act="${suggestAct}">
        <p class="eyebrow">今日建議</p>
        <p class="suggest-t">${escHtml(suggestHtml)}</p>
      </button>`
          : ''
      }
      ${quickNav}
      <div class="filters s3 home-filters">
        <label class="field">科目
          <select id="home-subject" class="ctrl-select">
            <option value="">全部</option>
            ${Object.entries(SUBJECT_LABELS)
              .map(([k, v]) => `<option value="${k}"${subject === k ? ' selected' : ''}>${v}</option>`)
              .join('')}
          </select>
        </label>
        <label class="field home-book-filter">書
          <select id="home-book" class="ctrl-select">
            <option value="">全部</option>
            ${bookOptions}
          </select>
        </label>
      </div>
      <div class="book-grid">${bookCards}</div>
      <div class="start-scrim" id="start-scrim" hidden></div>
      <aside class="start-panel" id="start-panel" hidden role="dialog" aria-labelledby="start-panel-h">
        <div class="start-panel-head">
          <h2 id="start-panel-h">開始設定</h2>
          <button type="button" class="btn b2 start-close" id="start-close" aria-label="關閉">關閉</button>
        </div>
        <p class="start-title" id="start-title"></p>
        <p class="start-scope mute" id="start-scope" hidden></p>
        <label class="field s3">對答案方式
          <select id="start-mode" class="ctrl-select"><option value="instant">當場對</option><option value="exam">交卷才對</option></select>
        </label>
        <label class="ctrl-check s1"><input type="checkbox" id="start-shuffle" checked> 打亂順序</label>
        <button type="button" class="btn b1" id="start-go">開始作答</button>
      </aside>
    </div>`;

    /** @type {null|{type:string,bookId:string,unitCode:string,round?:number,unitName?:string,title?:string,bookTitle?:string,count?:number}} */
    let pendingScope = null;

    const openStart = (scope) => {
      pendingScope = scope;
      const panel = mount.querySelector('#start-panel');
      const scrim = mount.querySelector('#start-scrim');
      panel.hidden = false;
      if (scrim) scrim.hidden = false;
      mount.querySelector('#start-title').textContent = scope.title || '';
      const sc = mount.querySelector('#start-scope');
      if (sc) {
        if (scope.count != null) {
          sc.hidden = false;
          sc.textContent = `範圍：${scope.roundLabel || ''}・${scope.count} 題`;
        } else {
          sc.hidden = true;
          sc.textContent = '';
        }
      }
    };

    mount.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]');
      if (act?.dataset.act === 'continue') {
        ctx.resumeProgress?.();
        return;
      }
      if (act?.dataset.act === 'suggest-first') {
        mount.querySelector('.round')?.click();
        return;
      }
      const t = e.target.closest('[data-book].round');
      if (!t || !t.classList.contains('round')) return;
      const bookTitle = t.closest('.book')?.querySelector('h2')?.textContent || '';
      const roundLabel = t.dataset.roundLabel || t.querySelector('span')?.textContent?.trim() || '';
      const countTxt = t.querySelector('small')?.textContent || '';
      const m = countTxt.match(/(\d+)\s*題/);
      openStart({
        type: 'round',
        bookId: t.dataset.book,
        unitCode: t.dataset.unit,
        round: +t.dataset.round,
        unitName: t.dataset.unitName,
        bookTitle,
        roundLabel,
        count: m ? +m[1] : undefined,
        title: `${bookTitle}・${t.dataset.unitName}・${roundLabel}`,
      });
    });

    const closeStart = () => {
      const panel = mount.querySelector('#start-panel');
      const scrim = mount.querySelector('#start-scrim');
      if (panel) panel.hidden = true;
      if (scrim) scrim.hidden = true;
    };
    mount.querySelector('#start-close')?.addEventListener('click', closeStart);
    mount.querySelector('#start-scrim')?.addEventListener('click', closeStart);

    mount.querySelector('#home-subject')?.addEventListener('change', (e) => {
      writeFilters({ subject: e.target.value, bookId: '' });
      renderHome(mount, ctx);
    });
    mount.querySelector('#home-book')?.addEventListener('change', (e) => {
      writeFilters({ bookId: e.target.value });
      renderHome(mount, ctx);
    });

    mount.querySelector('#start-go')?.addEventListener('click', async () => {
      if (!pendingScope) return;
      const go = mount.querySelector('#start-go');
      if (go?.dataset.busy === '1') return;
      if (go) {
        go.dataset.busy = '1';
        go.disabled = true;
        go.textContent = '開始中…';
      }
      try {
        const mode = mount.querySelector('#start-mode').value;
        const shuffle = mount.querySelector('#start-shuffle').checked;
        const { questions, groups } = await fetchQuestionsForRound(
          ctx,
          pendingScope.bookId,
          pendingScope.unitCode,
          pendingScope.round,
        );
        if (!questions.length) {
          ctx.toast?.(ERR.rangeEmpty);
          return;
        }
        closeStart();
        ctx.startScope?.({
          ...pendingScope,
          mode,
          shuffle,
          questions,
          groups,
          title: pendingScope.title,
        });
      } finally {
        if (go && mount.contains(go)) {
          go.dataset.busy = '';
          go.disabled = false;
          go.textContent = '開始作答';
        }
      }
    });
  } catch {
    mount.innerHTML = `<div class="page home"><p class="e2">${ERR.loadQuestions}</p>
      <div class="empty-next"><button type="button" class="btn b1" data-retry>重試</button>
      <a class="btn b2" href="#/">回首頁</a></div></div>`;
    mount.querySelector('[data-retry]')?.addEventListener('click', () => renderHome(mount, ctx));
  }
}

export async function renderWrongBook(mount, ctx) {
  mount.innerHTML = `<div class="page wrong"><div class="e3 skel" aria-busy="true">載入中…</div></div>`;
  const uid = ctx.user.uid;
  const filters = readFilters();
  let subject = filters.wrongSubject || '';
  let unitFilter = filters.wrongUnit || '';
  try {
    const allRows = await loadQstatsWrong(uid);
    const bySubject = subject ? allRows.filter((r) => r.subject === subject) : allRows;
    const units = [...new Set(bySubject.map((r) => r.unitCode).filter(Boolean))].sort();
    const stats = unitFilter ? bySubject.filter((r) => r.unitCode === unitFilter) : bySubject;
    const count = stats.length;
    const label = wrongPracticeLabel(count);
    // R5-3：卡片顯示題幹摘要，不露內部 id
    const stemById = await loadStemSnippets(
      ctx,
      stats.map((s) => s.qid),
    );
    mount.innerHTML = `<div class="page wrong">
      <div class="tabs g2">
        <button type="button" class="tab${!subject ? ' on' : ''}" data-sub="">全部<span class="l5">${allRows.length || ''}</span></button>
        ${Object.entries(SUBJECT_LABELS)
          .map(
            ([k, v]) =>
              `<button type="button" class="tab${subject === k ? ' on' : ''}" data-sub="${k}">${v}<span class="l5">${allRows.filter((s) => s.subject === k).length || ''}</span></button>`,
          )
          .join('')}
      </div>
      <div class="filters m1">
        <label>單元
          <select id="wrong-unit">
            <option value="">全部單元</option>
            ${units.map((u) => `<option value="${escHtml(u)}"${unitFilter === u ? ' selected' : ''}>${escHtml(u)}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="wrong-list">${
        count
          ? stats
              .map(
                (s) => `<article class="card c1 wrong-card" data-qid="${escHtml(s.qid)}">
          <p class="meta">${escHtml(s.unitCode)} · 連對 ${Math.min(s.streak || 0, 2)}/2</p>
          <p class="stem-snip">${escHtml(stemById[s.qid] || '（題幹載入失敗）')}</p>
        </article>`,
              )
              .join('')
          : `<div class="empty-next">
            <p class="e1">${
              subject || unitFilter ? '這個科目沒有錯題' : '目前沒有錯題，去做新的一回'
            }</p>
            ${
              subject || unitFilter
                ? '<button type="button" class="btn b2" data-clear-filter>看全部科目</button>'
                : '<a class="btn b1" href="#/">回首頁選一回</a>'
            }
          </div>`
      }
      </div>
      ${
        count
          ? `<footer class="dock"><button type="button" class="btn b1" id="wrong-practice">${label}</button></footer>`
          : ''
      }
    </div>`;

    mount.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        writeFilters({ wrongSubject: tab.dataset.sub, wrongUnit: '' });
        renderWrongBook(mount, ctx);
      });
    });

    mount.querySelector('[data-clear-filter]')?.addEventListener('click', () => {
      writeFilters({ wrongSubject: '', wrongUnit: '' });
      renderWrongBook(mount, ctx);
    });

    mount.querySelector('#wrong-unit')?.addEventListener('change', (e) => {
      writeFilters({ wrongUnit: e.target.value });
      renderWrongBook(mount, ctx);
    });

    mount.querySelector('#wrong-practice')?.addEventListener('click', async () => {
      const go = mount.querySelector('#wrong-practice');
      if (go?.dataset.busy === '1') return;
      if (go) {
        go.dataset.busy = '1';
        go.disabled = true;
        go.textContent = '開始中…';
      }
      try {
        let pack = await fetchWrongQuestions(ctx, uid, subject || undefined);
        if (unitFilter) {
          pack = {
            ...pack,
            questions: pack.questions.filter((q) => q.unitCode === unitFilter).slice(0, 10),
          };
        }
        if (!pack.questions.length) {
          ctx.toast?.('沒有可練的錯題');
          return;
        }
        ctx.startScope?.({
          type: 'wrong',
          mode: 'instant',
          shuffle: true,
          questions: pack.questions.slice(0, 10),
          groups: pack.groups,
          title: '錯題本',
        });
      } finally {
        if (go && mount.contains(go)) {
          go.dataset.busy = '';
          go.disabled = false;
          go.textContent = label;
        }
      }
    });

    mount.querySelectorAll('.wrong-card').forEach((card) => {
      card.addEventListener('click', () => ctx.openWrongDetail?.(card.dataset.qid));
    });
  } catch {
    mount.innerHTML = `<div class="page wrong"><p class="e2">連不上網路，資料沒載入（或沒存進去）。請檢查網路後按重試。</p>
      <div class="empty-next"><button type="button" class="btn b2" data-retry>重試</button>
      <a class="btn b2" href="#/">回首頁</a></div></div>`;
    mount.querySelector('[data-retry]')?.addEventListener('click', () => renderWrongBook(mount, ctx));
  }
}


function favPracticeLabel(n) {
  if (n <= 0) return '目前沒有收藏題';
  if (n <= 10) return `練習收藏題（${n} 題）`;
  return `練習收藏題（隨機 10 題，共 ${n} 題）`;
}

function fmtFavDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} 收藏`;
}

function stemPreview(stem, lines = 2) {
  const t = String(stem || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '（無題幹）';
  // 約兩行預覽
  return t.length > 72 ? `${t.slice(0, 72)}…` : t;
}

/**
 * 收藏夾頁（§3 畫面 6／§5.7）
 */
export async function renderFavorites(mount, ctx) {
  mount.innerHTML = `<div class="page fav"><div class="e3 skel" aria-busy="true">載入中…</div></div>`;
  const uid = ctx.user.uid;
  const filters = readFilters();
  let subject = filters.favSubject || '';
  try {
    const rows = await loadFavorites(uid, true);
    const bySubject = subject ? rows.filter((r) => r.subject === subject) : rows;
    const qids = bySubject.map((r) => r.qid);
    const stemById = {};
    const metaById = {};
    const missing = [];
    if (qids.length) {
      const { db, fs } = await ensureFb(ctx);
      for (let i = 0; i < qids.length; i += 30) {
        const chunk = qids.slice(i, i + 30);
        const q = fs.query(
          fs.collection(db, 'questions'),
          fs.where(fs.documentId(), 'in', chunk),
        );
        const snap = await fs.getDocs(q);
        const found = new Set();
        snap.forEach((d) => {
          found.add(d.id);
          const data = d.data() || {};
          if (data.review?.status && data.review.status !== 'checked') {
            missing.push(d.id);
            return;
          }
          stemById[d.id] = data.stem || '';
          metaById[d.id] = data;
        });
        chunk.forEach((id) => {
          if (!found.has(id)) missing.push(id);
        });
      }
      if (missing.length) pruneMissingFavorites(uid, missing).catch(() => {});
    }
    const visible = bySubject.filter((r) => stemById[r.qid] != null && !missing.includes(r.qid));
    const count = visible.length;
    const label = favPracticeLabel(count);
    const allCount = rows.length;

    // 科目→單元分組；組內 addedAt 新到舊
    const groups = new Map();
    for (const r of visible) {
      const q = metaById[r.qid] || {};
      const unitName = q.unit || r.unitCode;
      const key = `${r.subject}|${r.unitCode}|${unitName}`;
      if (!groups.has(key)) {
        groups.set(key, {
          subject: r.subject,
          unitCode: r.unitCode,
          unitName,
          items: [],
        });
      }
      groups.get(key).items.push(r);
    }
    for (const g of groups.values()) {
      g.items.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    }
    const groupList = [...groups.values()].sort(
      (a, b) =>
        a.subject.localeCompare(b.subject) || a.unitCode.localeCompare(b.unitCode),
    );

    const STAR_ON =
      '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M12 3.6l2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 16.2 7.2 18.5l.9-5.4L4.2 9.3l5.4-.8z" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';

    const listHtml = count
      ? groupList
          .map((g) => {
            const cards = g.items
              .map((r) => {
                const q = metaById[r.qid] || {};
                const round = q.source?.round ?? q.round;
                const num = q.source?.number;
                const loc =
                  round != null && num != null
                    ? `第 ${round} 回第 ${num} 題`
                    : round != null
                      ? `第 ${round} 回`
                      : '';
                return `<article class="card c1 fav-card" data-qid="${escHtml(r.qid)}">
                  <button type="button" class="xbtn fav-btn on" data-unfav="${escHtml(r.qid)}" aria-pressed="true" aria-label="取消收藏這題">${STAR_ON}</button>
                  <p class="stem-snip">${escHtml(stemPreview(stemById[r.qid]))}</p>
                  <p class="meta">${escHtml(loc)}${loc && r.addedAt ? ' · ' : ''}${escHtml(fmtFavDate(r.addedAt))}</p>
                </article>`;
              })
              .join('');
            return `<section class="fav-group">
              <h2 class="fav-group-h">${escHtml(g.unitCode)} ${escHtml(g.unitName)}・${g.items.length} 題</h2>
              <div class="fav-list">${cards}</div>
            </section>`;
          })
          .join('')
      : `<div class="empty-next">
          <p class="e1">${subject ? ERR.favFilteredEmpty : ERR.favEmpty}</p>
          ${
            subject
              ? '<button type="button" class="btn b2" data-clear-filter>看全部科目</button>'
              : '<a class="btn b1" href="#/">去練習</a>'
          }
        </div>`;

    mount.innerHTML = `<div class="page fav">
      <h1 class="page-title">收藏夾${allCount ? `　${allCount} 題` : ''}</h1>
      <div class="tabs g2">
        <button type="button" class="tab${!subject ? ' on' : ''}" data-sub="">全部<span class="l5">${allCount || ''}</span></button>
        ${Object.entries(SUBJECT_LABELS)
          .map(([k, v]) => {
            const n = rows.filter((r) => r.subject === k).length;
            return `<button type="button" class="tab${subject === k ? ' on' : ''}" data-sub="${k}">${v}<span class="l5">${n || ''}</span></button>`;
          })
          .join('')}
      </div>
      <div class="fav-practice-row">
        <button type="button" class="btn b1" id="fav-practice"${count ? '' : ' disabled'}>${label}</button>
        ${count ? '' : '<p class="mute fav-practice-hint">目前沒有可練習的收藏題</p>'}
      </div>
      ${listHtml}
    </div>`;

    mount.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        writeFilters({ favSubject: tab.dataset.sub || '' });
        renderFavorites(mount, ctx);
      });
    });
    mount.querySelector('[data-clear-filter]')?.addEventListener('click', () => {
      writeFilters({ favSubject: '' });
      renderFavorites(mount, ctx);
    });

    mount.querySelector('#fav-practice')?.addEventListener('click', async () => {
      const go = mount.querySelector('#fav-practice');
      if (!count || go?.dataset.busy === '1') return;
      if (go) {
        go.dataset.busy = '1';
        go.disabled = true;
        go.textContent = '開始中…';
      }
      try {
        const pool = [...visible];
        for (let i = pool.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        const pick = pool.slice(0, 10);
        const questions = [];
        const groups = [];
        const seenG = new Set();
        for (const r of pick) {
          const q = metaById[r.qid];
          if (!q) continue;
          questions.push({ ...q, id: q.id || r.qid });
          if (q.groupId && !seenG.has(q.groupId)) {
            seenG.add(q.groupId);
            try {
              const { db, fs } = await ensureFb(ctx);
              const gSnap = await fs.getDoc(fs.doc(db, 'groups', q.groupId));
              if (gSnap.exists()) groups.push(gSnap.data());
            } catch {
              /* ignore */
            }
          }
        }
        if (!questions.length) {
          ctx.toast?.('沒有可練的收藏題');
          return;
        }
        ctx.startScope?.({
          type: 'fav',
          mode: 'instant',
          shuffle: true,
          questions,
          groups,
          title: '收藏練習',
          favSubject: subject || '',
        });
      } finally {
        if (go && mount.contains(go)) {
          go.dataset.busy = '';
          go.disabled = !count;
          go.textContent = label;
        }
      }
    });

    /** 5 秒復原 */
    const pendingRemoves = new Map();

    mount.querySelectorAll('[data-unfav]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const qid = btn.dataset.unfav;
        const row = visible.find((r) => r.qid === qid);
        if (!row) return;
        const card = mount.querySelector(`.fav-card[data-qid="${CSS.escape(qid)}"]`);
        if (card) card.hidden = true;
        const job = scheduleFavoriteRemove(uid, row, 5000);
        pendingRemoves.set(qid, job);
        ctx.toast?.('已取消收藏', {
          retryLabel: '復原',
          ms: 5000,
          onRetry: () => {
            job.undo();
            pendingRemoves.delete(qid);
            if (card) card.hidden = false;
          },
        });
        // 逾時後若整組空了就重渲
        setTimeout(() => {
          if (pendingRemoves.get(qid) === job) {
            pendingRemoves.delete(qid);
            const still = mount.querySelectorAll('.fav-card:not([hidden])').length;
            if (still === 0) renderFavorites(mount, ctx);
          }
        }, 5100);
      });
    });

    mount.querySelectorAll('.fav-card').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-unfav]')) return;
        const qid = card.dataset.qid;
        const q = metaById[qid];
        if (!q) return;
        openFavDetail(ctx, uid, q, () => renderFavorites(mount, ctx));
      });
    });
  } catch {
    mount.innerHTML = `<div class="page fav"><p class="e2">${ERR.favLoadFail}</p>
      <div class="empty-next"><button type="button" class="btn b1" data-retry>重試</button>
      <a class="btn b2" href="#/">回首頁</a></div></div>`;
    mount.querySelector('[data-retry]')?.addEventListener('click', () => renderFavorites(mount, ctx));
  }
}

async function openFavDetail(ctx, uid, q, onChanged) {
  const L = 'ABCD';
  let dlg = document.querySelector('dialog.fav-detail-dlg');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.className = 'fav-detail-dlg wrong-detail-dlg';
    document.body.appendChild(dlg);
  }
  const STAR_ON =
    '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M12 3.6l2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 16.2 7.2 18.5l.9-5.4L4.2 9.3l5.4-.8z" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  dlg.innerHTML = `
    <form method="dialog">
      <div class="fav-detail-head">
        <h2>收藏詳情</h2>
        <button type="button" class="xbtn fav-btn on" data-unfav aria-pressed="true" aria-label="取消收藏這題">${STAR_ON}</button>
      </div>
      <p class="meta">${escHtml(q.unitCode || '')} ${escHtml(q.unit || '')}</p>
      <div class="wd-stem">${escHtml(q.stem || '').replace(/\n/g, '<br>')}</div>
      <p><strong>正確答案：</strong>(${L[q.answer]}) ${escHtml(q.options?.[q.answer] || '')}</p>
      <div class="wd-ex">${escHtml(q.explain || '').replace(/\n/g, '<br>')}</div>
      <div class="leave-actions">
        <button type="submit" class="btn b2" value="close">關閉</button>
      </div>
    </form>`;
  dlg.querySelector('[data-unfav]')?.addEventListener('click', () => {
    const row = {
      qid: q.id,
      bookId: q.bookId || '',
      subject: q.subject || '',
      unitCode: q.unitCode || '',
      addedAt: Date.now(),
    };
    const job = scheduleFavoriteRemove(uid, row, 5000);
    dlg.close();
    ctx.toast?.('已取消收藏', {
      retryLabel: '復原',
      ms: 5000,
      onRetry: () => {
        job.undo();
        onChanged?.();
      },
    });
    setTimeout(() => onChanged?.(), 5100);
  });
  if (typeof dlg.showModal === 'function') dlg.showModal();
}

export { updateQstatManualOut, wrongPracticeLabel };
