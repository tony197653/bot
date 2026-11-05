/**
 * 站內確認對話框（取代 window.confirm）。
 * 同標題同時只會有一個；並發呼叫共用同一個 Promise（#22）。
 * @param {{title?:string, message:string, okLabel?:string, cancelLabel?:string}} opts
 * @returns {Promise<boolean>}
 */

/** @type {Map<string, Promise<boolean>>} */
const inflightByTitle = new Map();

export function askConfirm(opts) {
  const title = opts.title || '請確認';
  const message = opts.message || '';
  const okLabel = opts.okLabel || '確定';
  const cancelLabel = opts.cancelLabel || '取消';

  const existing = inflightByTitle.get(title);
  if (existing) return existing;

  const promise = new Promise((resolve) => {
    // 清掉殘留同標題 dialog（避免 DOM 疊層）
    document.querySelectorAll('dialog.confirm-dlg').forEach((d) => {
      if (d.dataset.confirmTitle === title) {
        try {
          d.close();
        } catch {
          /* ignore */
        }
        d.remove();
      }
    });

    const dlg = document.createElement('dialog');
    dlg.className = 'leave-dlg confirm-dlg';
    dlg.dataset.confirmTitle = title;
    dlg.setAttribute('aria-labelledby', 'confirm-dlg-title');
    dlg.innerHTML = `<form method="dialog" class="leave-form">
      <h2 id="confirm-dlg-title">${escapeText(title)}</h2>
      <p>${escapeText(message)}</p>
      <div class="leave-actions">
        <button type="submit" class="btn b2" value="cancel">${escapeText(cancelLabel)}</button>
        <button type="submit" class="btn b1" value="ok">${escapeText(okLabel)}</button>
      </div>
    </form>`;
    const finish = (ok) => {
      dlg.removeEventListener('close', onClose);
      dlg.remove();
      inflightByTitle.delete(title);
      resolve(ok);
    };
    const onClose = () => finish(false);
    dlg.addEventListener('close', onClose);
    dlg.addEventListener('submit', (e) => {
      e.preventDefault();
      const val = e.submitter?.value;
      dlg.removeEventListener('close', onClose);
      dlg.close();
      finish(val === 'ok');
    });
    document.body.appendChild(dlg);
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else finish(window.confirm(message));
  });

  inflightByTitle.set(title, promise);
  return promise;
}

function escapeText(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
