# GitHub App Setup

Kale Deploy is designed around one central GitHub App owned by the [CUNY-AI-Lab](https://github.com/CUNY-AI-Lab) organization. Students, faculty, and staff should install that app on repositories; they should not have to create their own GitHub App.

The actual GitHub App name remains `CAIL Deploy`.

The current public front door is:

- `https://cuny.qzz.io/kale`

The current Cloudflare deployment shape behind that front door is:

- deploy-service: `https://cail-deploy-service.ailab-452.workers.dev`
- gateway: `https://cail-gateway.ailab-452.workers.dev/<project-name>`

## Recommended path

Use the manifest flow exposed by the deploy-service instead of filling out the GitHub form by hand:

1. Open `https://cuny.qzz.io/kale/github/register`.
2. GitHub opens the new-app page inside the `CUNY-AI-Lab` organization with the CAIL manifest prefilled.
3. Confirm the registration.
4. GitHub redirects back to `https://cuny.qzz.io/kale/github/manifest/callback`.
5. Copy the returned values immediately:
   - `GITHUB_APP_ID`
   - `GITHUB_APP_SLUG`
   - `GITHUB_WEBHOOK_SECRET`
   - `GITHUB_APP_PRIVATE_KEY`

The manifest flow already fills in:

- Homepage URL: `https://cuny.qzz.io/kale`
- Setup URL: `https://cuny.qzz.io/kale/github/setup`
- Webhook URL: `https://cuny.qzz.io/kale/github/webhook`
- Permissions: `Checks: Read & write`, `Contents: Read`, `Metadata: Read`
- Events: `Push`
- Installability: `Any account`

## Who can do this

The person completing the manifest flow must have permission to create GitHub Apps for the `CUNY-AI-Lab` organization.

## Cloudflare config after registration

Set these values in the deploy-service Worker:

- vars:
  - `GITHUB_APP_ID`
  - `GITHUB_APP_SLUG`
  - `GITHUB_APP_NAME`
- secrets:
  - `GITHUB_APP_PRIVATE_KEY`
  - `GITHUB_WEBHOOK_SECRET`
  - `BUILD_RUNNER_TOKEN`
  - `CLOUDFLARE_API_TOKEN`
  - `GATEWAY_PREVIEW_TOKEN`

Set the same `GATEWAY_PREVIEW_TOKEN` secret on the gateway Worker too. Kale uses it for the authenticated preview path that validates automatic `shared_static` cutovers without replacing the live project Worker first.

Example commands:

```bash
npx wrangler secret put GITHUB_APP_PRIVATE_KEY --config packages/deploy-service/wrangler.jsonc
npx wrangler secret put GITHUB_WEBHOOK_SECRET --config packages/deploy-service/wrangler.jsonc
npx wrangler secret put BUILD_RUNNER_TOKEN --config packages/deploy-service/wrangler.jsonc
npx wrangler secret put CLOUDFLARE_API_TOKEN --config packages/deploy-service/wrangler.jsonc
npx wrangler secret put GATEWAY_PREVIEW_TOKEN --config packages/deploy-service/wrangler.jsonc
npx wrangler secret put GATEWAY_PREVIEW_TOKEN --config packages/gateway-worker/wrangler.jsonc
```

The `CLOUDFLARE_API_TOKEN` now needs enough account permissions for Kale's managed provisioning flow:

- `Workers Scripts: Edit`
- `D1: Edit`
- `Workers KV Storage: Edit`
- `Workers R2 Storage: Edit`

Then redeploy the Workers:

```bash
npx wrangler deploy --config packages/deploy-service/wrangler.jsonc
npx wrangler deploy --config packages/gateway-worker/wrangler.jsonc
```

## Verification checklist

1. Open `https://cuny.qzz.io/kale/github/app`.
2. Confirm `appId` and `appSlug` are populated.
3. Open `https://cuny.qzz.io/kale/github/install`.
4. Install the app on a test repository.
5. Push to `main`.
6. Confirm the GitHub check run appears and completes.
7. Confirm the live app is reachable at `https://<project-name>.cuny.qzz.io`.

## Notes

- The current public front door is `https://cuny.qzz.io/kale`. The lower-level Workers still exist behind it.
- Ordinary Kale deploys only need the shared GitHub App installation. The second GitHub user-auth step appears only for sensitive project-admin actions such as secrets.
- Current harness install and update policy is published in the runtime manifest at `https://runtime.cuny.qzz.io/.well-known/kale-runtime.json`, especially `dynamic_skill_policy`, `client_update_policy`, and `agent_harnesses`. For Claude Code, the preferred ready state is one direct HTTP `kale` MCP server that uses `headersHelper` to read and refresh the latest valid Kale OAuth token; `mcp-remote` is only the OAuth bootstrap.
- Project secret management requires `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, and `CONTROL_PLANE_ENCRYPTION_KEY`. Those are not part of the ordinary deploy path, but they must be configured before secrets will work.
- If the CUNY AI Lab front page later becomes the public entry point, update `DEPLOY_SERVICE_BASE_URL`, `PROJECT_BASE_URL`, and the GitHub App URLs together. A draft checklist is in [friendly-url-rollout.md](/Users/stephenzweibel/Apps/CAIL-deploy/docs/friendly-url-rollout.md).
- The deploy-service also exposes:
  - `/github/app` for machine-readable app metadata
  - `/github/setup` for the post-install landing page
  - `/github/manifest` for the exact manifest JSON being submitted to GitHub
