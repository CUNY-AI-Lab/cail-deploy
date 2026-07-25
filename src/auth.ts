import { parseIdentityConfig, verifyIdentityJwt } from "@cuny-ai-lab/cail-identity";
import { trustedIdentityIssuers } from "./identity-issuers";
import type { JSONWebKeySet } from "jose";
import { SUBJECT_PATTERN } from "./domain/contracts";
import { ApiError } from "./domain/errors";
import type { Env } from "./env";

// A key set with no keys, or with an ambiguous `kid`, cannot verify anything.
// Newer cail-identity rejects both at config load; 4.6.0 does not, so the check
// lives here until Deploy migrates.
function isUsableKeySet(jwks: JSONWebKeySet): boolean {
  if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) return false;
  const kids = jwks.keys.map((key) => key.kid);
  if (kids.some((kid) => typeof kid !== "string" || kid.length === 0)) {
    return false;
  }
  return new Set(kids).size === kids.length;
}

/** This service's own audience, named by tokens presented at its ingress. */
export const SERVICE_AUDIENCE = "cail:deploy";

/**
 * Whether identity verification is usable right now. Used by the readiness probe
 * so it reports the same health this boundary enforces, instead of ok
 * unconditionally — which left a broken service in rotation while every
 * authenticated request failed.
 */
export function identityReady(env: Env): boolean {
  if (env.AUTH_MODE !== "cail-jwt") return true;
  const config = parseIdentityConfig({
    jwks: env.CAIL_IDENTITY_JWKS,
    issuer: env.CAIL_IDENTITY_ISSUER,
    supportedIssuers: trustedIdentityIssuers(env),
  });
  return config.ok && isUsableKeySet(config.jwks) && env.SERVICE_AUDIENCE === SERVICE_AUDIENCE;
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
    throw new ApiError(
      401,
      "credential_ambiguity",
      "Provide exactly one accepted identity credential.",
    );
  }
  if (env.AUTH_MODE === "cail-jwt") {
    if (!identityJwt || identityJwt.includes(",")) {
      throw new ApiError(401, "authentication_required", "One CAIL identity JWT is required.");
    }
    const config = parseIdentityConfig({
      jwks: env.CAIL_IDENTITY_JWKS,
      issuer: env.CAIL_IDENTITY_ISSUER,
      // See identity-issuers.ts: the trusted set is this environment's declared
      // allowlist, defaulting to the canonical CAIL issuers.
      supportedIssuers: trustedIdentityIssuers(env),
    });
    if (!config.ok) {
      throw new ApiError(
        503,
        "identity_not_configured",
        "CAIL identity verification is not configured.",
      );
    }
    // Two operator errors, both reported as unavailable rather than as a bad
    // credential. This primitive treats an empty or duplicate-`kid` key set as a
    // token concern, so every user saw 401 invalid_credential during a bad JWKS
    // rotation while peer services correctly reported 503. And the audience is
    // pinned in code rather than merely read from configuration: the four fleet
    // audiences sit adjacently in deployment config, so a value mis-set to a
    // peer's would otherwise silently accept that peer's tokens here.
    if (!isUsableKeySet(config.jwks) || env.SERVICE_AUDIENCE !== SERVICE_AUDIENCE) {
      throw new ApiError(
        503,
        "identity_not_configured",
        "CAIL identity verification is not configured.",
      );
    }
    const identity = await verifyIdentityJwt(identityJwt, config.jwks, {
      expectedAudience: env.SERVICE_AUDIENCE,
      allowedIssuers: [config.issuer],
    });
    if (!identity)
      throw new ApiError(401, "invalid_credential", "The CAIL identity JWT is invalid.");
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
      "CAIL identity verification is not configured.",
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
