/** Client admission and chosen carry-in policy. */
export const DEFAULT_NEW_PLAYER_CHIPS = 2000;

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
    : Math.max(50 * config.bb, Math.min(config.newPlayerChips, player?.bank || 0)));
  return `${session ? '本次買入' : '攜入'} ${(Number(amount) || 0).toLocaleString('en-US')} 籌碼`;
}
