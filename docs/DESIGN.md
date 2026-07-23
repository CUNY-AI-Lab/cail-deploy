# Design gate

## Boundary

Kale Release Control Plane accepts a source artifact from any authenticated producer, records an immutable content-addressed revision, and runs a durable release workflow that prepares and publishes a Worker to an isolated Workers for Platforms namespace. It owns project, revision, release, approval, and release-event records.

The first vertical slice supports Worker-native TypeScript or JavaScript artifacts only. Worker Bundler compiles them, a Dynamic Worker executes a network-disabled smoke request, R2 retains the exact uploaded and prepared bytes, D1 owns history, Cloudflare Workflows owns durable progress and approval wait, and the documented Workers for Platforms API publishes the prepared modules.

## Invariants

- A principal is derived from authentication, never request JSON. Every project read or mutation compares that subject with D1 ownership.
- The raw API constructs that principal only from its verified CAIL identity JWT. The MCP adapter constructs it only from props attached to a provider-validated OAuth bearer; neither credential crosses into the other surface.
- A revision ID is `rev_sha256_<hex>` over the exact uploaded artifact bytes. The server verifies `Content-Digest` before R2 or D1 writes.
- Revision rows and R2 keys are immutable. Re-uploading the same bytes is an idempotent read; a missing object behind an existing row fails closed.
- A release references one existing revision owned by the same project. Approval is bound to that release and revision.
- Prepared modules are written to R2 with their own digest before the release can enter `prepared` or `publishing`.
- Publication always reuses the retained prepared bytes. Retrying an ambiguous Workers for Platforms `PUT` is safe because the target and body are identical.
- Rollback creates a new release from a retained prepared artifact. It does not rebuild or edit earlier history.
- User artifacts receive no control-plane bindings or secrets. Binding requests fail until project-isolated provisioning is implemented.
- Idempotency keys are scoped to project and operation. Reusing a key with a different request digest fails.

## Evidence and trust boundaries

The digest check prevents a producer or transport error from substituting different bytes for the requested revision. The owner comparison is required because the HTTP and MCP surfaces are multi-tenant. Public OAuth requires explicit consent and a one-use D1 nonce because the browser-to-client grant is a real CSRF/replay boundary; the nonce is bound to the verified subject, client, canonical authorization request, and expiry. OAuth protocol tokens remain in a run-scoped KV namespace. Prepared activation and retry follow the ambiguous-final-write failure already reproduced in CAIL-deploy at `1fd95315b2d4f3e5573383030856a7844ffa4151`.

## Scope decisions

GitHub, repository ownership, webhooks, check runs, installation tokens, PATs, email/admin authorization, AWS dispatch, and old identifiers are absent. Linux/Sandbox builds are deferred until a first Linux-only artifact enters the integration scenario. Project D1/R2 provisioning and project secrets are deferred; this slice rejects all requested bindings, which keeps publication isolated without inventing a resource policy engine. One run-scoped KV binding stores only OAuth registration/grant/token protocol state. The isolated deployment verifies an offline run-scoped CAIL identity issuer with the accepted identity 4.6.0 source package. The local bearer map exists only for component tests.

## Recovery and rollback

D1 is authoritative for ownership and release history, and R2 holds replay bytes. The isolated stack can be exported with `wrangler d1 export` and `wrangler r2 object get` for named keys. OAuth provider state is non-authoritative, test-only KV data; deleting it revokes clients and sessions without stranding projects, releases, or artifacts. Safe teardown uses only exact names and provider IDs in `resources/manifest.json`.
