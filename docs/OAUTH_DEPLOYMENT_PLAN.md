# OAuth MCP isolated deployment plan

This plan is source-only. No Cloudflare resource, D1 migration, secret, route, or Worker version has been created or changed for OAuth MCP.

After independent source acceptance and a new exact authorization, Integration may:

1. Create the single planned KV namespace in `resources/oauth-provisional-manifest.json` and record its provider ID.
2. Add the `OAUTH_KV` binding to `wrangler.integration.jsonc` with that exact ID. Set `PUBLIC_BASE_URL` to `https://ki-20260722223510-ecade68e-deploy.ailab-452.workers.dev` and update `SERVICE_RELEASE` only to the independently accepted OAuth descendant.
3. Apply `schema/0002_oauth_consent.sql` to the existing run-scoped D1 with `CLOUDFLARE_ACCOUNT_ID=452c33847cf5cb1e46f391fca32fd1b5 bunx wrangler d1 migrations apply ki-20260722223510-ecade68e-deploy-d1 --remote --config wrangler.integration.jsonc`.
4. Redeploy only the existing run-scoped Worker, then run the accepted OAuth 2.1/PKCE and standard MCP-client canary. No custom route, D1, R2 bucket, Workflow, dispatch namespace, secret, or API token is added.

The existing Worker depends on the new KV after redeploy. Teardown deletes the Worker before the KV; deleting KV revokes test OAuth clients and tokens without affecting authoritative D1 project/release history or R2 artifacts. D1 teardown remains last. Secrets and token values never appear in this plan or manifest.
