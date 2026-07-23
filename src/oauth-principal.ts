import type { Principal } from "./auth";
import { SUBJECT_PATTERN } from "./domain/contracts";

const OPERATIONAL_SUBJECT_PATTERN = /^cail-v1-[0-9a-f]{32}$/u;
export const OAUTH_REQUIRED_SCOPE = "cail:deploy";

export interface OAuthPrincipalProps {
  subject: string;
  operationalSubject?: string;
  scope: string[];
}

export type OAuthPrincipalResult =
  | { kind: "ok"; principal: Principal }
  | { kind: "insufficient_scope" }
  | { kind: "invalid" };

export function oauthPrincipalFromProps(props: unknown): OAuthPrincipalResult {
  if (typeof props !== "object" || props === null || Array.isArray(props)) {
    return { kind: "invalid" };
  }
  if (
    Object.keys(props).some(
      (key) => key !== "subject" && key !== "operationalSubject" && key !== "scope",
    )
  ) {
    return { kind: "invalid" };
  }
  const candidate = props as Partial<OAuthPrincipalProps>;
  if (
    !Array.isArray(candidate.scope) ||
    candidate.scope.length !== 1 ||
    candidate.scope[0] !== OAUTH_REQUIRED_SCOPE
  ) {
    return { kind: "insufficient_scope" };
  }
  if (!SUBJECT_PATTERN.test(candidate.subject ?? "")) return { kind: "invalid" };
  if (
    candidate.operationalSubject !== undefined &&
    !OPERATIONAL_SUBJECT_PATTERN.test(candidate.operationalSubject)
  ) {
    return { kind: "invalid" };
  }
  return {
    kind: "ok",
    principal: {
      subject: candidate.subject as string,
      ...(candidate.operationalSubject ? { operationalSubject: candidate.operationalSubject } : {}),
      authentication: "oauth-access-token",
    },
  };
}

export function insufficientScopeResponse(
  protectedResourceMetadataUrl: string,
  requestId: string,
): Response {
  return Response.json(
    { error: "insufficient_scope", error_description: "The cail:deploy scope is required." },
    {
      status: 403,
      headers: {
        "X-CAIL-Request-Id": requestId,
        "WWW-Authenticate": `Bearer realm="OAuth", resource_metadata="${protectedResourceMetadataUrl}", error="insufficient_scope", scope="${OAUTH_REQUIRED_SCOPE}"`,
      },
    },
  );
}
