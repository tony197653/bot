/**
 * Process-only live promote for Firebase Hosting site tony-poker.
 * All Firebase I/O goes through an injected adapter (mocked in tests).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const VERSION_NAME_RE = /^sites\/[^/]+\/versions\/[^/]+$/;

export class PromoteError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PromoteError';
    this.code = code;
  }
}

/** @param {string} versionName */
export function assertImmutableVersionName(versionName, field = 'sourceVersion') {
  if (typeof versionName !== 'string' || !VERSION_NAME_RE.test(versionName)) {
    throw new PromoteError(
      'INVALID_VERSION_NAME',
      `${field} must be an immutable Hosting version name ` +
        `(sites/<site>/versions/<id>), not a channel. Got: ${JSON.stringify(versionName)}`,
    );
  }
}

/**
 * @param {Array<{path: string, hash: string}> | Record<string, string>} files
 * @returns {{ manifest: Record<string, string>, digest: string }}
 */
export function canonicalizeManifest(files) {
  /** @type {Record<string, string>} */
  const manifest = {};
  if (Array.isArray(files)) {
    for (const f of files) {
      if (!f || typeof f.path !== 'string' || typeof f.hash !== 'string') {
        throw new PromoteError('INVALID_MANIFEST', 'Each file needs path and hash strings');
      }
      const p = f.path.startsWith('/') ? f.path : `/${f.path}`;
      manifest[p] = f.hash;
    }
  } else if (files && typeof files === 'object') {
    for (const [p0, hash] of Object.entries(files)) {
      const p = p0.startsWith('/') ? p0 : `/${p0}`;
      if (typeof hash !== 'string') {
        throw new PromoteError('INVALID_MANIFEST', `Hash for ${p} must be a string`);
      }
      manifest[p] = hash;
    }
  } else {
    throw new PromoteError('INVALID_MANIFEST', 'manifest must be an object or file list');
  }
  const digest = manifestDigest(manifest);
  return { manifest, digest };
}

/** @param {Record<string, string>} manifest */
export function manifestDigest(manifest) {
  const lines = Object.keys(manifest)
    .sort()
    .map((p) => `${p}\t${manifest[p]}`);
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

/**
 * @param {Record<string, string>} expected
 * @param {Record<string, string>} actual
 */
export function diffManifests(expected, actual) {
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  /** @type {Array<{path: string, expected: string|null, actual: string|null}>} */
  const diffs = [];
  for (const p of [...keys].sort()) {
    const e = expected[p] ?? null;
    const a = actual[p] ?? null;
    if (e !== a) diffs.push({ path: p, expected: e, actual: a });
  }
  return diffs;
}

/**
 * @param {unknown} record
 */
export function validateApprovalRecord(record) {
  if (!record || typeof record !== 'object') {
    throw new PromoteError('INVALID_RECORD', 'Approval record must be a JSON object');
  }
  const r = /** @type {Record<string, unknown>} */ (record);
  for (const key of ['id', 'approverQuote', 'approvedAt', 'sourceVersion', 'expectedLiveVersion', 'manifest']) {
    if (r[key] == null || r[key] === '') {
      throw new PromoteError('INVALID_RECORD', `Approval record missing required field: ${key}`);
    }
  }
  if (typeof r.approverQuote !== 'string' || !r.approverQuote.trim()) {
    throw new PromoteError('INVALID_RECORD', 'approverQuote must be non-empty text');
  }
  assertImmutableVersionName(String(r.sourceVersion), 'sourceVersion');
  assertImmutableVersionName(String(r.expectedLiveVersion), 'expectedLiveVersion');
  const { manifest, digest } = canonicalizeManifest(/** @type {any} */ (r.manifest));
  if (r.manifestDigest != null && r.manifestDigest !== digest) {
    throw new PromoteError(
      'INVALID_RECORD',
      `Record manifestDigest does not match manifest contents (record=${r.manifestDigest}, computed=${digest})`,
    );
  }
  return {
    id: String(r.id),
    approverQuote: String(r.approverQuote),
    approvedAt: String(r.approvedAt),
    sourceVersion: String(r.sourceVersion),
    expectedLiveVersion: String(r.expectedLiveVersion),
    manifest,
    manifestDigest: digest,
  };
}

/**
 * @param {{
 *   approvalPath: string,
 *   releasesLogPath: string,
 *   siteId: string,
 *   liveChannel?: string,
 *   firebase: {
 *     getChannelVersionName: (siteId: string, channelId: string) => Promise<string|null>,
 *     listVersionFiles: (versionName: string) => Promise<Array<{path: string, hash: string}>>,
 *     getVersionFileText?: (versionName: string, filePath: string) => Promise<string|null>,
 *     releaseVersionToLive: (siteId: string, versionName: string) => Promise<void>,
 *   },
 *   auxiliaryContentChecks?: Array<{path: string, forbiddenSubstring: string}>,
 *   now?: () => Date,
 *   readFile?: typeof fs.readFileSync,
 *   writeFile?: typeof fs.writeFileSync,
 *   appendFile?: typeof fs.appendFileSync,
 *   exists?: typeof fs.existsSync,
 * }} opts
 */
export async function promoteLive(opts) {
  const readFile = opts.readFile ?? fs.readFileSync;
  const appendFile = opts.appendFile ?? fs.appendFileSync;
  const exists = opts.exists ?? fs.existsSync;
  const liveChannel = opts.liveChannel ?? 'live';
  const now = opts.now ?? (() => new Date());

  // Track whether we wrote anything before a refusal — refusals must not write baselines.
  let wroteAnything = false;
  const noteWrite = () => {
    wroteAnything = true;
  };

  if (!exists(opts.approvalPath)) {
    throw Object.assign(
      new PromoteError('NO_RECORD', `No approval record at ${opts.approvalPath}`),
      { wroteAnything },
    );
  }

  let raw;
  try {
    raw = JSON.parse(String(readFile(opts.approvalPath, 'utf8')));
  } catch (e) {
    throw Object.assign(
      new PromoteError('INVALID_RECORD', `Cannot parse approval record: ${e.message}`),
      { wroteAnything },
    );
  }

  let record;
  try {
    record = validateApprovalRecord(raw);
  } catch (e) {
    e.wroteAnything = wroteAnything;
    throw e;
  }

  if (!record.expectedLiveVersion) {
    throw Object.assign(
      new PromoteError('NO_BASELINE', 'Approval record has no expectedLiveVersion baseline; refuse'),
      { wroteAnything },
    );
  }

  const liveVersion = await opts.firebase.getChannelVersionName(opts.siteId, liveChannel);
  if (!liveVersion) {
    throw Object.assign(
      new PromoteError('NO_LIVE_VERSION', `Could not resolve current ${liveChannel} version`),
      { wroteAnything },
    );
  }
  if (liveVersion !== record.expectedLiveVersion) {
    throw Object.assign(
      new PromoteError(
        'LIVE_DRIFT',
        `Live version drifted from approval baseline.\n` +
          `  expected: ${record.expectedLiveVersion}\n` +
          `  actual:   ${liveVersion}`,
      ),
      { wroteAnything },
    );
  }

  const sourceFiles = await opts.firebase.listVersionFiles(record.sourceVersion);
  const { manifest: sourceManifest, digest: sourceDigest } = canonicalizeManifest(sourceFiles);
  const diffs = diffManifests(record.manifest, sourceManifest);
  if (diffs.length > 0) {
    const sample = diffs
      .slice(0, 5)
      .map((d) => `  ${d.path}: expected=${d.expected} actual=${d.actual}`)
      .join('\n');
    throw Object.assign(
      new PromoteError(
        'MANIFEST_MISMATCH',
        `Source version manifest differs from approval record (${diffs.length} path(s)).\n${sample}`,
      ),
      { wroteAnything, diffs },
    );
  }
  if (sourceDigest !== record.manifestDigest) {
    throw Object.assign(
      new PromoteError('MANIFEST_MISMATCH', 'Manifest digest mismatch after compare'),
      { wroteAnything },
    );
  }

  // Auxiliary content checks only — never sole evidence (manifest already compared).
  const checks = opts.auxiliaryContentChecks ?? [];
  if (checks.length && typeof opts.firebase.getVersionFileText === 'function') {
    for (const check of checks) {
      const text = await opts.firebase.getVersionFileText(record.sourceVersion, check.path);
      if (text != null && text.includes(check.forbiddenSubstring)) {
        throw Object.assign(
          new PromoteError(
            'AUX_FORBIDDEN_STRING',
            `Auxiliary check failed: ${check.path} contains forbidden substring ${JSON.stringify(check.forbiddenSubstring)}`,
          ),
          { wroteAnything },
        );
      }
    }
  }

  await opts.firebase.releaseVersionToLive(opts.siteId, record.sourceVersion);

  const postLive = await opts.firebase.getChannelVersionName(opts.siteId, liveChannel);
  if (postLive !== record.sourceVersion) {
    throw Object.assign(
      new PromoteError(
        'POST_VERIFY_VERSION',
        `Post-release live version is ${postLive}, expected approved ${record.sourceVersion}`,
      ),
      { wroteAnything, released: true },
    );
  }
  const postFiles = await opts.firebase.listVersionFiles(postLive);
  const { manifest: postManifest } = canonicalizeManifest(postFiles);
  const postDiffs = diffManifests(record.manifest, postManifest);
  if (postDiffs.length > 0) {
    throw Object.assign(
      new PromoteError(
        'POST_VERIFY_MANIFEST',
        `Post-release live manifest differs from approved manifest (${postDiffs.length} path(s))`,
      ),
      { wroteAnything, released: true, diffs: postDiffs },
    );
  }

  const ts = now().toISOString();
  const line =
    `| ${ts} | ${record.id} | \`${record.sourceVersion}\` | \`${record.expectedLiveVersion}\` |\n`;
  appendFile(opts.releasesLogPath, line, 'utf8');
  noteWrite();

  return {
    ok: true,
    approvalId: record.id,
    newLiveVersion: record.sourceVersion,
    previousLiveVersion: record.expectedLiveVersion,
    manifestDigest: record.manifestDigest,
    wroteAnything,
  };
}

/**
 * Build an approval record from a channel or version (hashes collected via adapter).
 * Does not release anything.
 *
 * @param {{
 *   id: string,
 *   approverQuote: string,
 *   approvedAt?: string,
 *   source: string,
 *   expectedLiveVersion: string,
 *   siteId: string,
 *   firebase: {
 *     getChannelVersionName: (siteId: string, channelId: string) => Promise<string|null>,
 *     listVersionFiles: (versionName: string) => Promise<Array<{path: string, hash: string}>>,
 *   },
 *   now?: () => Date,
 * }} opts
 */
export async function buildApprovalRecord(opts) {
  const now = opts.now ?? (() => new Date());
  assertImmutableVersionName(opts.expectedLiveVersion, 'expectedLiveVersion');

  let sourceVersion = opts.source;
  if (VERSION_NAME_RE.test(sourceVersion)) {
    // already immutable version name
  } else if (sourceVersion.includes('@')) {
    // site@version short form → expand
    const [site, ver] = sourceVersion.split('@');
    if (!site || !ver || ver.includes(':')) {
      throw new PromoteError('INVALID_SOURCE', `Bad site@version source: ${opts.source}`);
    }
    sourceVersion = `sites/${site}/versions/${ver}`;
    assertImmutableVersionName(sourceVersion);
  } else if (sourceVersion.includes(':')) {
    // site:channel → resolve to immutable version
    const [site, channel] = sourceVersion.split(':');
    if (!site || !channel) {
      throw new PromoteError('INVALID_SOURCE', `Bad site:channel source: ${opts.source}`);
    }
    const resolved = await opts.firebase.getChannelVersionName(site, channel);
    if (!resolved) {
      throw new PromoteError('INVALID_SOURCE', `Channel ${sourceVersion} has no version`);
    }
    assertImmutableVersionName(resolved);
    sourceVersion = resolved;
  } else {
    throw new PromoteError(
      'INVALID_SOURCE',
      `Source must be sites/.../versions/..., site@version, or site:channel. Got: ${opts.source}`,
    );
  }

  const files = await opts.firebase.listVersionFiles(sourceVersion);
  const { manifest, digest } = canonicalizeManifest(files);

  return {
    id: opts.id,
    approverQuote: opts.approverQuote,
    approvedAt: opts.approvedAt ?? now().toISOString(),
    sourceVersion,
    expectedLiveVersion: opts.expectedLiveVersion,
    manifest,
    manifestDigest: digest,
  };
}

/**
 * Write approval JSON. Only call intentionally (never as a promote refusal side effect).
 * @param {string} filePath
 * @param {object} record
 * @param {{ writeFile?: typeof fs.writeFileSync, mkdir?: typeof fs.mkdirSync }} [io]
 */
export function writeApprovalRecord(filePath, record, io = {}) {
  const writeFile = io.writeFile ?? fs.writeFileSync;
  const mkdir = io.mkdir ?? fs.mkdirSync;
  mkdir(path.dirname(filePath), { recursive: true });
  writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}
