# Kale Deploy

Kale Deploy is a GitHub-first publishing system from the CUNY AI Lab. It lets a user work with an AI agent, connect a GitHub repository, and publish a Cloudflare Worker app to a host-based project URL like `https://<project-name>.cuny.qzz.io`.

## Current URLs

- Public front door: `https://cuny.qzz.io/kale`
- Runtime manifest: `https://runtime.cuny.qzz.io/.well-known/kale-runtime.json`
- Project URL pattern: `https://<project-name>.cuny.qzz.io`

The lower-level Cloudflare Workers still exist behind that front door:

- deploy-service: `https://cail-deploy-service.ailab-452.workers.dev`
- internal gateway: `https://cail-gateway.ailab-452.workers.dev/<project-name>`

## What This Repo Contains

- `packages/deploy-service`: control-plane Worker for onboarding, GitHub App setup, MCP/OAuth, project registration, validation, and deployment state.
- `packages/gateway-worker`: internal gateway Worker that dispatches requests to deployed project Workers.
- `packages/project-host-proxy`: wildcard host proxy on `cuny.qzz.io` that routes public traffic to the gateway and exposes the public runtime manifest.
- `packages/build-runner`: managed Node-based runner that pulls build jobs from Cloudflare Queues, builds Worker artifacts, and reports back to the deploy service.
- `packages/build-contract`: shared types used by the deploy service and the runner.
- `platform`: assistant-neutral runtime contract in Markdown and JSON.
- `plugins/kale-deploy`: shared Codex and Claude Code plugin bundle plus the `kale-init` assistant workflow.

## Architecture

At a high level:

1. A user connects a repository through the shared GitHub App.
2. A push to the default branch reaches the deploy-service webhook.
3. The deploy service creates a GitHub check, stores state in D1, and enqueues a build job.
4. The build runner checks out the repository, builds the Worker bundle, and calls back with the artifact metadata.
5. The deploy service uploads the Worker to Workers for Platforms, updates deployment state, and completes the GitHub check.
6. Public traffic reaches `https://<project-name>.cuny.qzz.io` through the host proxy and gateway.

## Repository Layout

```text
.
├── docs/
├── packages/
│   ├── build-contract/
│   ├── build-runner/
│   ├── deploy-service/
│   ├── gateway-worker/
│   └── project-host-proxy/
├── platform/
└── plugins/
    └── kale-deploy/
```

## Local Development

Install dependencies from the repo root:

```bash
npm install
```

Run the workspace checks:

```bash
npm run check
```

Run the deploy-service tests:

```bash
npm run test --workspace @cuny-ai-lab/deploy-service
```

## Deploying

Apply the deploy-service D1 migrations before deploying the Workers:

```bash
npx wrangler d1 migrations apply cail-control-plane --config packages/deploy-service/wrangler.jsonc
```

Deploy the core Workers:

```bash
npx wrangler deploy --config packages/deploy-service/wrangler.jsonc
npx wrangler deploy --config packages/gateway-worker/wrangler.jsonc
npx wrangler deploy --config packages/project-host-proxy/wrangler.jsonc
```

The build runner is separate from the Workers deployment. See the runner hosting guide below before changing how it is hosted.

## Assistant and MCP Surface

Kale Deploy exposes:

- a remote MCP server at `POST /mcp`
- MCP OAuth metadata under `/.well-known/oauth-*`
- a machine-readable runtime manifest at `https://runtime.cuny.qzz.io/.well-known/kale-runtime.json`
- structured JSON endpoints for repo registration, validation, and status polling

The MCP surface is a thin adapter over the deploy-service control plane, not a separate backend.

Current harness note:

- The public setup prompts now tell supported harnesses to acquire the `kale-deploy` skill or plugin first, then connect Kale.
- Codex can usually use the standard MCP OAuth flow directly.
- Claude Code is more reliable today through the `/connect` token bridge plus `claude mcp add --transport http --header "Authorization: Bearer ..."` rather than the interactive `/mcp` screen.

## Status and Scope

Implemented now:

- GitHub App manifest flow and webhook handling
- Cloudflare Access-backed OAuth for MCP clients
- structured repo registration, validation, and deployment status APIs
- Workers for Platforms project deployment
- host-based project URLs on `*.cuny.qzz.io`
- Codex and Claude plugin packaging
- an AWS-hosted build runner with a stable Elastic IP and SSM-ready instance profile
- a scheduled GitHub Actions healthcheck for the public stack and AWS runner
- no daily validate/deploy cap by default, but support for per-repository override caps
- project-isolated `DB`, `FILES`, and `CACHE` provisioning
- approval-only policy for advanced bindings such as AI, Vectorize, and Rooms
- internal groundwork for future custom-domain routing

Still not finished:

- fully polished onboarding with no human GitHub approval step
- full external custom-domain support
- a richer admin surface for per-project caps
- institution-wide support polish beyond the current pilot shape

## Guides

- Student quickstart: [docs/quickstart-students.md](/Users/stephenzweibel/Apps/CAIL-deploy/docs/quickstart-students.md)
- Claude quickstart: [docs/claude-quickstart.md](/Users/stephenzweibel/Apps/CAIL-deploy/docs/claude-quickstart.md)
- Codex quickstart: [docs/codex-quickstart.md](/Users/stephenzweibel/Apps/CAIL-deploy/docs/codex-quickstart.md)
- Support matrix: [docs/support-matrix.md](/Users/stephenzweibel/Apps/CAIL-deploy/docs/support-matrix.md)
- Troubleshooting: [docs/troubleshooting.md](/Users/stephenzweibel/Apps/CAIL-deploy/docs/troubleshooting.md)
- Operator runbook: [docs/runbook.md](/Users/stephenzweibel/Apps/CAIL-deploy/docs/runbook.md)
- Pilot policy: [docs/pilot-policy.md](/Users/stephenzweibel/Apps/CAIL-deploy/docs/pilot-policy.md)
- Pilot checklist: [docs/pilot-checklist.md](/Users/stephenzweibel/Apps/CAIL-deploy/docs/pilot-checklist.md)
- Agent API: [docs/agent-api.md](/Users/stephenzweibel/Apps/CAIL-deploy/docs/agent-api.md)
- Cloudflare Access auth: [docs/cloudflare-access-auth.md](/Users/stephenzweibel/Apps/CAIL-deploy/docs/cloudflare-access-auth.md)
- GitHub App setup: [docs/github-app-setup.md](/Users/stephenzweibel/Apps/CAIL-deploy/docs/github-app-setup.md)
- Friendly URL rollout: [docs/friendly-url-rollout.md](/Users/stephenzweibel/Apps/CAIL-deploy/docs/friendly-url-rollout.md)
- Future custom domains plan: [docs/custom-domains-plan.md](/Users/stephenzweibel/Apps/CAIL-deploy/docs/custom-domains-plan.md)
- Build runner hosting: [docs/build-runner-hosting.md](/Users/stephenzweibel/Apps/CAIL-deploy/docs/build-runner-hosting.md)
- Build runner contract: [docs/build-runner-contract.md](/Users/stephenzweibel/Apps/CAIL-deploy/docs/build-runner-contract.md)

## Archive Policy

Deployment metadata stays in D1. Artifact retention is intentionally bounded:

- keep the latest two successful deployment bundles per project in R2 for rollback
- keep failed deployment manifests briefly for debugging
- prune older R2 artifacts while preserving deployment metadata in D1
