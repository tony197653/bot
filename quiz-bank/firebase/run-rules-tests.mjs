#!/usr/bin/env node
/**
 * 啟動 Firestore emulator、跑 rules.test.mjs、關閉。
 * 絕不含正式專案 — projectId 固定 demo-quiz-bank。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const javaOk = await new Promise((resolve) => {
  const p = spawn('java', ['-version'], { stdio: 'ignore' });
  p.on('exit', (c) => resolve(c === 0));
  p.on('error', () => resolve(false));
});
if (!javaOk) {
  console.error('Java required for Firestore emulator');
  process.exit(1);
}

const firebaseBin = path.resolve(dir, '../node_modules/.bin/firebase');
const emu = spawn(
  firebaseBin,
  [
    'emulators:exec',
    '--only',
    'firestore',
    '--project',
    'demo-quiz-bank',
    'node rules.test.mjs',
  ],
  {
    cwd: dir,
    stdio: 'inherit',
    env: {
      ...process.env,
      FIRESTORE_EMULATOR_PORT: '8295',
    },
  },
);

emu.on('exit', (code) => process.exit(code ?? 1));
