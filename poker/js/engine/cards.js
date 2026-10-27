/** @typedef {{ r: number, s: number }} Card */
/** ranks: 2..14 (T=10,J=11,Q=12,K=13,A=14); suits: 0=c,1=d,2=h,3=s */

export const RANK_CHARS = '23456789TJQKA';
export const SUIT_CHARS = 'cdhs';
export const SUIT_NAMES_ZH = ['梅花', '方塊', '紅心', '黑桃'];
export const RANK_LABELS = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};

/** @returns {Card[]} */
export function makeDeck() {
  /** @type {Card[]} */
  const deck = [];
  for (let s = 0; s < 4; s++) {
    for (let r = 2; r <= 14; r++) deck.push({ r, s });
  }
  return deck;
}

/** @param {Card} c */
export function cardKey(c) {
  return RANK_LABELS[c.r] + SUIT_CHARS[c.s];
}

/** @param {string} key */
export function parseCard(key) {
  if (typeof key !== 'string' || key.length < 2) throw new Error('無效牌面: ' + key);
  const rs = key.slice(0, -1).toUpperCase();
  const ss = key.slice(-1).toLowerCase();
  const r = RANK_CHARS.indexOf(rs === '10' ? 'T' : rs);
  const s = SUIT_CHARS.indexOf(ss);
  if (r < 0 || s < 0) throw new Error('無效牌面: ' + key);
  return { r: r + 2, s };
}

/** @param {Card|string} c */
export function asCard(c) {
  return typeof c === 'string' ? parseCard(c) : c;
}

/** @param {Card} c */
export function isRed(c) {
  return c.s === 1 || c.s === 2;
}

/** @param {(Card|string)[]} cards */
export function cloneCards(cards) {
  return cards.map((c) => {
    const x = asCard(c);
    return { r: x.r, s: x.s };
  });
}

/** Deep-clone any JSON-serializable value */
export function cloneJson(v) {
  return JSON.parse(JSON.stringify(v));
}
