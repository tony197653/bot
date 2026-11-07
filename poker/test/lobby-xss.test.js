import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openRowHtml, esc } from '../js/ui/lobby.js';

describe('lobby XSS escaping', () => {
  it('escapes HTML specials', () => {
    assert.equal(esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
    assert.equal(esc('"quoted"'), '&quot;quoted&quot;');
  });

  it('malicious lobby.seated renders as text, not HTML', () => {
    const html = openRowHtml({
      id: 'r1',
      code: '042',
      name: '週五',
      lobby: {
        name: '週五',
        hostName: '阿明',
        hostPhoto: '',
        blinds: '10/20',
        seated: '<img src=x onerror=alert(1)>',
      },
    });
    assert.equal(html.includes('<img src=x'), false);
    assert.equal(html.includes('onerror'), false);
    assert.match(html, /0\/6/);
  });

  it('malicious lobby name/hostName/blinds are escaped', () => {
    const html = openRowHtml({
      id: 'r2',
      code: '007',
      lobby: {
        name: '<b>hack</b>',
        hostName: '<script>x</script>',
        hostPhoto: 'https://evil.example/a.png" onerror="alert(1)',
        blinds: '1<script>',
        seated: 2,
      },
    });
    assert.equal(html.includes('<b>hack</b>'), false);
    assert.equal(html.includes('<script>'), false);
    assert.match(html, /&lt;b&gt;hack&lt;\/b&gt;/);
    assert.match(html, /&lt;script&gt;/);
    // quoted attribute break attempt is escaped inside src=
    assert.match(html, /src="https:\/\/evil\.example\/a\.png&quot; onerror=&quot;alert\(1\)"/);
  });
});
