import { CAIL_CANONICAL_ISSUER } from "@cuny-ai-lab/cail-identity";

/**
 * The issuers this deployment is allowed to be configured with.
 *
 * `supportedIssuers` is an authority over configuration, not over the token:
 * it says which issuer a deployment may be pointed at in the first place.
 * Passing `[env.CAIL_IDENTITY_ISSUER]` made it a tautology — the configuration
 * validated itself — so a bad config push or a compromised secret store could
 * point issuer and JWKS at an attacker pair and this service would verify
 * tokens minted by it.
 *
 * The first fix pinned the list to the canonical CAIL issuer in code. That
 * closed the tautology and broke something real: an isolated run mints tokens
 * from its own run-scoped issuer with its own JWKS, and had no way left to say
 * so. This surfaced on the Gateway, whose practice deployment rejected every
 * fixture JWT while its API-key path kept working. No test caught it there or
 * here, because the tests were written to agree with the change.
 *
 * Two properties are deliberate:
 *
 *   - **Production is locked by default.** Declaring nothing yields the
 *     canonical CAIL issuer, so a deployment cannot be pointed somewhere else
 *     by omission. Trusting anything else takes a deliberate, auditable line of
 *     configuration.
 *   - **An environment trusts only its own issuer.** The practice run declares
 *     its run-scoped issuer instead of production. Issuer unions are rejected.
 *
 * Malformed configuration yields an empty list, which the primitive rejects as
 * `issuer_unsupported`. Falling back to the default would silently move the
 * trust boundary at exactly the moment the operator got it wrong.
 */

export interface IdentityIssuerEnv {
  /** One exact issuer. Absent means the canonical CAIL issuer. */
  CAIL_TRUSTED_IDENTITY_ISSUER?: string;
}

const DEFAULT_TRUSTED_ISSUERS: readonly string[] = [CAIL_CANONICAL_ISSUER];

function isExactIssuer(value: string): boolean {
  if (value.includes(",")) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  // Exactly the primitive's own rule: `parsed.href === value`. An earlier
  // version invented a stricter one — it stripped a root slash and refused any
  // trailing slash — and was wrong in both directions. It rejected
  // `https://issuer.example/tenant/`, which OpenID Connect Discovery permits and
  // the primitive accepts, and it accepted `https://issuer.example`, which the
  // primitive rejects as issuer_unsupported. A gate that disagrees with the
  // thing it guards either strands a valid deployment or passes a configuration
  // that cannot load.
  return (
    parsed.protocol === "https:" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.search === "" &&
    parsed.hash === "" &&
    parsed.href === value
  );
}

export function trustedIdentityIssuers(env: IdentityIssuerEnv): readonly string[] {
  const raw = env.CAIL_TRUSTED_IDENTITY_ISSUER;
  // Absent means "not configured": take the canonical defaults. Present but
  // empty is a different statement and must not be read as absent — a template
  // that renders a missing value as "" would otherwise silently restore trust in
  // production issuers, and an operator clearing the variable to withdraw trust
  // would get the opposite of what they asked for.
  if (raw === undefined) return DEFAULT_TRUSTED_ISSUERS;
  const declared = raw.trim();
  if (declared === "") return [];

  return isExactIssuer(declared) ? [declared] : [];
}
