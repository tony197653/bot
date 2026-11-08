#!/usr/bin/env node
/**
 * Generate an approval record JSON from a Hosting channel or immutable version.
 * Hashes/version ids are collected via the Firebase adapter — do not hand-type hashes.
 *
 * Usage:
 *   node scripts/generate-approval.mjs \
 *     --id 2026-11-08-a1 \
 *     --source tony-poker:main \
 *     --expected-live sites/tony-poker/versions/<currentLiveId> \
 *     --quote "Owner approval text..." \
 *     --out deploy/approvals/2026-11-08-a1.json
 *
 *   node scripts/generate-approval.mjs --id ... --source sites/tony-poker/versions/<id> ...
 *   node scripts/generate-approval.mjs --id ... --source tony-poker@<versionId> ...
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApprovalRecord, writeApprovalRecord, PromoteError } from './promote/lib.mjs';
import { createFirebaseAdapter } from './promote/firebase-adapter.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    out[key] = argv[++i];
  }
  return out;
}

function usage() {
  console.log(`Generate deploy/approvals/<id>.json from a channel or version.

Required:
  --id <id>
  --source <sites/.../versions/ID | site@versionId | site:channel>
  --expected-live <sites/.../versions/ID>
  --quote <approver quote text>
  --out <path>   (default deploy/approvals/<id>.json)`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.id || !args.source || !args['expected-live'] || !args.quote) {
    usage();
    process.exit(2);
  }
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'deploy/config.json'), 'utf8'));
  const outPath = path.resolve(args.out || path.join(ROOT, config.approvalsDir, `${args.id}.json`));
  const firebase = createFirebaseAdapter({ projectId: config.projectId });

  try {
    const record = await buildApprovalRecord({
      id: args.id,
      approverQuote: args.quote,
      source: args.source,
      expectedLiveVersion: args['expected-live'],
      siteId: config.siteId,
      firebase,
    });
    writeApprovalRecord(outPath, record);
    console.log(JSON.stringify({ ok: true, outPath, sourceVersion: record.sourceVersion, manifestDigest: record.manifestDigest, fileCount: Object.keys(record.manifest).length }, null, 2));
  } catch (e) {
    if (e instanceof PromoteError) {
      console.error(`FAILED [${e.code}]: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}

main();
