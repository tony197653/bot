# Poker live deploy (process-only protection)

Convention for releasing **tony-poker** Hosting **live**. This is **not** IAM enforcement: anyone with Firebase Console / CLI credentials can still bypass it. Agents and humans agree to release live **only** through `scripts/promote-live.mjs`.

## What CI does

GitHub Actions (`.github/workflows/poker-deploy.yml`) deploys **previews only**:

| Event | Channel | Live? |
| --- | --- | --- |
| PR touching `poker/**` or `lib/**` | auto preview (7d) | no |
| Push to `main` touching `poker/**` or `lib/**` | preview channel `main` (30d) | no |

Changes under `.github/`, `scripts/`, or `deploy/` alone do **not** trigger hosting deploys.

There is **no** Actions path that deploys `channelId: live`.

## How to release live

1. Owner approves (existing approval card / chat). Agent captures the quote text.
2. Agent generates an approval record (hashes collected automatically — do not hand-type):

   ```bash
   node scripts/generate-approval.mjs \
     --id 2026-11-08-a1 \
     --source tony-poker:main \
     --expected-live sites/tony-poker/versions/<CURRENT_LIVE_VERSION_ID> \
     --quote "…owner approval quote…" \
     --out deploy/approvals/2026-11-08-a1.json
   ```

   `--source` may be `sites/tony-poker/versions/<id>`, `tony-poker@<id>`, or `tony-poker:<channel>`. The written record always stores the **immutable** `sites/…/versions/…` name.

3. Promote:

   ```bash
   node scripts/promote-live.mjs --approval deploy/approvals/2026-11-08-a1.json
   ```

### Gates (all required)

- Approval file exists and is valid.
- `expectedLiveVersion` baseline present (otherwise **refuse**; script never invents a baseline).
- Current live version **equals** that baseline (else **refuse** — live drifted).
- Full file manifest (every path + hash) of the source version **equals** the record.
- Only then release the exact approved version to live.
- After release: re-read live manifest; must match; append `deploy/releases.md`.

Auxiliary content checks (e.g. forbidden old-UI substrings) may run when enabled in `deploy/config.json`, but are never the sole evidence.

## Release command (documented, not guessed)

Immutable version → live uses Firebase CLI:

```bash
firebase hosting:clone tony-poker@<VERSION_ID> tony-poker:live --project tony-poker
```

Cited from:

- [Manage Hosting resources — version cloning](https://firebase.google.com/docs/hosting/manage-hosting-resources) (`SOURCE_SITE_ID@VERSION_ID`)
- [Firebase CLI reference](https://firebase.google.com/docs/cli)
- `firebase-tools` `hosting-clone.js`: for same-site, calls Hosting `releases.create` with `versionName=sites/…/versions/…`

Equivalent REST:

`POST https://firebasehosting.googleapis.com/v1beta1/sites/tony-poker/channels/live/releases?versionName=sites/tony-poker/versions/<VERSION_ID>`

Manifests come from [sites.versions.files.list](https://firebase.google.com/docs/reference/hosting/rest/v1beta1/sites.versions.files/list).

## Rollback

`deploy/releases.md` lists the previous live version per release. Re-promote that version with a new approval record, or (manual bypass) `firebase hosting:clone tony-poker@<previousVersionId> tony-poker:live`.

## Tests

```bash
node --test deploy/test/*.test.js
```

Tests inject a mock Firebase adapter and make **zero** network calls.
