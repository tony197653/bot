/**
 * 首頁（Traditional Chinese UI；v1.4.1）。
 */
import { escHtml } from './render.js';
import { ERR } from './errors.js';
import { loadAttemptSummary, progressKey } from './stats.js';

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

function roundKey(bookId, unitCode, round) {
  return `${bookId}|${unitCode}|${round}`;
}

function subjectsInBanks(banks) {
  return [...new Set(banks.map((b) => b.subject).filter(Boolean))].sort();
}

function filterBooks(banks, subject, bookId) {
  let filtered = subject ? banks.filter((b) => b.subject === subject) : banks.slice();
  if (bookId) filtered = filtered.filter((b) => b.bookId === bookId);
  return filtered;
}

function readProgress(uid) {
  try {
    const raw = localStorage.getItem(progressKey(uid));
    if (!raw) return null;
    const prog = JSON.parse(raw);
    if (!prog?.qids?.length) return null;
    return prog;
  } catch {
    return null;
  }
}

function findFirstRound(books) {
  for (const book of books) {
    for (const u of book.units || []) {
      for (const r of u.rounds || []) {
        if (r.count > 0) {
          const roundLabel = r.label || `第 ${r.round} 回`;
          return {
            bookId: book.bookId,
            bookTitle: book.title || '',
            unitCode: u.unitCode,
            unitName: u.name || '',
            round: r.round,
            roundLabel,
            count: r.count,
          };
        }
      }
    }
  }
  return null;
}

function progressMatchesFilter(prog, subject, filteredBooks) {
  if (!prog) return false;
  const bookId = prog.scope?.bookId;
  if (subject) {
    const sub = prog.scope?.subject;
    if (sub && sub !== subject) return false;
    if (bookId && !filteredBooks.some((b) => b.bookId === bookId)) return false;
  } else if (bookId && filteredBooks.length && !filteredBooks.some((b) => b.bookId === bookId)) {
    return false;
  }
  return true;
}

function buildSuggest(prog, firstRound) {
  if (prog) {
    const cur = (prog.idx || 0) + 1;
    const total = prog.qids?.length || '?';
    const roundNum = prog.scope?.round;
    const roundLabel =
      prog.scope?.roundLabel ||
      (roundNum != null && roundNum !== '' ? `第 ${roundNum} 回` : null);
    const tail = roundLabel ? `繼續${roundLabel}（${cur}/${total}）` : `繼續作答（${cur}/${total}）`;
    return { kind: 'continue', prog, line: `今日建議：${tail}`, count: prog.qids?.length || 0 };
  }
  if (firstRound) {
    const line = `今日建議：從「${firstRound.bookTitle}」${firstRound.unitName} ${firstRound.roundLabel} 開始`;
    return { kind: 'first', round: firstRound, line, count: firstRound.count };
  }
  return { kind: 'none', line: '今日建議：—', count: 0 };
}

function parsePick(pick, banks) {
  if (!pick) return null;
  const parts = String(pick).split('|');
  if (parts.length !== 3) return null;
  const [bookId, unitCode, roundStr] = parts;
  const round = +roundStr;
  if (!bookId || !unitCode || !Number.isFinite(round)) return null;
  const book = banks.find((b) => b.bookId === bookId);
  if (!book) return null;
  const unit = (book.units || []).find((u) => u.unitCode === unitCode);
  if (!unit) return null;
  const r = (unit.rounds || []).find((x) => x.round === round);
  if (!r || r.count <= 0) return null;
  const roundLabel = r.label || `第 ${r.round} 回`;
  return {
    bookId,
    bookTitle: book.title || '',
    unitCode,
    unitName: unit.name || '',
    round,
    roundLabel,
    count: r.count,
  };
}

function syncSubjectAllOption(selectEl) {
  const opt = selectEl?.querySelector('option[value=""]');
  if (!opt) return;
  const desktop = typeof window !== 'undefined' && window.matchMedia('(min-width:900px)').matches;
  opt.textContent = desktop ? '全部' : '科目';
}

function subjectAriaLabel(subject) {
  const name = subject ? SUBJECT_LABELS[subject] || subject : '全部';
  return `科目：${name}`;
}

function renderBookCards(filtered, summary, pickKey) {
  if (!filtered.length) {
    return `<p class="e1 home-empty" data-el="home-empty-filter">這個篩選下沒有書</p>`;
  }
  return filtered
    .map((book) => {
      const units = book.units || [];
      return `<article class="card c1 book" data-book="${escHtml(book.bookId)}">
        <header><h2>${escHtml(book.title)}</h2><span class="l3">${SUBJECT_LABELS[book.subject] || book.subject}</span></header>
        <div class="unit-list">${units
          .map((u) => {
            const rounds = (u.rounds || [])
              .filter((r) => r.count > 0)
              .map((r) => {
                const key = roundKey(book.bookId, u.unitCode, r.round);
                const stat = summary.byRound[key];
                const meta = stat ? `已做 ${stat.count} 次・最高 ${stat.best}` : '';
                const roundLabel = r.label || `第 ${r.round} 回`;
                const on = pickKey === key;
                return `<button type="button" class="round a1${on ? ' on' : ''}" data-book="${escHtml(book.bookId)}" data-unit="${escHtml(u.unitCode)}" data-round="${r.round}" data-unit-name="${escHtml(u.name)}" data-round-label="${escHtml(roundLabel)}" data-count="${r.count}" aria-pressed="${on ? 'true' : 'false'}">
                    <span>${escHtml(roundLabel)}${on ? ' <span class="round-pick">✓ 已選</span>' : ''}</span>
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
}

/**
 * @param {HTMLElement} mount
 * @param {object} ctx { user, navigate, toast, isAdmin, startScope, resumeProgress }
 */
export async function renderHome(mount, ctx) {
  mount.innerHTML = `<div class="page home"><div class="e3 skel" aria-busy="true">載入中…</div></div>`;
  const uid = ctx.user.uid;
  try {
    const [banks, summary] = await Promise.all([fetchBanks(ctx), loadAttemptSummary(uid)]);
    const filters = readFilters();
    const subject = filters.subject || '';
    const bookId = filters.bookId || '';
    const mode = filters.mode === 'exam' ? 'exam' : 'instant';
    const shuffle = filters.shuffle !== false;

    const bankEmpty = banks.length === 0;
    const subjectKeys = subjectsInBanks(banks);
    let filtered = filterBooks(banks, subject, bookId);

    let selected = parsePick(filters.pick, banks);
    if (selected && subject && banks.find((b) => b.bookId === selected.bookId)?.subject !== subject) {
      selected = null;
      writeFilters({ pick: '' });
    }
    if (selected && bookId && selected.bookId !== bookId) {
      selected = null;
      writeFilters({ pick: '' });
    }
    if (selected && !filtered.some((b) => b.bookId === selected.bookId)) {
      selected = null;
      writeFilters({ pick: '' });
    }

    const progSaved = readProgress(uid);
    const progRaw = progressMatchesFilter(progSaved, subject, filtered) ? progSaved : null;
    const firstRound = findFirstRound(filtered);
    let suggest = buildSuggest(progRaw, firstRound);

    const pickKey = selected ? roundKey(selected.bookId, selected.unitCode, selected.round) : '';

    const subjectOptions = subjectKeys
      .map(
        (k) =>
          `<option value="${escHtml(k)}"${subject === k ? ' selected' : ''}>${SUBJECT_LABELS[k] || k}</option>`,
      )
      .join('');

    const bookOptions = banks
      .filter((b) => !subject || b.subject === subject)
      .map(
        (b) =>
          `<option value="${escHtml(b.bookId)}"${bookId === b.bookId ? ' selected' : ''}>${escHtml(b.title)}</option>`,
      )
      .join('');

    const opsClass = ctx.isAdmin ? 'home-ops home-ops--admin' : 'home-ops home-ops--student';
    const importBtn = ctx.isAdmin
      ? `<a class="btn b2 home-ops-import" href="#/import">匯入校對</a>`
      : '';

    const emptyMsg = ctx.isAdmin ? '題庫還是空的' : '題目還在準備中，宗良匯入後就能練習';
    const emptyActions = ctx.isAdmin
      ? `<a class="btn b1" href="#/import">去匯入校對</a>`
      : `<button type="button" class="btn b2" data-reload>重新整理</button>`;

    const practiceBlock = bankEmpty
      ? ''
      : `<section class="card practice-card" data-el="practice">
        <div class="practice-range">
          <p class="practice-range-t" id="practice-range-text"></p>
          <button type="button" class="btn b2" id="practice-reset" hidden>改回今日建議</button>
        </div>
        <div class="practice-settings">
          <label class="field s3">對答案方式
            <select id="practice-mode" class="ctrl-select">
              <option value="instant"${mode === 'instant' ? ' selected' : ''}>當場對</option>
              <option value="exam"${mode === 'exam' ? ' selected' : ''}>交卷才對</option>
            </select>
          </label>
          <label class="ctrl-check s1"><input type="checkbox" id="practice-shuffle"${shuffle ? ' checked' : ''}> 打亂順序</label>
        </div>
        <p class="e1 practice-empty-reason" id="practice-empty-reason" hidden>${ERR.rangeEmpty}</p>
      </section>`;

    const bookToolbar = bankEmpty
      ? ''
      : `<div class="book-toolbar">
        <label class="field m1 home-book-filter">書
          <select id="home-book" class="ctrl-select">
            <option value="">全部</option>
            ${bookOptions}
          </select>
        </label>
      </div>`;

    const bookGrid = bankEmpty
      ? `<div class="home-empty-wrap" data-el="home-empty">
          <p class="e1 home-empty">${escHtml(emptyMsg)}</p>
          <div class="empty-next">${emptyActions}</div>
        </div>`
      : `<div class="book-grid" data-el="book-grid">${renderBookCards(filtered, summary, pickKey)}</div>`;

    mount.innerHTML = `<div class="page home">
      <div class="${opsClass}" data-el="home-ops">
        <label class="field home-ops-subject">
          <span class="home-ops-sub-label">科目</span>
          <select id="home-subject" class="ctrl-select"${bankEmpty ? ' disabled' : ''} aria-label="${escHtml(subjectAriaLabel(subject))}">
            <option value=""${subject === '' ? ' selected' : ''}>全部</option>
            ${subjectOptions}
          </select>
        </label>
        ${importBtn}
        <button type="button" class="btn b1" id="home-start"${bankEmpty ? ' disabled' : ''}>開始練習</button>
      </div>
      ${practiceBlock}
      ${bookToolbar}
      ${bookGrid}
    </div>`;

    mount.querySelector('[data-reload]')?.addEventListener('click', () => {
      window.location.reload();
    });

    const subjectSel = mount.querySelector('#home-subject');
    syncSubjectAllOption(subjectSel);

    /** @type {null|ReturnType<typeof parsePick>} */
    let selectedRound = selected;
    let suggestState = suggest;

    const getActiveCount = () => {
      if (selectedRound) return selectedRound.count || 0;
      return suggestState.count || 0;
    };

    const updatePracticeCard = () => {
      const rangeEl = mount.querySelector('#practice-range-text');
      const resetBtn = mount.querySelector('#practice-reset');
      const reasonEl = mount.querySelector('#practice-empty-reason');
      const startBtn = mount.querySelector('#home-start');
      if (!rangeEl) return;

      if (selectedRound) {
        rangeEl.textContent = `已選：${selectedRound.bookTitle}・${selectedRound.roundLabel}（${selectedRound.count} 題）`;
        if (resetBtn) resetBtn.hidden = false;
      } else {
        rangeEl.textContent = suggestState.line;
        if (resetBtn) resetBtn.hidden = true;
      }

      const empty = getActiveCount() <= 0;
      if (reasonEl) reasonEl.hidden = !empty;
      if (startBtn && !bankEmpty) {
        startBtn.disabled = empty || startBtn.dataset.busy === '1';
      }
    };

    const updateRoundButtons = () => {
      const key = selectedRound
        ? roundKey(selectedRound.bookId, selectedRound.unitCode, selectedRound.round)
        : '';
      mount.querySelectorAll('.round[data-book]').forEach((btn) => {
        const k = roundKey(btn.dataset.book, btn.dataset.unit, +btn.dataset.round);
        const on = k === key;
        btn.classList.toggle('on', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        const span = btn.querySelector('span');
        if (!span) return;
        const label = btn.dataset.roundLabel || span.textContent.replace(/\s*✓ 已選$/, '').trim();
        span.innerHTML = on
          ? `${escHtml(label)} <span class="round-pick">✓ 已選</span>`
          : escHtml(label);
      });
    };

    const setSelected = (next) => {
      selectedRound = next;
      writeFilters({ pick: next ? roundKey(next.bookId, next.unitCode, next.round) : '' });
      updatePracticeCard();
      updateRoundButtons();
    };

    updatePracticeCard();

    subjectSel?.addEventListener('change', (e) => {
      const v = e.target.value;
      writeFilters({ subject: v, bookId: '', pick: '' });
      renderHome(mount, ctx);
    });

    mount.querySelector('#home-book')?.addEventListener('change', (e) => {
      writeFilters({ bookId: e.target.value, pick: '' });
      renderHome(mount, ctx);
    });

    mount.querySelector('#practice-mode')?.addEventListener('change', (e) => {
      writeFilters({ mode: e.target.value });
    });

    mount.querySelector('#practice-shuffle')?.addEventListener('change', (e) => {
      writeFilters({ shuffle: e.target.checked });
    });

    mount.querySelector('#practice-reset')?.addEventListener('click', () => {
      setSelected(null);
    });

    mount.addEventListener('click', (e) => {
      const t = e.target.closest('.round[data-book]');
      if (!t) return;
      const key = roundKey(t.dataset.book, t.dataset.unit, +t.dataset.round);
      if (
        selectedRound &&
        roundKey(selectedRound.bookId, selectedRound.unitCode, selectedRound.round) === key
      ) {
        setSelected(null);
        return;
      }
      const bookTitle = t.closest('.book')?.querySelector('h2')?.textContent || '';
      setSelected({
        bookId: t.dataset.book,
        unitCode: t.dataset.unit,
        round: +t.dataset.round,
        unitName: t.dataset.unitName,
        bookTitle,
        roundLabel: t.dataset.roundLabel || t.querySelector('span')?.textContent?.trim() || '',
        count: +(t.dataset.count || 0),
      });
    });

    mount.querySelector('#home-start')?.addEventListener('click', async () => {
      const go = mount.querySelector('#home-start');
      if (go?.dataset.busy === '1' || go?.disabled) return;
      if (getActiveCount() <= 0) {
        ctx.toast?.(ERR.rangeEmpty);
        return;
      }

      const modeVal = mount.querySelector('#practice-mode')?.value || mode;
      const shuffleVal = mount.querySelector('#practice-shuffle')?.checked ?? shuffle;

      if (go) {
        go.dataset.busy = '1';
        go.disabled = true;
        go.textContent = '開始中…';
      }
      try {
        if (selectedRound) {
          const { questions, groups } = await fetchQuestionsForRound(
            ctx,
            selectedRound.bookId,
            selectedRound.unitCode,
            selectedRound.round,
          );
          if (!questions.length) {
            ctx.toast?.(ERR.rangeEmpty);
            return;
          }
          ctx.startScope?.({
            type: 'round',
            bookId: selectedRound.bookId,
            unitCode: selectedRound.unitCode,
            round: selectedRound.round,
            unitName: selectedRound.unitName,
            bookTitle: selectedRound.bookTitle,
            roundLabel: selectedRound.roundLabel,
            mode: modeVal,
            shuffle: shuffleVal,
            questions,
            groups,
            title: `${selectedRound.bookTitle}・${selectedRound.unitName}・${selectedRound.roundLabel}`,
          });
          return;
        }

        if (suggestState.kind === 'continue') {
          await ctx.resumeProgress?.();
          return;
        }

        if (suggestState.kind === 'first' && suggestState.round) {
          const r = suggestState.round;
          const { questions, groups } = await fetchQuestionsForRound(ctx, r.bookId, r.unitCode, r.round);
          if (!questions.length) {
            ctx.toast?.(ERR.rangeEmpty);
            return;
          }
          ctx.startScope?.({
            type: 'round',
            bookId: r.bookId,
            unitCode: r.unitCode,
            round: r.round,
            unitName: r.unitName,
            bookTitle: r.bookTitle,
            roundLabel: r.roundLabel,
            mode: modeVal,
            shuffle: shuffleVal,
            questions,
            groups,
            title: `${r.bookTitle}・${r.unitName}・${r.roundLabel}`,
          });
          return;
        }

        ctx.toast?.(ERR.rangeEmpty);
      } finally {
        if (go && mount.contains(go)) {
          go.dataset.busy = '';
          go.textContent = '開始練習';
          updatePracticeCard();
        }
      }
    });

    if (typeof window !== 'undefined') {
      const mq = window.matchMedia('(min-width:900px)');
      const onMq = () => syncSubjectAllOption(subjectSel);
      mq.addEventListener?.('change', onMq);
    }
  } catch {
    mount.innerHTML = `<div class="page home"><p class="e2">${ERR.loadQuestions}</p>
      <div class="empty-next"><button type="button" class="btn b1" data-retry>重試</button>
      <a class="btn b2" href="#/">回首頁</a></div></div>`;
    mount.querySelector('[data-retry]')?.addEventListener('click', () => renderHome(mount, ctx));
  }
}
