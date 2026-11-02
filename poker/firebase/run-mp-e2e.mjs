#!/usr/bin/env node
/**
 * Start Auth+Firestore emulators (demo-poker), run test/mp-e2e.mjs, tear down.
 * Never points at production.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const poker = path.join(dir, '..');

const emu = spawn(
  'npx',
  [
    '--yes',
    'firebase-tools@13.20.2',
    'emulators:exec',
    '--only',
    'auth,firestore',
    '--project',
    'demo-poker',
    'node ../test/mp-e2e.mjs',
  ],
  {
    cwd: dir,
    stdio: 'inherit',
    env: { ...process.env },
  },
);
emu.on('exit', (c) => process.exit(c ?? 1));
