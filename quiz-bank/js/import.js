/**
 * 匯入校對（管理者）：三步驟、紅標、預覽、writeBatch 存入、回報分頁。
 */
import { validateBatch, collectFlags, figureByteSize } from './schema.js';
import { escHtml, renderMath, stemHtml, optionsHtml, groupPassageHtml } from './render.js';

const DRAFT_KEY = 'quizbank:v1:importDraft';

function readDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeDraft(d) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch {
    /* ignore */
  }
}

async function ensureFb(ctx) {
  if (ctx.fb) return ctx.fb;
  const { initFirebase } = await import('./fb.js');
  ctx.fb = await initFirebase();
  return ctx.fb;
}

async function loadExistingIds(ctx) {
  const { db, fs } = await ensureFb(ctx);
  const snap = await fs.getDocs(fs.collection(db, 'questions'));
  return new Set(snap.docs.map((d) => d.id));
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
      const ctx2 = canvas.getContext('2d');
      ctx2.drawImage(img, 0, 0, w, h);
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

function mergeBankUnits(existing, batch) {
  const units = [...(existing?.units || [])];
  const byCode = Object.fromEntries(units.map((u) => [u.unitCode, u]));
  const unitCode = batch.questions[0]?.unitCode;
  const unitName = batch.questions[0]?.unit;
  const round = batch.questions[0]?.source?.round || 1;
  const count = batch.questions.length;
  if (!unitCode) return units;
  if (!byCode[unitCode]) {
    byCode[unitCode] = { unitCode, name: unitName || unitCode, rounds: [] };
  }
  const rounds = byCode[unitCode].rounds || [];
  const idx = rounds.findIndex((r) => r.round === round);
  const entry = { round, label: batch.questions[0]?.source?.roundLabel || `第 ${round} 回`, count };
  if (idx >= 0) rounds[idx] = entry;
  else rounds.push(entry);
  byCode[unitCode].rounds = rounds.sort((a, b) => a.round - b.round);
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

  /** @type {{step:number,batch:any,validation:any,selectedId:string|null,tab:string,dismissed:Record<string,boolean>}} */
  let state = readDraft() || { step: 1, batch: null, validation: null, selectedId: null, tab: 'all', dismissed: {} };

  const saveState = () => writeDraft(state);

  async function parseInput(text) {
    const data = JSON.parse(text);
    const existingIds = await loadExistingIds(ctx);
    const validation = validateBatch(data, { existingIds });
    state = { ...state, step: validation.schemaErrors?.length ? 1 : 2, batch: data, validation, selectedId: data.questions?.[0]?.id || null };
    saveState();
    paint();
  }

  async function commitBatch() {
    const checked = state.batch.questions.filter((q) => q.review?.status === 'checked');
    if (!checked.length) {
      ctx.toast?.('沒有已確認的題目可存入');
      return;
    }
    const { db, fs } = await ensureFb(ctx);
    const book = state.batch.book;
    const bookRef = fs.doc(db, 'banks', book.bookId);
    const bookSnap = await fs.getDoc(bookRef);
    const mergedUnits = mergeBankUnits(bookSnap.data(), state.batch);
    const batch = fs.writeBatch(db);
    batch.set(
      bookRef,
      {
        title: book.title,
        subject: book.subject,
        grade: book.grade,
        edition: book.edition || '',
        units: mergedUnits,
        updatedAt: fs.serverTimestamp(),
      },
      { merge: true },
    );
    for (const g of state.batch.groups || []) {
      batch.set(fs.doc(db, 'groups', g.groupId), { ...g, bookId: book.bookId, updatedAt: fs.serverTimestamp() });
    }
    let n = 0;
    for (const q of checked) {
      const roundKey = `${book.bookId}|${q.unitCode}|${q.source.round}`;
      batch.set(fs.doc(db, 'questions', q.id), {
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
      n++;
      if (n >= 400) break;
    }
    await batch.commit();
    ctx.toast?.(`已存入 ${n} 題`);
    state.step = 1;
    state.batch = null;
    saveState();
    paint();
  }

  function paintEditor(q) {
    if (!q) return '<p class="mute">選一題預覽</p>';
    const flags = (state.validation?.flags?.[q.id] || []).filter((f) => !state.dismissed[`${q.id}:${f}`]);
    return `<div class="import-editor">
      ${flags.map((f) => `<span class="l2 bad flag" data-flag="${escHtml(f)}">${escHtml(f)} <button type="button" class="btn b5 dismiss-flag">我看過了</button></span>`).join('')}
      <label class="i1">題幹<textarea data-field="stem" rows="3">${escHtml(q.stem)}</textarea></label>
      <label class="i1">詳解<textarea data-field="explain" rows="4">${escHtml(q.explain)}</textarea></label>
      <div class="preview">${groupPassageHtml(state.batch.groups?.find((g) => g.groupId === q.groupId) || null, { collapsed: false })}
        ${stemHtml(q)}${optionsHtml(q, null, { revealed: false, mode: 'instant' })}</div>
      <button type="button" class="btn b2" data-act="confirm-q"${flags.length ? ' disabled' : ''}>這題確認</button>
      <label>換圖<input type="file" accept="image/*" id="fig-file"></label>
    </div>`;
  }

  async function paint() {
    const step = state.step;
    mount.innerHTML = `<div class="page import">
      <ol class="p3 steps"><li class="${step >= 1 ? 'on' : ''}">① 選檔</li><li class="${step >= 2 ? 'on' : ''}">② 紅標</li><li class="${step >= 3 ? 'on' : ''}">③ 預覽</li></ol>
      ${step === 1 ? `<div class="import-step">
        <label class="btn b2">選擇 JSON 檔<input type="file" accept=".json,application/json" hidden id="import-file"></label>
        <label class="i1">或貼上 JSON<textarea id="import-paste" rows="6"></textarea></label>
        <button type="button" class="btn b1" id="import-parse">解析</button>
        ${state.validation?.schemaErrors?.length ? `<ul class="err">${state.validation.schemaErrors.map((e) => `<li>${escHtml(e)}</li>`).join('')}</ul>` : ''}
      </div>` : ''}
      ${step >= 2 && state.batch ? `<div class="import-work">
        ${state.validation?.batchFlags?.length ? `<p class="banner">${state.validation.batchFlags.map(escHtml).join('；')}</p>` : ''}
        <div class="tabs g2">
          <button type="button" data-tab="all" class="${state.tab === 'all' ? 'on' : ''}">全部</button>
          <button type="button" data-tab="flagged" class="${state.tab === 'flagged' ? 'on' : ''}">紅標</button>
          <button type="button" data-tab="checked" class="${state.tab === 'checked' ? 'on' : ''}">已確認</button>
          <button type="button" data-tab="reports" class="${state.tab === 'reports' ? 'on' : ''}">回報</button>
        </div>
        <div class="import-split">
          <div class="import-list t3">${(state.tab === 'reports' ? (await loadOpenReports(ctx)) : state.batch.questions)
            .filter((row) => {
              if (state.tab === 'reports') return true;
              const flags = state.validation.flags[row.id] || [];
              if (state.tab === 'flagged') return flags.length > 0;
              if (state.tab === 'checked') return row.review?.status === 'checked';
              return true;
            })
            .map((row) => {
              const id = row.qid || row.id;
              const flags = state.validation?.flags?.[id] || [];
              return `<button type="button" class="import-row${state.selectedId === id ? ' sel' : ''}" data-qid="${escHtml(id)}">
                <span>${escHtml(id)}</span>${flags.length ? `<span class="l3">${flags.join(',')}</span>` : ''}
              </button>`;
            })
            .join('')}</div>
          <div class="import-preview">${paintEditor(state.batch.questions.find((q) => q.id === state.selectedId))}</div>
        </div>
        <footer class="dock"><button type="button" class="btn b1" id="import-save">存入 ${state.batch.questions.filter((q) => q.review?.status === 'checked').length} 題</button></footer>
      </div>` : ''}
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
    mount.querySelectorAll('.import-row').forEach((row) => {
      row.addEventListener('click', () => {
        state.selectedId = row.dataset.qid;
        state.step = 3;
        saveState();
        paint();
      });
    });
    mount.querySelectorAll('[data-tab]').forEach((tab) => {
      tab.addEventListener('click', () => {
        state.tab = tab.dataset.tab;
        saveState();
        paint();
      });
    });
    const editor = mount.querySelector('.import-editor');
    editor?.querySelectorAll('[data-field]').forEach((el) => {
      el.addEventListener('input', () => {
        const q = state.batch.questions.find((x) => x.id === state.selectedId);
        if (!q) return;
        q[el.dataset.field] = el.value;
        const existingIds = new Set();
        state.validation = validateBatch(state.batch, { existingIds });
        saveState();
        paint();
      });
    });
    editor?.querySelector('[data-act="confirm-q"]')?.addEventListener('click', () => {
      const q = state.batch.questions.find((x) => x.id === state.selectedId);
      if (!q) return;
      q.review = { ...(q.review || {}), status: 'checked' };
      saveState();
      paint();
    });
    editor?.querySelectorAll('.dismiss-flag').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const flag = btn.closest('.flag')?.dataset.flag;
        if (flag) state.dismissed[`${state.selectedId}:${flag}`] = true;
        saveState();
        paint();
      });
    });
    editor?.querySelector('#fig-file')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      const q = state.batch.questions.find((x) => x.id === state.selectedId);
      if (!file || !q) return;
      try {
        const src = await fileToWebp(file);
        q.figures = [{ id: 'fig1', src, alt: q.figures?.[0]?.alt || '題目附圖，請補充描述至少四字。' }];
        state.validation = validateBatch(state.batch, { existingIds: new Set() });
        saveState();
        paint();
      } catch {
        ctx.toast?.('圖片處理失敗');
      }
    });
    renderMath(mount);
  }

  await paint();
}

export { DRAFT_KEY };
