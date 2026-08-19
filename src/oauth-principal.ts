import type { Principal } from "./auth";
import { SUBJECT_PATTERN } from "./domain/contracts";
import { z } from "zod";

const OPERATIONAL_SUBJECT_PATTERN = /^cail-v1-[0-9a-f]{32}$/u;
export const OAUTH_REQUIRED_SCOPE = "cail:deploy";

export interface OAuthPrincipalProps {
  subject: string;
  operationalSubject?: string;
  scope: string[];
}

export type OAuthPrincipalInput = {
  subject?: string;
  operationalSubject?: string;
  scope?: string[];
  callerSubject?: string;
} | null;

export type OAuthPrincipalResult =
  | { kind: "ok"; principal: Principal }
  | { kind: "insufficient_scope" }
  | { kind: "invalid" };

const oauthPrincipalPropsSchema = z
  .object({
    subject: z.string().optional(),
    operationalSubject: z.string().optional(),
    scope: z.array(z.string()).optional().catch(undefined),
  })
  .strict();

export function oauthPrincipalFromProps(props: OAuthPrincipalInput): OAuthPrincipalResult {
  const parsed = oauthPrincipalPropsSchema.safeParse(props);
  if (!parsed.success) return { kind: "invalid" };
  const candidate = parsed.data;
  if (candidate.scope?.length !== 1 || candidate.scope[0] !== OAUTH_REQUIRED_SCOPE) {
    return { kind: "insufficient_scope" };
  }
  if (candidate.subject === undefined || !SUBJECT_PATTERN.test(candidate.subject)) {
    return { kind: "invalid" };
  }
  if (
    candidate.operationalSubject !== undefined &&
    !OPERATIONAL_SUBJECT_PATTERN.test(candidate.operationalSubject)
  ) {
    return { kind: "invalid" };
  }
  const principal: Principal = {
    subject: candidate.subject,
    authentication: "oauth-access-token",
  };
  if (candidate.operationalSubject) principal.operationalSubject = candidate.operationalSubject;
  return {
    kind: "ok",
    principal,
  };
}

export function insufficientScopeResponse(
  protectedResourceMetadataUrl: string,
  requestId: string,
): Response {
  return Response.json(
    {
      error: "insufficient_scope",
      error_description: "This app doesn't have permission to deploy.",
    },
    {
      status: 403,
      headers: {
        "X-CAIL-Request-Id": requestId,
        "WWW-Authenticate": `Bearer realm="OAuth", resource_metadata="${protectedResourceMetadataUrl}", error="insufficient_scope", scope="${OAUTH_REQUIRED_SCOPE}"`,
      },
    },
  );
}
