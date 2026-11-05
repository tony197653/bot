#!/usr/bin/env node
/**
 * 啟動 Firestore emulator、跑 test/emu-acceptance.mjs。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dir, '..');
const firebaseBin = path.resolve(root, 'node_modules/.bin/firebase');

const emu = spawn(
  firebaseBin,
  [
    'emulators:exec',
    '--only',
    'firestore',
    '--project',
    'demo-quiz-bank',
    'node ../test/emu-acceptance.mjs',
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
