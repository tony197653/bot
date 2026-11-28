/**
 * Copy shown in the action bar between hands.
 * First hand does not start automatically; only the host can press 開始第一手.
 */
export function guestWaitFirstHandHint({ isHost, mySeat, phase, handNo } = {}) {
  if (isHost) return '';
  if (mySeat == null || mySeat < 0) return '';
  if (phase === 'lobby' || !handNo) return '等房主按『開始第一手』';
  return '';
}
