import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statsView, personalStatsHtml, pct } from '../js/ui/personal-stats.js';
const agg = { validHands: 4, wonHands: 1, vpipOppHands: 4, vpipHands: 2, pfrOppHands: 0, pfrHands: 0, threeBetOppHands: 2, threeBetHands: 0, netChips: -1260 };
test('C1 view states per spec §2.3', () => {
  assert.equal(statsView(agg, { enabled: false }).state, 'disabled');
  assert.equal(statsView(null, { enabled: true }).state, 'missing');
  const v = statsView(agg, { enabled: true });
  assert.equal(v.win, 25); assert.equal(v.vpip, 50); assert.equal(v.pfr, null); assert.equal(v.tb, 0);
  assert.equal(pct(undefined, 3), null);
});
test('C1 html: other player has no 我的/本人 label, shows name; dash for unknown', () => {
  const h = personalStatsHtml({ name: '大雄', isMe: false, view: statsView(agg, { enabled: true }), chips: null });
  assert.match(h, /大雄/); assert.doesNotMatch(h, /我的|本人|（你）/);
  assert.match(h, /25\.0%/); assert.match(h, /−1,260/); assert.match(h, /ps-neg/); assert.match(h, /PFR —/);
  const me = personalStatsHtml({ name: '阿明', isMe: true, view: { state: 'error' } });
  assert.match(me, /統計讀取失敗，請重試/); assert.match(me, /data-ps="retry"/);
  assert.match(personalStatsHtml({ name: 'x', isMe: false, view: { state: 'disabled' } }), /尚未開始記錄/);
});
test('C1 html escapes names', () => {
  assert.doesNotMatch(personalStatsHtml({ name: '<img onerror=1>', isMe: false, view: { state: 'missing' } }), /<img onerror/);
});
import { cacheKey } from '../js/ui/personal-stats.js';
test('C3 offline cache key isolates viewer and target uid', () => {
  assert.notEqual(cacheKey('a', 'b'), cacheKey('b', 'a'));
  assert.notEqual(cacheKey('a', 'b'), cacheKey('a', 'c'));
});
import { shouldToastClosedFallback as f } from '../js/ui/personal-stats.js';
test('C6 closed-table fallback: toast only when no close-result card for that table, once', () => {
  const base = { fromRoom: 'r1', roomId: 'r1', status: 'playing', gone: false, cardShownFor: null, cardDismissedFor: null, toastedFor: null };
  assert.equal(f(base), false, 'still open → no toast');
  assert.equal(f({ ...base, fromRoom: null }), false, 'not opened from table');
  assert.equal(f({ ...base, gone: true }), true, 'room deleted/inaccessible, no card → toast');
  assert.equal(f({ ...base, status: 'closed' }), true, 'closed but card not shown → toast');
  assert.equal(f({ ...base, roomId: null }), true, 'room cleared → toast');
  assert.equal(f({ ...base, status: 'closed', cardShownFor: 'r1' }), false, 'same table card shown → dedup');
  assert.equal(f({ ...base, status: 'closed', cardDismissedFor: 'r1' }), false, 'same table card dismissed → dedup');
  assert.equal(f({ ...base, status: 'closed', cardShownFor: 'other' }), true, 'other table card does not suppress');
  assert.equal(f({ ...base, gone: true, toastedFor: 'r1' }), false, 'no repeat');
});

test('C7 ring track covers only the uncovered remainder (no overlap)', async () => {
  const { personalStatsHtml } = await import('../js/ui/personal-stats.js');
  const h = (vpip) => personalStatsHtml({ name: 'x', isMe: false, chips: 0, view: { state: 'ok', win: 0, hands: 1, net: 0, vpip, pfr: 0, tb: null } });
  const track = (html) => [...html.matchAll(/<circle[^>]*#4B505C[^>]*>/g)].map((m) => m[0]);
  const t = track(h(30));
  assert.ok(t.some((c) => c.includes('stroke-dasharray="70 30"') && c.includes('stroke-dashoffset="-30"') && c.includes('rotate(-90')));
  assert.ok(track(h(0)).some((c) => c.includes('stroke-dasharray="100 0"')));
  assert.equal(track(h(100)).length, track(h(0)).length - 1);
  assert.ok(!t.some((c) => !c.includes('pathLength="100"')));
});
