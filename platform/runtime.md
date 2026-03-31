# CAIL Runtime Contract

This file is the assistant-neutral source of truth for the CAIL Deploy environment.

## Core model

CAIL Deploy hosts student applications on Cloudflare Workers using Workers for Platforms.

- Each student project is a user Worker in a shared dispatch namespace.
- Public URLs are host-based: `https://<project-name>.cuny.qzz.io`.
- A public wildcard proxy maps `https://<project-name>.cuny.qzz.io/*` to the internal gateway and project Worker.
- The deploy service, not the student's local `wrangler.jsonc`, is the authority that attaches production bindings.

## Product surface

The primary deployment UX lives in GitHub.

- Students install a GitHub App on a repository.
- A push to `main` triggers a build and deployment workflow.
- GitHub receives a status or check result with the deployed URL.
- The build itself runs on a CAIL-owned runner fed by a Cloudflare Queue and coordinated by the deploy service.

Assistant integrations are optional helpers for authoring and scaffolding.

## Agent discovery and status

The repo-local contract is `AGENTS.md`, but the platform also exposes a machine-readable runtime contract at:

- `https://runtime.cuny.qzz.io/.well-known/cail-runtime.json`

Agents should prefer the structured control-plane endpoints over scraping GitHub check-run prose:

- `POST /mcp`: remote MCP server for agents that support Streamable HTTP plus MCP OAuth
- `GET /.well-known/kale-connection.json`: public machine-readable connection-health document for Kale itself
- `GET /.well-known/oauth-protected-resource/mcp`: OAuth protected-resource metadata for `/mcp`
- `GET /.well-known/oauth-authorization-server`: OAuth authorization-server metadata
- `POST /oauth/register`: dynamic client registration for public MCP clients
- `GET /api/oauth/authorize`: browser-facing OAuth authorization endpoint, protected by Cloudflare Access
- `POST /oauth/token`: OAuth token exchange endpoint
- `GET /api/repositories/<owner>/<repo>/status`: inspect the full repo lifecycle before or after registration, including install state, project slug, next action, and live deployment status
- `POST /api/projects/register`: validate a GitHub repository reference, suggest or confirm the project slug, report whether the GitHub App is installed, and return the canonical project URL plus a status endpoint
- `POST /api/validate`: validate a GitHub-visible branch or commit without deploying it
- `GET /api/build-jobs/<jobId>/status`: poll a specific validation or deployment job
- `GET /api/projects/<project-name>/status`: return structured deployment state, including `status`, `deployment_url`, `error_kind`, `error_message`, and `error_detail`
- `GET /api/projects/<project-name>/secrets`: list stored project secret names and metadata, never values
- `PUT /api/projects/<project-name>/secrets/<SECRET_NAME>`: create or update one project secret
- `DELETE /api/projects/<project-name>/secrets/<SECRET_NAME>`: remove one project secret

The intended auth model is now:

- `/mcp` is a standard OAuth-protected MCP resource
- agents discover auth from `401` plus `WWW-Authenticate` and protected-resource metadata
- the browser authorization step happens at `GET /api/oauth/authorize`
- Cloudflare Access supplies the human identity there
- the harness stores the MCP OAuth access token and then calls `/mcp`

Current harness note:

- Codex can usually stay on the direct MCP OAuth path
- Claude Code is currently more reliable through `GET /connect`, where the user generates a Kale token and the harness re-adds `/mcp` with `Authorization: Bearer kale_pat_*`

The JSON endpoints above still exist, but for agent harnesses the preferred path is now MCP first.

If a repository still needs GitHub approval, the agent should stop and hand the user the returned `guidedInstallUrl`. That GitHub approval is still a browser handoff even when the rest of the loop is agent-driven.

The MCP tool surface is intentionally thin. It wraps the same control-plane behavior the JSON API already exposes:

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

The intended long-term model is:

- MCP OAuth for agents
- browser identity via Cloudflare Access at the authorization endpoint
- eventual SSO under the same Access boundary

Before pushing, agents should still run local preflight commands:

- `npm run check`
- `npx wrangler dev`

The remote validate endpoint is intentionally GitHub-first. It validates a branch or commit that already exists in GitHub. It does not accept an arbitrary local folder upload.

## Runtime constraints

- JavaScript and TypeScript only.
- Workers-compatible packages only. Avoid native binaries and Node-only APIs.
- No Python workloads.
- No long-running CPU-heavy jobs.
- Do not build around `app.listen(...)`, long-lived in-memory server state, or filesystem-backed application state.
- Prefer server-rendered HTML plus small JSON APIs over heavy SPA infrastructure.
- Prefer Hono for routing.

## Good first app shapes

Agents should bias toward app types that fit the platform well:

- exhibit or archive sites
- course or project sites
- guestbooks, forms, and submissions
- small APIs
- bibliographies or lightweight searchable collections

These are usually a better fit than heavyweight front-end frameworks or traditional server stacks.

Projects that require extra approval or tighter oversight include:

- lightweight AI interfaces
- vector search or semantic retrieval features
- realtime rooms or collaborative presence features

## Deployment-ready repository checklist

Before asking the user to validate or deploy, the repository should usually include:

- `package.json`
- `wrangler.jsonc`
- `src/index.ts`
- `AGENTS.md`

It should also usually provide:

- a root route at `/`
- a health route at `/api/health`
- `npm run check`
- `npm run dev`

It should not depend on:

- `app.listen(...)`
- Python runtime assumptions
- native Node modules
- filesystem-backed runtime state

## Expected binding names inside student apps

These names should remain stable across assistant adapters:

- `DB`: primary per-project D1 database
- `FILES`: R2 bucket binding or per-project bucket prefix facade
- `CACHE`: KV namespace for light configuration and cache data
- `AI`: Workers AI binding
- `VECTORIZE`: Vectorize binding when enabled
- `ROOMS`: Durable Object namespace when enabled

Not every project needs every binding, but assistants should treat this set as the standard vocabulary.

Current policy defaults are:

- `DB`, `FILES`, and `CACHE` are self-service production bindings.
- `AI`, `VECTORIZE`, and `ROOMS` are approval-only.
- `FILES` is implemented as one project-isolated R2 bucket per repository that requests it.
- `CACHE` is implemented as one project-isolated KV namespace per repository that requests it.

To request self-service storage in a repository:

- declare `FILES` in `wrangler.jsonc` under `r2_buckets`
- declare `CACHE` in `wrangler.jsonc` under `kv_namespaces`
- use placeholder local IDs or bucket names if needed; Kale replaces the production binding values with project-isolated resources during deployment

Default caps are:

- no daily validation cap by default
- no daily deployment cap by default
- 1 active build per repository at a time
- 90 MiB for the total deployment upload bundle per build

Those caps are intentionally narrow:

- the active-build cap protects a shared Kale-owned runner from being monopolized by one repository or agent loop
- the upload cap protects Kale's current deploy transport, which receives each build as a single multipart upload and needs headroom under Cloudflare request-body limits
- daily validate or deploy caps remain available as per-project overrides, but they are not enabled by default

Assistants should not promise AI, vector search, realtime rooms, or large asset hosting unless the user has explicit approval.

Per-project secrets now use an extra GitHub-backed admin check:

- ordinary deploys still use only MCP OAuth plus the shared GitHub App install
- secret management may ask the user to confirm their GitHub account separately
- Kale then checks that the linked GitHub user has write, maintain, or admin access to the repository that owns the project

This second GitHub user-authorization step is intentionally limited to sensitive project-admin actions such as secrets.

The browser settings surface is also intentionally narrow:

- it is a private admin page, not a general project homepage
- it should remain behind CUNY sign-in and repo-admin verification
- agents should send users there only for project-admin work such as secrets and later domain/redirect controls
- ordinary deploy, validate, and status loops should stay in the standard repo-first flow

## Naming conventions

- Project names must be lowercase kebab-case and no longer than 63 characters.
- Prefer names under 40 characters.
- Public URL slug and deployed Worker name should match.
- Some slugs are reserved for platform infrastructure, including `runtime`.
- Use repository descriptions or explicit metadata to populate the project directory.

## Local scaffolding

The scaffold should create:

- `wrangler.jsonc` for local structure and type generation
- a minimal Hono app
- `AGENTS.md` as the canonical repo-local assistant guidance
- `CLAUDE.md` as an optional tool-specific shim
- scripts for local checking
- a request-handler-oriented app shape rather than a traditional Node server bootstrap

The scaffold is not a starter repo download. It writes files directly into the current project.

## Deployment contract

The deploy service expects a built Worker artifact plus deployment metadata from the CAIL-owned build runner. The service is responsible for:

- validating the project name
- claiming the project slug
- storing project, webhook, job, and deployment state in a control-plane D1 database
- provisioning the first D1 database if needed
- keeping a bounded rollback cache in R2 rather than an infinite archive
- uploading static assets with Cloudflare's direct-upload flow when present
- uploading the Worker into the dispatch namespace
- recording project metadata and deployment history
- updating the GitHub check run for the commit

The build runner is responsible for:

- checking out the repository at the pushed commit
- producing the Worker bundle
- producing static assets metadata when the project serves assets
- posting start and completion callbacks back to the deploy service

In practice, student repositories should usually commit a real Wrangler config. The runner supports a narrow fallback for simple `src/index.*` Workers, but it should not depend on interactive framework autoconfiguration.

Student repositories should not need their own deployment workflow file for the default path.

## First-version exclusions

- Dynamic Workers
- Cloudflare Sandboxes
- per-project custom domains
- platform-managed end-user authentication

Those may be useful later, but they are not required for the first deployable version of the platform.
