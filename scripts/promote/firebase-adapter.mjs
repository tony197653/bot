import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PromoteError, assertImmutableVersionName, requireText, canonicalizeManifest } from './lib.mjs';
const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
export function firebaseCommand(projectId, args) {
  requireText(projectId, 'projectId');
  return {args: [...args, '--project', projectId, '--config', 'poker/firebase/firebase.json'], cwd: ROOT};
}
export function cloneArguments(siteId, versionName) {
  requireText(siteId, 'siteId');
  assertImmutableVersionName(versionName);
  if (siteId !== 'tony-poker') throw new PromoteError('INVALID_SITE', 'Expected tony-poker');
  const [,sourceSite,,id] = versionName.split('/');
  return ['hosting:clone', `${sourceSite}@${id}`, `${siteId}:live`];
}
function runCommand(cmd, args, options) {
  const res = spawnSync(cmd, args, {...options, encoding:'utf8'});
  if (res.status !== 0) throw new PromoteError('CLI_FAILED', `Firebase CLI failed: ${res.stderr || res.error || res.status}`);
  return res;
}
export function createFirebaseAdapter(opts) {
  requireText(opts?.projectId, 'projectId');
  const run = opts.run ?? runCommand;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const env = opts.env ?? process.env;
  const cli = args => {
    // Both CLI and REST require an explicitly selected credential, never ambient gcloud.
    requireText(env.GOOGLE_APPLICATION_CREDENTIALS, 'GOOGLE_APPLICATION_CREDENTIALS (explicit ADC credential file required)');
    const command = firebaseCommand(opts.projectId, args);
    const res = run(opts.firebaseBin ?? 'firebase', command.args, {cwd:command.cwd, env:{...env, FIREBASE_TOKEN:undefined}});
    if (res.status !== 0) throw new PromoteError('CLI_FAILED', 'Firebase CLI failed');
    return res;
  };
  async function request(resource) {
    requireText(env.GOOGLE_APPLICATION_CREDENTIALS, 'GOOGLE_APPLICATION_CREDENTIALS (explicit ADC credential file required)');
    // Supply an OAuth2 access token explicitly minted for the selected ADC credential.
    const token = opts.getAccessToken ? await opts.getAccessToken() : env.HOSTING_ACCESS_TOKEN;
    requireText(token, 'HOSTING_ACCESS_TOKEN (OAuth2 access token for selected ADC credential required)');
    const res = await fetchImpl(`https://firebasehosting.googleapis.com/v1beta1/${resource}`, {headers:{Authorization:`Bearer ${token}`}});
    if (!res.ok) throw new PromoteError('REST_FAILED', `Hosting REST failed: ${res.status}`);
    return res.json();
  }
  return {
    async getChannelVersionName(siteId, channelId) {
      requireText(siteId, 'siteId'); requireText(channelId, 'channelId');
      const body = JSON.parse(cli(['hosting:channel:list','--site',siteId,'--json']).stdout);
      const channels = body?.result?.channels ?? body?.channels;
      if (!Array.isArray(channels)) throw new PromoteError('INVALID_RESPONSE', 'Missing channels');
      const ch = channels.find(c => c?.id === channelId || (typeof c?.name === 'string' && c.name.endsWith(`/channels/${channelId}`)));
      const name = ch?.release?.version?.name;
      assertImmutableVersionName(name, 'channel version');
      return name;
    },
    async getVersion(name) { assertImmutableVersionName(name); return request(name); },
    async listVersionFiles(name) {
      assertImmutableVersionName(name);
      const files = [];
      let token;
      do {
        const body = await request(`${name}/files${token ? `?pageToken=${encodeURIComponent(token)}` : ''}`);
        if (body.files !== undefined && !Array.isArray(body.files)) throw new PromoteError('INVALID_MANIFEST', 'files must be an array');
        files.push(...(body.files ?? []));
        token = body.nextPageToken;
        if (token !== undefined) requireText(token, 'nextPageToken');
      } while (token);
      canonicalizeManifest(files); // Includes duplicate path/type guards across all pages.
      return files;
    },
    async releaseVersionToLive(siteId, name) { cli(cloneArguments(siteId, name)); },
  };
}
