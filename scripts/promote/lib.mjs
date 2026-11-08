import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const VERSION_NAME_RE = /^sites\/tony-poker\/versions\/[A-Za-z0-9_-]+$/;
export class PromoteError extends Error {
  constructor(code, message) { super(message); this.name = 'PromoteError'; this.code = code; }
}
export function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new PromoteError('INVALID_INPUT', `${field} must be non-empty text`);
  return value;
}
export function assertImmutableVersionName(value, field = 'sourceVersion') {
  if (typeof value !== 'string' || !VERSION_NAME_RE.test(value)) throw new PromoteError('INVALID_VERSION_NAME', `${field} must be sites/tony-poker/versions/<id>`);
}
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, sorted(value[k])]));
  return value;
}
function checkConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new PromoteError('INVALID_CONFIG', 'version.config must be an object');
}
export function canonicalizeManifest(files, config = {}) {
  checkConfig(config);
  const manifest = Object.create(null);
  const entries = Array.isArray(files) ? files : files && typeof files === 'object' ? Object.entries(files).map(([path, hash]) => ({path, hash})) : null;
  if (!entries) throw new PromoteError('INVALID_MANIFEST', 'manifest must be an object or file list');
  for (const f of entries) {
    if (!f || typeof f.path !== 'string' || !f.path || typeof f.hash !== 'string' || !f.hash) throw new PromoteError('INVALID_MANIFEST', 'Each file needs non-empty path/hash strings');
    const p = f.path.startsWith('/') ? f.path : `/${f.path}`;
    if (Object.hasOwn(manifest, p)) throw new PromoteError('DUPLICATE_PATH', `Duplicate path: ${p}`);
    manifest[p] = f.hash;
  }
  return {manifest, digest: manifestDigest(manifest, config)};
}
export function manifestDigest(manifest, config = {}) {
  checkConfig(config);
  return createHash('sha256').update(JSON.stringify({files: Object.keys(manifest).sort().map(p => [p, manifest[p]]), config: sorted(config)})).digest('hex');
}
export function diffManifests(expected, actual) {
  return [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort().filter(p => expected[p] !== actual[p]).map(p => ({path:p, expected:expected[p] ?? null, actual:actual[p] ?? null}));
}
export function validateApprovalRecord(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new PromoteError('INVALID_RECORD', 'Approval must be an object');
  for (const k of ['id','approverQuote','approvalRef','approvedAt','manifestDigest']) requireText(r[k], k);
  assertImmutableVersionName(r.sourceVersion);
  if (r.expectedLiveVersion === undefined || r.expectedLiveVersion === null || r.expectedLiveVersion === '') throw new PromoteError('NO_BASELINE', 'Approval has no expectedLiveVersion baseline');
  assertImmutableVersionName(r.expectedLiveVersion, 'expectedLiveVersion');
  checkConfig(r.servingConfig);
  const {manifest, digest} = canonicalizeManifest(r.manifest, r.servingConfig);
  if (digest !== r.manifestDigest) throw new PromoteError('INVALID_RECORD', 'Approval manifest hash mismatch');
  return {...r, manifest};
}
export async function inspectArtifact(firebase, versionName) {
  assertImmutableVersionName(versionName);
  const version = await firebase.getVersion(versionName);
  if (!version || version.name !== versionName || version.status !== 'FINALIZED') throw new PromoteError('INVALID_VERSION_STATUS', 'Version must match and be FINALIZED');
  checkConfig(version.config);
  const files = await firebase.listVersionFiles(versionName);
  const artifact = canonicalizeManifest(files, version.config);
  if (!['number','string'].includes(typeof version.fileCount) || !/^\d+$/.test(String(version.fileCount)) || !Number.isSafeInteger(Number(version.fileCount)) || version.fileCount == null || Number(version.fileCount) !== Object.keys(artifact.manifest).length) throw new PromoteError('FILE_COUNT_MISMATCH', 'Version fileCount differs from manifest length');
  return {...artifact, servingConfig: version.config};
}
// Only completed releases (or an explicitly recorded initial baseline) establish a baseline.
export function recordedLive(log) {
  let current;
  for (const line of log.split('\n')) {
    if (!line.startsWith('| ')) continue;
    const cells = line.split('|').slice(1,-1).map(s => s.trim().replaceAll('`',''));
    if (['DONE','BASELINE'].includes(cells[1])) { assertImmutableVersionName(cells[3]); current = cells[3]; }
  }
  return current;
}
export async function promoteLive(opts) {
  let lock;
  let wroteAnything = false;
  const lockPath = opts.lockPath ?? path.join(path.dirname(opts.releasesLogPath), '.promote.lock');
  try {
    try { lock = fs.openSync(lockPath, 'wx', 0o600); }
    catch (e) { if (e.code === 'EEXIST') throw new PromoteError('LOCKED', 'Another promote holds the lock'); throw e; }
    if (!fs.existsSync(opts.approvalPath)) throw new PromoteError('NO_RECORD', 'Approval record missing');
    let raw;
    try { raw = JSON.parse(fs.readFileSync(opts.approvalPath, 'utf8')); }
    catch { throw new PromoteError('INVALID_RECORD', 'Cannot parse approval'); }
    const record = validateApprovalRecord(raw);
    const baseline = fs.existsSync(opts.releasesLogPath) ? recordedLive(fs.readFileSync(opts.releasesLogPath, 'utf8')) : undefined;
    if (!baseline || baseline !== record.expectedLiveVersion) throw new PromoteError('NO_BASELINE', 'No matching recorded previous live release');
    const checkLive = async () => {
      const live = await opts.firebase.getChannelVersionName(opts.siteId, opts.liveChannel ?? 'live');
      assertImmutableVersionName(live, 'liveVersion');
      if (live !== record.expectedLiveVersion) throw new PromoteError('LIVE_DRIFT', 'Live changed from approval baseline');
    };
    await checkLive();
    const source = await inspectArtifact(opts.firebase, record.sourceVersion);
    if (source.digest !== record.manifestDigest) throw new PromoteError('MANIFEST_MISMATCH', 'Artifact/config differs from approval');
    for (const check of opts.auxiliaryContentChecks ?? []) {
      const text = await opts.firebase.getVersionFileText?.(record.sourceVersion, check.path);
      if (text?.includes(check.forbiddenSubstring)) throw new PromoteError('AUX_FORBIDDEN_STRING', 'Auxiliary content check failed');
    }
    const rollback = `firebase hosting:clone tony-poker@${record.expectedLiveVersion.split('/').at(-1)} tony-poker:live --project tony-poker --config poker/firebase/firebase.json`;
    const append = status => {
      const values = [(opts.now?.() ?? new Date()).toISOString(), status, record.id, record.sourceVersion, record.expectedLiveVersion, record.approvalRef, record.manifestDigest, rollback];
      const fd = fs.openSync(opts.releasesLogPath, 'a');
      try { fs.writeFileSync(fd, `| ${values.map(v => String(v).replaceAll('|','\\|').replace(/[\r\n]/g,' ')).join(' | ')} |\n`); fs.fsyncSync(fd); wroteAnything = true; }
      finally { fs.closeSync(fd); }
    };
    append('PENDING');
    let released = false;
    try {
      await checkLive(); // Last external read before release; local lock serializes this tool.
      await opts.firebase.releaseVersionToLive(opts.siteId, record.sourceVersion);
      released = true;
      if (await opts.firebase.getChannelVersionName(opts.siteId, 'live') !== record.sourceVersion) throw new PromoteError('POST_VERIFY_VERSION', 'Live version differs after release');
      const post = await inspectArtifact(opts.firebase, record.sourceVersion);
      if (post.digest !== record.manifestDigest) throw new PromoteError('POST_VERIFY_MANIFEST', 'Post-release artifact/config differs');
      append('DONE');
    } catch (e) { append('FAILED'); e.released = released; throw e; }
    return {ok:true, approvalId:record.id, newLiveVersion:record.sourceVersion, previousLiveVersion:record.expectedLiveVersion, manifestDigest:record.manifestDigest, wroteAnything};
  } catch (e) { e.wroteAnything = wroteAnything; throw e; }
  finally { if (lock !== undefined) { fs.closeSync(lock); fs.unlinkSync(lockPath); } }
}
export async function buildApprovalRecord(opts) {
  // Quotes must reference an already identified immutable artifact; never resolve a mutable channel.
  assertImmutableVersionName(opts.source);
  assertImmutableVersionName(opts.expectedLiveVersion, 'expectedLiveVersion');
  for (const k of ['id','approverQuote','approvalRef']) requireText(opts[k], k);
  const live = await opts.firebase.getChannelVersionName(opts.siteId, 'live');
  if (live !== opts.expectedLiveVersion) throw new PromoteError('LIVE_DRIFT', 'Live differs at approval time');
  const artifact = await inspectArtifact(opts.firebase, opts.source);
  return validateApprovalRecord({id:opts.id, approverQuote:opts.approverQuote, approvalRef:opts.approvalRef, approvedAt:opts.approvedAt ?? (opts.now?.() ?? new Date()).toISOString(), sourceVersion:opts.source, expectedLiveVersion:live, manifest:artifact.manifest, servingConfig:artifact.servingConfig, manifestDigest:artifact.digest});
}
export function writeApprovalRecord(filePath, record, io = {}) {
  (io.mkdir ?? fs.mkdirSync)(path.dirname(filePath), {recursive:true});
  (io.writeFile ?? fs.writeFileSync)(filePath, `${JSON.stringify(record,null,2)}\n`, 'utf8');
}
