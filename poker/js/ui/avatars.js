const PRESET_BASE = 'https://tony-poker.web.app/friday-poker/assets/avatars/';

export const AVATAR_PRESETS = [
  ['cat', '貓'], ['cat-gray', '灰貓'],
  ['cat-siamese', '暹羅貓'], ['cat-white', '白貓'], ['dog', '狗'], ['rabbit', '兔子'],
  ['bear', '熊'], ['panda', '貓熊'], ['fox', '狐狸'], ['lion', '獅子'], ['tiger', '老虎'],
  ['monkey', '猴子'], ['owl', '貓頭鷹'], ['frog', '青蛙'], ['fish', '魚'],
].map(([key, label]) => ({ key, label }));

export function presetUrl(key) {
  return `${PRESET_BASE}${key}.svg`;
}

export function presetKeyOf(url) {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.search || parsed.hash || !url.endsWith('.svg')) return null;
    const match = parsed.pathname.match(/\/friday-poker\/assets\/avatars\/([a-z-]+)\.svg$/);
    const key = match?.[1];
    return AVATAR_PRESETS.some((preset) => preset.key === key) ? key : null;
  } catch {
    return null;
  }
}

export function avatarSrc(url) {
  const key = presetKeyOf(url);
  if (key) return new URL(`../../assets/avatars/${key}.svg`, import.meta.url).href;
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return '';
  try {
    return new URL(url).protocol === 'https:' ? url : '';
  } catch {
    return '';
  }
}

const esc = (value) => String(value).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function avatarInnerHtml(url, name, { size }) {
  const initial = Array.from(name || '?')[0];
  const fallback = `<span class="av-fallback">${esc(initial)}</span>`;
  const src = avatarSrc(url);
  if (!src) return fallback;
  const onerror = `this.outerHTML=${JSON.stringify(fallback)}`;
  return `<img class="av-img" src="${esc(src)}" alt="" width="${esc(size)}" height="${esc(size)}" loading="lazy" onerror="${esc(onerror)}">`;
}
