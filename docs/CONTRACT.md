# Kale artifact and release contract

Contract revision: `kale.release.v1`

All JSON responses use `content-type: application/json`. Errors have the exact shape:

```json
{"error":{"code":"stable_code","message":"Plain-language detail.","requestId":"request-id"}}
```

Authentication accepts exactly one credential. The isolated integration stack verifies `X-CAIL-Identity-JWT` with RS256/JWKS, exact issuer, and exact scalar Deploy audience. Ownership uses only its verified `subject`. A signed optional `operationalSubject` may identify user-attributed operational events; when absent, Deploy emits service-attributed events and does not derive or map from the ownership subject. The local component-test mode accepts only its explicit bearer map.

Clients propagate correlation through `X-CAIL-Request-Id`, which must be a UUID. Deploy returns that same value in errors and release operational events.

## Service API

- `POST /v1/projects` with `Idempotency-Key` and `{"name":"Example"}` returns `201` and `{projectId,name,createdAt}`.
- `POST /v1/projects/{projectId}/revisions` accepts exact artifact JSON bytes as `application/vnd.cuny.kale.artifact.v1+json`. `Content-Digest` is required as `sha-256=:<base64>:`. It returns `201`, or `200` for the same retained revision.
- `POST /v1/projects/{projectId}/releases` with `Idempotency-Key` and `{revisionId,target,approval}` returns `202`.
- `GET /v1/projects/{projectId}/releases/{releaseId}` returns the release and ordered events.
- `POST /v1/projects/{projectId}/releases/{releaseId}/approve` with `Idempotency-Key` and `{decision:"approved"}` returns `202`.
- `POST /v1/projects/{projectId}/releases/{releaseId}/rollback` with `Idempotency-Key` and `{approval:"required"|"automatic"}` returns a new release.
- `POST /v1/projects/{projectId}/releases/{releaseId}/reconcile` retries only a release whose prepared bytes are retained and whose state is `publishing` or `reconciling`.

`target` is `preview` or `production`. The isolated deployment permits `preview` only. The exact release status enum is `queued`, `validating`, `building`, `prepared`, `awaiting_approval`, `publishing`, `reconciling`, `live`, `rejected`, or `failed`. The underscore spelling `awaiting_approval` is normative.

## MCP

`POST /mcp` exposes the same operations through JSON-RPC 2.0 tools. `kale.upload_revision` carries `artifactBase64` and `contentDigest`; all other arguments mirror the service API. `/.well-known/oauth-protected-resource` identifies the MCP resource and configured CAIL authorization server. MCP never has more authority than the bearer principal.

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
