#!/usr/bin/env node
/**
 * Single entry point to release poker Hosting live.
 * Usage:
 *   node scripts/promote-live.mjs --approval deploy/approvals/<id>.json
 *   node scripts/promote-live.mjs --approval-id <id>
 *
 * Never auto-writes a baseline. Refusals leave deploy/ unchanged aside from stdout.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promoteLive, PromoteError } from './promote/lib.mjs';
import { createFirebaseAdapter } from './promote/firebase-adapter.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  /** @type {{ help?: boolean, approval?: string, approvalId?: string }} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--approval') out.approval = argv[++i];
    else if (a === '--approval-id') out.approvalId = argv[++i];
  }
  return out;
}

function usage() {
  console.log(`Release tony-poker live from an approval record (process convention only).

Usage:
  node scripts/promote-live.mjs --approval deploy/approvals/<id>.json
  node scripts/promote-live.mjs --approval-id <id>

See deploy/README.md.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }

  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'deploy/config.json'), 'utf8'));
  let approvalPath = args.approval ? path.resolve(String(args.approval)) : null;
  if (!approvalPath && args.approvalId) {
    approvalPath = path.join(ROOT, config.approvalsDir, `${args.approvalId}.json`);
  }
  if (!approvalPath) {
    usage();
    process.exit(2);
  }

  const firebase = createFirebaseAdapter({ projectId: config.projectId });
  const auxiliaryContentChecks = (config.auxiliaryContentChecks || []).filter((c) => c.enabled);

  try {
    const result = await promoteLive({
      approvalPath,
      releasesLogPath: path.join(ROOT, config.releasesLog),
      siteId: config.siteId,
      liveChannel: config.liveChannel,
      firebase,
      auxiliaryContentChecks,
    });
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } catch (e) {
    if (e instanceof PromoteError) {
      console.error(`REFUSED [${e.code}]: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}

main();
