import { createRemoteJWKSet, jwtVerify } from "jose";

export type CloudflareAccessConfig = {
  teamDomain: string;
  audience: string;
  allowedEmails?: string[];
  allowedEmailDomains?: string[];
};

export type CloudflareAccessIdentity = {
  email: string;
  subject: string;
  issuer: string;
  audience: string[];
};

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function resolveCloudflareAccessConfig(input: {
  teamDomain?: string;
  audience?: string;
  allowedEmails?: string;
  allowedEmailDomains?: string;
}): CloudflareAccessConfig | undefined {
  const teamDomain = normalizeOrigin(input.teamDomain);
  const audience = input.audience?.trim();
  if (!teamDomain || !audience) {
    return undefined;
  }

  return {
    teamDomain,
    audience,
    allowedEmails: splitConfiguredList(input.allowedEmails).map((value) => value.toLowerCase()),
    allowedEmailDomains: splitConfiguredList(input.allowedEmailDomains).map(normalizeEmailDomain)
  };
}

export async function verifyCloudflareAccessRequest(
  request: Request,
  config: CloudflareAccessConfig
): Promise<CloudflareAccessIdentity> {
  const token = request.headers.get("cf-access-jwt-assertion")?.trim();
  if (!token) {
    throw new Error("Missing Cloudflare Access JWT assertion.");
  }

  const jwks = getRemoteJwks(config.teamDomain);
  const { payload } = await jwtVerify(token, jwks, {
    audience: config.audience
  });

  const issuer = typeof payload.iss === "string" ? payload.iss.replace(/\/$/, "") : undefined;
  if (issuer && issuer !== config.teamDomain) {
    throw new Error("Unexpected Cloudflare Access token issuer.");
  }

  const payloadEmail = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : undefined;
  const headerEmail = request.headers.get("cf-access-authenticated-user-email")?.trim().toLowerCase();
  const email = payloadEmail ?? headerEmail;
  if (!email) {
    throw new Error("Cloudflare Access token did not include an email address.");
  }

  if (payloadEmail && headerEmail && payloadEmail !== headerEmail) {
    throw new Error("Cloudflare Access email headers did not match the JWT.");
  }

  enforceAllowedEmail(email, config);

  const subject = typeof payload.sub === "string" && payload.sub.trim()
    ? payload.sub
    : email;

  return {
    email,
    subject,
    issuer: issuer ?? config.teamDomain,
    audience: normalizeAudience(payload.aud, config.audience)
  };
}

export function readBearerToken(request: Request): string | undefined {
  const header = request.headers.get("authorization")?.trim();
  if (!header) {
    return undefined;
  }

  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function getRemoteJwks(teamDomain: string) {
  const existing = jwksCache.get(teamDomain);
  if (existing) {
    return existing;
  }

  const jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
  jwksCache.set(teamDomain, jwks);
  return jwks;
}

function splitConfiguredList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function enforceAllowedEmail(email: string, config: CloudflareAccessConfig): void {
  const allowedEmails = config.allowedEmails ?? [];
  const allowedDomains = config.allowedEmailDomains ?? [];

  if (allowedEmails.length === 0 && allowedDomains.length === 0) {
    return;
  }

  if (allowedEmails.includes(email)) {
    return;
  }

  const domain = normalizeEmailDomain(email.split("@")[1] ?? "");
  if (domain && allowedDomains.some((allowedDomain) => domain === allowedDomain || domain.endsWith(`.${allowedDomain}`))) {
    return;
  }

  throw new Error("This email address is not allowed to use CAIL Deploy.");
}

function normalizeOrigin(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return new URL(withProtocol).origin.replace(/\/$/, "");
}

function normalizeAudience(aud: unknown, fallback: string): string[] {
  if (Array.isArray(aud)) {
    return aud.map((value) => String(value));
  }

  if (typeof aud === "string" && aud) {
    return [aud];
  }

  return [fallback];
}

function normalizeEmailDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^@+/, "");
}
