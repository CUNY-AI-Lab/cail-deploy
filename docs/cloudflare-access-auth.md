# Cloudflare Access and MCP OAuth

Kale Deploy uses [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider) as the OAuth 2.1 authorization server for the MCP surface, with Cloudflare Access sitting in front of the browser-facing authorize endpoint to capture institutional identity.

The top-level shape of the flow is:

1. A harness connects to `POST /mcp`
2. The provider returns an OAuth 2.1 challenge (`WWW-Authenticate: Bearer`) with an RFC 9728 `resource_metadata` hint
3. The harness discovers `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`
4. The harness dynamically registers a client at `POST /oauth/register` (the provider implements RFC 7591)
5. The harness opens the browser to `GET /api/oauth/authorize`
6. Cloudflare Access challenges the user for institutional login and forwards the request with a `cf-access-jwt-assertion` header
7. Kale verifies the Access JWT, then calls `env.OAUTH_PROVIDER.completeAuthorization({ userId, scope, props })` — the provider mints a one-time authorization code, stores the grant in `OAUTH_KV`, and returns a redirect URL
8. The harness exchanges the code at `POST /oauth/token` (implemented by the provider) and receives a bearer access token plus a refresh token
9. The harness calls `/mcp` with the bearer; the provider validates it against the KV-stored grant (tokens are stored as hashes; user props are encrypted with a key derived from the token itself) and invokes the Kale MCP handler with `ctx.props` populated

The `/connect` personal access token bridge still exists for harnesses that can't complete the browser exchange. PATs are resolved through the provider's `resolveExternalToken` callback and flow into the same `McpAuthProps` shape.

## What Kale still owns

Kale Deploy only implements two pieces of the OAuth surface directly:

- The browser-facing `GET /api/oauth/authorize` handler, which verifies the Cloudflare Access JWT on the request and calls `env.OAUTH_PROVIDER.completeAuthorization`. This is where institutional identity enters the system.
- The `resolveExternalToken` callback, which accepts `kale_pat_*` personal access tokens and surfaces them to MCP tools as `McpAuthProps` with `source: "mcp_pat"`. Admin tools reject this source so PATs cannot elevate to Kale admin operations.

Everything else — RFC 8414 metadata, RFC 9728 resource metadata, dynamic client registration, authorization-code exchange, refresh-token rotation, bearer validation, token revocation — is handled by the provider library.

## What to protect with Cloudflare Access

Protect:

- `GET /api/oauth/authorize` — this is the browser identity capture point
- The setup/status paths you want browser-visible:
  - `POST /api/projects/register`
  - `POST /api/validate`
  - `GET /api/projects/*/status`
  - `GET /api/build-jobs/*/status`

Keep public (the provider handles auth on these itself, or they are intentionally unauthenticated):

- `POST /mcp` (provider issues 401 for missing/invalid bearers)
- `POST /oauth/token`
- `POST /oauth/register`
- `GET /.well-known/oauth-authorization-server`
- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-protected-resource/mcp`
- `POST /github/webhook`
- The public runtime manifest
- Landing and setup pages

## Required bindings and config

Worker vars:

- `CLOUDFLARE_ACCESS_TEAM_DOMAIN`
- `CLOUDFLARE_ACCESS_AUD`
- `CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS`
- optional: `CLOUDFLARE_ACCESS_ALLOWED_EMAILS`
- optional: `PROJECT_CONTROL_FORM_TOKEN_SECRET` (only for the browser project-control CSRF token; unrelated to MCP OAuth)

Worker bindings:

- `OAUTH_KV` (KV namespace) — the provider stores OAuth clients, grants, and token metadata here
- `CONTROL_PLANE_DB` (D1) — existing control plane

Create the KV namespace with:

```bash
npx wrangler kv namespace create cail-oauth --config packages/deploy-service/wrangler.jsonc
```

Copy the returned namespace ID into `kv_namespaces[0].id` in `packages/deploy-service/wrangler.jsonc`.

No more `MCP_OAUTH_TOKEN_SECRET` / `MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS` / `MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS` — access/refresh TTLs are configured as constructor options on the provider instance in `packages/deploy-service/src/index.ts`, and token confidentiality comes from KV-stored hashes plus per-token encryption keys rather than a shared HMAC secret.

Example local values are in [packages/deploy-service/.dev.vars.example](/Users/stephenzweibel/Apps/CAIL-deploy/packages/deploy-service/.dev.vars.example).

## Why this shape

- **MCP OAuth is fully standard.** The provider implements RFC 8414, RFC 9728, RFC 7591, and OAuth 2.1 with PKCE out of the box, including cross-client leakage fixes from `@modelcontextprotocol/sdk` ≥ 1.26.
- **Cloudflare Access stays in its lane.** Access is the identity provider for the browser authorize leg; it does not need to sit on `/mcp`, `/oauth/token`, or `/oauth/register`.
- **DCR keeps working.** Every harness install registers its own client with its own loopback redirect URI. There is no shared CLIENT_ID and no manual Cloudflare dashboard step per harness.
- **CUNY SSO is orthogonal.** When CUNY SSO is added to the Access application, the rest of this contract does not change — the harness still sees the same OAuth 2.1 metadata and token endpoints.

## Migration notes (from the bespoke OAuth implementation)

The previous deploy-service minted its own HS256 JWTs (access, refresh, authorization code, client registration) signed with `MCP_OAUTH_TOKEN_SECRET`, and tracked one-shot JTIs in the `oauth_used_grants` / `oauth_used_refresh_tokens` D1 tables. Both tables are dropped in migration `0016_drop_legacy_oauth_tables.sql`. Existing OAuth clients and bearer tokens from that era are invalidated — harnesses that already have a Kale OAuth bearer must re-run `/connect` (PAT) or re-run the OAuth flow (register → authorize → token) to pick up provider-issued tokens.
