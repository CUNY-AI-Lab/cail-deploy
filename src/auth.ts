import { loadIdentityVerifierConfig, verifyIdentityJwt } from "@cuny-ai-lab/cail-identity";
import { trustedIdentityIssuers } from "./identity-issuers";
import { SUBJECT_PATTERN } from "./domain/contracts";
import { ApiError } from "./domain/errors";
import type { Env } from "./env";

/** This service's own audience, named by tokens presented at its ingress. */
export const SERVICE_AUDIENCE = "cail:deploy";

/**
 * Whether identity verification is usable right now. Used by the readiness probe
 * so it reports the same health this boundary enforces, instead of ok
 * unconditionally — which left a broken service in rotation while every
 * authenticated request failed.
 */
export async function identityReady(env: Env): Promise<boolean> {
  if (env.AUTH_MODE !== "cail-jwt") return true;
  const config = await loadIdentityVerifierConfig({
    jwks: env.CAIL_IDENTITY_JWKS,
    issuer: env.CAIL_IDENTITY_ISSUER,
    expectedAudience: env.SERVICE_AUDIENCE,
    supportedIssuers: trustedIdentityIssuers(env),
  });
  return config.ok && env.SERVICE_AUDIENCE === SERVICE_AUDIENCE;
}

export interface Principal {
  subject: string;
  operationalSubject?: string;
  authentication: "isolated-test-bearer" | "cail-identity-jwt" | "oauth-access-token";
}

export async function authenticate(request: Request, env: Env): Promise<Principal> {
  const identityJwt = request.headers.get("X-CAIL-Identity-JWT");
  const authorization = request.headers.get("Authorization");
  if (identityJwt && authorization) {
    throw new ApiError(401, "credential_ambiguity", "Send one sign-in credential, not two.");
  }
  if (env.AUTH_MODE === "cail-jwt") {
    if (!identityJwt || identityJwt.includes(",")) {
      throw new ApiError(401, "authentication_required", "You need to sign in.");
    }
    const config = await loadIdentityVerifierConfig({
      jwks: env.CAIL_IDENTITY_JWKS,
      issuer: env.CAIL_IDENTITY_ISSUER,
      expectedAudience: env.SERVICE_AUDIENCE,
      // See identity-issuers.ts: the trusted set is this environment's declared
      // allowlist, defaulting to the canonical CAIL issuer.
      supportedIssuers: trustedIdentityIssuers(env),
    });
    if (!config.ok) {
      throw new ApiError(
        503,
        "identity_not_configured",
        "Sign-in is unavailable right now. Try again shortly.",
      );
    }
    // The audience is pinned in code rather than merely read from configuration:
    // the fleet audiences sit adjacently in deployment config, so a value
    // mis-set to a peer's would otherwise silently accept that peer's tokens
    // here.
    if (env.SERVICE_AUDIENCE !== SERVICE_AUDIENCE) {
      throw new ApiError(
        503,
        "identity_not_configured",
        "Sign-in is unavailable right now. Try again shortly.",
      );
    }
    const identity = await verifyIdentityJwt(identityJwt, config.config);
    if (!identity)
      throw new ApiError(401, "invalid_credential", "Your sign-in isn't valid. Sign in again.");
    return {
      subject: identity.subject,
      operationalSubject: identity.operationalSubject,
      authentication: "cail-identity-jwt",
    };
  }
  if (env.AUTH_MODE !== "test") {
    throw new ApiError(
      503,
      "identity_not_configured",
      "Sign-in is unavailable right now. Try again shortly.",
    );
  }
  if (identityJwt)
    throw new ApiError(
      401,
      "credential_ambiguity",
      "Test mode accepts one test bearer credential only.",
    );
  const match = authorization?.match(/^Bearer ([A-Za-z0-9._~-]+)$/u);
  if (!match?.[1])
    throw new ApiError(401, "authentication_required", "A bearer credential is required.");

  let principals: Record<string, string>;
  try {
    principals = JSON.parse(env.TEST_PRINCIPALS_JSON ?? "{}") as Record<string, string>;
  } catch {
    throw new ApiError(503, "test_identity_invalid", "The isolated identity map is invalid.");
  }
  const subject = principals[match[1]];
  if (!subject || !SUBJECT_PATTERN.test(subject)) {
    throw new ApiError(401, "invalid_credential", "The bearer credential is invalid.");
  }
  return { subject, authentication: "isolated-test-bearer" };
}
