/**
 * 最小 e2e：template-demo 可載入且標題存在。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 8765;

const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], {
  cwd: root,
  stdio: 'ignore',
});

await new Promise((r) => setTimeout(r, 400));

try {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(`http://127.0.0.1:${port}/template-demo.html`, { waitUntil: 'networkidle', timeout: 15000 });
  const titleText = await page.locator('.quiz-top .title').textContent();
  if (!titleText || !titleText.includes('示範')) throw new Error('title missing');
  await browser.close();
  console.log('e2e OK:', titleText.trim());
} catch (e) {
  console.error('e2e FAIL', e.message);
  server.kill();
  process.exit(1);
}

server.kill();
process.exit(0);
