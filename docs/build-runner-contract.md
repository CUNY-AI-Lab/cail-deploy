# Build Runner Contract

The deploy service owns GitHub App credentials, GitHub check runs, Cloudflare credentials, control-plane state, and deployment history. The runner owns source checkout and bundle creation.

The current implementation lives in `packages/build-runner`.

## Decision

Builds run on a Kale-owned runner and are delivered through Cloudflare Queues.

- Students should not need to maintain GitHub Actions workflow files just to deploy.
- The GitHub App webhook remains the single product entrypoint.
- Cloudflare Workers stay the control plane; the runner handles the Node build environment that Workers do not provide.
- Queue delivery is more durable than directly POSTing from the webhook to the runner.

## Lifecycle

1. GitHub sends a `push` webhook to `packages/deploy-service` for the repository default branch.
2. The deploy service verifies the webhook, records the delivery in control-plane D1, creates a GitHub check run, stores a build job, and publishes a queue message.
3. The runner consumes the queue message and calls `GET /internal/build-jobs/:jobId/source` to lease a fresh GitHub installation token for the exact commit.
4. The runner builds the deployable bundle, emits runtime evidence, and reports `start` / `complete` back to the deploy service.
5. On success, the deploy service keeps a bounded rollback bundle in R2, uploads any static assets through the Cloudflare direct-upload flow, provisions D1 if needed, either promotes a certified pure static build onto the shared-static lane or uploads the dedicated Worker into Workers for Platforms, stores deployment history, and completes the check run with the live URL.
6. On failure, the deploy service completes the check run with a failure conclusion, preserves the job record, and may retain only a short-lived manifest instead of a full artifact bundle.

## Repository Expectations

- Prefer committing a real `wrangler.jsonc`, `wrangler.json`, or `wrangler.toml`.
- Repositories should carry an `AGENTS.md` file as the canonical repo-local guidance for assistants.
- The runner installs dependencies, runs `build` when a `package.json` script exists, and then runs `wrangler deploy --dry-run --outdir ...`.
- If a repo does not have a Wrangler config, the runner only supports a narrow fallback for simple Worker entrypoints at `src/index.ts`, `src/index.js`, `index.ts`, or `index.js`.
- If the Wrangler config defines static assets, the runner reads `assets.directory`, respects `.assetsignore`, and forwards `html_handling`, `not_found_handling`, and `run_worker_first`.
- If the repository declares Kale project metadata, the runner uses that plus framework signals to classify the build as shared-static-eligible, dedicated-only, or unknown.
- The runner does not forward student-defined production bindings. The deploy service remains the source of truth for D1 and Workers for Platforms bindings.

## Runner Environment

The runner process expects:

- `RUNNER_ID`
- `CLOUDFLARE_ACCOUNT_ID`
- `BUILD_QUEUE_ID`
- `QUEUES_API_TOKEN`
- `BUILD_RUNNER_TOKEN`

Optional controls:

- `RUNNER_WORKDIR_ROOT`
- `BUILD_BATCH_SIZE`
- `BUILD_IDLE_POLL_DELAY_MS`
- `BUILD_VISIBILITY_TIMEOUT_MS`
- `BUILD_RETRY_DELAY_SECONDS`
- `RUNNER_KEEP_WORKDIRS`
- `RUNNER_HEALTH_PORT`

## Queue Message

The deploy service publishes a JSON message to the `cail-builds` queue.

```json
{
  "jobId": "uuid",
  "createdAt": "2026-03-26T15:30:00.000Z",
  "trigger": {
    "event": "push",
    "deliveryId": "github-delivery-id",
    "ref": "refs/heads/main",
    "headSha": "commit-sha",
    "previousSha": "previous-commit-sha",
    "pushedAt": "2026-03-26T15:29:48Z"
  },
  "repository": {
    "id": 123,
    "ownerLogin": "student",
    "name": "project-repo",
    "fullName": "student/project-repo",
    "defaultBranch": "main",
    "htmlUrl": "https://github.com/student/project-repo",
    "cloneUrl": "https://github.com/student/project-repo.git",
    "private": true
  },
  "source": {
    "provider": "github",
    "archiveUrl": "https://api.github.com/repos/student/project-repo/tarball/commit-sha",
    "cloneUrl": "https://github.com/student/project-repo.git",
    "ref": "commit-sha",
    "tokenUrl": "https://cuny.qzz.io/kale/internal/build-jobs/<jobId>/source"
  },
  "deployment": {
    "publicBaseUrl": "https://cuny.qzz.io",
    "suggestedProjectName": "project-repo"
  },
  "callback": {
    "startUrl": "https://cuny.qzz.io/kale/internal/build-jobs/<jobId>/start",
    "completeUrl": "https://cuny.qzz.io/kale/internal/build-jobs/<jobId>/complete"
  }
}
```

## Source Lease

The runner calls `GET /internal/build-jobs/:jobId/source` with `Authorization: Bearer <BUILD_RUNNER_TOKEN>`.

```json
{
  "provider": "github",
  "archiveUrl": "https://api.github.com/repos/student/project-repo/tarball/commit-sha",
  "cloneUrl": "https://github.com/student/project-repo.git",
  "ref": "commit-sha",
  "accessToken": "installation-token",
  "accessTokenExpiresAt": "2026-03-26T16:29:48Z"
}
```

The queue message intentionally does not embed a GitHub installation token, because queue delay or retries could outlive token validity.

## Callback: Start

The runner calls `POST /internal/build-jobs/:jobId/start` with `Authorization: Bearer <BUILD_RUNNER_TOKEN>`.

```json
{
  "runnerId": "runner-1",
  "startedAt": "2026-03-26T15:31:00.000Z",
  "summary": "Installing dependencies and building the Worker bundle.",
  "text": "Optional longer log excerpt.",
  "buildLogUrl": "https://runner.ailab.gc.cuny.edu/jobs/uuid"
}
```

## Callback: Complete

Failure callbacks can be plain JSON:

```json
{
  "status": "failure",
  "runnerId": "runner-1",
  "completedAt": "2026-03-26T15:32:00.000Z",
  "summary": "Build failed during npm install.",
  "text": "Optional longer explanation.",
  "buildLogUrl": "https://runner.ailab.gc.cuny.edu/jobs/uuid",
  "errorMessage": "npm exited with status 1"
}
```

Success callbacks use `multipart/form-data`:

- `result`: JSON string matching the success payload below
- Worker bundle files: form parts keyed by their relative path, including the file named by `deployment.workerUpload.main_module`
- Static assets: additional form parts referenced by `deployment.staticAssets.files[].partName`

```json
{
  "status": "success",
  "runnerId": "runner-1",
  "completedAt": "2026-03-26T15:33:00.000Z",
  "summary": "Build succeeded.",
  "text": "Optional longer explanation.",
  "buildLogUrl": "https://runner.ailab.gc.cuny.edu/jobs/uuid",
  "deployment": {
    "projectName": "project-repo",
    "description": "Repository description or runner override.",
    "workerUpload": {
      "main_module": "dist/index.js",
      "compatibility_date": "2026-03-26",
      "bindings": []
    },
    "staticAssets": {
      "config": {
        "html_handling": "auto-trailing-slash"
      },
      "files": [
        {
          "path": "/index.html",
          "partName": "asset-0",
          "contentType": "text/html; charset=utf-8"
        }
      ]
    }
  }
}
```

The runner does not call GitHub or Cloudflare directly. Those side effects remain centralized in the deploy service.
