# Deployment environment binding

Deploy's operational log resource is identified by the explicit
`CAIL_ENVIRONMENT` Worker variable. The source-owned values are exactly
`production`, `staging`, and `test`; the logger never derives an environment
from `AUTH_MODE`, a hostname, or a default. Missing, empty, case-variant, or
whitespace-padded values leave readiness unavailable and reject operational
API/MCP traffic before it can reach authentication or stateful work.

The top-level `wrangler.jsonc` is the isolated local configuration and binds
`CAIL_ENVIRONMENT` to `test`. `wrangler.production.jsonc` is the complete live
configuration and binds `CAIL_ENVIRONMENT` to `production`. The label describes
the control-plane deployment; it is unrelated to artifact publication, which
always stays inside the configured Workers for Platforms namespace.

The live control plane must bind a D1 database created from the canonical
`schema/0001_control_plane.sql`. Because the current live database predates that
greenfield schema, release requires a fresh empty-state database and a new
binding ID before the updated Worker can receive traffic. The prior empty
database stays unbound as a temporary recovery artifact.

References: [Cloudflare Workers environment variables](https://developers.cloudflare.com/workers/configuration/environment-variables/),
[Wrangler environments and non-inheritance](https://developers.cloudflare.com/workers/wrangler/environments/),
and [OpenTelemetry deployment environment](https://opentelemetry.io/docs/specs/semconv/registry/attributes/deployment/).
