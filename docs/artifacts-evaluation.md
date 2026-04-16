# Cloudflare Artifacts Evaluation

This note records the initial product and architecture read on Cloudflare Artifacts for Kale Deploy.

Current status as of April 16, 2026:

- Cloudflare announced Artifacts as a versioned storage service that speaks Git.
- Artifacts is in private beta for paid Workers plans, with public beta targeted for early May 2026.
- Artifacts can create repos programmatically, import from existing Git repositories, fork repos, expose normal HTTPS Git remotes, and attach metadata through git notes.
- Cloudflare also describes future event subscriptions, SDKs, search APIs, and a Workers Builds API.

Sources:

- Cloudflare announcement: `https://blog.cloudflare.com/artifacts-git-for-agents-beta/`
- Workers Builds overview: `https://developers.cloudflare.com/workers/ci-cd/builds/`
- Workers Builds API reference: `https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/`

## Current Kale Shape

Kale Deploy is intentionally GitHub-first today:

1. A user connects a GitHub repository through the shared GitHub App.
2. GitHub sends push webhooks to the deploy service.
3. The deploy service creates GitHub check runs, records build state in D1, and enqueues a build job.
4. The AWS-hosted build runner leases a fresh GitHub installation token and downloads the exact commit archive.
5. The deploy service uploads the built result to Workers for Platforms and completes the GitHub check run.

The source-fetch contract is currently GitHub-specific. `GET /internal/build-jobs/:jobId/source` returns a GitHub archive URL plus a GitHub installation token, and the runner extracts the tarball before building.

## Recommendation

Do not introduce an Artifacts-only project lane first.

The better first experiment is an optional Artifacts mirror for GitHub-backed projects:

- GitHub remains canonical for users, classroom workflows, check runs, reviews, and social sharing.
- The deploy service optionally imports or syncs each connected GitHub repository into Artifacts.
- The build runner prefers an Artifacts source lease when available and falls back to the existing GitHub archive lease.
- Lifecycle smoke measures clone/fetch time, failure rate, and deployment correctness against the existing GitHub path.

That gives Kale an operational win without changing the product contract students see.

## Why Mirror First

Artifacts import from GitHub changes the tradeoff. Kale does not need to choose between "GitHub projects" and "Artifacts projects" at the start. A mirror can sit beside the current GitHub App flow.

Potential wins:

- Reduce runner hot-path dependence on GitHub archive downloads.
- Give Kale a Cloudflare-side source mirror for retry and incident tolerance.
- Preserve git-native history that can later support richer rollback, diffs, and deployment provenance.
- Keep a path open for fast fork-from-template and agent-session scratch repos.
- Avoid changing the public onboarding flow while Artifacts is still beta.

What does not change:

- Workers for Platforms remains the deploy target.
- The gateway and host proxy are unaffected.
- MCP/OAuth remains the control surface for agents.
- GitHub check runs remain the status surface for GitHub-backed repositories.
- The build runner still needs real compute for dependency install and bundling until Workers Builds exposes enough API surface for Kale's build and upload contract.

## Proposed Pilot

Add a disabled-by-default mirror path, gated by an explicit production variable such as `ARTIFACTS_MIRROR_ENABLED=true`.

Phase 1: model and lease shape

- Add D1 columns or a side table keyed by GitHub repo and commit SHA:
  - `github_repo`
  - `github_sha`
  - `artifacts_repo_name`
  - `artifacts_remote_url`
  - `artifacts_import_status`
  - `artifacts_imported_at`
  - `last_error`
- Extend the build source lease with a provider-discriminated shape:
  - `provider: "github_archive"` for the existing path
  - `provider: "artifacts_git"` for a Git remote plus short-lived token
- Keep the existing queue message compatible by making the source lease endpoint authoritative.

Phase 2: deploy-service import

- On repository registration, import the GitHub default branch into Artifacts when the feature flag is enabled.
- On push webhook, import or sync the pushed commit before queueing the build if the Artifacts API supports that cheaply.
- If import/sync fails, record the failure and enqueue the build using the GitHub fallback path.
- Do not fail user deploys only because the mirror is unavailable.

Phase 3: runner source checkout

- Teach the runner to handle `provider: "artifacts_git"` by cloning or fetching the requested SHA from the Artifacts remote.
- Keep the current GitHub tarball extractor as the fallback path.
- Record source provider, checkout duration, and checkout failure reason in runner logs and build completion metadata.

Phase 4: measurement

- Add lifecycle-smoke variants:
  - default GitHub archive path
  - Artifacts mirror preferred path
  - forced GitHub fallback after simulated Artifacts failure
- Compare:
  - source checkout duration
  - build success/failure rate
  - total push-to-live time
  - mirror import/sync latency
  - any GitHub API rate-limit reduction

## Later Options

Only after the mirror path is reliable:

- Use Artifacts history as a richer rollback source while keeping R2 bundles for deployable artifacts and fast restore.
- Store deployment metadata in git notes, such as runtime lane, build job ID, deploy outcome, and agent attribution.
- Hold starter templates as Artifacts repos and fork them for new projects.
- Offer an Artifacts-only "agent scratch" lane for users who are not ready to connect GitHub.
- Evaluate Workers Builds once its API supports Kale's required build, evidence, and upload handoff.

## Risks

- Artifacts is still beta and may change API shape or pricing.
- A mirror adds another lifecycle to monitor: import status, credentials, sync drift, retention, and cleanup.
- GitHub remains canonical, so Kale must avoid confusing users with a second visible source-of-truth.
- Artifacts history is source history, not a full replacement for R2 deployment bundles. The built output may include generated files, static assets, and Worker upload metadata that are not identical to source.
- If Artifacts is used for rollback, Kale still needs to know whether the original build was reproducible and whether dependencies changed since that commit.

## Open Questions

- Does Artifacts expose an efficient incremental sync from GitHub, or is `.import()` effectively a full import?
- Can Artifacts issue short-lived credentials scoped to a single repo or ref for the build runner?
- Can a Worker import private GitHub repos using the existing Kale GitHub App installation token, or does Artifacts need its own GitHub authorization path?
- What are the limits for repo size, packfile size, LFS, large binary blobs, and concurrent imports?
- Are Event Subscriptions available soon enough to drive future Artifacts-backed deploy triggers?
- How stable are the public REST and Workers APIs once the public beta opens?

## Decision For Now

Keep Kale GitHub-first.

Track Artifacts as a promising build-source mirror and future rollback/provenance layer. Do not change public onboarding, project registration, or the runtime manifest until Cloudflare's public beta API is available and a mirror experiment has passed lifecycle smoke with fallback behavior.
