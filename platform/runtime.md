# Kale Runtime Contract

This file is the assistant-neutral source of truth for the Kale Deploy environment.

## Core model

Kale Deploy hosts student applications on Cloudflare Workers using Workers for Platforms.

- Each student project is a user Worker in a shared dispatch namespace.
- Public URLs are host-based: `https://<project-name>.cuny.qzz.io`.
- A public wildcard proxy maps `https://<project-name>.cuny.qzz.io/*` to the internal gateway and project Worker.
- The deploy service, not the student's local `wrangler.jsonc`, is the authority that attaches production bindings.

## Product surface

The primary deployment UX lives in GitHub.

- Students install a GitHub App on a repository.
- A push to `main` triggers a build and deployment workflow.
- GitHub receives a status or check result with the deployed URL.
- The build itself runs on a Kale-owned runner fed by a Cloudflare Queue and coordinated by the deploy service.

Assistant integrations are optional helpers for authoring and scaffolding.

## Agent discovery and status

The repo-local contract is `AGENTS.md`, but the platform also exposes a machine-readable runtime contract at:

- `https://runtime.cuny.qzz.io/.well-known/kale-runtime.json`

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
- `GET /api/projects/<project-name>/status`: return structured deployment state, including `status`, `deployment_url`, `runtime_lane`, `recommended_runtime_lane`, runtime evidence fields, `error_kind`, `error_message`, and `error_detail`
- `GET /api/projects/<project-name>/secrets`: list stored project secret names and metadata, never values
- `PUT /api/projects/<project-name>/secrets/<SECRET_NAME>`: create or update one project secret
- `DELETE /api/projects/<project-name>/secrets/<SECRET_NAME>`: remove one project secret
- `DELETE /api/projects/<project-name>`: permanently delete the Kale project and its Kale-managed resources after confirming the slug in the request body

Connection-health version checks:

- `GET /.well-known/kale-connection.json?harness=<id>&localBundleVersion=<x.y.z>` can return `localWrapperStatus` when a reported local add-on, plugin, skill, or extension bundle looks stale.
- `test_connection` accepts the same optional `harness` and `localBundleVersion` inputs for harnesses that want the warning over MCP instead of a public JSON fetch.

The intended auth model is now:

- `/mcp` is a standard OAuth-protected MCP resource
- agents discover auth from `401` plus `WWW-Authenticate` and protected-resource metadata
- the browser authorization step happens at `GET /api/oauth/authorize`
- Cloudflare Access supplies the human identity there
- the harness stores the MCP OAuth access token and then calls `/mcp`

Current harness note:

- The public setup page now shows short per-agent install instructions for the `kale-deploy` add-on, then a plain-language build prompt.
- Codex normally uses the Kale add-on install path. The direct `codex mcp add` plus `codex mcp login` flow is the manual fallback.
- Claude Code should not search the MCP registry first when the local Kale plugin is installed. Start with the installed plugin guidance and `claude mcp list`. Then use `mcp-remote` only to complete the OAuth browser flow, and immediately rewrite Claude to one user-scope direct HTTP `kale` server whose `headersHelper` uses the installed `kale-claude-connect.mjs` helper to read the latest valid Kale OAuth token at connection time and refresh it automatically when a valid refresh token is cached. Only rerun the `mcp-remote` bootstrap if the helper reports that no valid Kale OAuth or refresh token is available. There is no supported `claude mcp auth`, `login`, or `authenticate` CLI flow today. `GET /connect` is the last-resort token bridge if `mcp-remote` also fails
- Gemini CLI can install Kale as an extension, and the preferred public path uses `--auto-update`

Harness update policy:

- Remote Kale MCP and runtime changes apply immediately.
- Local add-on, plugin, skill, or extension updates are harness-specific.
- The runtime manifest should be treated as the source of truth when local wrapper copy drifts.
- Claude has an explicit plugin update command.
- Gemini has explicit extension update commands and also supports `--auto-update` at install time.
- Codex does not currently expose add-on update commands in the CLI, so stale local add-ons may need an app-level refresh or reinstall.

Dynamic skill policy:

- The local skill or plugin bundle is bootstrap-only.
- Agents should read `dynamic_skill_policy`, `client_update_policy`, and `agent_harnesses` from `get_runtime_manifest`.
- `dynamic_skill_policy.wrapper_check_query_parameters` lists the public query fields for stale-wrapper checks.
- Agents should use `dynamicSkillPolicy`, `clientUpdatePolicy`, `harnesses`, `nextAction`, and `summary` from `test_connection` as the live source of truth after connection.
- When the local bundle and the live service disagree, the live service wins.

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
- `delete_project`

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
- Declare the starter shape explicitly: `static` for pure publishing sites, `worker` for projects that need request-time behavior.
- Choose the lightest Worker-compatible shape that fits the project.
- Prefer a static-first project when the work is mostly content or simple publishing.
- For a Kale-owned static-first project, write `kale.project.json` with `projectShape: "static_site"` and `requestTimeLogic: "none"`, then point `wrangler.jsonc` `assets.directory` at the static output directory.
- For a Kale-owned Worker project, write `kale.project.json` with `projectShape: "worker_app"` and `requestTimeLogic: "allowed"`.
- A project that needs `/api/health`, auth, redirects, custom headers, `_headers`, `_redirects`, or any other request-time behavior is not pure static and should stay on a Worker lane.
- If request-time routing, middleware, or a small API is clearly useful, Hono is the preferred Worker framework.

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
- `npm run check`
- `npm run dev`

It should not depend on:

- `app.listen(...)`
- Python runtime assumptions
- native Node modules
- filesystem-backed runtime state

## Expected binding names inside student apps

These names should remain stable across assistant adapters:

- `DB`: primary repo-scoped D1 database
- `FILES`: R2 bucket binding or repo-scoped bucket/prefix facade
- `CACHE`: KV namespace for light configuration and cache data
- `AI`: Workers AI binding
- `VECTORIZE`: Vectorize binding when enabled
- `ROOMS`: Durable Object namespace when enabled

Not every project needs every binding, but assistants should treat this set as the standard vocabulary.

Current policy defaults are:

- `DB`, `FILES`, and `CACHE` are self-service production bindings.
- `AI`, `VECTORIZE`, and `ROOMS` are approval-only.
- `DB`, `FILES`, and `CACHE` are repo-scoped. A slug rename keeps using the same provisioned resources.
- `FILES` is implemented as one repo-scoped R2 bucket per repository that requests it.
- `CACHE` is implemented as one repo-scoped KV namespace per repository that requests it.

To request self-service storage in a repository:

- declare `FILES` in `wrangler.jsonc` under `r2_buckets`
- declare `CACHE` in `wrangler.jsonc` under `kv_namespaces`
- use placeholder local IDs or bucket names if needed; Kale replaces the production binding values with repo-scoped resources during deployment

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

Sensitive project-admin actions now use an extra GitHub-backed admin check:

- ordinary deploys still use only MCP OAuth plus the shared GitHub App install
- secret management and project deletion may ask the user to confirm their GitHub account separately
- Kale then checks that the linked GitHub user has write, maintain, or admin access to the repository that owns the project

This second GitHub user-authorization step is intentionally limited to sensitive project-admin actions such as secrets and project deletion.

The browser settings surface is also intentionally narrow:

- it is a private admin page, not a general project homepage
- it should remain behind CUNY sign-in and repo-admin verification
- agents should send users there only for project-admin work such as secrets, project deletion, and later domain/redirect controls
- ordinary deploy, validate, and status loops should stay in the standard repo-first flow

## Naming conventions

- Project names must be lowercase kebab-case and no longer than 63 characters.
- Prefer names under 40 characters.
- Public URL slug and deployed Worker name should match.
- Some slugs are reserved for platform infrastructure, including `runtime`.
- Use repository descriptions or explicit metadata to populate the project directory.

## Local scaffolding

The scaffold should create:

- an explicit shape choice, not a hidden default
- `wrangler.jsonc` for local structure and type generation
- the lightest Worker-compatible starter that fits the chosen project shape
- `kale.project.json` declaring either `projectShape: "static_site"` or `projectShape: "worker_app"`
- for pure static projects, `kale.project.json` should explicitly declare `requestTimeLogic: "none"`
- for Worker projects, `kale.project.json` should explicitly declare `requestTimeLogic: "allowed"`
- a plain Worker handler when a homepage plus `/api/health` is enough
- Hono only when route composition or middleware clarity is clearly useful
- `AGENTS.md` as the canonical repo-local assistant guidance
- `CLAUDE.md` as an optional tool-specific shim
- scripts for local checking
- a request-handler-oriented app shape rather than a traditional Node server bootstrap

The scaffold is not a starter repo download. It writes files directly into the current project.

Shared static coverage is intentionally certification-based:

- explicit framework exports such as Next export, Astro static, SvelteKit adapter-static, and Nuxt generate can be auto-certified
- Kale-owned static-first projects can be auto-certified only when `kale.project.json` declares a pure static contract and Wrangler points at the same asset directory
- static projects that include `_headers` or `_redirects` stay on the dedicated lane until Kale's shared-static gateway explicitly supports those control files
- generic Worker-plus-assets projects stay on the dedicated lane unless the runner has strong positive evidence that request-time Worker behavior is disposable

## Deployment contract

The deploy service expects a built Worker artifact plus deployment metadata from the Kale-owned build runner. The service is responsible for:

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
