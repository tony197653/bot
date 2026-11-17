/** Client admission and chosen carry-in policy. */
// 預設盲注 10/20 的 50 大盲；其他盲注由 defaultCreateBuyin 計算。
export const DEFAULT_NEW_PLAYER_CHIPS = 1000;

/** 開房專用短提示；不改動入座規則。 */
export function canAffordBlinds(bank, bb) {
  return bank == null || bank >= 50 * bb;
}

export function createRoomBuyinError(chips, sb, bb, bank = null) {
  const fmt = n => n.toLocaleString('en-US');
  const minimum = 50 * bb;
  if (!canAffordBlinds(bank, bb)) return `帳戶 ${fmt(bank)}，${sb}/${bb} 至少要 ${fmt(minimum)}`;
  if (!Number.isSafeInteger(chips) || chips < minimum || chips > 100000) return `攜入須為 ${fmt(minimum)}–100,000`;
  if (bank != null && chips > bank) return `帳戶只有 ${fmt(bank)}，請降低攜入`;
  return '';
}

export function defaultCreateBuyin(chips, bb, bank = null) {
  // 換盲注時重設為 50 大盲，再受帳戶與 100,000 上限限制。
  return Math.min(50 * bb, 100000, bank ?? 100000);
}

export function wholeBalance(player, roomId) {
  return player?.tableRoomId === roomId ? player.inPlay : player?.bank;
}

export function assertMinimumBuyin(amount, bb) {
  if (!Number.isSafeInteger(bb) || bb <= 0) throw new Error('無法確認大盲，請稍後再試');
  const minimum = 50 * bb;
  if (!Number.isSafeInteger(amount) || amount < minimum) {
    throw new Error(`籌碼不足，入座至少需要 50 大盲（${minimum.toLocaleString('en-US')} 籌碼）；目前可帶入 ${(Number(amount) || 0).toLocaleString('en-US')} 籌碼。請選擇較低盲注的牌桌。`);
  }
  return amount;
}

export function buyinOptions(player, config) {
  const min = 50 * config.bb;
  const max = player?.bank || 0;
  assertMinimumBuyin(max, config.bb);
  return { min, max, step: 1,
    amount: Math.max(min, Math.min(config.newPlayerChips ?? DEFAULT_NEW_PLAYER_CHIPS, max)) };
}

export function buyinLabel(player, roomId, session, config = { bb: 20, newPlayerChips: DEFAULT_NEW_PLAYER_CHIPS }) {
  const amount = session?.buyIn ?? (player?.tableRoomId === roomId ? player.inPlay
    : Math.min(player?.bank || 0, Math.max(50 * config.bb, config.newPlayerChips ?? DEFAULT_NEW_PLAYER_CHIPS)));
  return `${session ? '本次買入' : '攜入'} ${(Number(amount) || 0).toLocaleString('en-US')} 籌碼`;
}

/** ＋每次增加 500，最後不足 500 時取剩餘全部；−從非 500 倍數回到上一檔 500。合法性仍由原面板驗證。 */
export function stepBuyinAmount(amount, direction, min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const n = Number(amount) || 0;
  if (direction > 0) {
    return Math.max(lo, Math.min(hi, n + 500));
  }
  const prev = n % 500 === 0 ? n - 500 : Math.floor(n / 500) * 500;
  return Math.max(lo, Math.min(hi, prev));
}

/** 面板上「帳戶」顯示的剩餘：總額減去目前攜入／加碼。無帳戶時回 null。 */
export function remainingBank(bank, amount) {
  if (bank == null || !Number.isFinite(Number(bank))) return null;
  return Math.max(0, Number(bank) - (Number(amount) || 0));
}
