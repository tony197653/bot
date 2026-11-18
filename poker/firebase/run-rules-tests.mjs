#!/usr/bin/env node
/**
 * 啟動本機 Firestore emulator，逐檔執行所有規則測試後關閉。
 * 每檔獨立 Node 程序，避免測試環境、專案資料及規則互相覆蓋。
 */
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const run = (command, args, options) => new Promise((resolve) => {
  const p = spawn(command, args, options);
  p.on('error', (error) => { console.error(error); resolve(1); });
  p.on('exit', (code) => resolve(code ?? 1));
});

if (process.argv.includes('--run-files')) {
  const endpoint = process.env.FIRESTORE_EMULATOR_HOST;
  if (!endpoint || !/^(127\.0\.0\.1|localhost):\d+$/.test(endpoint)) {
    console.error('必須設定本機 FIRESTORE_EMULATOR_HOST');
    process.exit(1);
  }
  // 包含 rules.test.mjs、所有 *.rules.test.mjs，以及既有 stats 規則測試。
  const files = (await readdir(dir)).filter(file => file !== 'rules.test.mjs' && file.endsWith('.test.mjs')).sort();
  files.unshift('rules.test.mjs');
  let failed = 0;
  for (const file of files) {
    console.log(`規則測試：${file}`);
    const code = await run(process.execPath, ['--test', file], {
      cwd: dir, stdio: 'inherit',
      env: { ...process.env, RULES_PROJECT: 'demo-fix1109', FILTER: '' },
    });
    if (code !== 0) failed++;
  }
  console.log(`規則測試檔案：${files.length - failed}/${files.length} 通過`);
  process.exitCode = failed ? 1 : 0;
} else {
  const javaOk = await run('java', ['-version'], { stdio: 'ignore' });
  if (javaOk !== 0) {
    console.error('Firestore emulator 需要 Java');
    process.exit(1);
  }
  process.exitCode = await run(
    'npx',
    [
      '--yes',
      'firebase-tools@13.20.2',
      'emulators:exec',
      '--only',
      'firestore',
      '--project',
      'demo-poker',
      'node run-rules-tests.mjs --run-files',
    ],
    {
      cwd: dir,
      stdio: 'inherit',
      env: {
        ...process.env,
        RULES: 'firestore.rules',
        OUT: 'results.json',
        // sess[i].startAt 不能使用 serverTimestamp（陣列內不允許），沿用 FIX-1。
        STARTAT: 'ts',
      },
    },
  );
}
