/** Client admission and chosen carry-in policy. */
export const DEFAULT_NEW_PLAYER_CHIPS = 2000;

/** 開房專用短提示；不改動入座規則。 */
export function canAffordBlinds(bank, bb) {
  return bank == null || bank >= 50 * bb;
}

export function createRoomBuyinError(chips, sb, bb, bank = null) {
  const fmt = n => n.toLocaleString('en-US');
  const minimum = 50 * bb;
  if (!canAffordBlinds(bank, bb)) return `帳戶 ${fmt(bank)}，${sb}/${bb} 至少要 ${fmt(minimum)}`;
  if (!Number.isSafeInteger(chips) || chips < 1000 || chips > 100000) return '攜入須為 1,000–100,000';
  if (chips % 500) return '攜入須為 500 的倍數';
  if (chips < minimum) return `${sb}/${bb} 至少要 ${fmt(minimum)}`;
  if (bank != null && chips > bank) return `帳戶只有 ${fmt(bank)}，請降低攜入`;
  return '';
}

export function defaultCreateBuyin(chips, bb, bank = null) {
  return canAffordBlinds(bank, bb) ? Math.max(chips, 50 * bb) : chips;
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
  return { min, max, step: (max - min) % config.bb === 0 ? config.bb : 1,
    amount: Math.max(min, Math.min(config.newPlayerChips ?? DEFAULT_NEW_PLAYER_CHIPS, max)) };
}

export function buyinLabel(player, roomId, session, config = { bb: 20, newPlayerChips: DEFAULT_NEW_PLAYER_CHIPS }) {
  const amount = session?.buyIn ?? (player?.tableRoomId === roomId ? player.inPlay
    : Math.min(player?.bank || 0, Math.max(50 * config.bb, config.newPlayerChips ?? DEFAULT_NEW_PLAYER_CHIPS)));
  return `${session ? '本次買入' : '攜入'} ${(Number(amount) || 0).toLocaleString('en-US')} 籌碼`;
}
