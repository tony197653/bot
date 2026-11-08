#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
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
    'node ../test/mp-e2e-6p-showdown.mjs',
  ],
  { cwd: dir, stdio: 'inherit', env: { ...process.env } },
);
emu.on('exit', (c) => process.exit(c ?? 1));
