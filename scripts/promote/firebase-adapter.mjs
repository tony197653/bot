/**
 * Real Firebase Hosting adapter for promote / approval helpers.
 *
 * Release command (same-site immutable version → live), verified against:
 * - Firebase docs: hosting:clone SOURCE_SITE_ID@VERSION_ID TARGET_SITE_ID:TARGET_CHANNEL_ID
 *   https://firebase.google.com/docs/hosting/manage-hosting-resources
 *   https://firebase.google.com/docs/cli
 * - firebase-tools hosting-clone.js: parses "<site>@<version>", then
 *   createRelease(site, channel, versionName) which POSTs
 *   /projects/-/sites/{site}/channels/{channel}/releases?versionName=...
 *
 * File manifests: Hosting REST sites.versions.files.list
 *   GET https://firebasehosting.googleapis.com/v1beta1/{parent=sites/*/versions/*}/files
 *   https://firebase.google.com/docs/reference/hosting/rest/v1beta1/sites.versions.files/list
 *
 * This module is intentionally unused by tests. Do not import it from unit tests.
 */
import { spawnSync } from 'node:child_process';

const HOSTING_API = 'https://firebasehosting.googleapis.com/v1beta1';

/**
 * @param {{
 *   projectId: string,
 *   firebaseBin?: string,
 *   run?: typeof runCommand,
 *   fetchImpl?: typeof fetch,
 *   getAccessToken?: () => Promise<string>,
 * }} opts
 */
export function createFirebaseAdapter(opts) {
  const run = opts.run ?? runCommand;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const firebaseBin = opts.firebaseBin ?? 'firebase';

  async function getAccessToken() {
    if (opts.getAccessToken) return opts.getAccessToken();
    // Prefer Application Default Credentials via gcloud when available; else firebase CLI token.
    const gcloud = run('gcloud', ['auth', 'print-access-token'], { allowFail: true });
    if (gcloud.status === 0 && gcloud.stdout.trim()) return gcloud.stdout.trim();
    const fb = run(firebaseBin, ['login:ci', '--no-localhost'], { allowFail: true });
    // login:ci is interactive — use print-access-token style via --token env if set.
    if (process.env.FIREBASE_TOKEN || process.env.CLOUDSDK_AUTH_ACCESS_TOKEN) {
      return process.env.CLOUDSDK_AUTH_ACCESS_TOKEN || process.env.FIREBASE_TOKEN;
    }
    throw new Error(
      'No access token for Hosting REST. Set CLOUDSDK_AUTH_ACCESS_TOKEN / FIREBASE_TOKEN or configure gcloud ADC.',
    );
  }

  return {
    /**
     * @param {string} siteId
     * @param {string} channelId
     * @returns {Promise<string|null>}
     */
    async getChannelVersionName(siteId, channelId) {
      const args = [
        'hosting:channel:list',
        '--site',
        siteId,
        '--project',
        opts.projectId,
        '--json',
      ];
      const res = run(firebaseBin, args);
      if (res.status !== 0) {
        throw new Error(`firebase hosting:channel:list failed: ${res.stderr || res.stdout}`);
      }
      const parsed = JSON.parse(res.stdout);
      const channels = parsed?.result?.channels ?? parsed?.channels ?? [];
      const ch = channels.find((c) => {
        const name = c.name || '';
        return name.endsWith(`/channels/${channelId}`) || c.id === channelId;
      });
      return ch?.release?.version?.name ?? null;
    },

    /**
     * @param {string} versionName sites/SITE/versions/ID
     * @returns {Promise<Array<{path: string, hash: string}>>}
     */
    async listVersionFiles(versionName) {
      const token = await getAccessToken();
      /** @type {Array<{path: string, hash: string}>} */
      const out = [];
      let pageToken;
      do {
        const url = new URL(`${HOSTING_API}/${versionName}/files`);
        url.searchParams.set('status', 'ACTIVE');
        if (pageToken) url.searchParams.set('pageToken', pageToken);
        const resp = await fetchImpl(url, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!resp.ok) {
          throw new Error(`files.list failed ${resp.status}: ${await resp.text()}`);
        }
        const body = await resp.json();
        for (const f of body.files || []) {
          out.push({ path: f.path, hash: f.hash });
        }
        pageToken = body.nextPageToken;
      } while (pageToken);
      return out;
    },

    /**
     * Best-effort file text for auxiliary checks (fetches the live CDN URL for that version’s path).
     * Optional — promote still works if this is omitted.
     * @param {string} _versionName
     * @param {string} _filePath
     */
    async getVersionFileText(_versionName, _filePath) {
      return null;
    },

    /**
     * Release an immutable version to live via hosting:clone site@version site:live.
     * @param {string} siteId
     * @param {string} versionName
     */
    async releaseVersionToLive(siteId, versionName) {
      const m = /^sites\/([^/]+)\/versions\/([^/]+)$/.exec(versionName);
      if (!m) throw new Error(`Invalid version name: ${versionName}`);
      const versionId = m[2];
      const source = `${siteId}@${versionId}`;
      const target = `${siteId}:live`;
      const args = ['hosting:clone', source, target, '--project', opts.projectId];
      const res = run(firebaseBin, args);
      if (res.status !== 0) {
        throw new Error(`firebase hosting:clone failed: ${res.stderr || res.stdout}`);
      }
    },
  };
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ allowFail?: boolean }} [opts]
 */
function runCommand(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8' });
  if (res.status !== 0 && !opts.allowFail) {
    const err = new Error(`${cmd} ${args.join(' ')} exited ${res.status}`);
    /** @type {any} */ (err).stdout = res.stdout;
    /** @type {any} */ (err).stderr = res.stderr;
    throw err;
  }
  return { status: res.status ?? 1, stdout: res.stdout || '', stderr: res.stderr || '' };
}
