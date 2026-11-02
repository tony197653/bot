#!/usr/bin/env node
/**
 * Start Firestore emulator, run rules.test.mjs, tear down.
 * NEVER points at production — projectId demo-poker only.
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

const emu = spawn(
  'npx',
  [
    '--yes',
    'firebase-tools@13.20.2',
    'emulators:exec',
    '--only',
    'firestore',
    '--project',
    'demo-poker',
    'node rules.test.mjs',
  ],
  {
    cwd: dir,
    stdio: 'inherit',
    env: {
      ...process.env,
      RULES: 'firestore.rules',
      OUT: 'results.json',
      // sess[i].startAt cannot be serverTimestamp (not allowed in arrays) — §FIX-1
      STARTAT: 'ts',
    },
  },
);

emu.on('exit', (code) => process.exit(code ?? 1));
