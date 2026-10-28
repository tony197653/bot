/** Card face / back DOM helpers (SVG suits). */

const SUIT_PATH = {
  0: // club
    'M12 2.5a4.6 4.6 0 0 0-4.3 6.2A4.6 4.6 0 1 0 10.6 17c-.3 1.9-1.2 3.4-2.6 5h8c-1.4-1.6-2.3-3.1-2.6-5a4.6 4.6 0 1 0 2.9-8.3A4.6 4.6 0 0 0 12 2.5z',
  1: // diamond
    'M12 1.8 20 12l-8 10.2L4 12z',
  2: // heart
    'M12 21.5C6.2 16.6 2.5 13.3 2.5 9A4.8 4.8 0 0 1 12 6.6 4.8 4.8 0 0 1 21.5 9c0 4.3-3.7 7.6-9.5 12.5z',
  3: // spade
    'M12 2C9 6.5 3 9.6 3 14a4.5 4.5 0 0 0 7.6 3.2c-.3 1.9-1.1 3.3-2.6 4.8h8c-1.5-1.5-2.3-2.9-2.6-4.8A4.5 4.5 0 0 0 21 14c0-4.4-6-7.5-9-12z',
};

const RANK_SHOW = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};

const SUIT_ZH = ['梅花', '方塊', '紅心', '黑桃'];

function svgIcon(path, cls) {
  return `<span class="${cls}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg></span>`;
}

/**
 * @param {{r:number,s:number}} card
 * @param {{hero?:boolean, anim?:boolean}} [opts]
 */
export function cardHtml(card, opts = {}) {
  const red = card.s === 1 || card.s === 2;
  const cls = ['card', red ? 'red' : 'blk', opts.hero ? 'hero' : '', opts.anim ? (opts.hero ? 'hero-deal' : 'is-deal') : '']
    .filter(Boolean)
    .join(' ');
  const label = `${SUIT_ZH[card.s]} ${RANK_SHOW[card.r]}`;
  const path = SUIT_PATH[card.s];
  return `<div class="${cls}" role="img" aria-label="${label}"><span class="rk">${RANK_SHOW[card.r] === '10' ? '10' : RANK_SHOW[card.r]}</span>${svgIcon(path, 'sm')}${svgIcon(path, 'big')}</div>`;
}

/** Small opponent card-back pair (seat rail). */
export function cardBackPair() {
  return `<div class="backs"><i class="is-pending"></i><i class="is-pending"></i></div>`;
}

/**
 * Hero-sized face-down hole cards (no face DOM — privacy until 換人 confirm).
 * @param {{ pending?: boolean }} [opts]
 */
export function heroBackPair(opts = {}) {
  const pend = opts.pending !== false ? ' is-pending' : '';
  return (
    `<div class="card hero is-back${pend}" aria-hidden="true"></div>` +
    `<div class="card hero is-back${pend}" aria-hidden="true"></div>`
  );
}

/**
 * Face markup only (no outer .card) for 3D flip front face.
 * @param {{r:number,s:number}} card
 */
export function cardFaceInner(card) {
  const red = card.s === 1 || card.s === 2;
  const path = SUIT_PATH[card.s];
  const rk = RANK_SHOW[card.r] === '10' ? '10' : RANK_SHOW[card.r];
  return `<span class="rk">${rk}</span>${svgIcon(path, 'sm')}${svgIcon(path, 'big')}` +
    `<span class="sr-only">${SUIT_ZH[card.s]} ${rk}</span>`;
}

export function fmtChips(n) {
  return Number(n).toLocaleString('zh-TW');
}
