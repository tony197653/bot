/**
 * 站內確認對話框（取代 window.confirm）。
 * @param {{title?:string, message:string, okLabel?:string, cancelLabel?:string}} opts
 * @returns {Promise<boolean>}
 */
export function askConfirm(opts) {
  const title = opts.title || '請確認';
  const message = opts.message || '';
  const okLabel = opts.okLabel || '確定';
  const cancelLabel = opts.cancelLabel || '取消';
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'leave-dlg confirm-dlg';
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
}

function escapeText(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
