import { authenticate } from "./auth";
import { canonicalJson, sha256Hex } from "./domain/digests";
import { ApiError, apiErrorSnapshot } from "./domain/errors";
import type { Env, OAuthAuthorizationRequest, OAuthHelpersLike } from "./env";
import { OAUTH_REQUIRED_SCOPE } from "./oauth-principal";

const CONSENT_TTL_MS = 10 * 60 * 1000;
export const CONSUME_CONSENT_NONCE_SQL = `DELETE FROM oauth_consent_nonces
     WHERE nonce = ? AND owner_subject = ? AND client_id = ? AND request_digest = ?
       AND expires_at > ?`;

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
      "This sign-in link isn't valid. Start again from your app.",
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
    if (apiErrorSnapshot(error)) throw error;
    throw new ApiError(
      400,
      "invalid_authorization_request",
      "This sign-in request isn't valid. Start again from your app.",
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

/**
 * The page's CSP is `default-src 'none'`, so no webfont can ever load here.
 * The Lab's Outfit/Inter are therefore deliberately absent rather than named
 * and silently substituted: this uses the platform UI face at brand weights
 * and colors. Widening the CSP for typography is not worth it on the page
 * where someone grants an app access to their projects.
 */
const CONSENT_PAGE_STYLE = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fafcf8;color:#333;font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:420px;width:100%;margin:24px;background:#fff;border:1px solid #e5e7eb;border-radius:14px;box-shadow:0 1px 2px rgba(51,51,51,.04),0 8px 24px rgba(51,51,51,.06);overflow:hidden}
.topline{height:5px;background:linear-gradient(90deg,#1d3a83 0 33%,#3b73e6 33% 66%,#2fb8d6 66%)}
.body{padding:28px}
.eyebrow{margin:0 0 10px;color:#2a6fb8;font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase}
h1{margin:0 0 14px;font-size:1.4rem;line-height:1.25;font-weight:700;letter-spacing:-.02em;text-wrap:balance}
p{margin:0 0 12px}
ul{margin:0 0 24px;padding-left:1.15rem;color:#4b5563}
li{margin:.3rem 0}
form{display:flex;flex-wrap:wrap;gap:12px}
button{font:inherit;font-weight:600;padding:10px 24px;border-radius:999px;cursor:pointer;transition:background .15s,border-color .15s,color .15s}
button[value=approve]{background:#3b73e6;border:1px solid #3b73e6;color:#fff}
button[value=approve]:hover{background:#2a6fb8;border-color:#2a6fb8}
button[value=deny]{background:transparent;border:1px solid #d1d5db;color:#333}
button[value=deny]:hover{border-color:#9ca3af}
button:focus-visible{outline:2px solid #3b73e6;outline-offset:2px}
@media (prefers-reduced-motion:reduce){button{transition:none}}
`.trim();

function consentPage(requestUrl: string, clientName: string, nonce: string): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Kale Deploy — approve access</title><style>${CONSENT_PAGE_STYLE}</style></head>
<body><main><div class="topline"></div><div class="body">
<p class="eyebrow">CUNY AI Lab &middot; Kale Deploy</p>
<h1>Let ${escapeHtml(clientName)} deploy your projects?</h1>
<p>If you allow this, the app will be able to:</p>
<ul><li>Create projects</li><li>Upload and publish new versions</li><li>Approve, check, and roll back releases</li></ul>
<form method="post" action="${escapeHtml(requestUrl)}"><input type="hidden" name="consentNonce" value="${escapeHtml(nonce)}">
<button type="submit" name="decision" value="approve">Allow</button><button type="submit" name="decision" value="deny">Cancel</button></form>
</div></main></body></html>`;
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
  if (!client) {
    throw new ApiError(
      400,
      "invalid_oauth_client",
      "This app isn't registered correctly. Start again from your app.",
    );
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
    throw new ApiError(401, "authentication_required", "Sign in before approving access.");
  }
  const authorization = await parseAuthorizationRequest(request, env, helpers);
  const client = await requireClient(helpers, authorization);
  const digest = await authorizationRequestDigest(authorization);

  if (request.method === "GET") {
    const nonce = `ocn_${crypto.randomUUID().replaceAll("-", "")}`;
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + CONSENT_TTL_MS).toISOString();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM oauth_consent_nonces WHERE expires_at <= ?").bind(now),
      env.DB.prepare(
        "INSERT INTO oauth_consent_nonces (nonce, owner_subject, client_id, request_digest, expires_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(nonce, principal.subject, authorization.clientId, digest, expiresAt),
    ]);
    return consentPage(request.url, client.clientName ?? "the app you're using", nonce);
  }

  if (request.headers.get("Origin") !== new URL(request.url).origin) {
    throw new ApiError(
      403,
      "invalid_consent_origin",
      "This approval didn't come from the approval page. Start again from your app.",
    );
  }
  const form = await request.formData();
  const nonce = form.get("consentNonce");
  const decision = form.get("decision");
  if (typeof nonce !== "string" || (decision !== "approve" && decision !== "deny")) {
    throw new ApiError(
      400,
      "invalid_consent",
      "The approval form was incomplete. Start again from your app.",
    );
  }
  const consumedAt = new Date().toISOString();
  const result = await env.DB.prepare(CONSUME_CONSENT_NONCE_SQL)
    .bind(nonce, principal.subject, authorization.clientId, digest, consumedAt)
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new ApiError(
      409,
      "consent_not_accepted",
      "This approval page expired. Start again from your app.",
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
