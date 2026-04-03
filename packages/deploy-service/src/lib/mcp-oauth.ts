import { SignJWT, base64url, jwtVerify } from "jose";

const REGISTERED_CLIENT_AUDIENCE = "cail-mcp-oauth-client";
const AUTHORIZATION_CODE_AUDIENCE = "cail-mcp-oauth-code";
const ACCESS_TOKEN_AUDIENCE = "cail-mcp";
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;

export type RegisteredOAuthClient = {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: "none";
  grantTypes: string[];
  responseTypes: string[];
  createdAt: number;
};

export type AuthorizationCodePayload = {
  jti: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  email: string;
  subject: string;
  scope?: string;
  resource?: string;
};

export type McpAccessTokenPayload = {
  email: string;
  subject: string;
  clientId: string;
  scope?: string;
  resource?: string;
};

export async function registerPublicOAuthClient(input: {
  secret: string;
  issuer: string;
  redirectUris: string[];
  clientName?: string;
  now?: Date;
}): Promise<RegisteredOAuthClient> {
  const now = input.now ?? new Date();
  const createdAt = Math.floor(now.getTime() / 1000);
  const redirectUris = dedupeRedirectUris(input.redirectUris);
  if (redirectUris.length === 0) {
    throw new Error("OAuth client registration requires at least one redirect URI.");
  }

  const tokenEndpointAuthMethod = "none" as const;
  const grantTypes = ["authorization_code"];
  const responseTypes = ["code"];

  const clientId = await new SignJWT({
    client_name: input.clientName,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: tokenEndpointAuthMethod,
    grant_types: grantTypes,
    response_types: responseTypes
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(normalizeIssuer(input.issuer))
    .setAudience(REGISTERED_CLIENT_AUDIENCE)
    .setIssuedAt(createdAt)
    .sign(encodeSecret(input.secret));

  return {
    clientId,
    clientName: input.clientName?.trim() || undefined,
    redirectUris,
    tokenEndpointAuthMethod,
    grantTypes,
    responseTypes,
    createdAt
  };
}

export async function verifyRegisteredOAuthClient(input: {
  clientId: string;
  secret: string;
  issuer: string;
}): Promise<RegisteredOAuthClient> {
  const { payload } = await jwtVerify(input.clientId, encodeSecret(input.secret), {
    issuer: normalizeIssuer(input.issuer),
    audience: REGISTERED_CLIENT_AUDIENCE
  });

  const redirectUris = Array.isArray(payload.redirect_uris)
    ? payload.redirect_uris.map((value) => String(value))
    : [];
  if (redirectUris.length === 0) {
    throw new Error("OAuth client registration did not include redirect URIs.");
  }

  return {
    clientId: input.clientId,
    clientName: typeof payload.client_name === "string" && payload.client_name.trim()
      ? payload.client_name.trim()
      : undefined,
    redirectUris: dedupeRedirectUris(redirectUris),
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
    createdAt: typeof payload.iat === "number" ? payload.iat : Math.floor(Date.now() / 1000)
  };
}

export async function createAuthorizationCode(input: {
  secret: string;
  issuer: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  email: string;
  subject: string;
  scope?: string;
  resource?: string;
  now?: Date;
  ttlSeconds?: number;
}): Promise<{ code: string; jti: string; expiresAt: string }> {
  const now = input.now ?? new Date();
  const issuedAt = Math.floor(now.getTime() / 1000);
  const ttlSeconds = input.ttlSeconds ?? DEFAULT_AUTHORIZATION_CODE_TTL_SECONDS;
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  const jti = crypto.randomUUID();

  const code = await new SignJWT({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    code_challenge: input.codeChallenge,
    code_challenge_method: input.codeChallengeMethod,
    email: input.email,
    scope: input.scope,
    resource: input.resource
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(normalizeIssuer(input.issuer))
    .setAudience(AUTHORIZATION_CODE_AUDIENCE)
    .setSubject(input.subject)
    .setJti(jti)
    .setIssuedAt(issuedAt)
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(encodeSecret(input.secret));

  return {
    code,
    jti,
    expiresAt: expiresAt.toISOString()
  };
}

export async function verifyAuthorizationCode(input: {
  code: string;
  secret: string;
  issuer: string;
}): Promise<AuthorizationCodePayload> {
  const { payload } = await jwtVerify(input.code, encodeSecret(input.secret), {
    issuer: normalizeIssuer(input.issuer),
    audience: AUTHORIZATION_CODE_AUDIENCE
  });

  const jti = typeof payload.jti === "string" && payload.jti ? payload.jti : undefined;
  const clientId = typeof payload.client_id === "string" && payload.client_id ? payload.client_id : undefined;
  const redirectUri = typeof payload.redirect_uri === "string" && payload.redirect_uri ? payload.redirect_uri : undefined;
  const codeChallenge = typeof payload.code_challenge === "string" && payload.code_challenge ? payload.code_challenge : undefined;
  const codeChallengeMethod = payload.code_challenge_method === "S256" ? "S256" : undefined;
  const email = typeof payload.email === "string" && payload.email ? payload.email : undefined;
  const subject = typeof payload.sub === "string" && payload.sub ? payload.sub : undefined;

  if (!jti || !clientId || !redirectUri || !codeChallenge || !codeChallengeMethod || !email || !subject) {
    throw new Error("Authorization code payload was incomplete.");
  }

  return {
    jti,
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    email,
    subject,
    scope: typeof payload.scope === "string" && payload.scope ? payload.scope : undefined,
    resource: typeof payload.resource === "string" && payload.resource ? payload.resource : undefined
  };
}

export async function mintMcpAccessToken(input: {
  secret: string;
  issuer: string;
  clientId: string;
  email: string;
  subject: string;
  scope?: string;
  resource?: string;
  now?: Date;
  ttlSeconds?: number;
}): Promise<{ accessToken: string; expiresAt: string; expiresIn: number }> {
  const now = input.now ?? new Date();
  const issuedAt = Math.floor(now.getTime() / 1000);
  const ttlSeconds = input.ttlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

  const accessToken = await new SignJWT({
    email: input.email,
    client_id: input.clientId,
    scope: input.scope,
    resource: input.resource,
    auth_source: "mcp_oauth"
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(normalizeIssuer(input.issuer))
    .setAudience(ACCESS_TOKEN_AUDIENCE)
    .setSubject(input.subject)
    .setIssuedAt(issuedAt)
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(encodeSecret(input.secret));

  return {
    accessToken,
    expiresAt: expiresAt.toISOString(),
    expiresIn: ttlSeconds
  };
}

export async function verifyMcpAccessToken(input: {
  token: string;
  secret: string;
  issuer: string;
}): Promise<McpAccessTokenPayload> {
  const { payload } = await jwtVerify(input.token, encodeSecret(input.secret), {
    issuer: normalizeIssuer(input.issuer),
    audience: ACCESS_TOKEN_AUDIENCE
  });

  const email = typeof payload.email === "string" && payload.email ? payload.email.toLowerCase() : undefined;
  const subject = typeof payload.sub === "string" && payload.sub ? payload.sub : undefined;
  const clientId = typeof payload.client_id === "string" && payload.client_id ? payload.client_id : undefined;

  if (!email || !subject || !clientId) {
    throw new Error("Access token payload was incomplete.");
  }

  return {
    email,
    subject,
    clientId,
    scope: typeof payload.scope === "string" && payload.scope ? payload.scope : undefined,
    resource: typeof payload.resource === "string" && payload.resource ? payload.resource : undefined
  };
}

export function validatePkceS256(codeVerifier: string, codeChallenge: string): Promise<boolean> {
  return sha256Base64Url(codeVerifier).then((digest) => digest === codeChallenge);
}

export function normalizeRedirectUri(value: string): string {
  const url = new URL(value);
  return url.toString();
}

function normalizeIssuer(value: string): string {
  return value.replace(/\/$/, "");
}

function dedupeRedirectUris(values: string[]): string[] {
  return Array.from(new Set(values.map(normalizeRedirectUri)));
}

function encodeSecret(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64url.encode(new Uint8Array(digest));
}
