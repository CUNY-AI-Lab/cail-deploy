# Friendly URL Rollout

Kale Deploy is currently mounted at:

- `https://cuny.qzz.io/kale`

That gives the product a friendlier public front door without changing the live project host pattern:

- Kale Deploy UI and API: `https://cuny.qzz.io/kale`
- Live projects: `https://<project-name>.cuny.qzz.io`

## What is already true

The deploy-service Worker already respects the pathname in `DEPLOY_SERVICE_BASE_URL`, including:

- homepage links
- GitHub setup and install links
- OAuth metadata
- MCP endpoint URLs
- cookie paths

The gateway Worker already respects `INSTALL_URL`, so it can point people back to a path like:

- `https://cuny.qzz.io/kale/github/install`

## Cutover checklist

1. Route or proxy a public path like `https://.../kale/*` to the deploy-service Worker.
2. Update the deploy-service var:
   - `DEPLOY_SERVICE_BASE_URL=https://.../kale`
3. Update the gateway var:
   - `INSTALL_URL=https://.../kale/github/install`
4. Redeploy:
   - `packages/deploy-service`
   - `packages/gateway-worker`
5. Update the GitHub App URLs to the same base path:
   - Homepage URL
   - Setup URL
   - Webhook URL
6. Verify:
   - `https://.../kale/`
   - `https://.../kale/github/install`
   - `https://.../kale/github/setup`
   - `https://.../kale/.well-known/oauth-authorization-server`
   - `https://.../kale/mcp`

## Why this is the right scope

Kale Deploy itself can live comfortably under a path on the CUNY AI Lab site. Student projects should not. Their canonical URLs should stay host-based, for example:

- `https://cail-deploy-smoke-test.cuny.qzz.io`

That avoids the asset, redirect, cookie, and API problems that happen when arbitrary apps are forced into path prefixes.

## Current state

The original Cloudflare testbed still exists behind the front door:

- `https://cail-deploy-service.ailab-452.workers.dev`

The point of this rollout is to keep the user-facing entry point friendly without changing the underlying platform shape.
