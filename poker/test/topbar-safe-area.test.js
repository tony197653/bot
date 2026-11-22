import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('牌桌頂欄把 safe-area-inset-top 算進高度，避免字被狀態列切到', () => {
  const css = readFileSync(new URL('../css/game.css', import.meta.url), 'utf8');
  assert.match(css, /--safe-top:\s*env\(safe-area-inset-top,\s*0px\)/);
  assert.match(css, /\.top\{[\s\S]*?height:calc\(var\(--top-h\) \+ var\(--safe-top\)\)/);
  assert.match(css, /\.top\{[\s\S]*?padding:var\(--safe-top\) 8px 0 4px/);
  assert.match(css, /grid-template-rows:calc\(var\(--top-h\) \+ var\(--safe-top\)\) 1fr/);
  assert.match(css, /\.menu-pop\{[\s\S]*?top:calc\(100% \+ 4px\)/);
  assert.match(css, /\.mp-shell\{[^}]*padding-top:max\(12px,env\(safe-area-inset-top\)\)/);
});
