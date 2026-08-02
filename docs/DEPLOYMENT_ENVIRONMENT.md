# Deployment environment binding

Deploy's operational log resource is identified by the explicit
`CAIL_ENVIRONMENT` Worker variable. The source-owned values are exactly
`production`, `staging`, and `test`; the logger never derives an environment
from `AUTH_MODE`, a hostname, or a default. Missing, empty, case-variant, or
whitespace-padded values leave readiness unavailable and reject operational
API/MCP traffic before it can reach authentication or stateful work.

The top-level `wrangler.jsonc` is the isolated local configuration and binds
`CAIL_ENVIRONMENT` to `test`. It declares a separate `env.production` value so
an explicitly selected production profile cannot inherit a test label. Wrangler
bindings and `vars` are non-inheritable across environments, so an authorized
production configuration must provide its complete resource bindings and
`CAIL_ENVIRONMENT: "production"` together. The repository does not declare a
staging profile; selecting one without a complete source-owned configuration
must remain unavailable rather than silently becoming staging.

No deployment or binding migration is performed by this source change.

References: [Cloudflare Workers environment variables](https://developers.cloudflare.com/workers/configuration/environment-variables/),
[Wrangler environments and non-inheritance](https://developers.cloudflare.com/workers/wrangler/environments/),
and [OpenTelemetry deployment environment](https://opentelemetry.io/docs/specs/semconv/registry/attributes/deployment/).
