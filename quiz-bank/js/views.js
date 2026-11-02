/**
 * 首頁、錯題本、單元強弱表（Traditional Chinese UI）。
 */
import { escHtml, renderMath } from './render.js';
import {
  loadAttempts30d,
  loadQstatsWrong,
  loadAttemptSummary,
  computeStrength,
  updateQstatManualOut,
  progressKey,
} from './stats.js';

export const SUBJECT_LABELS = {
  math: '數學',
  sci: '自然',
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

export function formatUnitsExportText({ strengthRows, wrongBySubject, recentAttempts, productName = '考題網' }) {
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
    const [banks, summary, attempts30] = await Promise.all([
      fetchBanks(ctx),
      loadAttemptSummary(uid),
      loadAttempts30d(uid),
    ]);
    const filters = readFilters();
    const subject = filters.subject || '';
    const filtered = subject ? banks.filter((b) => b.subject === subject) : banks;

    let suggestHtml = '';
    const progRaw = localStorage.getItem(progressKey(uid));
    if (progRaw) {
      try {
        const prog = JSON.parse(progRaw);
        suggestHtml = `<button type="button" class="card suggest" data-act="continue">
          <p class="eyebrow">今日建議</p>
          <p class="suggest-t">繼續未交卷的練習（第 ${(prog.idx || 0) + 1}／${prog.qids?.length || '?'} 題）</p>
        </button>`;
      } catch {
        /* ignore */
      }
    }
    if (!suggestHtml && filtered.length) {
      const book = filtered[0];
      const unit = book.units?.[0];
      const round = unit?.rounds?.[0];
      if (unit && round) {
        suggestHtml = `<button type="button" class="card suggest" data-act="suggest-first">
          <p class="eyebrow">今日建議</p>
          <p class="suggest-t">從「${escHtml(book.title)}」${escHtml(unit.name)} ${escHtml(round.label || `第 ${round.round} 回`)} 開始</p>
        </button>`;
      }
    }

    const bookCards =
      filtered.length === 0
        ? `<p class="e1">題目準備中${ctx.isAdmin ? '。管理者可至匯入頁存入題目。' : '。'}</p>`
        : filtered
            .map((book) => {
              const units = book.units || [];
              return `<article class="card c1 book" data-book="${escHtml(book.bookId)}">
                <header><h2>${escHtml(book.title)}</h2><span class="l3">${SUBJECT_LABELS[book.subject] || book.subject}</span></header>
                <div class="unit-list">${units
                  .map((u) => {
                    const rounds = (u.rounds || [])
                      .filter((r) => r.count > 0)
                      .map(
                        (r) => {
                          const key = `${book.bookId}|${u.unitCode}|${r.round}`;
                          const stat = summary.byRound[key];
                          const meta = stat ? `已做 ${stat.count} 次・最高 ${stat.best}` : '';
                          return `<button type="button" class="round a1" data-book="${escHtml(book.bookId)}" data-unit="${escHtml(u.unitCode)}" data-round="${r.round}" data-unit-name="${escHtml(u.name)}">
                            <span>${escHtml(r.label || `第 ${r.round} 回`)}</span>
                            <small>${meta || `${r.count} 題`}</small>
                          </button>`;
                        },
                      )
                      .join('');
                    return `<div class="unit-block"><p class="unit-name">${escHtml(u.unitCode)} ${escHtml(u.name)}</p>${rounds || '<p class="mute">尚無題目</p>'}</div>`;
                  })
                  .join('')}</div>
              </article>`;
            })
            .join('');

    mount.innerHTML = `<div class="page home">
      ${suggestHtml}
      <div class="filters s3">
        <label>科目
          <select id="home-subject">
            <option value="">全部</option>
            ${Object.entries(SUBJECT_LABELS)
              .map(([k, v]) => `<option value="${k}"${subject === k ? ' selected' : ''}>${v}</option>`)
              .join('')}
          </select>
        </label>
      </div>
      <div class="book-grid">${bookCards}</div>
      <aside class="start-panel" id="start-panel" hidden>
        <h2>開始設定</h2>
        <p class="start-title" id="start-title"></p>
        <label class="s3">對答案方式
          <select id="start-mode"><option value="instant">當場對</option><option value="exam">交卷才對</option></select>
        </label>
        <label class="s1"><input type="checkbox" id="start-shuffle" checked> 打亂順序</label>
        <button type="button" class="btn b1" id="start-go">開始作答</button>
      </aside>
    </div>`;

    /** @type {null|{type:string,bookId:string,unitCode:string,round?:number,unitName?:string,title?:string}} */
    let pendingScope = null;

    mount.addEventListener('click', (e) => {
      const t = e.target.closest('[data-act],[data-book].round');
      if (!t) return;
      if (t.dataset.act === 'continue') {
        ctx.navigate('#/quiz');
        return;
      }
      if (t.dataset.act === 'suggest-first') {
        const btn = mount.querySelector('.round');
        btn?.click();
        return;
      }
      if (t.classList.contains('round')) {
        pendingScope = {
          type: 'round',
          bookId: t.dataset.book,
          unitCode: t.dataset.unit,
          round: +t.dataset.round,
          unitName: t.dataset.unitName,
          title: `${t.closest('.book')?.querySelector('h2')?.textContent || ''}・${t.dataset.unitName}・${t.textContent.trim()}`,
        };
        const panel = mount.querySelector('#start-panel');
        panel.hidden = false;
        mount.querySelector('#start-title').textContent = pendingScope.title || '';
      }
    });

    mount.querySelector('#home-subject')?.addEventListener('change', (e) => {
      writeFilters({ subject: e.target.value });
      renderHome(mount, ctx);
    });

    mount.querySelector('#start-go')?.addEventListener('click', async () => {
      if (!pendingScope) return;
      const mode = mount.querySelector('#start-mode').value;
      const shuffle = mount.querySelector('#start-shuffle').checked;
      const { questions, groups } = await fetchQuestionsForRound(
        ctx,
        pendingScope.bookId,
        pendingScope.unitCode,
        pendingScope.round,
      );
      if (!questions.length) {
        ctx.toast?.('這個範圍沒有題目');
        return;
      }
      ctx.startScope?.({
        ...pendingScope,
        mode,
        shuffle,
        questions,
        groups,
        title: pendingScope.title,
      });
    });
  } catch {
    mount.innerHTML = `<div class="page home"><p class="e2">載入失敗。<button type="button" class="btn b2" data-retry>重試</button></p></div>`;
    mount.querySelector('[data-retry]')?.addEventListener('click', () => renderHome(mount, ctx));
  }
}

export async function renderWrongBook(mount, ctx) {
  mount.innerHTML = `<div class="page wrong"><div class="e3">載入中…</div></div>`;
  const uid = ctx.user.uid;
  let subject = readFilters().wrongSubject || '';
  try {
    const allRows = await loadQstatsWrong(uid);
    const stats = subject ? allRows.filter((r) => r.subject === subject) : allRows;
    const count = stats.length;
    const label = wrongPracticeLabel(count);
    mount.innerHTML = `<div class="page wrong">
      <div class="tabs g2">${Object.entries(SUBJECT_LABELS)
        .map(
          ([k, v]) =>
            `<button type="button" class="tab${subject === k ? ' on' : ''}" data-sub="${k}">${v}<span class="l5">${stats.filter((s) => s.subject === k).length || ''}</span></button>`,
        )
        .join('')}
        <button type="button" class="tab${!subject ? ' on' : ''}" data-sub="">全部</button>
      </div>
      <div class="wrong-list">${count ? stats.map((s) => `<article class="card c1 wrong-card" data-qid="${escHtml(s.qid)}">
          <p class="meta">${escHtml(s.unitCode)} · 連對 ${Math.min(s.streak || 0, 2)}/2</p>
          <p class="qid">${escHtml(s.qid)}</p>
        </article>`).join('') : '<p class="e1">目前沒有錯題，去做新的一回吧。</p>'}
      </div>
      <footer class="dock"><button type="button" class="btn b1" id="wrong-practice" ${count ? '' : 'disabled'}>${label}</button></footer>
    </div>`;

    mount.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        writeFilters({ wrongSubject: tab.dataset.sub });
        renderWrongBook(mount, ctx);
      });
    });

    mount.querySelector('#wrong-practice')?.addEventListener('click', async () => {
      const pack = await fetchWrongQuestions(ctx, uid, subject || undefined);
      if (!pack.questions.length) {
        ctx.toast?.('沒有可練的錯題');
        return;
      }
      ctx.startScope?.({
        type: 'wrong',
        mode: 'instant',
        shuffle: true,
        questions: pack.questions,
        groups: pack.groups,
        title: '錯題本',
      });
    });

    mount.querySelectorAll('.wrong-card').forEach((card) => {
      card.addEventListener('click', () => ctx.openWrongDetail?.(card.dataset.qid));
    });
  } catch {
    mount.innerHTML = `<div class="page wrong"><p class="e2">載入失敗</p></div>`;
  }
}

export async function renderUnits(mount, ctx) {
  mount.innerHTML = `<div class="page units-page"><div class="e3">載入中…</div></div>`;
  const uid = ctx.user.uid;
  try {
    const attempts = await loadAttempts30d(uid);
    const strength = computeStrength(attempts);
    const wrongStats = await loadQstatsWrong(uid);
    const wrongBySubject = {};
    wrongStats.forEach((s) => {
      wrongBySubject[s.subject] = (wrongBySubject[s.subject] || 0) + 1;
    });
    const summary = await loadAttemptSummary(uid);
    const exportText = formatUnitsExportText({
      strengthRows: strength,
      wrongBySubject,
      recentAttempts: summary.recent,
    });

    const totalAttempts = attempts.reduce((n, a) => n + (a.total || 0), 0);
    const totalCorrect = attempts.reduce((n, a) => n + (a.correct || 0), 0);
    const rate = totalAttempts ? Math.round((totalCorrect / totalAttempts) * 100) : 0;

    mount.innerHTML = `<div class="page units-page">
      <p class="note">最近 30 天</p>
      <div class="stat-grid">${[
        ['作答題數', totalAttempts],
        ['正確率', `${rate}%`],
        ['錯題本', wrongStats.length],
        ['完成回合', attempts.length],
      ]
        .map(([k, v]) => `<div class="stat-box"><span>${k}</span><b>${v}</b></div>`)
        .join('')}</div>
      <table class="t1 strength">
        <thead><tr><th>單元</th><th class="r">正確率</th><th>狀態</th><th></th></tr></thead>
        <tbody>${strength
          .map(
            (u) => `<tr>
              <td><span class="ucode">${escHtml(u.unitCode)}</span> ${escHtml(u.unit)}</td>
              <td class="r">${u.total ? `${Math.round(u.rate * 100)}%（${u.total} 次）` : '—'}</td>
              <td><span class="l2 ${u.status}"><i></i>${escHtml(u.label)}</span>${u.lowSample ? '<span class="l3">題數少</span>' : ''}</td>
              <td><button type="button" class="btn b5 unit-practice" data-unit="${escHtml(u.unitCode)}" data-book="">練這單元</button></td>
            </tr>`,
          )
          .join('')}</tbody>
      </table>
      ${strength.length === 0 ? '<p class="e1">最近 30 天做完一回就會出現資料。</p>' : ''}
      <label class="export-box">複製給家教 TU
        <textarea class="i1" readonly rows="8">${escHtml(exportText)}</textarea>
      </label>
      <button type="button" class="btn b1" id="copy-units">複製給家教 TU</button>
    </div>`;

    mount.querySelector('#copy-units')?.addEventListener('click', async () => {
      const ta = mount.querySelector('textarea');
      try {
        await navigator.clipboard.writeText(ta.value);
        ctx.toast?.('已複製');
      } catch {
        ta.select();
        ctx.toast?.('請長按選取後複製');
      }
    });

    mount.querySelectorAll('.unit-practice').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const unitCode = btn.dataset.unit;
        const banks = await fetchBanks(ctx);
        const book = banks.find((b) => (b.units || []).some((u) => u.unitCode === unitCode));
        if (!book) {
          ctx.toast?.('找不到這個單元的題庫');
          return;
        }
        const pack = await fetchQuestionsForUnit(ctx, book.bookId, unitCode, 10);
        if (!pack.questions.length) {
          ctx.toast?.('這個單元還沒有題目');
          return;
        }
        ctx.startScope?.({
          type: 'unit',
          bookId: book.bookId,
          unitCode,
          mode: 'instant',
          shuffle: true,
          questions: pack.questions,
          groups: pack.groups,
          title: `${book.title}・${unitCode} 單元練習`,
        });
      });
    });
  } catch {
    mount.innerHTML = `<div class="page units-page"><p class="e2">載入失敗</p></div>`;
  }
}

export { updateQstatManualOut, wrongPracticeLabel };
