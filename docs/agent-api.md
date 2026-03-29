# Agent API

CAIL Deploy now exposes a small machine-readable control-plane surface for assistants.

Use this when you want the loop to be:

1. create or update code
2. create or connect a GitHub repo
3. confirm install state
4. push
5. poll structured deployment status

## Runtime discovery

Start here:

- [https://runtime.cuny.qzz.io/.well-known/cail-runtime.json](https://runtime.cuny.qzz.io/.well-known/cail-runtime.json)

That manifest describes:

- public URL shape
- supported languages and bindings
- disallowed runtime patterns
- local preflight commands
- the agent API endpoints

## Agent auth

The preferred auth model is now:

1. the harness connects to `POST /mcp`
2. CAIL replies with an OAuth challenge and protected-resource metadata
3. the harness discovers `/.well-known/oauth-authorization-server`
4. the harness registers as a public client at `POST /oauth/register`
5. the harness opens the browser to `GET /api/oauth/authorize`
6. Cloudflare Access handles the institutional login there
7. the harness exchanges the code at `POST /oauth/token`
8. the harness stores the returned bearer token and continues normally

This keeps the auth model MCP-native. The browser step is still required, but there is no pasted token bridge anymore.

## Remote MCP server

Endpoint:

- `POST https://cuny.qzz.io/kale/mcp`

Transport:

- Streamable HTTP

Auth:

- standard MCP OAuth 2.1 with browser login
- protected resource metadata: `GET /.well-known/oauth-protected-resource/mcp`
- authorization server metadata: `GET /.well-known/oauth-authorization-server`
- dynamic client registration: `POST /oauth/register`
- browser authorization endpoint: `GET /api/oauth/authorize`
- token exchange: `POST /oauth/token`

Current MCP tools:

- `get_runtime_manifest`
- `test_connection`
- `get_repository_status`
- `register_project`
- `validate_project`
- `get_project_status`
- `get_build_job_status`
- `list_project_secrets`
- `set_project_secret`
- `delete_project_secret`

Public connection-health document:

- `GET https://cuny.qzz.io/kale/.well-known/kale-connection.json`

Use this when you want one machine-readable answer to:

- is Kale reachable?
- does it expect MCP OAuth?
- is deployment GitHub-triggered rather than local-folder upload?
- what is the next connection step?

Notes:

- the MCP layer is an adapter over the existing deploy-service API, not a separate control plane
- `guidedInstallUrl` still represents a human GitHub browser handoff step
- the MCP server also exposes runtime resources at `cail://runtime/manifest` and `cail://runtime/auth`

## Repository lifecycle status

Endpoint:

- `GET https://cuny.qzz.io/kale/api/repositories/<owner>/<repo>/status`

Use this when you want a repo-first answer to:

- is the GitHub App installed?
- which project slug will this repo use?
- is that slug available?
- what should the user or agent do next?

Example:

```bash
curl https://cuny.qzz.io/kale/api/repositories/szweibel/cail-deploy-smoke-test/status \
  -H 'authorization: Bearer <token>'
```

Response fields include:

- `workflowStage`: one of `app_setup`, `github_install`, `awaiting_push`, `build_queued`, `build_running`, `build_failed`, `live`, `name_conflict`
- `nextAction`: the most useful next step for the agent
- `summary`: plain-language lifecycle summary
- `installStatus`, `projectName`, `projectUrl`, `statusUrl`, `validateUrl`

## OAuth endpoints

Protected resource metadata:

- `GET https://cuny.qzz.io/kale/.well-known/oauth-protected-resource/mcp`

Authorization server metadata:

- `GET https://cuny.qzz.io/kale/.well-known/oauth-authorization-server`

Dynamic client registration:

- `POST https://cuny.qzz.io/kale/oauth/register`

Browser authorization endpoint:

- `GET https://cuny.qzz.io/kale/api/oauth/authorize`

Token exchange:

- `POST https://cuny.qzz.io/kale/oauth/token`

The `/api/oauth/authorize` route is where Cloudflare Access applies. The token endpoint stays public so the harness can complete the standard OAuth exchange.

Ordinary deploys stop here. Secret management is the first exception:

- normal deploys do not require a second GitHub user-authorization step
- secret management may ask the user to confirm their GitHub account in the browser
- Kale then checks that the linked GitHub user has write, maintain, or admin access to the repository that owns the project

That second GitHub confirmation is not part of the normal deploy loop. It is reserved for sensitive project-admin actions.

## Manage project secrets

Endpoints:

- `GET https://cuny.qzz.io/kale/api/projects/<projectName>/secrets`
- `PUT https://cuny.qzz.io/kale/api/projects/<projectName>/secrets/<SECRET_NAME>`
- `DELETE https://cuny.qzz.io/kale/api/projects/<projectName>/secrets/<SECRET_NAME>`

MCP tools:

- `list_project_secrets`
- `set_project_secret`
- `delete_project_secret`

Behavior:

- secret values are write-only and are never returned after creation
- Kale stores the desired secret state in its control plane and injects it as `secret_text` during deploy
- if a project is already live, Kale also tries to push the secret change directly to the live Worker without waiting for a redeploy
- if that live update fails, the secret is still saved and will apply on the next deploy

Agent pattern:

1. If you only know `owner/repo`, call `get_repository_status` first and read the returned `projectName`.
2. Call `list_project_secrets`, `set_project_secret`, or `delete_project_secret` with that `projectName`.
3. If Kale returns `nextAction="connect_github_user"`, stop and hand the user `connectGitHubUserUrl`.
4. After the user completes that browser step, retry the same secret tool.
5. Never repeat the secret value back to the user after writing it.

Example:

```bash
curl -X PUT https://cuny.qzz.io/kale/api/projects/my-project/secrets/OPENAI_API_KEY \
  -H 'authorization: Bearer <token>' \
  -H 'content-type: application/json' \
  -d '{
    "value": "sk-..."
  }'
```

## Validate a branch or commit without deploying

Endpoint:

- `POST https://cuny.qzz.io/kale/api/validate`

Use this when the code already exists in GitHub but should not go live yet.

Send:

- `repositoryFullName` or `repositoryUrl`

Optional:

- `ref`
- `projectName`

Notes:

- project names are unique across the platform at the repository level, not just the GitHub owner level
- some slugs are reserved for platform infrastructure, including `runtime`

Example:

```bash
curl -X POST https://cuny.qzz.io/kale/api/validate \
  -H 'authorization: Bearer <token>' \
  -H 'content-type: application/json' \
  -d '{
    "repositoryFullName": "szweibel/cail-assets-build-test",
    "ref": "main"
  }'
```

Response shape:

```json
{
  "ok": true,
  "jobId": "job_123",
  "jobKind": "validation",
  "repository": {
    "ownerLogin": "szweibel",
    "name": "cail-assets-build-test",
    "fullName": "szweibel/cail-assets-build-test",
    "htmlUrl": "https://github.com/szweibel/cail-assets-build-test"
  },
  "ref": "main",
  "headSha": "abc123",
  "projectName": "cail-assets-build-test",
  "projectUrlPreview": "https://cail-assets-build-test.cuny.qzz.io",
  "status": "queued",
  "buildStatus": "queued",
  "statusUrl": "https://cuny.qzz.io/kale/api/build-jobs/job_123/status",
  "checkRunId": 456789012,
  "checkRunUrl": "https://github.com/szweibel/cail-assets-build-test/runs/...",
  "nextAction": "poll_status"
}
```

This endpoint is intentionally GitHub-first:

- it validates a branch or commit that already exists in GitHub
- it does not accept a raw local bundle upload
- it does not deploy on success
- it can return `429` if the repository already has the maximum number of active builds, or if an operator has set a repository-specific daily validation cap

## Register a repository

Endpoint:

- `POST https://cuny.qzz.io/kale/api/projects/register`

Send either:

- `repositoryFullName`
- or `repositoryUrl`

Optional:

- `projectName`

Example:

```bash
curl -X POST https://cuny.qzz.io/kale/api/projects/register \
  -H 'authorization: Bearer <token>' \
  -H 'content-type: application/json' \
  -d '{
    "repositoryFullName": "szweibel/cail-deploy-smoke-test"
  }'
```

Successful response shape:

```json
{
  "ok": true,
  "repository": {
    "ownerLogin": "szweibel",
    "name": "cail-deploy-smoke-test",
    "fullName": "szweibel/cail-deploy-smoke-test",
    "htmlUrl": "https://github.com/szweibel/cail-deploy-smoke-test"
  },
  "projectName": "cail-deploy-smoke-test",
  "projectUrl": "https://cail-deploy-smoke-test.cuny.qzz.io",
  "projectAvailable": true,
  "installStatus": "installed",
  "installUrl": "https://github.com/apps/cail-deploy/installations/new",
  "guidedInstallUrl": "https://cuny.qzz.io/kale/github/install?repositoryFullName=szweibel%2Fcail-deploy-smoke-test&projectName=cail-deploy-smoke-test",
  "setupUrl": "https://cuny.qzz.io/kale/github/setup",
  "statusUrl": "https://cuny.qzz.io/kale/api/projects/cail-deploy-smoke-test/status",
  "nextAction": "push_to_default_branch",
  "installed": true,
  "installationId": 12345678,
  "latestStatus": "live"
}
```

Policy notes:

- advanced bindings such as `AI`, `VECTORIZE`, and `ROOMS` are approval-only because they create billable or always-on platform resources
- `DB`, `FILES`, and `CACHE` are self-service production bindings because Kale provisions one isolated D1 database, R2 bucket, and KV namespace per project when the repository requests them
- the control plane can reject validate or deploy activity when a repository already has the maximum number of active builds, or when an operator has set a repository-specific cap

Conflict response:

- `409 Conflict`
- `nextAction` becomes `choose_different_project_name`
- `suggestedProjectNames` returns available alternatives with canonical URLs

This lets an agent detect slug collisions before the first push.

When `installStatus` is not `installed`, agents should prefer `guidedInstallUrl` over the generic `installUrl`. It stores the repository context so the setup page can confirm whether that exact repo is covered after the GitHub install flow returns.

## Poll deployment status

Endpoint:

- `GET https://cuny.qzz.io/kale/api/projects/<project-name>/status`

Example:

```bash
curl https://cuny.qzz.io/kale/api/projects/cail-deploy-smoke-test/status \
  -H 'authorization: Bearer <token>'
```

Response shape:

```json
{
  "projectName": "cail-deploy-smoke-test",
  "status": "live",
  "build_status": "success",
  "deployment_url": "https://cail-deploy-smoke-test.cuny.qzz.io",
  "deployment_id": "dep_123",
  "error_kind": null,
  "error_message": null,
  "error_detail": null,
  "build_log_url": null,
  "job_id": "job_123",
  "check_run_id": 456789012,
  "created_at": "2026-03-26T23:00:00.000Z",
  "updated_at": "2026-03-26T23:01:10.000Z",
  "started_at": "2026-03-26T23:00:15.000Z",
  "completed_at": "2026-03-26T23:01:10.000Z"
}
```

Important values:

- `status`: `queued`, `running`, `live`, `failed`
- `build_status`: raw internal build state when a job exists
- `error_kind`: `build_failure`, `needs_adaptation`, `unsupported`
- `deployment_url`: canonical public URL when deployment succeeds

## Poll a validation or deployment job directly

Endpoint:

- `GET https://cuny.qzz.io/kale/api/build-jobs/<jobId>/status`

Use this for validation jobs, or when an agent wants to follow one specific build job instead of the latest project deployment state.

Example:

```bash
curl https://cuny.qzz.io/kale/api/build-jobs/job_123/status \
  -H 'authorization: Bearer <token>'
```

Important values:

- `jobKind`: `validation` or `deployment`
- `status`: normalized lifecycle state
- validation jobs end in `passed`
- deployment jobs end in `live`
- `build_status`: raw internal state
- `error_kind`, `error_message`, `error_detail`
- `deployment_url`: only present for deployment jobs that actually went live

## Best current agent loop

Today, the strongest loop is:

1. scaffold with `CAIL-init` or create a Worker-compatible repo
2. create the GitHub repo with `gh repo create` or another GitHub client
3. connect the harness to `POST /mcp`
4. let the harness complete MCP OAuth through the browser
5. call `test_connection`
6. call `register_project`
7. if `installStatus` is `not_installed`, send the user to `guidedInstallUrl`
8. call `validate_project` for a non-production branch, or push to the default branch for a real deployment
9. poll `get_build_job_status` or `get_project_status` until the state is terminal

If the GitHub App is already installed for all repositories in the owner account, the agent can usually do the whole loop without pausing after repo creation.

## Local preflight before push

CAIL Deploy now exposes a remote validation API for GitHub-visible refs, but local preflight is still the fastest feedback loop for unpushed work.

Agents should still use:

```bash
npm run check
npx wrangler dev
```

That is the fastest way to catch obvious Worker-shape problems before waiting on the queue-backed deploy path.
