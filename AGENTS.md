# Kale Deploy Repository Guidance

This repository is the control plane and delivery stack for Kale Deploy, the public name for CAIL Deploy from the CUNY AI Lab.

## Product naming

- Use `Kale Deploy` for public-facing product copy.
- Use `CAIL Deploy` only where the actual GitHub App name or internal identifier matters.
- The current public front door is `https://cuny.qzz.io/kale`.

## Repository layout

- `packages/deploy-service`: control-plane Worker, onboarding UI, GitHub App flow, MCP/OAuth, status APIs
- `packages/gateway-worker`: internal project gateway Worker
- `packages/project-host-proxy`: public host proxy on `cuny.qzz.io`
- `packages/build-runner`: managed Node build runner
- `packages/build-contract`: shared types between deploy-service and runner
- `platform`: machine-readable and Markdown runtime contract
- `plugins/kale-deploy`: Codex and Claude plugin bundle

## Deployment shape

- The public product lives at `https://cuny.qzz.io/kale`.
- Project URLs are host-based: `https://<project-name>.cuny.qzz.io`.
- If the public front door URL changes, update these together:
  - `packages/deploy-service/wrangler.jsonc`
  - `packages/gateway-worker/wrangler.jsonc`
  - `packages/project-host-proxy/wrangler.jsonc`
  - docs that mention the public entry point
- When changing URL/base-path behavior, redeploy `deploy-service`, `gateway-worker`, and `project-host-proxy` together.

## Runtime and platform constraints

- This system targets Cloudflare Workers and Workers for Platforms.
- Keep apps and examples Worker-shaped, not traditional long-running Node servers.
- Avoid Python, native Node modules, local filesystem assumptions, and long-running background processes in platform examples and guidance.
- Preserve the standard binding vocabulary where relevant:
  - `DB`
  - `FILES`
  - `CACHE`
  - `AI`
  - `VECTORIZE`
  - `ROOMS`
- Treat advanced bindings as approval-only unless the task is explicitly about platform policy:
  - `DB`, `FILES`, and `CACHE` are self-service via project-isolated provisioning
  - `AI`, `VECTORIZE`, and `ROOMS` require approval

## UI and copy

- Prefer plain-language onboarding.
- Avoid leading with terms like `MCP`, `manifest`, `webhook`, or `runtime contract` in user-facing copy.
- Keep public pages oriented around:
  - connecting an agent
  - connecting GitHub
  - watching setup progress
  - opening the live site
- Do not introduce a second GitHub user-auth step into the ordinary deploy flow. Reserve that for future sensitive project-admin features such as secrets.

## Checks

- Run `npm run check` after structural changes.
- Run `npm run test --workspace @cuny-ai-lab/deploy-service` after deploy-service logic or UI changes.

## Docs to keep aligned

- `README.md`
- `docs/quickstart-students.md`
- `docs/github-app-setup.md`
- `docs/agent-api.md`
- `platform/runtime.json`
- `platform/runtime.md`

If one of those changes public URLs, onboarding language, or auth flow, update the others in the same pass.
