import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
let forbiddenCalls = 0;
const deny = () => { forbiddenCalls++; const error = new Error('NETWORK_OR_PROCESS_FORBIDDEN'); fs.writeSync(2, error.stack + '\n'); throw error; };
globalThis.fetch = deny;
for (const mod of [http, https]) for (const key of ['request','get']) mod[key] = deny;
for (const key of ['connect','createConnection']) net[key] = deny;
for (const key of ['spawn','exec','execFile','execSync','spawnSync','execFileSync']) childProcess[key] = deny;
syncBuiltinESMExports();
const { createFirebaseAdapter, firebaseCommand, cloneArguments } = await import('../../scripts/promote/firebase-adapter.mjs');
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  promoteLive,
  buildApprovalRecord,
  writeApprovalRecord,
  canonicalizeManifest,
  PromoteError,
  VERSION_NAME_RE,
  validateApprovalRecord,
  assertImmutableVersionName,
} from '../../scripts/promote/lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const WORKFLOW = path.join(ROOT, '.github/workflows/poker-deploy.yml');

const SITE = 'tony-poker';
const LIVE_V = `sites/${SITE}/versions/livebase001`;
const SRC_V = `sites/${SITE}/versions/srcgood001`;
const FILES = [
  { path: '/poker/index.html', hash: 'aaa111' },
  { path: '/poker/js/ui/lobby.js', hash: 'bbb222' },
];

function makeMockFirebase(state) {
  return {
    async getChannelVersionName(siteId, channelId) {
      state.calls.push(['getChannelVersionName', siteId, channelId]);
      if (state.network) throw new Error('NETWORK_FORBIDDEN');
      return state.channels[`${siteId}:${channelId}`] ?? null;
    },
    async getVersion(versionName) {
      return {name:versionName, status:state.status ?? 'FINALIZED', fileCount:state.fileCount ?? state.files[versionName].length, config:state.servingConfig ?? {}};
    },
    async listVersionFiles(versionName) {
      state.calls.push(['listVersionFiles', versionName]);
      if (state.network) throw new Error('NETWORK_FORBIDDEN');
      const files = state.files[versionName];
      if (!files) throw new Error(`no files for ${versionName}`);
      return files.map((f) => ({ ...f }));
    },
    async getVersionFileText(versionName, filePath) {
      state.calls.push(['getVersionFileText', versionName, filePath]);
      return state.fileText?.[versionName]?.[filePath] ?? null;
    },
    async releaseVersionToLive(siteId, versionName) {
      state.calls.push(['releaseVersionToLive', siteId, versionName]);
      if (state.failRelease) throw new Error('release failed');
      state.channels[`${siteId}:live`] = versionName;
      if (state.postReleaseFiles) {
        state.files[versionName] = state.postReleaseFiles;
      }
    },
  };
}

function baseState(overrides = {}) {
  const { manifest, digest } = canonicalizeManifest(FILES);
  return {
    network: false,
    calls: [],
    channels: {
      [`${SITE}:live`]: LIVE_V,
      [`${SITE}:main`]: SRC_V,
    },
    files: {
      [LIVE_V]: FILES.map((f) => ({ ...f, hash: f.hash + 'old' })),
      [SRC_V]: FILES.map((f) => ({ ...f })),
    },
    fileText: {},
    manifest,
    digest,
    ...overrides,
  };
}

function writeRecord(dir, record) {
  const p = path.join(dir, `${record.id}.json`);
  writeApprovalRecord(p, record);
  return p;
}

describe('workflow: no automatic live deploy', () => {
  it('does not set channelId live and only previews on main', () => {
    const yml = fs.readFileSync(WORKFLOW, 'utf8');
    assert.equal(yml.includes('channelId: live'), false);
    assert.equal(/Deploy live \(main\)/.test(yml), false);
    assert.match(yml, /channelId:\s*main/);
    assert.match(yml, /Previews only/);
    // process-only paths must not trigger hosting
    assert.equal(yml.includes(".github/workflows/poker-deploy.yml"), false);
    assert.match(yml, /poker\/\*\*/);
    assert.match(yml, /lib\/\*\*/);
  });
});

describe('promoteLive (mocked Firebase)', () => {
  /** @type {string} */
  let tmp;
  /** @type {string} */
  let releasesLog;
  /** @type {ReturnType<typeof baseState>} */
  let state;
  /** @type {ReturnType<typeof makeMockFirebase>} */
  let firebase;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-'));
    releasesLog = path.join(tmp, 'releases.md');
    fs.writeFileSync(releasesLog, `| 2026-11-08 | BASELINE | initial | ${LIVE_V} | | | | |\n`);
    state = baseState();
    firebase = makeMockFirebase(state);
  });

  function approval(extra = {}) {
    return {
      id: 'test-allow',
      approvalRef: '宗良/card/123',
      servingConfig: {},
      approverQuote: 'Ship the preview we just checked.',
      approvedAt: '2026-11-08T00:00:00.000Z',
      sourceVersion: SRC_V,
      expectedLiveVersion: LIVE_V,
      manifest: state.manifest,
      manifestDigest: state.digest,
      ...extra,
    };
  }

  async function run(extra = {}) {
    return promoteLive({approvalPath:writeRecord(tmp, approval(extra)), releasesLogPath:releasesLog, siteId:SITE, firebase});
  }
  it('refuses absent recorded baseline', async () => {
    fs.writeFileSync(releasesLog, '# Empty log\n');
    await assert.rejects(() => run(), e => e.code === 'NO_BASELINE');
    assert.equal(state.calls.length, 0);
  });
  it('refuses missing approvalRef', async () => {
    await assert.rejects(() => run({approvalRef:''}), PromoteError);
    assert.equal(state.calls.length, 0);
  });
  it('refuses missing or mismatched full manifest hash', async () => {
    for (const manifestDigest of [undefined, 'bad']) await assert.rejects(() => run({manifestDigest}), PromoteError);
    assert.equal(state.calls.length, 0);
  });
  it('serving config is bound to approval', async () => {
    state.servingConfig = {redirects:[{glob:'/', location:'/other'}]};
    await assert.rejects(() => run(), e => e.code === 'MANIFEST_MISMATCH');
  });
  it('rejects version not FINALIZED', async () => {
    state.status = 'CREATED';
    await assert.rejects(() => run(), e => e.code === 'INVALID_VERSION_STATUS');
  });
  it('rejects fileCount mismatch', async () => {
    state.fileCount = 3;
    await assert.rejects(() => run(), e => e.code === 'FILE_COUNT_MISMATCH');
  });
  it('refuses held lock without removing it', async () => {
    const lock = path.join(tmp, '.promote.lock');
    fs.writeFileSync(lock, 'held');
    await assert.rejects(() => run(), e => e.code === 'LOCKED');
    assert.equal(fs.readFileSync(lock, 'utf8'), 'held');
    assert.equal(state.calls.length, 0);
  });
  it('rechecks live immediately before release and logs FAILED on drift', async () => {
    let count = 0;
    const original = firebase.getChannelVersionName;
    firebase.getChannelVersionName = async (...args) => {
      if (++count === 2) state.channels[`${SITE}:live`] = `sites/${SITE}/versions/changed`;
      return original(...args);
    };
    await assert.rejects(() => run(), e => e.code === 'LIVE_DRIFT');
    assert.equal(state.calls.some(c => c[0] === 'releaseVersionToLive'), false);
    assert.match(fs.readFileSync(releasesLog,'utf8'), /PENDING[^]*FAILED/);
    assert.equal(fs.existsSync(path.join(tmp,'.promote.lock')), false);
  });
  it('release error logs durable PENDING then FAILED and releases lock', async () => {
    state.failRelease = true;
    const original = firebase.releaseVersionToLive;
    firebase.releaseVersionToLive = async (...args) => {
      assert.match(fs.readFileSync(releasesLog,'utf8'), /PENDING/);
      return original(...args);
    };
    await assert.rejects(() => run(), /release failed/);
    const log = fs.readFileSync(releasesLog,'utf8');
    assert.match(log, /PENDING[^]*FAILED/);
    assert.match(log, /宗良\/card\/123/);
    assert.match(log, /firebase hosting:clone tony-poker@livebase001 tony-poker:live/);
    assert.ok(log.includes(state.digest));
    assert.equal(fs.existsSync(path.join(tmp,'.promote.lock')), false);
  });
  it('allow path: releases approved version, verifies, appends release log', async () => {
    const approvalPath = writeRecord(tmp, approval());
    const before = fs.readdirSync(tmp);
    const result = await promoteLive({
      approvalPath,
      releasesLogPath: releasesLog,
      siteId: SITE,
      firebase,
    });
    assert.equal(result.ok, true);
    assert.equal(result.newLiveVersion, SRC_V);
    assert.equal(result.previousLiveVersion, LIVE_V);
    assert.equal(state.channels[`${SITE}:live`], SRC_V);
    assert.ok(state.calls.some((c) => c[0] === 'releaseVersionToLive'));
    const log = fs.readFileSync(releasesLog, 'utf8');
    assert.match(log, /test-allow/);
    assert.match(log, new RegExp(SRC_V));
    assert.match(log, new RegExp(LIVE_V));
    // no new baseline/approval files written by promote itself
    assert.deepEqual(fs.readdirSync(tmp).sort(), [...before].sort());
  });

  it('refuse when no approval record', async () => {
    const missing = path.join(tmp, 'missing.json');
    await assert.rejects(
      () =>
        promoteLive({
          approvalPath: missing,
          releasesLogPath: releasesLog,
          siteId: SITE,
          firebase,
        }),
      (e) => e instanceof PromoteError && e.code === 'NO_RECORD',
    );
    assert.equal(state.calls.length, 0);
    assert.equal(fs.readFileSync(releasesLog, 'utf8').includes('test-allow'), false);
  });

  it('refuse when no baseline (expectedLiveVersion empty) and write nothing', async () => {
    const bad = approval({ expectedLiveVersion: '' });
    // bypass writer validation by hand
    const approvalPath = path.join(tmp, 'nobase.json');
    fs.writeFileSync(
      approvalPath,
      JSON.stringify({ ...bad, expectedLiveVersion: '' }),
    );
    const logBefore = fs.readFileSync(releasesLog, 'utf8');
    await assert.rejects(
      () =>
        promoteLive({
          approvalPath,
          releasesLogPath: releasesLog,
          siteId: SITE,
          firebase,
        }),
      (e) => e instanceof PromoteError && (e.code === 'INVALID_RECORD' || e.code === 'NO_BASELINE'),
    );
    assert.equal(fs.readFileSync(releasesLog, 'utf8'), logBefore);
    assert.ok(!state.calls.some((c) => c[0] === 'releaseVersionToLive'));
  });

  it('refuse when live drifted from expected baseline; no baseline written', async () => {
    state.channels[`${SITE}:live`] = `sites/${SITE}/versions/drifted999`;
    const approvalPath = writeRecord(tmp, approval());
    const entriesBefore = new Set(fs.readdirSync(tmp));
    await assert.rejects(
      () =>
        promoteLive({
          approvalPath,
          releasesLogPath: releasesLog,
          siteId: SITE,
          firebase,
        }),
      (e) => e instanceof PromoteError && e.code === 'LIVE_DRIFT' && e.wroteAnything === false,
    );
    assert.deepEqual(new Set(fs.readdirSync(tmp)), entriesBefore);
    assert.ok(!state.calls.some((c) => c[0] === 'releaseVersionToLive'));
  });

  it('refuse when manifest differs by one file', async () => {
    const rec = approval();
    rec.manifest = { ...rec.manifest, '/poker/index.html': 'DIFFERENT_HASH' };
    rec.manifestDigest = canonicalizeManifest(rec.manifest).digest;
    const approvalPath = writeRecord(tmp, rec);
    await assert.rejects(
      () =>
        promoteLive({
          approvalPath,
          releasesLogPath: releasesLog,
          siteId: SITE,
          firebase,
        }),
      (e) => e instanceof PromoteError && e.code === 'MANIFEST_MISMATCH',
    );
    assert.ok(!state.calls.some((c) => c[0] === 'releaseVersionToLive'));
  });

  it('refuse when record references a channel instead of a version', async () => {
    const approvalPath = path.join(tmp, 'channel.json');
    fs.writeFileSync(
      approvalPath,
      JSON.stringify({
        ...approval(),
        sourceVersion: `${SITE}:main`,
      }),
    );
    await assert.rejects(
      () =>
        promoteLive({
          approvalPath,
          releasesLogPath: releasesLog,
          siteId: SITE,
          firebase,
        }),
      (e) => e instanceof PromoteError && e.code === 'INVALID_VERSION_NAME',
    );
    assert.equal(VERSION_NAME_RE.test(`${SITE}:main`), false);
  });

  it('reports post-release verification failure', async () => {
    state.postReleaseFiles = [
      { path: '/poker/index.html', hash: 'tampered' },
      { path: '/poker/js/ui/lobby.js', hash: 'bbb222' },
    ];
    const approvalPath = writeRecord(tmp, approval());
    await assert.rejects(
      () =>
        promoteLive({
          approvalPath,
          releasesLogPath: releasesLog,
          siteId: SITE,
          firebase,
        }),
      (e) =>
        e instanceof PromoteError &&
        e.code === 'POST_VERIFY_MANIFEST' &&
        e.released === true,
    );
  });

  it('no baseline written on refusal (first-run style)', async () => {
    const approvalPath = path.join(tmp, 'does-not-exist.json');
    const before = fs.readdirSync(tmp);
    await assert.rejects(
      () =>
        promoteLive({
          approvalPath,
          releasesLogPath: releasesLog,
          siteId: SITE,
          firebase,
        }),
      (e) => e.code === 'NO_RECORD' && e.wroteAnything === false,
    );
    assert.deepEqual(fs.readdirSync(tmp), before);
  });

  it('auxiliary forbidden-string check can refuse (never sole evidence path covered separately)', async () => {
    state.fileText = {
      [SRC_V]: {
        '/poker/js/ui/lobby.js': 'button 同一支手機輪流玩',
      },
    };
    const approvalPath = writeRecord(tmp, approval());
    await assert.rejects(
      () =>
        promoteLive({
          approvalPath,
          releasesLogPath: releasesLog,
          siteId: SITE,
          firebase,
          auxiliaryContentChecks: [
            { path: '/poker/js/ui/lobby.js', forbiddenSubstring: '同一支手機輪流玩' },
          ],
        }),
      (e) => e instanceof PromoteError && e.code === 'AUX_FORBIDDEN_STRING',
    );
  });
});

describe('buildApprovalRecord helper', () => {
  it('binds immutable source and fills manifest', async () => {
    const state = baseState();
    const firebase = makeMockFirebase(state);
    const record = await buildApprovalRecord({
      id: 'gen-1',
      approverQuote: 'ok',
      source: SRC_V,
      approvalRef: '宗良/card/123',
      expectedLiveVersion: LIVE_V,
      siteId: SITE,
      firebase,
      now: () => new Date('2026-11-08T12:00:00.000Z'),
    });
    assert.equal(record.sourceVersion, SRC_V);
    assert.ok(VERSION_NAME_RE.test(record.sourceVersion));
    assert.equal(record.manifestDigest, state.digest);
    assert.equal(record.manifest['/poker/index.html'], 'aaa111');
  });

  it('rejects expectedLiveVersion that is a channel name', async () => {
    const state = baseState();
    const firebase = makeMockFirebase(state);
    await assert.rejects(
      () =>
        buildApprovalRecord({
          id: 'gen-2',
          approverQuote: 'ok',
          source: SRC_V,
          expectedLiveVersion: `${SITE}:live`,
          siteId: SITE,
          firebase,
        }),
      (e) => e.code === 'INVALID_VERSION_NAME',
    );
  });
});

describe('isolation', () => {
  it('mock adapter never implies network', async () => {
    const state = baseState({ network: true });
    const firebase = makeMockFirebase(state);
    // With network flag, any call throws — prove promote refuses before needing network when no record
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-net-'));
    await assert.rejects(
      () =>
        promoteLive({
          approvalPath: path.join(tmp, 'x.json'),
          releasesLogPath: path.join(tmp, 'r.md'),
          siteId: SITE,
          firebase,
        }),
      (e) => e.code === 'NO_RECORD',
    );
  });
});

describe('guards and adapter helpers with injected execution only', () => {
  it('duplicate normalized paths throw', () => {
    assert.throws(() => canonicalizeManifest([{path:'x',hash:'a'},{path:'/x',hash:'a'}]), e => e.code === 'DUPLICATE_PATH');
  });
  it('bad types throw PromoteError', async () => {
    for (const bad of [null, 1, {}, [], 'channel']) assert.throws(() => assertImmutableVersionName(bad), PromoteError);
    for (const bad of [null, 1, [{path:1,hash:'a'}], [{path:'x',hash:null}]]) assert.throws(() => canonicalizeManifest(bad), PromoteError);
    assert.throws(() => validateApprovalRecord(null), PromoteError);
    await assert.rejects(() => buildApprovalRecord({source:12}), PromoteError);
    assert.throws(() => cloneArguments(null, SRC_V), PromoteError);
  });
  it('hash uses sorted paths/config keys and changes with config', () => {
    assert.equal(canonicalizeManifest(FILES,{b:2,a:1}).digest, canonicalizeManifest([...FILES].reverse(),{a:1,b:2}).digest);
    assert.notEqual(canonicalizeManifest(FILES,{}).digest, canonicalizeManifest(FILES,{headers:[]}).digest);
  });
  it('approval generation refuses mutable channel', async () => {
    await assert.rejects(() => buildApprovalRecord({source:`${SITE}:main`}), PromoteError);
  });
  it('builds clone source and config/cwd without spawning', async () => {
    const calls = [];
    const adapter = createFirebaseAdapter({projectId:SITE, env:{GOOGLE_APPLICATION_CREDENTIALS:'/explicit/adc.json'}, run:(...args) => {calls.push(args);return {status:0,stdout:'{}'};}});
    await adapter.releaseVersionToLive(SITE, SRC_V);
    assert.deepEqual(calls[0][1], ['hosting:clone','tony-poker@srcgood001','tony-poker:live','--project',SITE,'--config','poker/firebase/firebase.json']);
    assert.equal(calls[0][2].cwd, ROOT);
    assert.equal(calls[0][2].env.FIREBASE_TOKEN, undefined);
    assert.equal(JSON.stringify(calls).includes('login:ci'), false);
    assert.equal(firebaseCommand(SITE,[]).cwd, ROOT);
  });
  it('explicit credentials required; FIREBASE_TOKEN alone never used', async () => {
    const adapter = createFirebaseAdapter({projectId:SITE, env:{FIREBASE_TOKEN:'not-oauth'}, run:() => {throw new Error('unexpected exec');}});
    await assert.rejects(() => adapter.getVersion(SRC_V), PromoteError);
    await assert.rejects(() => adapter.releaseVersionToLive(SITE,SRC_V), PromoteError);
    const noToken = createFirebaseAdapter({projectId:SITE, env:{GOOGLE_APPLICATION_CREDENTIALS:'/adc',FIREBASE_TOKEN:'bad'}});
    await assert.rejects(() => noToken.getVersion(SRC_V), PromoteError);
  });
  it('adapter malformed channel throws instead of returning null', async () => {
    const adapter = createFirebaseAdapter({projectId:SITE,env:{GOOGLE_APPLICATION_CREDENTIALS:'/adc'},run:() => ({status:0,stdout:'{"channels":[]}'})});
    await assert.rejects(() => adapter.getChannelVersionName(SITE,'live'), PromoteError);
  });
  it('adapter validates duplicate paths across REST pages using injected fetch', async () => {
    let page = 0;
    const adapter = createFirebaseAdapter({projectId:SITE,env:{GOOGLE_APPLICATION_CREDENTIALS:'/adc',HOSTING_ACCESS_TOKEN:'oauth'},fetchImpl:async () => ({ok:true,json:async () => ++page === 1 ? {files:[FILES[0]],nextPageToken:'next'} : {files:[FILES[0]]}})});
    await assert.rejects(() => adapter.listVersionFiles(SRC_V), e => e.code === 'DUPLICATE_PATH');
  });
  it('real network/process adapter transports were never invoked', () => {
    assert.equal(forbiddenCalls, 0);
  });
});
