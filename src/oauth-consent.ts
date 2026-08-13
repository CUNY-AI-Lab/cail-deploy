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

// Palette and type match the main website (ailab.gc.cuny.edu): cream ground,
// charcoal ink, the Lab's action blue, Inter body with Outfit headings. The
// CSP admits exactly the two Google Fonts hosts and nothing else.
const CONSENT_PAGE_STYLE = `
:root{color-scheme:light;--sans:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--display:Outfit,var(--sans)}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fafcf8;color:#333;font:16px/1.6 var(--sans);-webkit-font-smoothing:antialiased}
main{position:relative;max-width:440px;width:100%;margin:24px;background:#fff;padding:32px}
main::before{content:'';position:absolute;top:0;left:0;right:0;height:4px;background:linear-gradient(90deg,#7ac88e 0 44px,#1d3a83 44px)}
.wordmark{display:flex;align-items:center;gap:10px;margin:0 0 18px}
.mark{display:flex;flex-direction:column;justify-content:center;gap:3px;width:34px;height:32px}
.mark i{display:block;height:4px;border-radius:999px}
.mark .b1{width:26px;margin-left:6px;background:#1d3a83}
.mark .b2{width:28px;margin-left:0;background:#3b73e6}
.mark .b3{width:26px;margin-left:8px;background:#2fb8d6}
.mark .b4{width:24px;margin-left:2px;background:#2a6fb8}
.wordmark-text{display:flex;flex-direction:column;line-height:1.15}
.wordmark-name{font:700 14px/1.15 var(--display);letter-spacing:-.01em}
.wordmark-sub{color:#6b7280;font:500 12px/1.2 var(--sans)}
h1{margin:0 0 14px;font-family:var(--display);font-size:1.5rem;line-height:1.2;font-weight:800;letter-spacing:-.03em;text-wrap:balance}
p{margin:0 0 12px}
ul{margin:0 0 24px;padding-left:1.15rem;color:#4b5563}
li{margin:.3rem 0}
form{display:flex;flex-wrap:wrap;gap:12px}
button{font:inherit;font-weight:600;padding:10px 24px;cursor:pointer;transition:background .15s,border-color .15s,color .15s}
button[value=approve]{background:#2a6fb8;border:1px solid #2a6fb8;color:#fff}
button[value=approve]:hover{background:#1d3a83;border-color:#1d3a83}
button[value=deny]{background:transparent;border:2px solid #1d3a83;color:#1d3a83}
button[value=deny]:hover{background:#e8f4fc}
button:focus-visible{outline:3px solid #ffb81c;outline-offset:0}
@media (prefers-reduced-motion:reduce){button{transition:none}}
`.trim();

function consentPage(requestUrl: string, clientName: string, nonce: string): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light"><title>Kale Deploy — approve access</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@400;500;600;700;800&display=swap" rel="stylesheet"><style>${CONSENT_PAGE_STYLE}</style></head>
<body><main>
<div class="wordmark"><span class="mark" aria-hidden="true"><i class="b1"></i><i class="b2"></i><i class="b3"></i><i class="b4"></i></span><span class="wordmark-text"><span class="wordmark-name">CUNY AI Lab</span><span class="wordmark-sub">Kale Deploy</span></span></div>
<h1>Let ${escapeHtml(clientName)} deploy your projects?</h1>
<p>If you allow this, the app will be able to:</p>
<ul><li>Create projects</li><li>Upload and publish new versions</li><li>Approve, check, and roll back releases</li></ul>
<form method="post" action="${escapeHtml(requestUrl)}"><input type="hidden" name="consentNonce" value="${escapeHtml(nonce)}">
<button type="submit" name="decision" value="approve">Allow</button><button type="submit" name="decision" value="deny">Cancel</button></form>
</main></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
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
