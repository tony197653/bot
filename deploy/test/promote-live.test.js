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
    fs.writeFileSync(releasesLog, '| time | approval | new | prev |\n| --- | --- | --- | --- |\n');
    state = baseState();
    firebase = makeMockFirebase(state);
  });

  function approval(extra = {}) {
    return {
      id: 'test-allow',
      approverQuote: 'Ship the preview we just checked.',
      approvedAt: '2026-11-08T00:00:00.000Z',
      sourceVersion: SRC_V,
      expectedLiveVersion: LIVE_V,
      manifest: state.manifest,
      manifestDigest: state.digest,
      ...extra,
    };
  }

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
  it('resolves channel source to immutable version and fills manifest', async () => {
    const state = baseState();
    const firebase = makeMockFirebase(state);
    const record = await buildApprovalRecord({
      id: 'gen-1',
      approverQuote: 'ok',
      source: `${SITE}:main`,
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
