# Agent API

Kale Deploy now exposes a small machine-readable control-plane surface for assistants.

Use this when you want the loop to be:

1. create or update code
2. create or connect a GitHub repo
3. confirm install state
4. push
5. poll structured deployment status

## Runtime discovery

Start here:

- [https://runtime.cuny.qzz.io/.well-known/kale-runtime.json](https://runtime.cuny.qzz.io/.well-known/kale-runtime.json)

That manifest describes:

- public URL shape
- required starter-shape choices for agents
- supported languages and bindings
- disallowed runtime patterns
- local preflight commands
- the agent API endpoints

Important current manifest fields:

- `scaffold_shape_required: true`
- `scaffold_shape_options: ["static", "worker"]`
- `static_project_marker_file: "kale.project.json"`
- `static_project_shape_value: "static_site"`
- `worker_project_shape_value: "worker_app"`
- `static_project_request_time_logic_key: "requestTimeLogic"`
- `static_project_request_time_logic_value: "none"`
- `dynamic_skill_policy`
- `client_update_policy`
- `agent_harnesses`
- `dynamic_skill_policy.wrapper_check_query_parameters`

For dynamic harness behavior, agents should:

- read `dynamic_skill_policy`, `client_update_policy`, and `agent_harnesses` from `get_runtime_manifest`
- use `dynamicSkillPolicy`, `clientUpdatePolicy`, `harnesses`, `nextAction`, and `summary` from `test_connection` as the live source of truth once Kale is connected

Current shape policy:

- choose `static` for pure publishing sites with no request-time behavior
- choose `worker` for forms, APIs, auth, redirects, or other request-time logic
- `_headers` and `_redirects` currently keep a project on the dedicated Worker lane rather than the shared-static lane

## Agent auth

The preferred auth model is now:

1. the harness connects to `POST /mcp`
2. Kale replies with an OAuth challenge and protected-resource metadata
3. the harness discovers `/.well-known/oauth-authorization-server`
4. the harness registers as a public client at `POST /oauth/register`
5. the harness opens the browser to `GET /api/oauth/authorize`
6. Cloudflare Access handles the institutional login there
7. the harness exchanges the code at `POST /oauth/token`
8. the harness stores the returned bearer token and continues normally

This keeps the auth model MCP-native for harnesses that complete MCP OAuth cleanly.

There is also a current bootstrap path for Claude Code when native remote-MCP OAuth does not complete reliably:

- `claude mcp add -s user kale -- npx -y mcp-remote https://cuny.qzz.io/kale/mcp --transport http-only`

That bridge handles Kale's existing OAuth endpoints itself. After OAuth succeeds, Claude should immediately rewrite `kale` to a direct HTTP MCP server whose `headersHelper` reads the latest valid Kale OAuth token through the installed `kale-claude-connect.mjs` helper and refreshes it automatically when a cached refresh token is available. Only rerun the bootstrap and sync steps if the helper reports that no valid Kale OAuth or refresh token is available. The token bridge at `https://cuny.qzz.io/kale/connect` is still available as the last resort.

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
- current Claude Code OAuth bootstrap: `claude mcp add -s user kale -- npx -y mcp-remote https://cuny.qzz.io/kale/mcp --transport http-only`, then run the installed `kale-claude-connect.mjs` helper to convert `kale` to direct HTTP with `headersHelper`
- last-resort token bridge for stubborn harnesses: `GET /connect`, then use `Authorization: Bearer kale_pat_*` on `/mcp`

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
- `delete_project`

Public connection-health document:

- `GET https://cuny.qzz.io/kale/.well-known/kale-connection.json`

Optional stale-wrapper check query parameters:

- `harness=claude|codex|gemini`
- `localBundleVersion=<x.y.z>`

Use this when you want one machine-readable answer to:

- is Kale reachable?
- does it expect MCP OAuth?
- is deployment GitHub-triggered rather than local-folder upload?
- what is the next connection step?

Notes:

- the MCP layer is an adapter over the existing deploy-service API, not a separate control plane
- `guidedInstallUrl` still represents a human GitHub browser handoff step
- the MCP server also exposes runtime resources at `kale://runtime/manifest` and `kale://runtime/auth`
- `test_connection` now also accepts optional `harness` and `localBundleVersion` inputs and can return `localWrapperStatus` when an installed local wrapper looks stale

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
curl https://cuny.qzz.io/kale/api/repositories/szweibel/kale-deploy-smoke-test/status \
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

Ordinary deploys stop here. Sensitive project-admin work is the first exception:

- normal deploys do not require a second GitHub user-authorization step
- secret management and project deletion may ask the user to confirm their GitHub account in the browser
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
- `delete_project`

Behavior:

- secret values are write-only and are never returned after creation
- Kale stores the desired secret state in its control plane and injects it as `secret_text` during deploy
- if a project is already live, Kale also tries to push the secret change directly to the live Worker without waiting for a redeploy
- if that live update fails, the secret is still saved and will apply on the next deploy
- humans can also manage secrets in the Access-protected project settings page on the Kale auth host
- that settings page is a private admin surface, not a general project page
- agents should only send users there for project-admin tasks such as secrets, project deletion, or future domain controls

Agent pattern:

1. If you only know `owner/repo`, call `get_repository_status` first and read the returned `projectName`.
2. Call `list_project_secrets`, `set_project_secret`, or `delete_project_secret` with that `projectName`.
3. If Kale returns `nextAction="connect_github_user"`, stop and hand the user `connectGitHubUserUrl`.
4. After the user completes that browser step, retry the same secret tool.
5. Never repeat the secret value back to the user after writing it.

Settings URL shape:

- `https://<kale-auth-host>/projects/<projectName>/control`

Use that settings URL only when the user needs project administration. For ordinary deploy and status work, stay in the normal register/validate/status flow.

Example:

```bash
curl -X PUT https://cuny.qzz.io/kale/api/projects/my-project/secrets/OPENAI_API_KEY \
  -H 'authorization: Bearer <token>' \
  -H 'content-type: application/json' \
  -d '{
    "value": "sk-..."
  }'
```

## Delete a Kale project

Endpoint:

- `DELETE https://cuny.qzz.io/kale/api/projects/<projectName>`

MCP tool:

- `delete_project`

Behavior:

- this deletes the Kale project only
- it removes the live Kale URL, stored secrets, deployment history, archived deployment artifacts, and Kale-managed D1/R2/KV resources
- it does **not** delete the GitHub repository
- the request must confirm the slug exactly with `confirmProjectName`

Agent pattern:

1. Resolve the canonical `projectName` first.
2. Ask for explicit user confirmation before deleting.
3. Call `delete_project` or `DELETE /api/projects/<projectName>` with `confirmProjectName`.
4. If Kale returns `nextAction="connect_github_user"`, stop and hand the user `connectGitHubUserUrl`.
5. Treat the delete as irreversible inside Kale. If the user wants the site back later, redeploy from GitHub.

Example:

```bash
curl -X DELETE https://cuny.qzz.io/kale/api/projects/my-project \
  -H 'authorization: Bearer <token>' \
  -H 'content-type: application/json' \
  -d '{
    "confirmProjectName": "my-project"
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
    "repositoryFullName": "szweibel/kale-assets-build-test",
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
    "name": "kale-assets-build-test",
    "fullName": "szweibel/kale-assets-build-test",
    "htmlUrl": "https://github.com/szweibel/kale-assets-build-test"
  },
  "ref": "main",
  "headSha": "abc123",
  "projectName": "kale-assets-build-test",
  "projectUrlPreview": "https://kale-assets-build-test.cuny.qzz.io",
  "status": "queued",
  "buildStatus": "queued",
  "statusUrl": "https://cuny.qzz.io/kale/api/build-jobs/job_123/status",
  "checkRunId": 456789012,
  "checkRunUrl": "https://github.com/szweibel/kale-assets-build-test/runs/...",
  "nextAction": "poll_status"
}
```

This endpoint is intentionally GitHub-first:

- it validates a branch or commit that already exists in GitHub
- it does not accept a raw local bundle upload
- it does not deploy on success
- it can return `429` if the repository already has the maximum number of active builds, or if an operator has set a repository-specific daily validation cap

## Project status details

Endpoint:

- `GET https://cuny.qzz.io/kale/api/projects/<project-name>/status`

The status payload now includes runtime-lane data so agents can see what Kale actually chose:

- `runtime_lane`
- `recommended_runtime_lane`
- runtime-evidence fields such as framework, classification, confidence, basis, and summary

That lets an agent distinguish between:

- a live dedicated Worker app
- a certified shared-static deploy
- a project that looked static-ish but stayed dedicated because the runner did not have strong enough evidence

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
    "repositoryFullName": "szweibel/kale-deploy-smoke-test"
  }'
```

Successful response shape:

```json
{
  "ok": true,
  "repository": {
    "ownerLogin": "szweibel",
    "name": "kale-deploy-smoke-test",
    "fullName": "szweibel/kale-deploy-smoke-test",
    "htmlUrl": "https://github.com/szweibel/kale-deploy-smoke-test"
  },
  "projectName": "kale-deploy-smoke-test",
  "projectUrl": "https://kale-deploy-smoke-test.cuny.qzz.io",
  "projectAvailable": true,
  "installStatus": "installed",
  "installUrl": "https://github.com/apps/cail-deploy/installations/new",
  "guidedInstallUrl": "https://cuny.qzz.io/kale/github/install?repositoryFullName=szweibel%2Fkale-deploy-smoke-test&projectName=kale-deploy-smoke-test",
  "setupUrl": "https://cuny.qzz.io/kale/github/setup",
  "statusUrl": "https://cuny.qzz.io/kale/api/projects/kale-deploy-smoke-test/status",
  "nextAction": "push_to_default_branch",
  "installed": true,
  "installationId": 12345678,
  "latestStatus": "live"
}
```

Policy notes:

- advanced bindings such as `AI`, `VECTORIZE`, and `ROOMS` are approval-only because they create billable or always-on platform resources
- `DB`, `FILES`, and `CACHE` are self-service production bindings because Kale provisions one repo-scoped D1 database, R2 bucket, and KV namespace when the repository requests them
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
curl https://cuny.qzz.io/kale/api/projects/kale-deploy-smoke-test/status \
  -H 'authorization: Bearer <token>'
```

Response shape:

```json
{
  "projectName": "kale-deploy-smoke-test",
  "status": "live",
  "build_status": "success",
  "deployment_url": "https://kale-deploy-smoke-test.cuny.qzz.io",
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

1. install the `kale-deploy` add-on once in the agent
2. scaffold with `kale-init` or create a Worker-compatible repo
3. create the GitHub repo with `gh repo create` or another GitHub client
4. connect the harness to `POST /mcp`
5. let the harness complete MCP OAuth through the browser; for Claude Code today, use `mcp-remote` to complete OAuth and then immediately finalize to a direct HTTP `kale` server with `headersHelper`; that helper should refresh automatically when a cached refresh token exists, and only fall back to a new bootstrap if no valid OAuth or refresh token is available; if the flow stalls, fall back to `/connect`
6. call `test_connection`
7. call `register_project`
8. if `installStatus` is `not_installed`, send the user to `guidedInstallUrl`
9. call `validate_project` for a non-production branch, or push to the default branch for a real deployment
10. poll `get_build_job_status` or `get_project_status` until the state is terminal

If the GitHub App is already installed for all repositories in the owner account, the agent can usually do the whole loop without pausing after repo creation.

Harness update note:

- Remote MCP behavior updates immediately.
- Local plugin, add-on, skill, or extension updates are harness-specific.
- Agents should prefer the live runtime manifest for current install and update guidance when local wrapper copy looks stale.

## Local preflight before push

Kale Deploy now exposes a remote validation API for GitHub-visible refs, but local preflight is still the fastest feedback loop for unpushed work.

Agents should still use:

```bash
npm run check
npx wrangler dev
```

That is the fastest way to catch obvious Worker-shape problems before waiting on the queue-backed deploy path.
