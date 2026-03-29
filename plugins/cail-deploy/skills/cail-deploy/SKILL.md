---
name: cail-deploy
description: Use when building or adapting a web application for the CAIL Deploy runtime on Cloudflare Workers, especially Hono apps that will be deployed by the CAIL control plane to a shared CUNY host. Trigger when the user mentions CAIL Deploy, Cloudflare Workers for CAIL, live deployment under <project>.cuny.qzz.io, or wants a project scaffold that fits this platform.
---

# CAIL Deploy

Use this skill when the target runtime is CAIL Deploy.

## What CAIL Deploy is

CAIL Deploy is a GitHub-first deployment platform for the CUNY AI Lab community.

- Students build locally with an assistant.
- The deploy experience itself happens through GitHub.
- Production hosting uses Cloudflare Workers for Platforms.
- Public project URLs are host-based: `https://<project-name>.cuny.qzz.io`.

The deploy control plane, not the student's local `wrangler.jsonc`, is responsible for attaching production bindings.

## Default technical choices

When there is no strong reason to do otherwise:

- use TypeScript
- use Hono
- serve small HTML pages directly from the Worker
- add JSON routes only where they are clearly useful
- use D1 for structured data
- treat R2 and KV as managed platform extras, not default self-service promises
- treat AI, Vectorize, and Rooms as approval-only features

## Good first app shapes

Bias toward projects that make Kale Deploy useful quickly:

- exhibit or archive sites
- course or project sites
- guestbooks, forms, and submissions
- small APIs
- bibliographies or lightweight searchable collections

These are usually better targets than heavy SPA stacks or apps that assume a traditional server.

## Runtime constraints

- JavaScript and TypeScript only
- no Python
- no native Node modules
- no long CPU-heavy tasks
- do not assume a traditional Node server, filesystem, or process model
- do not use `app.listen(...)` or frameworks that expect a long-running server process
- avoid dependencies that require sockets, child processes, or binary addons

## Standard binding vocabulary

Use these names consistently in generated code:

- `DB`: D1 database
- `FILES`: R2 bucket or project-scoped file storage facade
- `CACHE`: KV namespace
- `AI`: Workers AI
- `VECTORIZE`: Vectorize index
- `ROOMS`: Durable Object namespace

Do not invent binding names unless the user explicitly asks.

Current policy defaults for platform-managed bindings are:

- `DB`, `FILES`, and `CACHE` are self-service
- `AI`, `VECTORIZE`, and `ROOMS` require approval
- `FILES` and `CACHE` are attached as isolated per-project resources when the repository requests them

To request `FILES` or `CACHE`, add the standard binding names to `wrangler.jsonc`:

- `r2_buckets` with `binding: "FILES"`
- `kv_namespaces` with `binding: "CACHE"`

Kale replaces the production bucket and namespace values during deployment, so local placeholder values are acceptable when the repository only needs the production binding.

## Project structure

Prefer a structure like:

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

Use D1 for:

- surveys
- bibliographies
- submissions
- inventories
- lightweight user-generated content

Use R2 for:

- uploaded PDFs
- images
- generated files

Use KV for:

- caching
- feature flags
- short configuration records
- light session-like data

## Error handling

Prefer simple, explicit failures:

- validate inputs close to the edge
- return plain-language error messages
- avoid leaking stack traces into HTML
- use HTTP status codes correctly

## Important deployment fact

`wrangler.jsonc` is local structure and intent metadata. It is not the source of truth for production bindings in CAIL Deploy.

When generating code:

- code against the standard binding names
- keep the config minimal
- do not claim that a student's local Wrangler config alone provisions production resources

## Things to avoid

- Python scaffolds
- Next.js unless the user has a compelling reason and accepts extra complexity
- SQLite files on disk
- large client-side state systems
- worker-incompatible ORMs without a proven D1 path
- overbuilt abstractions for small class projects

## When asked to scaffold

Create a minimal Hono starter with:

- a root HTML route
- `/api/health`
- package scripts for `wrangler dev` and TypeScript checking
- an `AGENTS.md` that records the canonical CAIL runtime assumptions
- a thin `CLAUDE.md` that points back to `AGENTS.md`

If a slash command or scaffolding script is available, use it. Otherwise, write the files directly.

## Deployment-ready checklist

Before you ask the user to validate or deploy, make sure the repo usually has:

- `package.json`
- `wrangler.jsonc`
- `src/index.ts`
- `AGENTS.md`
- a root route at `/`
- `/api/health`
- `npm run check`
- `npm run dev`

## Preferred deployment loop for agents

After scaffolding or adapting the repo, use this loop:

1. Run local preflight:
   - `npm run check`
   - `npx wrangler dev`
2. Create or connect the GitHub repo.
3. If the harness is not already connected to Kale Deploy, connect it to the remote MCP server:
   - `POST https://cuny.qzz.io/kale/mcp`
   - Prefer the direct remote MCP connection when possible so the OAuth/browser flow is visible.
4. Let the harness complete MCP OAuth through the browser:
   - protected resource metadata: `GET /.well-known/oauth-protected-resource/mcp`
   - authorization server metadata: `GET /.well-known/oauth-authorization-server`
   - registration: `POST /oauth/register`
   - browser login: `GET /api/oauth/authorize`
   - token exchange: `POST /oauth/token`
5. Use MCP tools first:
   - `register_project`
   - `validate_project`
   - `get_build_job_status`
   - `get_project_status`
   - confirm the harness can actually see these tools before you say Kale Deploy is connected
   - in Claude Code, the most reliable auth path is the interactive `/mcp` screen
   - if the harness opens a browser login, use only the newest URL from that exact attempt
6. If `installStatus` is not `installed`, stop and give the user the returned `guidedInstallUrl`.
7. After the install step, continue with one of:
   - `validate_project` for a non-production branch or preflight build
   - push to the default branch for a real deployment
8. Poll:
   - `get_build_job_status` for a validation job
   - `get_project_status` for deployment state

Use the structured MCP or JSON responses instead of scraping GitHub check-run prose.

Do not ask the user to confirm a second GitHub account connection for ordinary deploys.

Only ask for the extra GitHub user-auth step when you are managing project secrets:

- `list_project_secrets`
- `set_project_secret`
- `delete_project_secret`

Treat the browser settings page as a private admin console, not a general project page:

- only send the user there for project-admin tasks such as secrets
- do not use it as the default next step for ordinary deploy, validate, or status checks
- only hand out the exact settings URL when the user needs project administration
- assume it is behind CUNY sign-in and repo-admin verification

If one of those tools returns `nextAction="connect_github_user"`, stop and hand the user the returned `connectGitHubUserUrl`.

For those secret tools, pass the Kale `projectName` slug, not `owner/repo`.
If you only know the repository, call `get_repository_status` first and use its returned `projectName`.

### Secret-management example

For a repo `szweibel/kale-cache-smoke-test` and a secret named `OPENAI_API_KEY`:

1. Call `get_repository_status` for `szweibel/kale-cache-smoke-test`.
2. Read the returned `projectName`.
3. Call `set_project_secret` with:
   - `projectName`
   - `secretName="OPENAI_API_KEY"`
   - `value="<the secret value>"`
4. If Kale returns `nextAction="connect_github_user"`, stop immediately and give the user the returned `connectGitHubUserUrl`.
5. After the user finishes that browser step, call the same secret tool again with the same arguments.
6. If the tool succeeds, report that the secret is saved. Do not echo the secret value back to the user.
7. If the project is already live, tell the user whether Kale updated the live site immediately or whether the change will apply on the next deploy.

## Worked example

For a repo `szweibel/cail-deploy-smoke-test`:

1. Add the remote MCP server in Claude Code, Codex, or Gemini CLI.
2. Let the harness open the browser and complete MCP OAuth automatically.
3. Call `register_project` with `repository="szweibel/cail-deploy-smoke-test"`.
4. If needed, hand the user the returned `guidedInstallUrl`.
5. Call `validate_project` for `ref="main"` without deploying.
6. Poll `get_build_job_status` until it reaches `passed` or `failed`.
7. For a real deploy, push to the default branch and poll `get_project_status`.

If the repo is already covered by the GitHub App, the only remaining human step is the GitHub permission click during install. Everything else should be agent-driven.
