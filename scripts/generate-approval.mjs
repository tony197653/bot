#!/usr/bin/env node
/**
 * Generate an approval record bound to an IMMUTABLE Hosting version.
 * Does not resolve mutable channels. Hashes/version ids collected via adapter.
 *
 * Usage:
 *   node scripts/generate-approval.mjs \
 *     --id 2026-11-08-a1 \
 *     --source sites/tony-poker/versions/<VERSION_ID> \
 *     --expected-live sites/tony-poker/versions/<CURRENT_LIVE_VERSION_ID> \
 *     --approval-ref <approval-card-or-message-id> \
 *     --quote "Owner approval text..." \
 *     --out deploy/approvals/2026-11-08-a1.json
 *
 * Record includes approvalRef, reviewedDiffSummary, and diffVsLive (vs current live).
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
  console.log(`Generate deploy/approvals/<id>.json from an immutable version.

Required:
  --id <id>
  --source <sites/tony-poker/versions/ID>
  --expected-live <sites/tony-poker/versions/ID>
  --approval-ref <approval card/message id>
  --quote <approver quote text>
  --out <path>   (default deploy/approvals/<id>.json)`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.id || !args.source || !args['expected-live'] || !args.quote || !args['approval-ref']) {
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
      approvalRef: args['approval-ref'],
      source: args.source,
      expectedLiveVersion: args['expected-live'],
      siteId: config.siteId,
      firebase,
    });
    writeApprovalRecord(outPath, record);
    console.log(
      JSON.stringify(
        {
          ok: true,
          outPath,
          sourceVersion: record.sourceVersion,
          expectedLiveVersion: record.expectedLiveVersion,
          manifestDigest: record.manifestDigest,
          approvalRef: record.approvalRef,
          fileCount: Object.keys(record.manifest).length,
          reviewedDiffSummary: record.reviewedDiffSummary,
        },
        null,
        2,
      ),
    );
  } catch (e) {
    if (e instanceof PromoteError) {
      console.error(`FAILED [${e.code}]: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}

main();
