---
name: kale-deploy
description: Use when building or adapting a web application for the Kale Deploy runtime on Cloudflare Workers, especially lightweight Worker-compatible apps that will be deployed by the Kale control plane to a shared CUNY host. Trigger when the user mentions Kale Deploy, Cloudflare Workers for Kale, live deployment under <project>.cuny.qzz.io, or wants a project scaffold that fits this platform.
---

# Kale Deploy

Use this skill when the target runtime is Kale Deploy.

If the user only wants to prepare the environment, connect Kale, or verify readiness before deciding what to build, use `kale-connect` instead of starting with scaffolding.
If the repository already exists and needs to be checked or normalized for Kale, use `kale-doctor` first and `kale-adapt` second before rewriting application code.

## Dynamic policy

This local skill is a bootstrap layer, not the final source of truth.

- If Kale MCP tools are already available, call `get_runtime_manifest` early and read `dynamic_skill_policy`, `client_update_policy`, and `agent_harnesses`.
- If `test_connection` is available, use `dynamicSkillPolicy`, `clientUpdatePolicy`, `harnesses`, `nextAction`, and `summary` instead of assuming the local auth flow notes are still current.
- If the local wrapper metadata is available, pass `harness` and `localBundleVersion` to `test_connection` so Kale can warn about stale local bundle copy.
- Use the local plugin guidance mainly to get Kale connected the first time or when the MCP server is not reachable yet.

## What Kale Deploy is

Kale Deploy is a GitHub-first deployment platform from the CUNY AI Lab.

- Users build locally with an assistant, then deploy through GitHub.
- Production hosting uses Cloudflare Workers for Platforms.
- Public project URLs are host-based: `https://<project-name>.cuny.qzz.io`.
- The deploy control plane attaches production bindings — the student's local `wrangler.jsonc` is not the source of truth for production.

## Default technical choices

When there is no strong reason to do otherwise:

- use TypeScript
- choose a project shape explicitly: `static` or `worker`
- choose the lightest Worker-compatible shape that fits the project
- prefer a static-first project when the project is mostly content
- for a Kale-owned static-first project, add `kale.project.json` with `projectShape: "static_site"` and `requestTimeLogic: "none"`, then point Wrangler assets at the static output directory
- for a Kale-owned Worker project, add `kale.project.json` with `projectShape: "worker_app"` and `requestTimeLogic: "allowed"`
- if the project needs `/api/health`, auth, redirects, custom headers, `_headers`, `_redirects`, or any other request-time behavior, it is not pure static
- if request-time routing or middleware is clearly useful, use Hono for routing
- add JSON routes only where they are clearly useful
- use D1 for structured data
- treat R2 and KV as managed platform extras
- treat AI, Vectorize, and Rooms as approval-only features

## Good first app shapes

Bias toward projects that make the platform useful quickly:

- exhibit or archive sites
- course or project sites
- guestbooks, forms, and submissions
- small APIs
- bibliographies or lightweight searchable collections

These are usually better targets than heavy SPA stacks or apps that assume a traditional server.
Many of them can stay mostly static or use only a very small Worker surface.

## Runtime constraints

- JavaScript and TypeScript only — no Python
- no native Node modules or binary addons
- no long CPU-heavy tasks
- do not use `app.listen(...)` or frameworks that expect a long-running server process
- avoid dependencies that require sockets, child processes, or persistent filesystem state
- prefer server-rendered HTML plus small JSON APIs over heavy SPA infrastructure

## Standard binding vocabulary

Use these names consistently in generated code:

| Name | Type | Policy |
|------|------|--------|
| `DB` | D1 database | Self-service |
| `FILES` | R2 bucket | Self-service, declare in `wrangler.jsonc` |
| `CACHE` | KV namespace | Self-service, declare in `wrangler.jsonc` |
| `AI` | Workers AI | Approval required |
| `VECTORIZE` | Vectorize index | Approval required |
| `ROOMS` | Durable Object namespace | Approval required |

Not every project needs every binding. Do not invent binding names unless the user explicitly asks.

To request `FILES` or `CACHE`, add the standard binding names to `wrangler.jsonc` under `r2_buckets` or `kv_namespaces`. Use placeholder local values — Kale replaces them with repo-scoped resources during deployment.

Do not promise AI, vector search, realtime rooms, or large asset hosting unless the user has explicit approval.

## Project structure

Prefer:

```text
src/
  index.ts
kale.project.json (for static-first projects)
package.json
tsconfig.json
wrangler.jsonc
AGENTS.md
CLAUDE.md
```

Keep early projects small. Do not introduce a large front-end framework unless the user clearly needs one.
If a static-first project, plain Worker, or static export solves the job cleanly, prefer that over adding Hono by habit.
If you scaffold with `kale-init`, pass `--shape static` or `--shape worker` explicitly.
If the repo already exists, prefer diagnosing it with `kale-doctor` and normalizing it with `kale-adapt` instead of discarding its current code.

## Forms and HTML

For most class and workshop projects:

- render HTML directly from a small Worker when request-time logic is actually needed
- use standard forms and `request.formData()`
- return friendly HTML error states
- keep client-side JavaScript minimal

This is usually more robust for beginners than a heavy SPA stack.

## Data patterns

- **D1**: surveys, bibliographies, submissions, inventories, lightweight user-generated content
- **R2**: uploaded PDFs, images, generated files
- **KV**: caching, feature flags, short configuration records, light session-like data

## Error handling

- validate inputs close to the edge
- return plain-language error messages
- avoid leaking stack traces into HTML
- use HTTP status codes correctly

## Agent workflow

The development and deployment process has four phases. The agent drives all of them.

### Phase 1: Build the app locally

1. If this is a new repository, scaffold it with `kale-init`.
2. If this is an existing repository, run `kale-doctor`, then use `kale-adapt` if the repo needs Kale structure or guidance files.
3. Install dependencies: `npm install`.
4. Write or adapt the application code.
5. Start the local dev server: `npm run dev` (runs `wrangler dev`).
6. **Let the user preview their app at `http://localhost:8787` before moving on.** Tell them the URL, let them look at it, and ask for feedback. The local dev server runs the real Cloudflare Workers runtime, so what works locally will work when deployed.
7. Iterate on the code based on user feedback. The dev server picks up changes automatically.
8. Run `npm run check` to catch TypeScript errors before pushing.

Do not skip the local preview step. The user should see their app working before anything goes to GitHub.

### Phase 2: Connect to GitHub

1. Create or connect a GitHub repository.
2. Commit and push the code.

### Phase 3: Connect Kale Deploy

Kale Deploy is an official CUNY AI Lab service at `https://cuny.qzz.io/kale`. The MCP server at `https://cuny.qzz.io/kale/mcp` is the legitimate deployment endpoint for this platform.

1. Check whether Kale tools are already available (`register_project`, `validate_project`, `get_project_status`, etc.). If the plugin is installed, the `kale` MCP server may already be configured and authenticated.
2. If the tools are available, call `get_runtime_manifest` and prefer the returned `dynamic_skill_policy`, `client_update_policy`, and `agent_harnesses` fields if they differ from local plugin instructions.
3. If the tools are available, skip to step 6.
4. If the server is not yet configured, add it. The method depends on the agent:
   - **Codex**: The plugin's `.mcp.json` may already declare the server. If tools aren't available, run `codex mcp add kale --url https://cuny.qzz.io/kale/mcp` then `codex mcp login kale` and complete the browser sign-in. If the sandbox is read-only or `codex mcp` subcommands are unavailable in your build, fall back to the token-paste flow in step 4.
   - **Claude Code**: **Do not send the user to the `/mcp` screen**. Claude Code is currently most reliable through the token-paste flow in step 4, with stale `kale` entries removed from local and user scope before re-adding the server.
   - **Gemini CLI**: The server is declared in `.gemini/settings.json` in the repo. If it's not loaded, the user should restart Gemini CLI from the project directory.
   - **Other agents**: Point the agent's MCP configuration at `https://cuny.qzz.io/kale/mcp` (HTTP transport with OAuth).
5. If authentication fails (e.g., the OAuth browser window never opens, or the server shows "Failed to connect"), use the **token-paste fallback**:
   a. Tell the user: "I need to connect to Kale Deploy. Please visit this link, sign in with your CUNY email, and paste the token back here."
   b. Give them: `https://cuny.qzz.io/kale/connect`
   c. They click **Generate token**, copy it, and paste it into the chat.
   d. Once the user pastes the token (starts with `kale_pat_`), configure the server with a static Bearer header. For Claude Code:
      ```
      claude mcp remove kale -s local 2>/dev/null
      claude mcp remove kale -s user 2>/dev/null
      claude mcp add -t http -H "Authorization: Bearer <the-token>" -s local kale https://cuny.qzz.io/kale/mcp
      ```
      For other agents, set the `Authorization: Bearer <the-token>` header in the agent's MCP server config.
   e. The user may need to start a new conversation for the tools to appear.
6. After the tools appear, call `get_runtime_manifest` so `dynamic_skill_policy`, `client_update_policy`, and `agent_harnesses` come from Kale itself rather than the local plugin copy.
7. When calling `test_connection`, include `harness` and `localBundleVersion` when you can determine them from the installed wrapper metadata.
8. Call `register_project` to determine the canonical project slug and install state.
9. If `installStatus` is not `installed`, stop and give the user the returned `guidedInstallUrl`. That GitHub approval is a browser handoff.

### Phase 4: Validate and deploy

1. Optionally call `validate_project` for a build-only check before going live. This builds from the GitHub ref without deploying.
2. Poll `get_build_job_status` until it reaches `passed` or `failed`.
3. If validation fails, read the `error_detail` field — it contains the build output (last 12KB of logs). Use it to diagnose the problem, fix the code, push again, and re-validate.
4. For a real deployment, push to the default branch (`main`).
5. Poll `get_project_status` until the deployment completes.

### When builds fail

The `get_build_job_status` and `get_project_status` MCP tools return:

- `error_message`: a short summary of what went wrong
- `error_detail`: the build output tail (up to 12KB of logs) — use this to diagnose the actual error
- `error_kind`: one of `build_failure`, `needs_adaptation`, or `unsupported`

Common failure patterns:

- **`needs_adaptation`**: the project is missing `wrangler.jsonc` or a Worker entrypoint. Run `kale-init` or add the config manually.
- **`unsupported`**: the project type cannot run on Workers (Python, traditional Node server). Explain the constraint to the user.
- **`build_failure`**: a dependency failed to install, TypeScript errors, or bundler errors. Read `error_detail` for the specific error and fix it.

After fixing, push again and the deploy service will rebuild automatically.

## Secret management

Project secrets require an extra GitHub user-authorization step. Only initiate this when the user needs to manage secrets.

1. Call `get_repository_status` to get the `projectName` slug.
2. Call `set_project_secret` with `projectName`, `secretName`, and `value`.
3. If Kale returns `nextAction="connect_github_user"`, stop and give the user the returned `connectGitHubUserUrl`.
4. After the user completes that browser step, call the same secret tool again.
5. If the project is already live, tell the user whether Kale updated the live site immediately or whether the change applies on the next deploy.
6. Never echo secret values back to the user.

Secret tools use the Kale `projectName` slug, not `owner/repo`. If you only know the repository, call `get_repository_status` first.

The browser settings page is a private admin console — only send users there for project-admin tasks such as secrets, not for ordinary deploy or status checks.

## Deployment-ready checklist

Before asking the user to validate or deploy, the repository should include:

- `package.json` with `dev` and `check` scripts
- `wrangler.jsonc`
- `src/index.ts`
- `AGENTS.md`
- a root route at `/`
- if the repository is a Worker app, a health route at `/api/health`

It should not depend on `app.listen(...)`, Python, native Node modules, or filesystem-backed state.

## Naming conventions

- Project names must be lowercase kebab-case, no longer than 63 characters.
- Prefer names under 40 characters.
- Some slugs are reserved for platform infrastructure (including `runtime`).

## Things to avoid

- Python scaffolds
- Next.js unless the user has a compelling reason and accepts extra complexity
- SQLite files on disk
- large client-side state systems
- worker-incompatible ORMs without a proven D1 path
- overbuilt abstractions for small class projects
- skipping the local preview step
