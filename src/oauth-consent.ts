import { authenticate } from "./auth";
import { canonicalJson, sha256Hex } from "./domain/digests";
import { ApiError } from "./domain/errors";
import type { Env, OAuthAuthorizationRequest, OAuthHelpersLike } from "./env";
import { OAUTH_REQUIRED_SCOPE } from "./oauth-principal";

const CONSENT_TTL_MS = 10 * 60 * 1000;
export const CONSUME_CONSENT_NONCE_SQL = `UPDATE oauth_consent_nonces SET consumed_at = ?
     WHERE nonce = ? AND owner_subject = ? AND client_id = ? AND request_digest = ?
       AND consumed_at IS NULL AND expires_at > ?`;

function authorizationResource(env: Env): string {
  return new URL("/mcp", env.PUBLIC_BASE_URL).toString();
}

function requireAuthorizationRequest(
  request: OAuthAuthorizationRequest,
  env: Env,
): OAuthAuthorizationRequest {
  const resource = Array.isArray(request.resource) ? request.resource : [request.resource];
  if (
    request.responseType !== "code" ||
    request.scope.length !== 1 ||
    request.scope[0] !== OAUTH_REQUIRED_SCOPE ||
    request.codeChallengeMethod !== "S256" ||
    !request.codeChallenge ||
    resource.length !== 1 ||
    resource[0] !== authorizationResource(env)
  ) {
    throw new ApiError(
      400,
      "invalid_authorization_request",
      "Authorization requires code flow, S256 PKCE, the cail:deploy scope, and the exact MCP resource.",
    );
  }
  return request;
}

async function parseAuthorizationRequest(
  request: Request,
  env: Env,
  helpers: OAuthHelpersLike,
): Promise<OAuthAuthorizationRequest> {
  try {
    return requireAuthorizationRequest(await helpers.parseAuthRequest(request), env);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      400,
      "invalid_authorization_request",
      "The OAuth authorization request is invalid.",
    );
  }
}

async function authorizationRequestDigest(request: OAuthAuthorizationRequest): Promise<string> {
  return sha256Hex(
    canonicalJson({
      responseType: request.responseType,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      scope: request.scope,
      state: request.state,
      codeChallenge: request.codeChallenge,
      codeChallengeMethod: request.codeChallengeMethod,
      resource: request.resource,
    }),
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    if (character === '"') return "&quot;";
    return "&#39;";
  });
}

function consentPage(requestUrl: string, clientName: string, nonce: string): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Authorize Kale Deploy</title></head>
<body><main><h1>Connect ${escapeHtml(clientName)}?</h1><p>Allow this client to use <code>${OAUTH_REQUIRED_SCOPE}</code> for Kale Deploy.</p>
<form method="post" action="${escapeHtml(requestUrl)}"><input type="hidden" name="consentNonce" value="${escapeHtml(nonce)}">
<button type="submit" name="decision" value="approve">Approve</button><button type="submit" name="decision" value="deny">Deny</button></form></main></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
    },
  });
}

async function requireClient(
  helpers: OAuthHelpersLike,
  request: OAuthAuthorizationRequest,
): Promise<{ clientId: string; clientName?: string }> {
  const client = await helpers.lookupClient(request.clientId);
  if (!client || !client.redirectUris.includes(request.redirectUri)) {
    throw new ApiError(400, "invalid_oauth_client", "The OAuth client or redirect URI is invalid.");
  }
  return client;
}

export async function handleOAuthAuthorize(
  request: Request,
  env: Env,
  helpers: OAuthHelpersLike,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    throw new ApiError(405, "method_not_allowed", "The authorization method is not allowed.");
  }
  const principal = await authenticate(request, env);
  if (principal.authentication !== "cail-identity-jwt") {
    throw new ApiError(
      401,
      "authentication_required",
      "A verified CAIL identity JWT is required for OAuth consent.",
    );
  }
  const authorization = await parseAuthorizationRequest(request, env, helpers);
  const client = await requireClient(helpers, authorization);
  const digest = await authorizationRequestDigest(authorization);

  if (request.method === "GET") {
    const nonce = `ocn_${crypto.randomUUID().replaceAll("-", "")}`;
    const expiresAt = new Date(Date.now() + CONSENT_TTL_MS).toISOString();
    await env.DB.prepare(
      "INSERT INTO oauth_consent_nonces (nonce, owner_subject, client_id, request_digest, expires_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(nonce, principal.subject, authorization.clientId, digest, expiresAt)
      .run();
    return consentPage(request.url, client.clientName ?? "your MCP client", nonce);
  }

  if (request.headers.get("Origin") !== new URL(request.url).origin) {
    throw new ApiError(
      403,
      "invalid_consent_origin",
      "OAuth consent must be submitted same-origin.",
    );
  }
  const form = await request.formData();
  const nonce = form.get("consentNonce");
  const decision = form.get("decision");
  if (typeof nonce !== "string" || (decision !== "approve" && decision !== "deny")) {
    throw new ApiError(400, "invalid_consent", "The OAuth consent decision is incomplete.");
  }
  const consumedAt = new Date().toISOString();
  const result = await env.DB.prepare(CONSUME_CONSENT_NONCE_SQL)
    .bind(consumedAt, nonce, principal.subject, authorization.clientId, digest, consumedAt)
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new ApiError(
      409,
      "consent_not_accepted",
      "The OAuth consent nonce is invalid, expired, changed, or already used.",
    );
  }

  if (decision === "deny") {
    const redirect = new URL(authorization.redirectUri);
    redirect.searchParams.set("error", "access_denied");
    if (authorization.state) redirect.searchParams.set("state", authorization.state);
    return Response.redirect(redirect.toString(), 302);
  }

  const { redirectTo } = await helpers.completeAuthorization({
    request: authorization,
    userId: principal.subject,
    metadata: {},
    scope: [OAUTH_REQUIRED_SCOPE],
    props: {
      subject: principal.subject,
      ...(principal.operationalSubject ? { operationalSubject: principal.operationalSubject } : {}),
      scope: [OAUTH_REQUIRED_SCOPE],
    },
  });
  return Response.redirect(redirectTo, 302);
}
