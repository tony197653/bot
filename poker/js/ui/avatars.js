const PRESET_BASE = 'https://tony-poker.web.app/friday-poker/assets/avatars/';

/** Picker backgrounds: 深藍, 淺藍, 紅. Same-colour keys stay together. */
export const AVATAR_BG = {
  deep: ['#5AB0FF', '#1F5FD6'],
  light: ['#D8F0FF', '#8EC4F8'],
  red: ['#FF5A62', '#C01828'],
};

export const AVATAR_PRESETS = [
  // 深藍
  ['cat', '貓'], ['cat-siamese', '暹羅貓'], ['cat-white', '白貓'], ['cat-calico', '三花貓'],
  ['dog', '狗'], ['rabbit', '兔子'], ['fish', '魚'],
  // 淺藍
  ['cat-gray', '灰貓'], ['bear', '熊'], ['panda', '貓熊'], ['fox', '狐狸'],
  ['lion', '獅子'], ['tiger', '老虎'], ['owl', '貓頭鷹'], ['frog', '青蛙'],
  // 紅
  ['spade', '黑桃'], ['heart', '紅心'], ['diamond', '方塊'], ['club', '梅花'],
].map(([key, label]) => ({ key, label }));

/** Removed from the picker; file kept so existing players still see their avatar. */
export const AVATAR_RETIRED = ['monkey'];

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
    const known = AVATAR_PRESETS.some((preset) => preset.key === key) || AVATAR_RETIRED.includes(key);
    return known ? key : null;
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
