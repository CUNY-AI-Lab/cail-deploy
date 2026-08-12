---
name: kale-deploy
description: Prepare, publish, inspect, approve, reconcile, preview, and roll back Cloudflare Worker apps through the CUNY AI Lab Kale Deploy MCP release control plane. Use when the user asks to deploy with Kale or work with a Kale project or release.
---

# Kale Deploy

Kale Deploy publishes immutable Worker artifacts into the CUNY AI Lab Workers for Platforms namespace. Its MCP endpoint is:

`https://kale-release-control-plane.ailab-452.workers.dev/mcp`

The current public tool surface is:

- `kale.create_project`
- `kale.upload_revision`
- `kale.create_release`
- `kale.get_release`
- `kale.preview_project`
- `kale.approve_release`
- `kale.reconcile_release`
- `kale.rollback_release`

## Before publication

1. Read the repository README, AGENTS.md, source, and Wrangler configuration.
2. Confirm the app is a Cloudflare Module Worker and that its root route works locally in the real Workers runtime.
3. Run the repository's authoritative formatter, type-checker, tests, and build.
4. Use the bundled `scripts/prepare-artifact.mjs` helper to create exact artifact bytes and MCP upload arguments. The helper includes UTF-8 source files under `src/`, requires the declared entrypoint, rejects unsafe paths and binary input, and writes `.kale/artifact.json` plus `.kale/upload-arguments.json`.
5. Inspect the generated artifact before any external write. Never include `.env`, secrets, credentials, build output, dependencies, user data, or files outside the declared source roots.
6. Keep `.kale/` in the project ignore file. It is local release material, not application source.

Example:

```bash
bun <plugin-root>/scripts/prepare-artifact.mjs \
  --root . \
  --entrypoint src/index.ts \
  --compatibility-date 2026-07-22
```

The current release contract accepts no requested production bindings. If the app needs D1, R2, KV, secrets, or service bindings, stop and report that product boundary instead of inventing placeholders or bypassing it.

## Publish

1. Call `kale.create_project` once with the user-facing project name and a stable idempotency key. Preserve the returned `projectId` in the project handoff or release record.
2. Read `.kale/upload-arguments.json`, add that `projectId`, and call `kale.upload_revision`. The revision is content-addressed, so the same exact bytes resolve to the same revision.
3. Call `kale.create_release` with the returned `revisionId`, a stable idempotency key, and `approval: "required"` unless the user explicitly authorized automatic publication.
4. If the release reaches `awaiting_approval`, show the exact project, revision, and intended effect. Call `kale.approve_release` only after explicit approval.
5. Poll `kale.get_release` until it reaches `live`, `failed`, `publishing`, or `reconciling`. Do not claim success from an accepted release request.
6. Once live, call `kale.preview_project` and inspect the returned status, content type, and root body. This is an authenticated preview, not a public project hostname.

Use a stable idempotency key for each logical write and reuse that same key after an ambiguous response. Never generate a new key merely because a request timed out.

## Recovery

- For a transport error or timeout after a release write, call `kale.get_release` before retrying.
- A `publishing` or `reconciling` release with retained prepared bytes may be finished with `kale.reconcile_release`.
- Do not reconcile a queued, validating, building, awaiting-approval, live, or failed release.
- Rollback creates a new release from an earlier live release. It does not mutate history.
- Never claim a Worker rollback restores D1, R2, KV, Durable Object, Workflow, or container state.

## Current boundary before DNS

Publication and authenticated preview work without delegated DNS. A friendly public hostname does not. Until the lab namespace is delegated or Cloudflare for SaaS is deliberately configured, report the release as live inside Kale with an authenticated preview only. Do not create a temporary hostname scheme that will be removed later.

## Safety

- Keep prompt text, user records, secrets, and credentials out of artifacts and logs.
- Do not echo OAuth tokens or raw authorization headers.
- Do not publish unreviewed changes.
- Do not delete projects, revisions, releases, or dynamic Worker scripts. The current contract intentionally exposes no delete operation.
