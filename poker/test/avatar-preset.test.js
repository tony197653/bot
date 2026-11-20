import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AVATAR_PRESETS, avatarInnerHtml, avatarSrc, presetKeyOf, presetUrl } from '../js/ui/avatars.js';
import { avatarPickerHtml, openPersonalStats, personalStatsHtml } from '../js/ui/personal-stats.js';
import { profilePatch } from '../../lib/auth/auth.js';

const googlePhotoURL = 'https://lh3.googleusercontent.com/avatar';

test('15 個預設網址存正式位址，預覽與本機畫面使用同站資產', () => {
  assert.deepEqual(AVATAR_PRESETS.map(({ key }) => key), [
    'cat', 'cat-gray', 'cat-siamese', 'cat-white', 'dog', 'rabbit', 'bear', 'panda',
    'fox', 'lion', 'tiger', 'monkey', 'owl', 'frog', 'fish',
  ]);
  for (const { key } of AVATAR_PRESETS) {
    assert.equal(presetUrl(key), `https://tony-poker.web.app/friday-poker/assets/avatars/${key}.svg`);
    assert.equal(presetKeyOf(presetUrl(key)), key);
    assert.equal(presetKeyOf(presetUrl(key).replace('tony-poker.web.app', 'preview.example')), key);
    assert.equal(avatarSrc(presetUrl(key)), new URL(`../assets/avatars/${key}.svg`, import.meta.url).href);
  }
  for (const url of [null, presetUrl('unknown'), presetUrl('cat') + '?size=32', presetUrl('cat') + '#preview']) {
    assert.equal(presetKeyOf(url), null);
  }
  assert.equal(avatarSrc(googlePhotoURL), googlePhotoURL);
  for (const url of ['http://example.com/avatar', 'data:image/png;base64,A', 'javascript:alert(1)', './avatar.png']) {
    assert.equal(avatarSrc(url), '');
  }
});

test('頭像首字支援 Unicode，圖片與載入失敗替代內容會轉義', () => {
  assert.equal(avatarInnerHtml(null, '🐱名字', { size: 32 }), '<span class="av-fallback">🐱</span>');
  assert.equal(avatarInnerHtml(null, '<姓名', { size: 32 }), '<span class="av-fallback">&lt;</span>');
  const html = avatarInnerHtml(googlePhotoURL + '?a="&b=', "'", { size: 40 });
  assert.match(html, /src="[^"]+\?a=&quot;&amp;b="/);
  assert.match(html, /width="40" height="40" loading="lazy"/);
  assert.match(html, /onerror="this\.outerHTML=.*av-fallback.*&amp;#39;/);
});

test('已移除的頭像沿用原 HTTPS 網址，載入失敗時顯示名字首字', () => {
  for (const key of ['cat-orange', 'cat-black', 'penguin']) {
    const url = presetUrl(key);
    assert.equal(presetKeyOf(url), null);
    assert.equal(avatarSrc(url), url);
    const html = avatarInnerHtml(url, '小明', { size: 32 });
    assert.ok(html.includes(`src="${url}"`));
    assert.ok(html.includes('onerror="this.outerHTML=&quot;&lt;span class=\\&quot;av-fallback\\&quot;&gt;小&lt;/span&gt;&quot;"'));
  }
});

test('浮層只有本人可換頭像，選擇器有 16 個選項且標記目前選擇', () => {
  const options = { name: '小明', view: { state: 'disabled' } };
  const other = personalStatsHtml({ ...options, photoURL: presetUrl('cat'), canEdit: true });
  assert.match(other, /ps-av" aria-hidden="true"><img/);
  assert.doesNotMatch(other, /data-ps="avatar"/);
  assert.match(personalStatsHtml(options), /class="av-fallback">小/);
  assert.match(personalStatsHtml({ ...options, isMe: true, canEdit: true }), /<button[^>]+data-ps="avatar"/);
  const picker = avatarPickerHtml({ ...options, photoURL: presetUrl('dog'), googlePhotoURL });
  assert.equal(picker.match(/data-ps="pick-choice"/g).length, 16);
  assert.equal(picker.match(/aria-pressed="true"/g).length, 1);
  assert.match(picker, /data-ps="pick-choice" data-key="original" aria-label="原本頭像" title="原本頭像"/);
  assert.doesNotMatch(picker.replace(/<[^>]+>/g, ''), /原本頭像/);
  assert.match(picker, /data-key="dog"[^>]+aria-pressed="true"/);
});

function overlay(onPickAvatar) {
  let host;
  let click;
  const doc = {
    getElementById: () => null,
    createElement: () => ({ addEventListener: (_, handler) => { click = handler; } }),
    head: { appendChild() {} },
    body: { appendChild(el) { host = el; } },
  };
  const win = { addEventListener() {} };
  openPersonalStats({ uid: 'me', myUid: 'me', name: '小明', enabled: false,
    photoURL: googlePhotoURL, googlePhotoURL, onPickAvatar, doc, win });
  return {
    html: () => host.innerHTML,
    tap: (ps, key) => click({ target: { closest: () => ({ dataset: { ps, key } }) } }),
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('儲存時停用選項，成功後更新浮層並可還原 Google 頭像', async () => {
  let finish;
  const calls = [];
  const app = overlay((url) => {
    calls.push(url);
    return new Promise((resolve) => { finish = resolve; });
  });
  app.tap('avatar');
  assert.match(app.html(), /role="dialog"[^>]+aria-label="選擇頭像"/);
  app.tap('pick-choice', 'cat');
  assert.match(app.html(), /data-key="dog"[^>]+ disabled/);
  app.tap('pick-choice', 'dog');
  assert.deepEqual(calls, [presetUrl('cat')]);
  finish();
  await settle();
  assert.match(app.html(), /assets\/avatars\/cat\.svg/);
  assert.doesNotMatch(app.html(), /class="ps-pick"/);
  app.tap('avatar');
  app.tap('pick-choice', 'original');
  assert.deepEqual(calls, [presetUrl('cat'), googlePhotoURL]);
  finish();
  await settle();
  assert.ok(app.html().includes(googlePhotoURL));
});

test('儲存失敗留在選擇器並可重試', async () => {
  const app = overlay(async () => { throw new Error('offline'); });
  app.tap('avatar');
  app.tap('pick-choice', 'cat');
  await settle();
  assert.match(app.html(), /儲存失敗，請重試/);
  assert.match(app.html(), /data-key="original"[^>]+aria-pressed="true">/);
});

test('登入時可保留已儲存的預設頭像，還原後繼續同步 Google', () => {
  const user = { displayName: '新名稱', photoURL: googlePhotoURL };
  const stored = { displayName: '舊名稱', photoURL: presetUrl('cat') };
  const keep = (url) => !!presetKeyOf(url);
  assert.deepEqual(profilePatch(stored, user, keep), { displayName: '新名稱' });
  assert.deepEqual(profilePatch(stored, user), user);
  assert.deepEqual(profilePatch({ ...stored, photoURL: null }, user, keep), user);
});
