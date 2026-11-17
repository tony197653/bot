/** 玩家端加碼排隊：只寫自己的 pokerRooms/{roomId}/addons/{uid}，扣款由房主兩手之間處理。 */

/** 數量範圍：最少 1 大盲、最多帳戶減去已排隊；預設 50 大盲（不足就全部）。 */
export function addonOptions(bank, bb, queued = 0) {
  const max = Math.max(0, (Number(bank) || 0) - queued);
  if (!Number.isSafeInteger(bb) || bb <= 0 || max < bb) return null;
  return { min: bb, max, step: 1, amount: Math.min(50 * bb, max) };
}

export function queuedTotal(queue) {
  return (queue?.items || []).reduce((sum, item) => sum + (item.amount || 0), 0);
}

export async function queueAddon(fb, { uid, roomId, amount, id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` }) {
  const { db, fs } = fb;
  const ref = fs.doc(db, 'pokerRooms', roomId, 'addons', uid);
  return fs.runTransaction(db, async (tx) => {
    const cur = (await tx.get(ref)).data?.() || null;
    const items = [...(cur?.items || []), { id, amount }];
    if (items.length > 20) throw new Error('排隊太多筆，請等下一手');
    const next = { items, seq: (cur?.seq || 0) + 1, at: fs.serverTimestamp() };
    tx.set(ref, next);
    return next;
  });
}

/** 一顆鈕全部取消；房主已處理的不受影響（帳本已入帳）。 */
export async function cancelAddons(fb, { uid, roomId }) {
  const { db, fs } = fb;
  const ref = fs.doc(db, 'pokerRooms', roomId, 'addons', uid);
  return fs.runTransaction(db, async (tx) => {
    const cur = (await tx.get(ref)).data?.() || null;
    if (!cur?.items?.length) return cur;
    const next = { items: [], seq: (cur.seq || 0) + 1, at: fs.serverTimestamp() };
    tx.set(ref, next);
    return next;
  });
}
