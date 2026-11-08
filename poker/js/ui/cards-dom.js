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

/**
 * Approved #20 raise quick-pick grid markup (3×2).
 * Each button shows label + resulting raise-to amount underneath.
 * Selection is by preset id (not amount) so duplicate amounts do not multi-highlight.
 * Shared by solo openRaisePanel and MP openMpRaise so MP cannot silently drop presets.
 * @param {{ id: string, label: string, to: number }[]} presets
 * @param {string|null|undefined} selectedId pressed preset id, or null when slider/± drifted
 * @param {(n: number) => string} [format]
 */
export function raisePresetsMarkup(presets, selectedId, format = fmtChips) {
  const list = Array.isArray(presets) ? presets : [];
  return list
    .map(
      (p) =>
        `<button type="button" data-to="${p.to}" data-id="${p.id}" aria-pressed="${p.id === selectedId}">` +
        `<span class="preset-lbl">${p.label}</span>` +
        `<span class="preset-amt">${format(p.to)}</span></button>`,
    )
    .join('');
}

/**
 * Title + confirm + min hint share the same verb: opening bet → 下注, else 加注到.
 * @param {boolean} isBet true when currentBet===0 (opening bet / postflop no bet yet)
 * @param {number} amount raise-to (title/confirm) or min-to (minHint) depending on call site
 * @param {(n: number) => string} [format]
 */
export function raisePanelCopy(isBet, amount, format = fmtChips) {
  const n = format(amount);
  return {
    isBet: !!isBet,
    verb: isBet ? '下注' : '加注到',
    title: isBet ? `下注 ${n}` : `加注到 ${n}`,
    confirm: isBet ? `確認下注 ${n}` : `確認加注到 ${n}`,
    minHint: isBet ? `最少下注 ${n}` : `最少加到 ${n}`,
  };
}

/**
 * Markup for five fixed community-card slots (flop 1–3, turn 4, river 5).
 * Empty slots are invisible placeholders that reserve the river row width.
 * @param {{r:number,s:number}[]} cards
 * @param {{ anim?: boolean }} [opts]
 */
export function boardSlotsMarkup(cards, opts = {}) {
  const list = Array.isArray(cards) ? cards : [];
  let html = '';
  for (let i = 0; i < 5; i++) {
    const c = list[i];
    if (c) {
      html += `<div class="slot is-filled">${cardHtml(c, { anim: !!opts.anim })}</div>`;
    } else {
      html += `<div class="slot" aria-hidden="true"></div>`;
    }
  }
  return html;
}

/**
 * Paint #board with five fixed slots so dealt cards never recenter.
 * @param {HTMLElement|null} boardEl
 * @param {{r:number,s:number}[]} cards
 * @param {{ anim?: boolean, active?: boolean }} [opts]
 *   active=false clears the board (lobby / pre-first-hand).
 */
export function paintBoardSlots(boardEl, cards, opts = {}) {
  if (!boardEl) return;
  const list = Array.isArray(cards) ? cards : [];
  const active = opts.active === true || (opts.active !== false && list.length > 0);
  if (!active) {
    boardEl.innerHTML = '';
    return;
  }
  const needRebuild =
    boardEl.children.length !== 5 ||
    ![...boardEl.children].every((el) => el.classList?.contains('slot'));
  if (needRebuild) {
    boardEl.innerHTML = boardSlotsMarkup(list, opts);
    return;
  }
  for (let i = 0; i < 5; i++) {
    const slot = boardEl.children[i];
    const c = list[i];
    if (c) {
      if (!slot.classList.contains('is-filled')) {
        slot.classList.add('is-filled');
        slot.removeAttribute('aria-hidden');
        slot.innerHTML = cardHtml(c, { anim: !!opts.anim });
      }
      // Already filled: leave DOM alone so prior streets never remount/shift
    } else if (slot.classList.contains('is-filled')) {
      slot.classList.remove('is-filled');
      slot.setAttribute('aria-hidden', 'true');
      slot.innerHTML = '';
    }
  }
}
