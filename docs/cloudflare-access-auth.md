# Cloudflare Access and MCP OAuth

Kale Deploy now uses Cloudflare Access as the browser identity layer inside a standard MCP OAuth flow.

The intended shape is:

1. a harness connects to `POST /mcp`
2. Kale replies with OAuth challenge headers and protected-resource metadata
3. the harness discovers the authorization server metadata
4. the harness opens the browser to `GET /api/oauth/authorize`
5. Cloudflare Access handles the institutional login there
6. Kale issues an OAuth access token back to the harness
7. the harness stores that token and continues using `/mcp`

This keeps the harness-facing auth model standard while still letting Cloudflare Access enforce institutional identity.

There is also a pragmatic fallback token bridge at `/connect` for harnesses that fail the browser exchange in practice today. That fallback does not change the intended long-term MCP contract; it is there to keep current harness onboarding usable.

## What to protect

Protect the browser-facing authorization endpoint with Cloudflare Access:

- `GET /api/oauth/authorize`
- the existing setup/status API paths you want to keep browser-visible:
  - `POST /api/projects/register`
  - `POST /api/validate`
  - `GET /api/projects/*/status`
  - `GET /api/build-jobs/*/status`

Keep these public:

- `POST /mcp`
- `GET /.well-known/oauth-protected-resource/mcp`
- `GET /.well-known/oauth-authorization-server`
- `POST /oauth/register`
- `POST /oauth/token`
- `POST /github/webhook`
- the public runtime manifest
- landing and setup pages, if you still want them visible without login

The key detail is that `/mcp` stays public as an OAuth-protected resource. Cloudflare Access should sit on the browser authorization path, not on the MCP transport itself.

## Required deploy-service config

Worker vars:

- `CLOUDFLARE_ACCESS_TEAM_DOMAIN`
- `CLOUDFLARE_ACCESS_AUD`
- `CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS`
- optional: `CLOUDFLARE_ACCESS_ALLOWED_EMAILS`

Worker secret:

- `MCP_OAUTH_TOKEN_SECRET`

Optional:

- `MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS`
- `MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS`

Example local values are in [packages/deploy-service/.dev.vars.example](/Users/stephenzweibel/Apps/CAIL-deploy/packages/deploy-service/.dev.vars.example).

## Why this is a good long-term shape

This is not just an interim hack.

The stable abstraction is:

- MCP OAuth for agents and harnesses
- browser identity at the Cloudflare Access layer
- eventual CUNY SSO inside that same Access boundary

Later, you can replace one-time email codes with real CUNY SSO inside Cloudflare Access without changing the MCP-facing contract.
