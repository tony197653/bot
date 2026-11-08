/** Styled in-app confirm using existing .screen/.sheet/.actions styles; replaces the browser-native dialog. */
export function styledConfirm({ title, okText = '確認', cancelText = '取消' }) {
  return new Promise((resolve) => {
    document.getElementById('appConfirm')?.remove();
    const el = document.createElement('div');
    el.id = 'appConfirm';
    el.className = 'screen';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'appConfirmT');
    el.innerHTML = `<div class="sheet"><h2 id="appConfirmT"></h2><div class="actions">
      <button type="button" class="primary" id="appConfirmOk"></button>
      <button type="button" id="appConfirmCancel"></button></div></div>`;
    el.querySelector('#appConfirmT').textContent = title;
    el.querySelector('#appConfirmOk').textContent = okText;
    el.querySelector('#appConfirmCancel').textContent = cancelText;
    document.body.appendChild(el);
    const done = (v) => {
      el.classList.remove('is-on');
      document.removeEventListener('keydown', onKey);
      setTimeout(() => el.remove(), 350);
      resolve(v);
    };
    const onKey = (e) => { if (e.key === 'Escape') done(false); };
    document.addEventListener('keydown', onKey);
    el.querySelector('#appConfirmOk').addEventListener('click', () => done(true));
    el.querySelector('#appConfirmCancel').addEventListener('click', () => done(false));
    requestAnimationFrame(() => { el.classList.add('is-on'); el.querySelector('#appConfirmCancel').focus(); });
  });
}
