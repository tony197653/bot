/** Client admission policy; money still moves as one whole-bank buy-in. */
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

export function buyinLabel(player, roomId, session) {
  const amount = session?.buyIn ?? wholeBalance(player, roomId);
  const label = session ? '本次買入' : '整筆買入';
  return `${label} ${(Number(amount) || 0).toLocaleString('en-US')} 籌碼`;
}
