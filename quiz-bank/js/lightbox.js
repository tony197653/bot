/**
 * 圖片放大檢視：Esc／關閉鈕／點背景關閉，焦點陷阱，手機可用。
 */

/** @type {HTMLElement|null} */
let active = null;

/** @type {WeakSet<EventTarget>} */
const boundRoots = new WeakSet();

let documentBound = false;

function trapFocus(e) {
  if (!active || e.key !== 'Tab') return;
  const focusables = active.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  );
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function onKey(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeLightbox();
  } else {
    trapFocus(e);
  }
}

function onLightboxClick(e) {
  const t = e.target;
  if (t?.dataset?.close === '1' || t?.closest?.('.lightbox-close')) closeLightbox();
}

/**
 * @param {string} src
 * @param {string} [alt]
 */
export function openLightbox(src, alt = '') {
  closeLightbox();
  const root = document.createElement('div');
  root.className = 'lightbox';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', '圖片放大');
  const safeAlt = String(alt).replace(/"/g, '&quot;');
  const safeSrc = String(src).replace(/"/g, '&quot;');
  root.innerHTML = `
    <div class="lightbox-backdrop" data-close="1" aria-hidden="true"></div>
    <div class="lightbox-panel">
      <button type="button" class="lightbox-close btn b2" aria-label="關閉">關閉</button>
      <img src="${safeSrc}" alt="${safeAlt}" decoding="async">
    </div>`;
  document.body.appendChild(root);
  document.body.classList.add('lightbox-open');
  active = root;
  const prev = document.activeElement;
  root._prevFocus = prev;
  root.querySelector('.lightbox-close')?.focus();
  root.addEventListener('click', onLightboxClick);
  document.addEventListener('keydown', onKey, true);
}

export function closeLightbox() {
  if (!active) return;
  const prev = active._prevFocus;
  active.removeEventListener('click', onLightboxClick);
  active.remove();
  active = null;
  document.body.classList.remove('lightbox-open');
  document.removeEventListener('keydown', onKey, true);
  if (prev && typeof prev.focus === 'function') {
    try {
      prev.focus();
    } catch {
      /* ignore */
    }
  }
}

function delegateOpen(e) {
  const btn = e.target.closest?.('.fig-zoom');
  if (!btn) return;
  e.preventDefault();
  openLightbox(btn.dataset.src || btn.querySelector('img')?.src || '', btn.dataset.alt || '');
}

/** 委派：點 .fig-zoom 開啟（每個 root 只綁一次） */
export function bindLightbox(root = document) {
  if (boundRoots.has(root)) return;
  boundRoots.add(root);
  root.addEventListener('click', delegateOpen);
}

/** 建議在 app 啟動時對 document 呼叫一次 */
export function bindLightboxOnce(root = document) {
  if (root === document && documentBound) return;
  if (root === document) documentBound = true;
  bindLightbox(root);
}
