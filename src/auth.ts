import { parseIdentityConfig, verifyIdentityJwt } from "@cuny-ai-lab/cail-identity";
import { SUBJECT_PATTERN } from "./domain/contracts";
import { ApiError } from "./domain/errors";
import type { Env } from "./env";

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
    });
    if (!config.ok) {
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
