import { SignJWT, jwtVerify } from "jose";

import {
  deleteGitHubUserAuthByGitHubUserId,
  getGitHubUserAuth,
  getProject,
  putGitHubUserAuth
} from "./lib/control-plane";
import {
  createGitHubUserClient,
  refreshGitHubUserAccessToken,
  resolveGitHubWebBaseUrl,
  type GitHubUserRepository
} from "./lib/github";
import { decryptStoredText, encryptStoredText } from "./lib/sealed-data";
import { HttpError, asHttpError } from "./http-error";
import { buildProjectControlPanelUrl } from "./project-control-ui";
import type { ProjectSecretsAccessContext } from "./project-secrets";

export type AuthenticatedAgentRequestIdentity = {
  type: "cloudflare_access" | "mcp_oauth" | "mcp_pat";
  subject: string;
  email: string;
};

export type AgentRequestIdentity =
  | {
      type: "anonymous";
      subject: string;
    }
  | AuthenticatedAgentRequestIdentity;

export type GitHubUserAuthStatePayload = {
  subject: string;
  email: string;
  repositoryFullName?: string;
  projectName?: string;
  returnTo?: string;
};

export type ProjectSecretsAuthErrorPayload = {
  error: string;
  summary: string;
  nextAction:
    | "sign_in_to_kale"
    | "connect_github_user"
    | "request_repository_write_access"
    | "operator_configure_github_user_auth";
  projectName: string;
  repositoryFullName: string;
  connectGitHubUserUrl?: string;
  connectionHealthUrl: string;
};

export type ProjectSecretsAuthorization =
  | ({ ok: true } & ProjectSecretsAccessContext)
  | {
      ok: false;
      status: 401 | 403 | 503;
      body: ProjectSecretsAuthErrorPayload;
    };

export type GitHubUserAuthConfig = {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  authorizeUrl: string;
};

type ProjectAdminAuthEnv = {
  CONTROL_PLANE_DB: D1Database;
  GITHUB_API_BASE_URL?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  CONTROL_PLANE_ENCRYPTION_KEY?: string;
};

type ProjectAdminAuthDependencies<Env extends ProjectAdminAuthEnv> = {
  resolveServiceBaseUrl(env: Env, requestUrl: string): string;
  resolveMcpOauthBaseUrl(env: Env, requestUrl: string): string;
  buildConnectionHealthPayload(
    env: Env,
    serviceBaseUrl: string,
    identity?: AgentRequestIdentity
  ): { connectionHealthUrl: string };
};

export function buildGitHubUserSecretsConnectUrl(
  browserBaseUrl: string,
  projectName: string,
  options?: { repositoryFullName?: string; returnTo?: string }
): string {
  const url = new URL(`${browserBaseUrl}/api/github/user-auth/start`);
  url.searchParams.set("projectName", projectName);
  if (options?.repositoryFullName) {
    url.searchParams.set("repositoryFullName", options.repositoryFullName);
  }
  if (options?.returnTo) {
    url.searchParams.set("returnTo", options.returnTo);
  }
  return url.toString();
}

export function resolveGitHubUserAuthConfig(
  env: ProjectAdminAuthEnv,
  serviceBaseUrl: string
): GitHubUserAuthConfig {
  const clientId = readConfiguredEnvValue(env.GITHUB_APP_CLIENT_ID);
  const clientSecret = readConfiguredEnvValue(env.GITHUB_APP_CLIENT_SECRET);

  if (!clientId || !clientSecret) {
    throw new HttpError(503, "GitHub user authorization is not configured on this deployment.");
  }

  const callbackUrl = `${serviceBaseUrl}/github/user-auth/callback`;
  const authorizeUrl = `${resolveGitHubWebBaseUrl(env.GITHUB_API_BASE_URL)}/login/oauth/authorize`;

  return {
    clientId,
    clientSecret,
    callbackUrl,
    authorizeUrl
  };
}

export function tryResolveGitHubUserAuthConfig(
  env: ProjectAdminAuthEnv,
  serviceBaseUrl: string
): GitHubUserAuthConfig | null {
  try {
    return resolveGitHubUserAuthConfig(env, serviceBaseUrl);
  } catch (error) {
    const httpError = asHttpError(error);
    if (httpError.status === 503) {
      return null;
    }

    throw error;
  }
}

export function resolveControlPlaneEncryptionKey(env: ProjectAdminAuthEnv): string {
  const secret = readConfiguredEnvValue(env.CONTROL_PLANE_ENCRYPTION_KEY);
  if (!secret) {
    throw new HttpError(503, "Encrypted project-admin storage is not configured on this deployment.");
  }

  return secret;
}

export async function createGitHubUserAuthStateToken(input: {
  secret: string;
  issuer: string;
  subject: string;
  email: string;
  repositoryFullName?: string;
  projectName?: string;
  returnTo?: string;
}): Promise<string> {
  return new SignJWT({
    email: input.email,
    repository_full_name: input.repositoryFullName,
    project_name: input.projectName,
    return_to: input.returnTo
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(input.issuer)
    .setAudience("github-user-auth-state")
    .setSubject(input.subject)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(input.secret));
}

export async function verifyGitHubUserAuthStateToken(input: {
  token: string;
  secret: string;
  issuer: string;
}): Promise<GitHubUserAuthStatePayload> {
  const { payload } = await jwtVerify(input.token, new TextEncoder().encode(input.secret), {
    issuer: input.issuer,
    audience: "github-user-auth-state"
  });

  const subject = typeof payload.sub === "string" && payload.sub ? payload.sub : undefined;
  const email = typeof payload.email === "string" && payload.email ? payload.email.toLowerCase() : undefined;
  if (!subject || !email) {
    throw new Error("GitHub user authorization state was incomplete.");
  }

  return {
    subject,
    email,
    repositoryFullName: typeof payload.repository_full_name === "string" && payload.repository_full_name
      ? payload.repository_full_name
      : undefined,
    projectName: typeof payload.project_name === "string" && payload.project_name
      ? payload.project_name
      : undefined,
    returnTo: typeof payload.return_to === "string" && payload.return_to
      ? payload.return_to
      : undefined
  };
}

export function normalizeOptionalGitHubUserAuthReturnTo(
  value: string | undefined,
  allowedBaseUrls: string[]
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const defaultBaseUrl = allowedBaseUrls[0];
  if (!defaultBaseUrl) {
    throw new HttpError(500, "Missing Kale Deploy origin for GitHub return URLs.");
  }

  const url = new URL(trimmed, defaultBaseUrl);
  const allowedOrigins = new Set(allowedBaseUrls.map((baseUrl) => new URL(baseUrl).origin));
  if (!allowedOrigins.has(url.origin)) {
    throw new HttpError(400, "GitHub returnTo URLs must stay on a Kale Deploy origin.");
  }

  return url.toString();
}

export function buildGitHubUserAuthorizeUrl(
  config: Pick<GitHubUserAuthConfig, "clientId" | "callbackUrl" | "authorizeUrl">,
  state: string
): string {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.callbackUrl);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function sealStoredToken(secret: string, plaintext: string): Promise<string> {
  return JSON.stringify(await encryptStoredText(secret, plaintext));
}

export async function authorizeProjectSecretsAccess<Env extends ProjectAdminAuthEnv>(
  env: Env,
  requestUrl: string,
  identity: AgentRequestIdentity,
  projectName: string,
  dependencies: ProjectAdminAuthDependencies<Env>
): Promise<ProjectSecretsAuthorization> {
  const serviceBaseUrl = dependencies.resolveServiceBaseUrl(env, requestUrl);
  const connection = dependencies.buildConnectionHealthPayload(env, serviceBaseUrl, identity);
  const connectGitHubUserUrl = buildGitHubUserSecretsConnectUrl(serviceBaseUrl, projectName, {
    returnTo: buildProjectControlPanelUrl(serviceBaseUrl, projectName)
  });
  let authenticatedIdentity: AuthenticatedAgentRequestIdentity;

  try {
    authenticatedIdentity = requireAuthenticatedIdentity(identity);
  } catch (error) {
    const httpError = asHttpError(error);
    return {
      ok: false,
      status: 401,
      body: {
        error: httpError.message,
        summary: "Sign in to Kale Deploy before managing project secrets.",
        nextAction: "sign_in_to_kale",
        projectName,
        repositoryFullName: "unknown",
        connectionHealthUrl: connection.connectionHealthUrl
      }
    };
  }

  const project = await getProject(env.CONTROL_PLANE_DB, projectName);
  if (!project) {
    return buildProjectSecretsConnectRequiredResponse(projectName, connectGitHubUserUrl, connection.connectionHealthUrl);
  }

  const authConfig = tryResolveGitHubUserAuthConfig(env, serviceBaseUrl);
  if (!authConfig) {
    return {
      ok: false,
      status: 503,
      body: {
        error: "GitHub-backed project administration is not configured on this deployment.",
        summary: "Kale Deploy cannot manage project secrets until GitHub-backed admin checks are configured by the operator.",
        nextAction: "operator_configure_github_user_auth",
        projectName,
        repositoryFullName: "unknown",
        connectionHealthUrl: connection.connectionHealthUrl
      }
    };
  }

  const linked = await getGitHubUserAuth(env.CONTROL_PLANE_DB, authenticatedIdentity.subject);
  if (!linked) {
    return buildProjectSecretsConnectRequiredResponse(projectName, connectGitHubUserUrl, connection.connectionHealthUrl);
  }

  let githubUserSession: Awaited<ReturnType<typeof resolveGitHubUserSession>>;
  try {
    githubUserSession = await resolveGitHubUserSession(env, authConfig, linked);
  } catch (error) {
    const httpError = asHttpError(error);
    if (httpError.status === 403) {
      return buildProjectSecretsConnectRequiredResponse(projectName, connectGitHubUserUrl, connection.connectionHealthUrl);
    }
    throw error;
  }

  const repositoryAccess = await fetchGitHubUserRepositoryAccess(
    env,
    githubUserSession.accessToken,
    project.githubRepo
  );

  if (!repositoryAccess.allowed) {
    return buildProjectSecretsConnectRequiredResponse(
      projectName,
      connectGitHubUserUrl,
      connection.connectionHealthUrl,
      repositoryAccess.shouldReconnect
        ? "Reconnect GitHub before managing project secrets."
        : "Connect a GitHub account with write or admin access before managing project secrets.",
      repositoryAccess.shouldReconnect
        ? "Kale Deploy could not verify your current GitHub authorization for this project."
        : "Kale Deploy could not confirm a GitHub account with write or admin access for this project."
    );
  }

  return {
    ok: true,
    project,
    repositoryFullName: project.githubRepo,
    githubLogin: githubUserSession.githubLogin,
    githubUserId: githubUserSession.githubUserId
  };
}

function requireAuthenticatedIdentity(identity: AgentRequestIdentity): AuthenticatedAgentRequestIdentity {
  if (identity.type === "anonymous") {
    throw new HttpError(503, "Kale Deploy needs institutional sign-in before it can evaluate project admin access.");
  }

  return identity;
}

function buildProjectSecretsConnectRequiredResponse(
  projectName: string,
  connectGitHubUserUrl: string,
  connectionHealthUrl: string,
  error = "Confirm your GitHub account before managing project secrets.",
  summary = "Kale Deploy can only show project secrets after it verifies a GitHub account with write or admin access for this project."
): Extract<ProjectSecretsAuthorization, { ok: false }> {
  return {
    ok: false,
    status: 403,
    body: {
      error,
      summary,
      nextAction: "connect_github_user",
      projectName,
      repositoryFullName: "unknown",
      connectGitHubUserUrl,
      connectionHealthUrl
    }
  };
}

async function resolveGitHubUserSession(
  env: ProjectAdminAuthEnv,
  authConfig: GitHubUserAuthConfig,
  linked: Awaited<ReturnType<typeof getGitHubUserAuth>>
): Promise<{ accessToken: string; githubLogin: string; githubUserId: number }> {
  if (!linked) {
    throw new HttpError(403, "GitHub user authorization is required.");
  }

  const encryptionKey = resolveControlPlaneEncryptionKey(env);
  if (!isExpiredOrNearExpiry(linked.accessTokenExpiresAt)) {
    return {
      accessToken: await unsealStoredToken(encryptionKey, linked.accessTokenEncrypted),
      githubLogin: linked.githubLogin,
      githubUserId: linked.githubUserId
    };
  }

  if (!linked.refreshTokenEncrypted) {
    throw new HttpError(403, "GitHub user authorization must be refreshed.");
  }

  try {
    const refreshToken = await unsealStoredToken(encryptionKey, linked.refreshTokenEncrypted);
    const refreshed = await refreshGitHubUserAccessToken({
      clientId: authConfig.clientId,
      clientSecret: authConfig.clientSecret,
      refreshToken,
      apiBaseUrl: env.GITHUB_API_BASE_URL
    });
    const now = new Date().toISOString();

    await putGitHubUserAuth(env.CONTROL_PLANE_DB, {
      accessSubject: linked.accessSubject,
      accessEmail: linked.accessEmail,
      githubUserId: linked.githubUserId,
      githubLogin: linked.githubLogin,
      accessTokenEncrypted: await sealStoredToken(encryptionKey, refreshed.accessToken),
      accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
      refreshTokenEncrypted: refreshed.refreshToken
        ? await sealStoredToken(encryptionKey, refreshed.refreshToken)
        : linked.refreshTokenEncrypted,
      refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt ?? linked.refreshTokenExpiresAt,
      createdAt: linked.createdAt,
      updatedAt: now
    });

    return {
      accessToken: refreshed.accessToken,
      githubLogin: linked.githubLogin,
      githubUserId: linked.githubUserId
    };
  } catch (error) {
    console.error("Refreshing stored GitHub user token failed.", error);
    await deleteGitHubUserAuthByGitHubUserId(env.CONTROL_PLANE_DB, linked.githubUserId);
    throw new HttpError(403, "GitHub user authorization must be refreshed.");
  }
}

async function fetchGitHubUserRepositoryAccess(
  env: ProjectAdminAuthEnv,
  accessToken: string,
  repositoryFullName: string
): Promise<{ allowed: boolean; shouldReconnect: boolean }> {
  const [owner, repo] = splitRepositoryFullName(repositoryFullName);

  try {
    const repository = await createGitHubUserClient({
      accessToken,
      apiBaseUrl: env.GITHUB_API_BASE_URL
    }).getRepository(owner, repo);

    return {
      allowed: hasGitHubRepositoryWriteAccess(repository),
      shouldReconnect: false
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitHub repository access could not be checked.";
    if (/failed with 401\b/u.test(message)) {
      return { allowed: false, shouldReconnect: true };
    }
    if (/failed with 404\b/u.test(message)) {
      return { allowed: false, shouldReconnect: false };
    }
    throw error;
  }
}

async function unsealStoredToken(secret: string, value: string): Promise<string> {
  const payload = parseSealedTokenPayload(value);
  return decryptStoredText(secret, payload);
}

function parseSealedTokenPayload(value: string): { ciphertext: string; iv: string } {
  try {
    const parsed = JSON.parse(value) as { ciphertext?: string; iv?: string };
    if (!parsed.ciphertext || !parsed.iv) {
      throw new Error("Stored token payload was incomplete.");
    }
    return {
      ciphertext: parsed.ciphertext,
      iv: parsed.iv
    };
  } catch (error) {
    throw new Error("Stored token payload could not be decrypted.");
  }
}

function hasGitHubRepositoryWriteAccess(repository: GitHubUserRepository): boolean {
  return Boolean(
    repository.permissions?.admin
    || repository.permissions?.maintain
    || repository.permissions?.push
  );
}

function splitRepositoryFullName(repositoryFullName: string): [string, string] {
  const [owner, repo] = repositoryFullName.split("/", 2);
  if (!owner || !repo) {
    throw new HttpError(400, "Repository names must be in owner/repo form.");
  }

  return [owner, repo];
}

function readConfiguredEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isExpiredOrNearExpiry(expiresAt: string | undefined): boolean {
  if (!expiresAt) {
    return false;
  }

  return Date.parse(expiresAt) <= Date.now() + 60_000;
}
