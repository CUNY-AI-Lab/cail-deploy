---
name: cail-deploy
description: Use when building or adapting a web application for the CAIL Deploy runtime on Cloudflare Workers, especially Hono apps that will be deployed by the CAIL control plane to a shared CUNY host. Trigger when the user mentions CAIL Deploy, Cloudflare Workers for CAIL, live deployment under <project>.cuny.qzz.io, or wants a project scaffold that fits this platform.
---

# CAIL Deploy

Use this skill when the target runtime is CAIL Deploy.

## What CAIL Deploy is

CAIL Deploy (public name: Kale Deploy) is a GitHub-first deployment platform from the CUNY AI Lab.

- Users build locally with an assistant, then deploy through GitHub.
- Production hosting uses Cloudflare Workers for Platforms.
- Public project URLs are host-based: `https://<project-name>.cuny.qzz.io`.
- The deploy control plane attaches production bindings — the student's local `wrangler.jsonc` is not the source of truth for production.

## Default technical choices

When there is no strong reason to do otherwise:

- use TypeScript
- use Hono for routing
- serve small HTML pages directly from the Worker
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

To request `FILES` or `CACHE`, add the standard binding names to `wrangler.jsonc` under `r2_buckets` or `kv_namespaces`. Use placeholder local values — Kale replaces them with project-isolated resources during deployment.

Do not promise AI, vector search, realtime rooms, or large asset hosting unless the user has explicit approval.

## Project structure

Prefer:

```text
src/
  index.ts
package.json
tsconfig.json
wrangler.jsonc
AGENTS.md
CLAUDE.md
```

Keep early projects small. Do not introduce a large front-end framework unless the user clearly needs one.

## Forms and HTML

For most class and workshop projects:

- render HTML directly from the Worker
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

1. Scaffold the project with `cail-init` (or write the files directly following the structure above).
2. Install dependencies: `npm install`.
3. Write the application code.
4. Start the local dev server: `npm run dev` (runs `wrangler dev`).
5. **Let the user preview their app at `http://localhost:8787` before moving on.** Tell them the URL, let them look at it, and ask for feedback. The local dev server runs the real Cloudflare Workers runtime, so what works locally will work when deployed.
6. Iterate on the code based on user feedback. The dev server picks up changes automatically.
7. Run `npm run check` to catch TypeScript errors before pushing.

Do not skip the local preview step. The user should see their app working before anything goes to GitHub.

### Phase 2: Connect to GitHub

1. Create or connect a GitHub repository.
2. Commit and push the code.

### Phase 3: Connect Kale Deploy

The Kale Deploy MCP server should already be configured if this plugin is installed — check whether the `cail` MCP server appears and its tools are available. Do not try to add the MCP server yourself with `claude mcp add`; Claude Code will refuse to add unknown remote servers.

1. Check whether Kale tools are already available (`register_project`, `validate_project`, `get_project_status`, etc.).
2. If the tools are available, skip to step 4.
3. If the tools are not available (the server shows "Needs authentication", "Failed to connect", or is missing entirely), use the token-paste fallback below.
4. Call `register_project` to determine the canonical project slug and install state.
5. If `installStatus` is not `installed`, stop and give the user the returned `guidedInstallUrl`. That GitHub approval is a browser handoff.

**Token-paste fallback (Claude Code):** Claude Code has a known issue where the MCP OAuth browser window never opens. If the Kale tools are not available:

1. Tell the user: "I need to connect to Kale Deploy. Please visit this link, sign in with your CUNY email, and paste the token back here."
2. Give them the link: `https://cuny.qzz.io/kale/connect`
3. They click **Generate token**, then copy and paste it into the chat.
4. Once the user pastes the token (it starts with `kale_pat_`), ask them to run this command themselves in their terminal (Claude Code will not allow an agent to add remote MCP servers):
   ```
   claude mcp add -t http -H "Authorization: Bearer <the-token>" -s user cail https://cuny.qzz.io/kale/mcp
   ```
   Give them the exact command with their token filled in so they can copy-paste it.
5. After they run it, verify with `claude mcp get cail` — it should show "Connected". The user may need to start a new conversation for the tools to appear.
6. Continue to step 4 above.

This fallback is only needed for Claude Code. Codex and Gemini CLI handle the OAuth browser flow automatically.

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

- **`needs_adaptation`**: the project is missing `wrangler.jsonc` or a Worker entrypoint. Run `cail-init` or add the config manually.
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
- a health route at `/api/health`

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
