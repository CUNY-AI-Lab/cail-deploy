# Kale artifact and release contract

Contract revision: `kale.release.v1`

All JSON responses use `content-type: application/json`. Errors have the exact shape:

```json
{"error":{"code":"stable_code","message":"Plain-language detail.","requestId":"request-id"}}
```

The raw service API accepts exactly one `X-CAIL-Identity-JWT`. The isolated integration stack verifies it with RS256/JWKS, exact issuer, expiry, and exact scalar Deploy audience `cail:deploy`. Ownership uses only its verified `subject`. A signed optional `operationalSubject` may identify user-attributed operational events; when absent, Deploy emits service-attributed events and does not derive or map from the ownership subject. The local component-test mode accepts only its explicit bearer map and has no user operational identity.

Clients propagate correlation through `X-CAIL-Request-Id`, which must be a UUID. Deploy returns that same value in errors and release operational events.

## Service API

- `POST /v1/projects` with `Idempotency-Key` and `{"name":"Example"}` returns `201` and `{projectId,name,createdAt}`.
- `POST /v1/projects/{projectId}/revisions` accepts exact artifact JSON bytes as `application/vnd.cuny.kale.artifact.v1+json`. `Content-Digest` is required as `sha-256=:<base64>:`. It returns `201`, or `200` for the same retained revision.
- `GET /v1/projects/{projectId}/revisions/{revisionId}` returns owner-scoped immutable revision metadata only after the D1 row and R2 key, byte count, custom metadata, and SHA-256 checksum agree. Missing and cross-owner revisions share the same `404 revision_not_found`; inconsistent retained state returns `409 artifact_store_inconsistent`. It never returns artifact bytes.
- `POST /v1/projects/{projectId}/releases` with `Idempotency-Key` and `{revisionId,target,approval}` returns `202`.
- `GET /v1/projects/{projectId}/releases/{releaseId}` returns the release and ordered events.
- `POST /v1/projects/{projectId}/releases/{releaseId}/approve` with `Idempotency-Key` and `{decision:"approved"}` returns `202`.
- `POST /v1/projects/{projectId}/releases/{releaseId}/rollback` with `Idempotency-Key` and `{approval:"required"|"automatic"}` returns a new release.
- `POST /v1/projects/{projectId}/releases/{releaseId}/reconcile` retries only a release whose prepared bytes are retained and whose state is `publishing` or `reconciling`.

`target` is `preview` or `production`. The isolated deployment permits `preview` only. The exact release status enum is `queued`, `validating`, `building`, `prepared`, `awaiting_approval`, `publishing`, `reconciling`, `live`, `rejected`, or `failed`. The underscore spelling `awaiting_approval` is normative.

## MCP

`POST /mcp` exposes the same operations through JSON-RPC 2.0 tools. The frozen compatibility lane negotiates MCP `2025-06-18`; the stateless MCP SDK v2 lane negotiates `2026-07-28`. Both lanes expose the same six tool names, descriptions, strict JSON Schema 2020-12 input schemas generated from the runtime Zod argument schemas, and Kale tool-result errors. `kale.upload_revision` carries `artifactBase64` and `contentDigest`; all other arguments mirror the service API.

The provider validates the bearer before protocol handling. MCP never has more authority than that provider-validated principal, the bearer is never forwarded into the raw API authentication function, and protocol state never becomes authority. Requests are bounded before protocol classification. Each internal API tool call has one 30-second operation deadline covering dispatch and response consumption; its derived abort signal is passed into the internal `Request`, and only the remaining budget is spent reading the response. Caller cancellation is a correlated `499 request_cancelled`; an internal deadline is a stable correlated `504 mcp_operation_timeout`. Response overflow is a correlated `502 mcp_response_too_large`: the reader is cancelled once and no truncated result is returned. Present `Host` and `Origin` hostnames must match the request URL hostname. Public responses preserve `X-CAIL-Request-Id`, and tool failures carry the same request ID in their Kale error document.

Release retrieval returns the complete ordered event history only when it contains at most 256 events and at most 1 MiB of encoded event fields. A larger or concurrently growing history fails explicitly with `release_history_too_large`; Deploy never presents a truncated history as complete.

The public surface is frozen in `contract/oauth-mcp-v1.json`:

- `GET /.well-known/oauth-protected-resource/mcp` identifies the exact absolute `/mcp` resource, the same-origin authorization server, and only `cail:deploy`.
- `GET /.well-known/oauth-authorization-server` identifies `POST /oauth/register`, `GET|POST /api/oauth/authorize`, and `POST /oauth/token`.
- Authorization uses a public OAuth 2.1 authorization-code client with S256 PKCE. Plain PKCE, implicit flow, token exchange, CIMD, and external/PAT tokens are disabled.
- Both authorize methods independently verify `X-CAIL-Identity-JWT` with the same exact issuer and `cail:deploy` audience. GET renders explicit client/scope consent but grants nothing. POST consumes one opaque ten-minute D1 nonce bound to the verified subject, client, canonical authorization request, and expiry.
- The grant carries only `{subject, operationalSubject?, scope:["cail:deploy"]}`. The Cloudflare provider validates the bearer and passes those props to the MCP adapter; Deploy validates their representation before constructing its existing `Principal`.
- `Authorization` is accepted only on `/mcp`; raw `/v1` remains identity-JWT-only. Supplying both credentials to `/mcp` returns `credential_ambiguity`.
- Missing, invalid, expired, or wrong-resource bearer tokens return the provider's RFC 9728 `401` challenge. Missing scope returns `403` with `scope="cail:deploy"`. Tokens and provider internals are never included in application error bodies.

The exact provider pin is `@cloudflare/workers-oauth-provider@0.5.0`, source `b4bc502c3421f2bc8a61760fb84790f09d0fa529`, npm tarball SHA-256 `097c5955e8eb6092575a008d9e3b960fc945b48c8fb26ae252bedd9482bdce11`. Its default refresh-token TTL is 30 days and dynamic-registration TTL is 90 days. These are test-only protocol records in `OAUTH_KV`; D1 project/revision/release state does not depend on them.

The MCP transport pins are `agents@0.20.1`, `@modelcontextprotocol/server@2.0.0`, and `@modelcontextprotocol/client@2.0.0`. `@modelcontextprotocol/sdk@1.30.0` satisfies the Agents peer pin and exercises the frozen `2025-06-18` client lane; no separate v1 SDK alias is installed. Cloudflare-specific MCP transport imports remain isolated in `src/adapters/cloudflare/mcp.ts`; the shared tool dispatcher does not depend on Cloudflare Agents.

## Artifact

```json
{
  "schemaVersion": "kale.artifact.v1",
  "runtime": "worker",
  "entrypoint": "src/index.ts",
  "files": {"src/index.ts": "export default { fetch() { return new Response('ok') } }"},
  "compatibility": {"date": "2026-07-22", "flags": []},
  "requestedBindings": []
}
```

Paths are relative, unique object keys without `..`, backslashes, or leading `/`. The artifact is limited to 2 MiB in this slice. Non-empty `requestedBindings` fails with `binding_not_supported`; this is the secret and production-resource isolation gate.

The digest covers the exact transmitted bytes. The service does not reorder fields, trim whitespace, or otherwise normalize JSON. Producers that need a shared golden input must use `fixtures/worker-artifact.v1.json` byte for byte; its final LF is part of the artifact. The response revision ID is `rev_sha256_` followed by the lowercase hexadecimal form of that same SHA-256 digest.
