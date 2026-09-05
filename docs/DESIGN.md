# Design gate

## Boundary

Kale Release Control Plane accepts a source artifact from any authenticated producer, records an immutable content-addressed revision, and runs a durable release workflow that prepares and publishes a Worker to one isolated Workers for Platforms namespace. It owns project, revision, release, approval, and release-event records. It does not expose a preview-versus-production target choice because both would address the same publication boundary.

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

The full local lifecycle gate follows Cloudflare's documented HTTP service-binding interface: a test-only `Fetcher` receives the same fully qualified Workers for Platforms `PUT` that production sends to `api.cloudflare.com`. The provider Worker verifies the authorization header, account and namespace path, multipart metadata, and every module. Production has no `WFP_API` binding and therefore continues to use Cloudflare's public API. The local gate drives real workerd Workflow, D1, R2, and Worker Bundler state through ambiguous publication, one reconciliation winner, a second live revision, and rollback of the exact retained first revision. This is contract evidence, not a claim that Cloudflare provider state was changed.

The local integration lane uses Wrangler's `createTestHarness()` to run the Deploy and provider Workers together with route-aware service bindings. It applies the real D1 migrations, inspects authoritative D1/R2 state, exercises signed identity and ownership failures, publication ambiguity and response boundaries, and verifies that rollback reuses the source release's exact prepared key, digest, bytes, and provider module hashes before resetting both Workers' local storage. It also requires the flattened `cail.action.admitted` and `cail.action.terminal` records for a fixed request correlation, including anonymous principal, route, truthful terminal outcome/reason, and bounded duration. The Node test has one bounded total timeout, uses only run-scoped fixtures, and consumes or cancels every response body; it remains hermetic and does not publish to Cloudflare. The existing process-level gate remains an independent transport oracle. See Cloudflare's [integration test harness guide](https://developers.cloudflare.com/workers/testing/test-harness/get-started/) and [configuration reference](https://developers.cloudflare.com/workers/testing/test-harness/configure/).

Canonical references:

- [Cloudflare HTTP service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/)
- [Cloudflare local multi-Worker development](https://developers.cloudflare.com/workers/local-development/multi-workers/)
- [Workers for Platforms multipart upload example](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/platform-examples/)

## MCP protocol direction

Deploy serves one stateless `/mcp` route through Cloudflare Agents' `createMcpHandler`. The maintained handler negotiates both MCP `2026-07-28` and stateless `2025-06-18` clients, so Deploy owns one protocol implementation, one tool dispatcher, and one set of tool schemas.

The repository is also the source of the `cuny-ai-lab` Codex marketplace and its `kale-deploy` plugin. That plugin names this Worker as its only MCP server and documents the tools published by this dispatcher.

OAuth metadata sends browser authorization to the canonical Doorway origin's
unlisted `https://tools.ailab.gc.cuny.edu/api/oauth/authorize` route. Doorway
performs CUNY login and privately forwards the exact consent request with a
short-lived `cail:deploy` identity. Deploy still parses and completes the
authorization, stores the consent nonce, issues the code and access token, and
owns the MCP resource; Doorway never receives the OAuth access token.
The canonical Doorway route and its `KALE_DEPLOY` binding must be read back
before this production profile is released; there is no workers.dev fallback.

The adapter reads and bounds each request once before protocol classification because the SDK handler does not own Deploy's payload ceiling. Its caller signal crosses both protocol lanes and the internal API request. Each tool call races the complete internal dispatch and response read against one 30-second operation deadline; the derived signal reaches the internal `Request`, and the response reader spends only the remaining budget. Caller abort is `499 request_cancelled`, internal deadline expiry is `504 mcp_operation_timeout`, and a response over the independent byte ceiling is `502 mcp_response_too_large`; each path cancels once, releases the reader, and never presents truncated output. Present `Host` and `Origin` hostnames are checked against the request URL hostname before dispatch. The existing Cloudflare OAuth provider still validates bearer tokens and passes restricted principal props into the route; neither MCP implementation receives a bearer token or derives authority from an MCP session. Tool failures remain correlated Kale error documents inside MCP `isError` results.

`kale.preview_project` crosses the existing owner-scoped preview boundary rather than dispatching directly. It can reach only the latest durably live release, inherits the same caller cancellation and operation deadline, returns only the bounded root response, and never returns response cookies. It is the pre-DNS acceptance surface; it is not a public hostname.

Release lifecycle events go to Workers Logs and, when the production `CAIL_FLEET_EVENTS` binding is present, to the shared `cail_fleet_events_v1` Analytics Engine projection. The projection omits stable user pseudonyms and event UUIDs. It is diagnostic, sampled storage rather than release authority; D1 release rows and ordered events remain authoritative.

Tool discovery is generated from the same strict Zod schemas that validate calls, using Zod's supported JSON Schema 2020-12 conversion. Representable enums, identifier grammars, length ceilings, canonical base64 syntax, digest form, required keys, and closed object shapes therefore have one maintained source. The create-project runtime bounds the post-trim name in Unicode code points and adds one explicit closed ECMA-262 pattern override for the trim/non-empty boundary that Zod refinements cannot emit; the parity matrix validates the exported schemas with a draft-2020-12 validator. Runtime checks retain the decoded artifact-byte ceiling and digest semantics that JSON Schema cannot express.

The package graph is pinned to `agents@0.20.1`, `@modelcontextprotocol/server@2.0.0`, `@modelcontextprotocol/client@2.0.0`, and the Agents peer `@modelcontextprotocol/sdk@1.30.0`. The v1 SDK remains only as an executed client-conformance check for the handler's maintained stateless compatibility. `McpAgent`, custom protocol adapters, Durable Objects for MCP sessions, bindings, ingress, and secrets remain absent.

Reference: [Cloudflare Agents SDK v0.20.0 and MCP SDK v2](https://developers.cloudflare.com/changelog/post/2026-07-27-agents-sdk-v0.20.0-mcp-sdk-v2/)

## Scope decisions

GitHub, repository ownership, webhooks, check runs, installation tokens, PATs, email/admin authorization, AWS dispatch, and old identifiers are absent. Linux/Sandbox builds are deferred until a first Linux-only artifact enters the integration scenario. Project D1/R2 provisioning and project secrets are deferred; this slice rejects all requested bindings, which keeps publication isolated without inventing a resource policy engine. One run-scoped KV binding stores only OAuth registration/grant/token protocol state. The isolated deployment verifies an offline run-scoped CAIL identity issuer with the published Identity 5.2.2 package.

## Recovery and rollback

D1 is authoritative for ownership and release history, and R2 holds replay bytes. The isolated stack can be exported with `wrangler d1 export` and `wrangler r2 object get` for named keys. OAuth provider state is non-authoritative, test-only KV data; deleting it revokes clients and sessions without stranding projects, releases, or artifacts.

Release-history reads are complete-or-error. Deploy checks a 256-event and 1 MiB encoded-field budget before materializing rows, then rechecks a sentinel-limited result so concurrent append cannot silently turn a complete history into a truncated one. Histories outside either budget return `release_history_too_large`.
