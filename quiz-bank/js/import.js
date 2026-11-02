/**
 * 匯入校對（管理者）：三步驟、紅標、預覽、分批 writeBatch、回報分頁。
 */
import { validateBatch, figureByteSize } from './schema.js';
import { escHtml, renderMath, stemHtml, optionsHtml, groupPassageHtml } from './render.js';

const DRAFT_KEY = 'quizbank:v1:importDraft';
const DRAFT_WARN_BYTES = 4 * 1024 * 1024;

function readDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * 草稿不含圖（避免 localStorage 爆掉）；失敗時回傳 false。
 * @param {object} d
 * @param {(msg:string)=>void} [toast]
 */
function writeDraft(d, toast) {
  try {
    const slim = JSON.parse(JSON.stringify(d));
    if (slim.batch?.questions) {
      for (const q of slim.batch.questions) {
        if (Array.isArray(q.figures)) {
          q.figures = q.figures.map((f) => ({
            ...f,
            src: f.src?.startsWith('data:') ? 'data:image/webp;base64,' : f.src,
          }));
        }
      }
    }
    if (slim.batch?.groups) {
      for (const g of slim.batch.groups) {
        if (Array.isArray(g.figures)) {
          g.figures = g.figures.map((f) => ({
            ...f,
            src: f.src?.startsWith('data:') ? 'data:image/webp;base64,' : f.src,
          }));
        }
      }
    }
    const text = JSON.stringify(slim);
    if (text.length > DRAFT_WARN_BYTES) {
      toast?.('草稿太大，已略過圖片欄位仍寫不進本機；請盡快存入雲端');
    }
    localStorage.setItem(DRAFT_KEY, text);
    return true;
  } catch {
    toast?.('本機草稿存不下（容量不足），編輯內容可能在重新整理後遺失');
    return false;
  }
}

async function ensureFb(ctx) {
  if (ctx.fb) return ctx.fb;
  const { initFirebase } = await import('./fb.js');
  ctx.fb = await initFirebase();
  return ctx.fb;
}

/** 輕量索引：只讀 banks.questionIds，不拉題目 base64 */
async function loadExistingIds(ctx) {
  const { db, fs } = await ensureFb(ctx);
  const snap = await fs.getDocs(fs.collection(db, 'banks'));
  const ids = new Set();
  snap.forEach((docSnap) => {
    const arr = docSnap.data()?.questionIds;
    if (Array.isArray(arr)) arr.forEach((id) => ids.add(id));
  });
  return ids;
}

async function loadOpenReports(ctx) {
  const { db, fs } = await ensureFb(ctx);
  const q = fs.query(fs.collection(db, 'reports'), fs.where('status', '==', 'open'));
  const snap = await fs.getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

function fileToWebp(file, maxBytes = 150 * 1024) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      let w = img.width;
      let h = img.height;
      const maxW = 1000;
      if (w > maxW) {
        h = Math.round((h * maxW) / w);
        w = maxW;
      }
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      let quality = 0.92;
      const tryEncode = () => {
        const data = canvas.toDataURL('image/webp', quality);
        const size = figureByteSize(data);
        if (size <= maxBytes || quality < 0.4) resolve(data);
        else {
          quality -= 0.08;
          tryEncode();
        }
      };
      tryEncode();
    };
    img.onerror = () => reject(new Error('圖片無法讀取'));
    img.src = url;
  });
}

/** 依每題 unitCode／round 合併 banks.units */
export function mergeBankUnits(existing, batch) {
  const units = [...(existing?.units || [])];
  const byCode = Object.fromEntries(units.map((u) => [u.unitCode, { ...u, rounds: [...(u.rounds || [])] }]));
  /** @type {Record<string, Record<number, {round:number,label:string,count:number}>>} */
  const counts = {};
  for (const q of batch.questions || []) {
    const code = q.unitCode;
    const round = q.source?.round || 1;
    if (!code) continue;
    if (!byCode[code]) {
      byCode[code] = { unitCode: code, name: q.unit || code, rounds: [] };
    } else if (q.unit) {
      byCode[code].name = q.unit;
    }
    if (!counts[code]) counts[code] = {};
    if (!counts[code][round]) {
      counts[code][round] = {
        round,
        label: q.source?.roundLabel || `第 ${round} 回`,
        count: 0,
      };
    }
    counts[code][round].count++;
  }
  for (const [code, roundsMap] of Object.entries(counts)) {
    const rounds = byCode[code].rounds || [];
    for (const entry of Object.values(roundsMap)) {
      const idx = rounds.findIndex((r) => r.round === entry.round);
      if (idx >= 0) rounds[idx] = entry;
      else rounds.push(entry);
    }
    byCode[code].rounds = rounds.sort((a, b) => a.round - b.round);
  }
  return Object.values(byCode);
}

/**
 * @param {HTMLElement} mount
 * @param {object} ctx
 */
export async function renderImport(mount, ctx) {
  if (!ctx.isAdmin) {
    mount.innerHTML = `<p class="e2">只有管理者可以匯入題目。</p>`;
    return;
  }

  let existingIds = await loadExistingIds(ctx);
  /** @type {any} */
  let state =
    readDraft() || {
      step: 1,
      batch: null,
      validation: null,
      selectedId: null,
      tab: 'all',
      dismissed: {},
      batchAck: false,
      reportFocus: null,
    };

  const saveState = () => writeDraft(state, ctx.toast);

  function revalidate() {
    state.validation = validateBatch(state.batch, { existingIds });
  }

  function undismissedFlags(qid) {
    return (state.validation?.flags?.[qid] || []).filter((f) => !state.dismissed[`${qid}:${f}`]);
  }

  function canConfirmQuestion(q) {
    return undismissedFlags(q.id).length === 0;
  }

  function batchGateOk() {
    if (!state.validation?.batchFlags?.length) return true;
    return !!state.batchAck;
  }

  async function parseInput(text) {
    const data = JSON.parse(text);
    existingIds = await loadExistingIds(ctx);
    const validation = validateBatch(data, { existingIds });
    state = {
      ...state,
      step: validation.schemaErrors?.length ? 1 : 2,
      batch: data,
      validation,
      selectedId: data.questions?.[0]?.id || null,
      batchAck: false,
      dismissed: {},
      reportFocus: null,
    };
    saveState();
    paint();
  }

  async function commitBatch() {
    if (!batchGateOk()) {
      ctx.toast?.('請先處理整批紅標（按「我知道了」）');
      return;
    }
    const checked = state.batch.questions.filter((q) => q.review?.status === 'checked');
    if (!checked.length) {
      ctx.toast?.('沒有已確認的題目可存入');
      return;
    }
    const { db, fs } = await ensureFb(ctx);
    const book = state.batch.book;
    const bookRef = fs.doc(db, 'banks', book.bookId);
    const bookSnap = await fs.getDoc(bookRef);
    const prevIds = new Set(bookSnap.data()?.questionIds || []);
    checked.forEach((q) => prevIds.add(q.id));
    const mergedUnits = mergeBankUnits(bookSnap.data(), {
      questions: checked,
    });

    const CHUNK = 400;
    let saved = 0;
    for (let offset = 0; offset < checked.length; offset += CHUNK) {
      const slice = checked.slice(offset, offset + CHUNK);
      const wb = fs.writeBatch(db);
      if (offset === 0) {
        wb.set(
          bookRef,
          {
            title: book.title,
            subject: book.subject,
            grade: book.grade,
            edition: book.edition || '',
            units: mergedUnits,
            questionIds: [...prevIds],
            updatedAt: fs.serverTimestamp(),
          },
          { merge: true },
        );
        for (const g of state.batch.groups || []) {
          wb.set(fs.doc(db, 'groups', g.groupId), {
            ...g,
            bookId: book.bookId,
            updatedAt: fs.serverTimestamp(),
          });
        }
      } else {
        wb.set(
          bookRef,
          { questionIds: [...prevIds], units: mergedUnits, updatedAt: fs.serverTimestamp() },
          { merge: true },
        );
      }
      for (const q of slice) {
        const roundKey = `${book.bookId}|${q.unitCode}|${q.source.round}`;
        wb.set(fs.doc(db, 'questions', q.id), {
          ...q,
          bookId: book.bookId,
          round: q.source.round,
          roundKey,
          importBatch: state.batch.batch.batchId,
          updatedAt: fs.serverTimestamp(),
          review: {
            ...q.review,
            status: 'checked',
            checkedBy: ctx.user.email,
            checkedAt: new Date().toISOString(),
          },
        });
      }
      await wb.commit();
      saved += slice.length;
    }

    const left = state.batch.questions.filter((q) => q.review?.status !== 'checked');
    ctx.toast?.(`已存入 ${saved} 題${left.length ? `，${left.length} 題留在草稿` : ''}`);
    if (left.length) {
      state.batch.questions = left;
      state.batch.batch.expectedCount = left.length;
      revalidate();
      state.step = 2;
      state.selectedId = left[0]?.id || null;
    } else {
      state.step = 1;
      state.batch = null;
      state.validation = null;
    }
    existingIds = await loadExistingIds(ctx);
    saveState();
    paint();
  }

  function paintEditor(q) {
    if (!q) return '<p class="mute">選一題預覽</p>';
    const flags = undismissedFlags(q.id);
    const cover = existingIds.has(q.id)
      ? '<span class="l3">將覆蓋</span>'
      : '';
    const optsFields = (q.options || [])
      .map(
        (o, i) =>
          `<label class="i1">選項 ${'ABCD'[i]}<input type="text" data-opt="${i}" value="${escHtml(o)}"></label>`,
      )
      .join('');
    return `<div class="import-editor" data-qid="${escHtml(q.id)}">
      ${cover}
      ${flags
        .map(
          (f) =>
            `<span class="l2 bad flag" data-flag="${escHtml(f)}">${escHtml(f)} <button type="button" class="btn b5 dismiss-flag">我看過了</button></span>`,
        )
        .join('')}
      ${(q.extract?.uncertain || [])
        .map((u) => `<p class="uncertain">待確認：${escHtml(u)}</p>`)
        .join('')}
      <label class="i1">題幹<textarea data-field="stem" rows="3">${escHtml(q.stem)}</textarea></label>
      ${optsFields}
      <label class="i1">正解
        <select data-field="answer">
          ${[0, 1, 2, 3]
            .map(
              (i) =>
                `<option value="${i}"${q.answer === i ? ' selected' : ''}>${'ABCD'[i]}</option>`,
            )
            .join('')}
        </select>
      </label>
      <label class="i1">詳解<textarea data-field="explain" rows="4">${escHtml(q.explain)}</textarea></label>
      <div class="preview" data-el="preview">${groupPassageHtml(
        state.batch.groups?.find((g) => g.groupId === q.groupId) || null,
        { collapsed: false },
      )}${stemHtml(q)}${optionsHtml(q, null, { revealed: false, mode: 'instant' })}</div>
      <button type="button" class="btn b2" data-act="confirm-q"${
        flags.length ? ' disabled' : ''
      }>這題確認</button>
      <button type="button" class="btn b5" data-act="delete-q">刪題</button>
      <label>換圖<input type="file" accept="image/*" id="fig-file"></label>
    </div>`;
  }

  function refreshPreviewOnly() {
    const q = state.batch?.questions?.find((x) => x.id === state.selectedId);
    const preview = mount.querySelector('[data-el="preview"]');
    if (!q || !preview) return;
    preview.innerHTML = `${groupPassageHtml(
      state.batch.groups?.find((g) => g.groupId === q.groupId) || null,
      { collapsed: false },
    )}${stemHtml(q)}${optionsHtml(q, null, { revealed: false, mode: 'instant' })}`;
    renderMath(preview);
    const confirmBtn = mount.querySelector('[data-act="confirm-q"]');
    if (confirmBtn) confirmBtn.disabled = !canConfirmQuestion(q);
  }

  function bindEditorEvents() {
    const editor = mount.querySelector('.import-editor');
    if (!editor) return;

    const onField = (el) => {
      const q = state.batch.questions.find((x) => x.id === state.selectedId);
      if (!q) return;
      if (el.dataset.field === 'answer') q.answer = Number(el.value);
      else if (el.dataset.field) q[el.dataset.field] = el.value;
      else if (el.dataset.opt != null) {
        q.options[+el.dataset.opt] = el.value;
      }
      revalidate();
      saveState();
      // 更新旗標列但不重繪 textarea（避免失焦）
      const flagHost = editor;
      flagHost.querySelectorAll('.flag').forEach((n) => n.remove());
      const flags = undismissedFlags(q.id);
      flags
        .slice()
        .reverse()
        .forEach((f) => {
          const span = document.createElement('span');
          span.className = 'l2 bad flag';
          span.dataset.flag = f;
          span.innerHTML = `${escHtml(f)} <button type="button" class="btn b5 dismiss-flag">我看過了</button>`;
          flagHost.insertBefore(span, flagHost.firstChild?.nextSibling || flagHost.firstChild);
          span.querySelector('.dismiss-flag')?.addEventListener('click', (ev) => {
            ev.stopPropagation();
            state.dismissed[`${state.selectedId}:${f}`] = true;
            saveState();
            paint();
          });
        });
      refreshPreviewOnly();
    };

    editor.querySelectorAll('[data-field], [data-opt]').forEach((el) => {
      el.addEventListener('input', () => onField(el));
      el.addEventListener('change', () => onField(el));
    });

    editor.querySelector('[data-act="confirm-q"]')?.addEventListener('click', () => {
      const q = state.batch.questions.find((x) => x.id === state.selectedId);
      if (!q || !canConfirmQuestion(q)) return;
      q.review = { ...(q.review || {}), status: 'checked', flags: [] };
      revalidate();
      saveState();
      paint();
    });

    editor.querySelector('[data-act="delete-q"]')?.addEventListener('click', () => {
      if (!confirm('確定要從這批移除這題？')) return;
      state.batch.questions = state.batch.questions.filter((x) => x.id !== state.selectedId);
      state.selectedId = state.batch.questions[0]?.id || null;
      revalidate();
      saveState();
      paint();
    });

    editor.querySelectorAll('.dismiss-flag').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const flag = btn.closest('.flag')?.dataset.flag;
        if (flag) state.dismissed[`${state.selectedId}:${flag}`] = true;
        saveState();
        paint();
      });
    });

    editor.querySelector('#fig-file')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      const q = state.batch.questions.find((x) => x.id === state.selectedId);
      if (!file || !q) return;
      try {
        const src = await fileToWebp(file);
        q.figures = [
          {
            id: 'fig1',
            src,
            alt: q.figures?.[0]?.alt || '題目附圖，請補充描述至少四字。',
          },
        ];
        revalidate();
        saveState();
        paint();
      } catch {
        ctx.toast?.('圖片處理失敗');
      }
    });
  }

  async function paintReports() {
    const reports = await loadOpenReports(ctx);
    return reports
      .map(
        (row) => `<button type="button" class="import-row" data-report="${escHtml(row.id)}" data-qid="${escHtml(row.qid)}">
          <span>${escHtml(row.qid)}</span>
          <span class="l3">${escHtml(row.reason)} · ${escHtml(row.note || '')}</span>
        </button>`,
      )
      .join('') || '<p class="mute">目前沒有未處理回報</p>';
  }

  async function paint() {
    const step = state.step;
    const checkedN = state.batch?.questions?.filter((q) => q.review?.status === 'checked').length || 0;
    const unflagged = (state.batch?.questions || []).filter(
      (q) => !(state.validation?.flags?.[q.id] || []).length && q.review?.status !== 'checked',
    );
    // 回報分頁一律可見（即使尚未選檔）
    if (!state.batch && state.tab === 'reports') {
      /* keep */
    } else if (!state.batch) {
      state.tab = state.tab === 'reports' ? 'reports' : 'all';
    }

    const listHtml =
      state.tab === 'reports'
        ? await paintReports()
        : state.batch
          ? state.batch.questions
              .filter((row) => {
                const flags = state.validation?.flags?.[row.id] || [];
                if (state.tab === 'flagged') return flags.length > 0;
                if (state.tab === 'checked') return row.review?.status === 'checked';
                return true;
              })
              .map((row) => {
                const flags = state.validation?.flags?.[row.id] || [];
                const cover = existingIds.has(row.id) ? '<span class="l3">將覆蓋</span>' : '';
                return `<button type="button" class="import-row${state.selectedId === row.id ? ' sel' : ''}" data-qid="${escHtml(row.id)}">
                <span>${escHtml(row.id)}</span>${cover}${
                  flags.length ? `<span class="l3">${flags.join(',')}</span>` : ''
                }
              </button>`;
              })
              .join('')
          : '<p class="mute">先選擇或貼上 JSON</p>';

    const previewHtml =
      state.tab === 'reports' && state.reportFocus && state.batch
        ? `${paintEditor(state.batch.questions.find((q) => q.id === state.reportFocus.qid))}
           <div class="report-actions">
             <button type="button" class="btn b1" id="report-save">存這題</button>
             <button type="button" class="btn b2" id="report-skip">不用改</button>
           </div>`
        : state.batch
          ? paintEditor(state.batch.questions.find((q) => q.id === state.selectedId))
          : '';

    mount.innerHTML = `<div class="page import">
      <ol class="p3 steps"><li class="${step >= 1 ? 'on' : ''}">① 選檔</li><li class="${step >= 2 ? 'on' : ''}">② 紅標</li><li class="${step >= 3 ? 'on' : ''}">③ 預覽</li></ol>
      <div class="tabs g2">
        <button type="button" data-tab="all" class="${state.tab === 'all' ? 'on' : ''}">全部</button>
        <button type="button" data-tab="flagged" class="${state.tab === 'flagged' ? 'on' : ''}">紅標</button>
        <button type="button" data-tab="checked" class="${state.tab === 'checked' ? 'on' : ''}">已確認</button>
        <button type="button" data-tab="reports" class="${state.tab === 'reports' ? 'on' : ''}">回報</button>
      </div>
      ${
        state.tab !== 'reports' && step === 1
          ? `<div class="import-step">
        <label class="btn b2">選擇 JSON 檔<input type="file" accept=".json,application/json" hidden id="import-file"></label>
        <label class="i1">或貼上 JSON<textarea id="import-paste" rows="6"></textarea></label>
        <button type="button" class="btn b1" id="import-parse">解析</button>
        ${
          state.validation?.schemaErrors?.length
            ? `<ul class="err">${state.validation.schemaErrors.map((e) => `<li>${escHtml(e)}</li>`).join('')}</ul>`
            : ''
        }
      </div>`
          : ''
      }
      ${
        state.tab === 'reports' || (step >= 2 && state.batch)
          ? `<div class="import-work">
        ${
          state.validation?.batchFlags?.length && state.tab !== 'reports'
            ? `<p class="banner">${state.validation.batchFlags.map(escHtml).join('；')}
                ${
                  state.batchAck
                    ? '（已確認）'
                    : `<button type="button" class="btn b2" id="batch-ack">我知道了</button>`
                }</p>`
            : ''
        }
        <div class="import-split">
          <div class="import-list t3">${listHtml}</div>
          <div class="import-preview">${previewHtml}</div>
        </div>
        ${
          state.tab !== 'reports' && state.batch
            ? `<footer class="dock">
          <button type="button" class="btn b2" id="confirm-unflagged"${
            unflagged.length ? '' : ' disabled'
          }>確認所有無旗標題目（${unflagged.length}）</button>
          <button type="button" class="btn b1" id="import-save"${
            !checkedN || !batchGateOk() ? ' disabled' : ''
          }>存入 ${checkedN} 題</button>
        </footer>`
            : ''
        }
      </div>`
          : ''
      }
    </div>`;

    mount.querySelector('#import-file')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      await parseInput(await file.text());
    });
    mount.querySelector('#import-parse')?.addEventListener('click', async () => {
      const text = mount.querySelector('#import-paste')?.value || '';
      try {
        await parseInput(text);
      } catch {
        ctx.toast?.('JSON 格式錯誤');
      }
    });
    mount.querySelector('#import-save')?.addEventListener('click', () => commitBatch());
    mount.querySelector('#batch-ack')?.addEventListener('click', () => {
      state.batchAck = true;
      saveState();
      paint();
    });
    mount.querySelector('#confirm-unflagged')?.addEventListener('click', () => {
      for (const q of state.batch.questions) {
        if (!(state.validation?.flags?.[q.id] || []).length) {
          q.review = { ...(q.review || {}), status: 'checked' };
        }
      }
      saveState();
      paint();
    });
    mount.querySelectorAll('.import-row[data-qid]').forEach((row) => {
      row.addEventListener('click', async () => {
        state.selectedId = row.dataset.qid;
        state.step = Math.max(state.step, 2);
        if (row.dataset.report) {
          state.tab = 'reports';
          state.reportFocus = { id: row.dataset.report, qid: row.dataset.qid };
          if (!state.batch) {
            state.batch = {
              schemaVersion: 1,
              batch: { batchId: 'report-fix', expectedCount: 0 },
              book: { bookId: 'tmp', title: '', subject: 'math', grade: '' },
              groups: [],
              questions: [],
            };
            state.validation = validateBatch(state.batch, { existingIds });
          }
          // 若題不在本批，從雲端載入
          if (!state.batch.questions.some((q) => q.id === row.dataset.qid)) {
            const { db, fs } = await ensureFb(ctx);
            const snap = await fs.getDoc(fs.doc(db, 'questions', row.dataset.qid));
            if (snap.exists()) {
              state.batch.questions.push(snap.data());
              revalidate();
            }
          }
        } else {
          state.reportFocus = null;
        }
        saveState();
        paint();
      });
    });
    mount.querySelectorAll('[data-tab]').forEach((tab) => {
      tab.addEventListener('click', () => {
        state.tab = tab.dataset.tab;
        state.reportFocus = null;
        saveState();
        paint();
      });
    });
    mount.querySelector('#report-save')?.addEventListener('click', async () => {
      const q = state.batch.questions.find((x) => x.id === state.reportFocus?.qid);
      if (!q || !state.reportFocus) return;
      const { db, fs } = await ensureFb(ctx);
      await fs.setDoc(
        fs.doc(db, 'questions', q.id),
        {
          ...q,
          updatedAt: fs.serverTimestamp(),
          review: {
            ...q.review,
            status: 'checked',
            checkedBy: ctx.user.email,
            checkedAt: new Date().toISOString(),
          },
        },
        { merge: true },
      );
      await fs.updateDoc(fs.doc(db, 'reports', state.reportFocus.id), { status: 'done' });
      ctx.toast?.('已存這題並標記回報完成');
      state.reportFocus = null;
      paint();
    });
    mount.querySelector('#report-skip')?.addEventListener('click', async () => {
      if (!state.reportFocus) return;
      const { db, fs } = await ensureFb(ctx);
      await fs.updateDoc(fs.doc(db, 'reports', state.reportFocus.id), { status: 'done' });
      ctx.toast?.('已標記不用改');
      state.reportFocus = null;
      paint();
    });

    bindEditorEvents();
    renderMath(mount);
  }

  await paint();
}

export { DRAFT_KEY, loadExistingIds };
