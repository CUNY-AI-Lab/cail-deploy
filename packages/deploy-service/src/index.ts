import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import * as z from "zod/v4";
import { SignJWT, jwtVerify } from "jose";

import { HttpError, asHttpError } from "./http-error";
import { baseStyles, escapeHtml, faviconLink, logoHtml, serializeJsonForHtml } from "./ui";
import {
  describeRepositoryCoverage,
  describeRepositorySetupStage,
  renderLifecycleSteps,
  renderRepositoryLiveRefreshScript,
  buildRepositoryBannerPresentationMap,
  buildRepositoryCoveragePresentationMap,
  buildRepositorySetupStagePresentationMap,
  type RepositoryInstallStatus,
  type RepositoryWorkflowStage
} from "./repository-lifecycle-presentation";
import {
  buildProjectControlPanelUrl,
  describeGitHubUserAuthContinueLabel,
  readProjectControlFlash,
  renderGitHubUserAuthErrorPage,
  renderGitHubUserAuthSuccessPage,
  renderProjectAdminEntryPage,
  renderProjectControlPanelAuthErrorPage,
  renderProjectControlPanelGatePage,
  renderProjectControlPanelPage
} from "./project-control-ui";
import {
  buildProjectSecretBindings,
  buildProjectSecretsListPayload,
  removeProjectSecretValue,
  setProjectSecretValue,
  type ProjectSecretsAccessContext
} from "./project-secrets";
import { prepareStaticAssetsUpload } from "./lib/assets";
import {
  readBearerToken,
  resolveCloudflareAccessConfig,
  verifyCloudflareAccessRequest
} from "./lib/access";
import { CloudflareApiClient } from "./lib/cloudflare";
import {
  DEFAULT_PROJECT_POLICY,
  attachWebhookDeliveryJob,
  claimProjectName,
  claimWebhookDelivery,
  countActiveBuildJobsForRepository,
  countBuildJobsForRepositoryOnDate,
  consumeOauthGrant,
  deleteGitHubUserAuthByGitHubUserId,
  ensureProjectPolicy,
  getBuildJob,
  getBuildJobByDeliveryId,
  getGitHubUserAuth,
  getLatestBuildJobForProject,
  getLatestProjectForRepository,
  getPreferredProjectNameForRepository,
  getProject,
  listExpiredRetainedFailedDeployments,
  listProjects,
  listRetainedSuccessfulDeployments,
  putGitHubUserAuth,
  putBuildJob,
  putProject,
  releaseWebhookDelivery,
  insertDeployment,
  updateDeploymentArchiveState
} from "./lib/control-plane";
import {
  GitHubAppClient,
  GitHubInstallationClient,
  createGitHubUserClient,
  createGitHubAppFromManifest,
  exchangeGitHubUserCode,
  refreshGitHubUserAccessToken,
  type GitHubCheckRunConclusion,
  type GitHubCheckRunOutput,
  type GitHubAppManifest,
  type GitHubManifestConversion,
  type GitHubRepository,
  type GitHubRepositoryInstallation,
  type GitHubUserRepository,
  resolveGitHubWebBaseUrl,
  verifyGitHubWebhookSignature
} from "./lib/github";
import {
  createAuthorizationCode,
  mintMcpAccessToken,
  normalizeRedirectUri,
  registerPublicOAuthClient,
  validatePkceS256,
  verifyAuthorizationCode,
  verifyMcpAccessToken,
  verifyRegisteredOAuthClient
} from "./lib/mcp-oauth";
import { decryptStoredText, encryptStoredText } from "./lib/sealed-data";
import type {
  BuildJobEventName,
  BuildJobStatus,
  BuildJobRecord,
  BuildRunnerCompletePayload,
  BuildRunnerJobRequest,
  BuildRunnerSourceLease,
  BuildRunnerStartPayload,
  DeploymentMetadata,
  DeploymentRecord,
  GitHubRepositoryRecord,
  ProjectRecord,
  StaticAssetUpload,
  WorkerAssetsConfig,
  WorkerBinding
} from "@cuny-ai-lab/build-contract";

type Env = {
  CONTROL_PLANE_DB: D1Database;
  DEPLOYMENT_ARCHIVE: R2Bucket;
  BUILD_QUEUE: Queue<BuildRunnerJobRequest>;
  DEPLOY_API_TOKEN?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_APP_NAME?: string;
  GITHUB_APP_MANIFEST_ORG?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_API_BASE_URL?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  BUILD_RUNNER_TOKEN?: string;
  CONTROL_PLANE_ENCRYPTION_KEY?: string;
  DEPLOY_SERVICE_BASE_URL?: string;
  RETAIN_SUCCESSFUL_ARTIFACTS?: string;
  FAILED_ARTIFACT_RETENTION_DAYS?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_ACCESS_AUD?: string;
  CLOUDFLARE_ACCESS_ALLOWED_EMAILS?: string;
  CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS?: string;
  CLOUDFLARE_ACCESS_TEAM_DOMAIN?: string;
  MCP_OAUTH_BASE_URL?: string;
  MCP_OAUTH_TOKEN_SECRET?: string;
  MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS?: string;
  WFP_NAMESPACE: string;
  PROJECT_BASE_URL: string;
  PROJECT_HOST_SUFFIX?: string;
  D1_LOCATION_HINT?: string;
};

type PushWebhookPayload = {
  ref: string;
  before: string;
  after: string;
  deleted?: boolean;
  head_commit?: {
    timestamp?: string;
  } | null;
  installation?: {
    id: number;
  } | null;
  repository: {
    id: number;
    name: string;
    full_name: string;
    default_branch: string;
    html_url: string;
    clone_url: string;
    private: boolean;
    owner: {
      login: string;
    };
  };
};

type DeployArtifactResult = {
  project: ProjectRecord;
  deployment: DeploymentRecord;
};

type DeploymentArchiveResult = {
  archiveKind: "none" | "manifest" | "full";
  manifestKey?: string;
};

type AuthenticatedAgentRequestIdentity = {
  type: "cloudflare_access" | "mcp_oauth";
  subject: string;
  email: string;
};

type AgentRequestIdentity =
  | {
      type: "anonymous";
      subject: string;
    }
  | AuthenticatedAgentRequestIdentity;

type CloudflareAccessRequestIdentity = {
  type: "cloudflare_access";
  subject: string;
  email: string;
};

type RepositoryLifecyclePayload = {
  ok: boolean;
  repository: {
    ownerLogin: string;
    name: string;
    fullName: string;
    htmlUrl: string;
  };
  projectName: string;
  projectUrl: string;
  projectAvailable: boolean;
  existingRepositoryFullName?: string;
  suggestedProjectUrl: string;
  suggestedProjectNames?: Array<{ projectName: string; projectUrl: string }>;
  installStatus: RepositoryInstallStatus;
  installUrl?: string;
  guidedInstallUrl?: string;
  setupUrl: string;
  statusUrl: string;
  repositoryStatusUrl: string;
  validateUrl: string;
  nextAction: string;
  summary: string;
  workflowStage: RepositoryWorkflowStage;
  installed: boolean;
  installationId?: number;
  latestStatus: "not_deployed" | "queued" | "running" | "live" | "failed";
  buildStatus?: BuildJobStatus;
  buildJobId?: string;
  buildJobStatusUrl?: string;
  deploymentUrl?: string;
  errorKind?: string;
  errorMessage?: string;
  errorDetail?: string;
  updatedAt?: string;
};

type GitHubUserAuthStatePayload = {
  subject: string;
  email: string;
  repositoryFullName?: string;
  projectName?: string;
  returnTo?: string;
};

type ProjectSecretsAuthErrorPayload = {
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

type ProjectSecretsAuthorization =
  | ({ ok: true } & ProjectSecretsAccessContext)
  | {
      ok: false;
      status: 401 | 403 | 503;
      body: ProjectSecretsAuthErrorPayload;
    };

type ApiResponseStatus = 200 | 202 | 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 502 | 503;

export const deployServiceApp = new Hono<{ Bindings: Env }>();
const DEFAULT_SUCCESSFUL_ARTIFACT_RETENTION = 2;
const DEFAULT_FAILED_ARTIFACT_RETENTION_DAYS = 7;
const MAX_PROJECT_NAME_LENGTH = 63;
const GITHUB_MANIFEST_STATE_COOKIE = "cail_github_manifest_state";
const GITHUB_MANIFEST_STATE_MAX_AGE_SECONDS = 60 * 60;
const GITHUB_INSTALL_CONTEXT_COOKIE = "cail_github_install_context";
const GITHUB_INSTALL_CONTEXT_MAX_AGE_SECONDS = 10 * 60;
const MCP_REQUIRED_SCOPE = "cail:deploy";
const PROJECT_SECRETS_CONFIG = {
  resolveControlPlaneEncryptionKey,
  resolveRequiredCloudflareApiToken,
  formatBytes
};

deployServiceApp.use("/mcp", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowHeaders: [
    "authorization",
    "content-type",
    "accept",
    "mcp-protocol-version",
    "mcp-session-id",
    "last-event-id"
  ],
  exposeHeaders: [
    "mcp-session-id",
    "mcp-protocol-version",
    "www-authenticate"
  ]
}));

deployServiceApp.use("/oauth/*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["authorization", "content-type", "accept"],
  exposeHeaders: ["www-authenticate"]
}));

deployServiceApp.use("/.well-known/*", cors({
  origin: "*",
  allowMethods: ["GET", "OPTIONS"],
  allowHeaders: ["accept"]
}));

deployServiceApp.use("/mcp/.well-known/*", cors({
  origin: "*",
  allowMethods: ["GET", "OPTIONS"],
  allowHeaders: ["accept", "mcp-protocol-version"]
}));

deployServiceApp.get("/healthz", (c) => c.json({ ok: true }));

deployServiceApp.get("/.well-known/cail-runtime.json", (c) => {
  const serviceBaseUrl = resolveServiceBaseUrl(c.env, c.req.raw.url);
  return c.json(buildRuntimeManifest(c.env, serviceBaseUrl), 200, {
    "cache-control": "public, max-age=300"
  });
});

deployServiceApp.get("/.well-known/kale-connection.json", (c) => {
  const serviceBaseUrl = resolveServiceBaseUrl(c.env, c.req.raw.url);
  return c.json(buildConnectionHealthPayload(c.env, serviceBaseUrl), 200, {
    "cache-control": "public, max-age=300"
  });
});

deployServiceApp.get("/.well-known/oauth-protected-resource/mcp", serveOauthProtectedResourceMetadata);
deployServiceApp.get("/.well-known/oauth-protected-resource", serveOauthProtectedResourceMetadata);
deployServiceApp.get("/mcp/.well-known/oauth-protected-resource", serveOauthProtectedResourceMetadata);

deployServiceApp.get("/.well-known/oauth-authorization-server", serveOauthAuthorizationServerMetadata);
deployServiceApp.get("/.well-known/oauth-authorization-server/mcp", serveOauthAuthorizationServerMetadata);
deployServiceApp.get("/mcp/.well-known/oauth-authorization-server", serveOauthAuthorizationServerMetadata);
deployServiceApp.get("/.well-known/openid-configuration/mcp", serveOauthAuthorizationServerMetadata);
deployServiceApp.get("/mcp/.well-known/openid-configuration", serveOauthAuthorizationServerMetadata);

deployServiceApp.post("/oauth/register", async (c) => {
  try {
    const secret = resolveMcpOauthSecret(c.env);
    const oauthBaseUrl = resolveMcpOauthBaseUrl(c.env, c.req.raw.url);
    const body = await c.req.json<{
      redirect_uris?: string[];
      client_name?: string;
      token_endpoint_auth_method?: string;
    }>();

    if ((body.token_endpoint_auth_method ?? "none") !== "none") {
      throw new HttpError(400, "CAIL Deploy only supports public OAuth clients with token_endpoint_auth_method 'none'.");
    }

    const redirectUris = (body.redirect_uris ?? []).map((value) => normalizeRedirectUri(String(value)));
    const client = await registerPublicOAuthClient({
      secret,
      issuer: oauthBaseUrl,
      clientName: body.client_name,
      redirectUris
    });

    return c.json({
      client_id: client.clientId,
      client_id_issued_at: client.createdAt,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: client.grantTypes,
      response_types: client.responseTypes,
      token_endpoint_auth_method: client.tokenEndpointAuthMethod
    });
  } catch (error) {
    const httpError = asHttpError(error);
    return c.json({
      error: "invalid_client_metadata",
      error_description: httpError.message
    }, { status: httpError.status });
  }
});

deployServiceApp.get("/api/oauth/authorize", async (c) => {
  try {
    const identity = await requireCloudflareAccessIdentity(c.req.raw, c.env);
    const secret = resolveMcpOauthSecret(c.env);
    const serviceBaseUrl = resolveServiceBaseUrl(c.env, c.req.raw.url);
    const oauthBaseUrl = resolveMcpOauthBaseUrl(c.env, c.req.raw.url);
    const clientId = c.req.query("client_id");
    const redirectUri = c.req.query("redirect_uri");
    const responseType = c.req.query("response_type");
    const state = c.req.query("state");
    const codeChallenge = c.req.query("code_challenge");
    const codeChallengeMethod = c.req.query("code_challenge_method");
    const scope = c.req.query("scope") ?? MCP_REQUIRED_SCOPE;
    const resource = c.req.query("resource") ?? `${serviceBaseUrl}/mcp`;

    if (responseType !== "code") {
      throw new HttpError(400, "Unsupported response_type. Expected 'code'.");
    }
    if (!clientId || !redirectUri || !state || !codeChallenge || codeChallengeMethod !== "S256") {
      throw new HttpError(400, "Missing or invalid OAuth authorization parameters.");
    }

    const client = await verifyRegisteredOAuthClient({
      clientId,
      secret,
      issuer: oauthBaseUrl
    });
    const normalizedRedirectUri = normalizeRedirectUri(redirectUri);
    if (!client.redirectUris.includes(normalizedRedirectUri)) {
      throw new HttpError(400, "OAuth redirect URI is not registered for this client.");
    }

    const { code } = await createAuthorizationCode({
      secret,
      issuer: oauthBaseUrl,
      clientId: client.clientId,
      redirectUri: normalizedRedirectUri,
      codeChallenge,
      codeChallengeMethod: "S256",
      email: identity.email,
      subject: identity.subject,
      scope,
      resource
    });

    const redirect = new URL(normalizedRedirectUri);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", state);
    return Response.redirect(redirect.toString(), 302);
  } catch (error) {
    const httpError = asHttpError(error);
    return c.html(renderOauthAuthorizationErrorPage(httpError.message), httpError.status);
  }
});

deployServiceApp.post("/oauth/token", async (c) => {
  try {
    const secret = resolveMcpOauthSecret(c.env);
    const oauthBaseUrl = resolveMcpOauthBaseUrl(c.env, c.req.raw.url);
    const form = await c.req.formData();
    const grantType = getRequiredOauthFormField(form, "grant_type");
    if (grantType !== "authorization_code") {
      throw new HttpError(400, "CAIL Deploy currently supports only the authorization_code grant.");
    }

    const clientId = getRequiredOauthFormField(form, "client_id");
    const redirectUri = normalizeRedirectUri(getRequiredOauthFormField(form, "redirect_uri"));
    const code = getRequiredOauthFormField(form, "code");
    const codeVerifier = getRequiredOauthFormField(form, "code_verifier");
    const client = await verifyRegisteredOAuthClient({
      clientId,
      secret,
      issuer: oauthBaseUrl
    });

    if (!client.redirectUris.includes(redirectUri)) {
      throw new HttpError(400, "OAuth redirect URI is not registered for this client.");
    }

    const authorizationCode = await verifyAuthorizationCode({
      code,
      secret,
      issuer: oauthBaseUrl
    });

    if (authorizationCode.clientId !== client.clientId || authorizationCode.redirectUri !== redirectUri) {
      throw new HttpError(400, "OAuth authorization code did not match this client or redirect URI.");
    }

    const pkceValid = await validatePkceS256(codeVerifier, authorizationCode.codeChallenge);
    if (!pkceValid) {
      throw new HttpError(400, "OAuth PKCE verification failed.");
    }

    const used = await consumeOauthGrant(
      c.env.CONTROL_PLANE_DB,
      authorizationCode.jti,
      "authorization_code",
      new Date().toISOString()
    );
    if (!used) {
      throw new HttpError(400, "OAuth authorization code has already been used.");
    }

    const accessToken = await mintMcpAccessToken({
      secret,
      issuer: oauthBaseUrl,
      clientId: client.clientId,
      email: authorizationCode.email,
      subject: authorizationCode.subject,
      scope: authorizationCode.scope,
      resource: authorizationCode.resource,
      ttlSeconds: parsePositiveInteger(c.env.MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS, 60 * 60)
    });

    return c.json({
      access_token: accessToken.accessToken,
      token_type: "Bearer",
      expires_in: accessToken.expiresIn,
      scope: authorizationCode.scope
    });
  } catch (error) {
    const httpError = asHttpError(error);
    return c.json({
      error: "invalid_grant",
      error_description: httpError.message
    }, { status: httpError.status });
  }
});

deployServiceApp.get("/", async (c) => {
  const serviceBaseUrl = resolveServiceBaseUrl(c.env, c.req.raw.url);
  const oauthBaseUrl = resolveMcpOauthBaseUrl(c.env, c.req.raw.url);
  const appName = resolveGitHubAppName(c.env);
  const appSlug = resolveGitHubAppSlug(c.env);
  const installUrl = appSlug ? githubAppInstallUrl(appSlug) : undefined;
  const runtimeManifestUrl = resolvePublicRuntimeManifestUrl(c.env, serviceBaseUrl);
  const mcpEndpoint = `${serviceBaseUrl}/mcp`;
  const repositoryUrl = "https://github.com/CUNY-AI-Lab/CAIL-deploy";
  const liveProjects = (await listProjects(c.env.CONTROL_PLANE_DB)).slice(0, 6);
  const liveProjectCount = liveProjects.length;
  const marketingName = "Kale Deploy";
  const marketingSource = "From the CUNY AI Lab";
  const claudeSetupPrompt = `Connect ${marketingName} in this Claude Code environment. If you can run terminal commands yourself, run:\nclaude mcp add --transport http cail ${mcpEndpoint}\nThen, inside Claude Code, open /mcp, select cail, choose Authenticate, and complete the browser sign-in. After that, verify that you can really use Kale Deploy tools like test_connection, get_repository_status, and register_project before you say ${marketingName} is connected.`;
  const codexSetupPrompt = `Connect ${marketingName} in this Codex environment. If you can run terminal commands yourself, run:\ncodex mcp add cail --url ${mcpEndpoint}\ncodex mcp login cail\nComplete the browser sign-in flow, and then verify that you can really use Kale Deploy tools like test_connection, get_repository_status, and register_project before you say ${marketingName} is connected.`;
  const geminiSetupPrompt = `Connect ${marketingName} in this Gemini CLI environment. If you can run terminal commands yourself, run:\ngemini mcp add --transport http cail ${mcpEndpoint}\nIf a browser opens, complete the sign-in flow. Then verify that you can see and use Kale Deploy tools like get_repository_status and register_project before you say ${marketingName} is connected.`;
  const buildPrompt = `Build me a small web app and deploy it with ${marketingName}. If ${marketingName} is not connected yet, connect it first. Then register the project, handle any GitHub setup steps, and deploy it so I can see it live.`;

  const agents = [
    { name: "Claude Code", prompt: claudeSetupPrompt, letter: "C" },
    { name: "Codex", prompt: codexSetupPrompt, letter: "X" },
    { name: "Gemini CLI", prompt: geminiSetupPrompt, letter: "G" },
  ];

  const clipboardSvg = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="6" height="3" rx="1"/><path d="M5 3H3.5A1.5 1.5 0 0 0 2 4.5v9A1.5 1.5 0 0 0 3.5 15h9a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 12.5 3H11"/></svg>`;
  const checkSvg = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5 6.5 12 13 4"/></svg>`;

  return c.html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(marketingName)}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,700;9..144,800&family=Source+Serif+4:opsz,wght@8..60,400;8..60,500&display=swap" rel="stylesheet" />
    ${faviconLink()}
    ${baseStyles(`
      @keyframes fadeUp {
        from { opacity: 0; transform: translateY(16px); }
        to { opacity: 1; transform: translateY(0); }
      }

      /* ── Hero ── */
      .hero {
        text-align: center;
        padding: 3.5rem 0 2.5rem;
        animation: fadeUp 0.5s ease-out;
      }
      .hero .logo { margin: 0 auto 0.75rem; }
      .hero .source {
        display: inline-block;
        margin: 0 0 0.3rem;
        font-size: 0.72rem;
        font-weight: 600;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--teal);
      }
      .hero h1 {
        font-family: 'Fraunces', serif;
        font-size: clamp(2.2rem, 5.5vw, 3.4rem);
        font-weight: 800;
        letter-spacing: -0.025em;
        margin: 0 0 0.6rem;
        line-height: 1.1;
        color: var(--ink);
      }
      .hero .lead {
        max-width: 38ch;
        margin: 0 auto;
        font-family: 'Source Serif 4', Georgia, serif;
        font-size: 1.15rem;
        color: var(--muted);
        line-height: 1.6;
      }

      /* ── Section ── */
      .get-started {
        max-width: 560px;
        margin: 0 auto;
      }
      .section-label {
        font-size: 0.72rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: var(--muted);
        margin: 0 0 14px;
      }

      /* ── Agent blocks ── */
      .agent-blocks {
        display: grid;
        gap: 12px;
        margin-bottom: 2rem;
        animation: fadeUp 0.5s ease-out 0.1s both;
      }
      .agent-block {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 14px;
        overflow: hidden;
        box-shadow: 0 2px 12px rgba(27, 42, 74, 0.05);
        transition: border-color 0.2s, box-shadow 0.2s;
      }
      .agent-block:hover {
        border-color: var(--accent);
        box-shadow: 0 4px 20px rgba(59, 107, 204, 0.1);
      }
      .agent-header {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 14px 16px 10px;
      }
      .agent-ico {
        width: 28px;
        height: 28px;
        border-radius: 8px;
        background: linear-gradient(135deg, var(--accent), var(--teal));
        color: white;
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 800;
        font-size: 0.82rem;
        flex-shrink: 0;
      }
      .agent-name {
        font-weight: 700;
        font-size: 0.92rem;
        color: var(--ink);
      }
      .agent-hint {
        font-size: 0.78rem;
        color: var(--muted);
        padding: 0 16px 4px;
      }
      .prompt-block {
        position: relative;
        margin: 0 12px 12px;
        background: var(--code-bg);
        border-radius: 10px;
        padding: 12px 44px 12px 14px;
        font-family: var(--font-mono);
        font-size: 0.8rem;
        line-height: 1.55;
        color: var(--ink);
        white-space: pre-wrap;
        word-break: break-word;
        cursor: pointer;
        transition: background 0.15s;
      }
      .prompt-block:hover { background: #e4eaf2; }
      .copy-btn {
        position: absolute;
        top: 8px;
        right: 8px;
        width: 30px;
        height: 30px;
        border: none;
        border-radius: 8px;
        background: transparent;
        color: var(--muted);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: color 0.15s, background 0.15s;
      }
      .copy-btn:hover {
        background: var(--border);
        color: var(--ink);
      }
      .copy-btn.copied {
        color: var(--success);
      }

      /* ── Build prompt ── */
      .build-section {
        animation: fadeUp 0.5s ease-out 0.2s both;
        margin-bottom: 2rem;
      }
      .build-block {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 14px;
        box-shadow: 0 2px 12px rgba(27, 42, 74, 0.05);
        overflow: hidden;
        transition: border-color 0.2s;
      }
      .build-block:hover { border-color: var(--accent); }
      .build-header {
        padding: 14px 16px 6px;
        font-weight: 700;
        font-size: 0.92rem;
        color: var(--ink);
      }
      .build-hint {
        font-size: 0.78rem;
        color: var(--muted);
        padding: 0 16px 4px;
      }

      /* ── Existing repo ── */
      .existing-repo {
        max-width: 560px;
        margin: 0 auto;
        animation: fadeUp 0.5s ease-out 0.3s both;
      }
      .existing-toggle {
        display: flex;
        align-items: center;
        gap: 6px;
        background: none;
        border: none;
        padding: 8px 0;
        font: inherit;
        font-size: 0.86rem;
        font-weight: 600;
        color: var(--muted);
        cursor: pointer;
        transition: color 0.15s;
      }
      .existing-toggle:hover { color: var(--accent); }
      .existing-toggle .arrow {
        transition: transform 0.2s;
        font-size: 0.65rem;
      }
      .existing-toggle.open .arrow { transform: rotate(90deg); }
      .existing-body {
        display: none;
        padding: 10px 0 0;
      }
      .existing-body.open { display: block; }
      .repo-form {
        display: flex;
        gap: 8px;
      }
      .repo-form input {
        flex: 1;
        padding: 9px 14px;
        border: 1px solid var(--border);
        border-radius: 10px;
        font: inherit;
        font-size: 0.88rem;
      }
      .repo-form input:focus {
        outline: none;
        border-color: var(--accent);
        box-shadow: 0 0 0 3px rgba(59, 107, 204, 0.1);
      }
      .repo-form button {
        padding: 9px 18px;
        border: 1px solid var(--accent);
        border-radius: 10px;
        background: var(--accent);
        color: white;
        font: inherit;
        font-size: 0.86rem;
        font-weight: 600;
        cursor: pointer;
        white-space: nowrap;
        transition: background 0.15s;
      }
      .repo-form button:hover { background: var(--accent-hover); }

      /* ── Live projects ── */
      .live-projects {
        max-width: 560px;
        margin: 2rem auto 0;
        animation: fadeUp 0.5s ease-out 0.4s both;
      }
      .live-list {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .live-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 5px 13px;
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 999px;
        font-size: 0.82rem;
        font-weight: 600;
        color: var(--ink);
        text-decoration: none;
        transition: border-color 0.15s, box-shadow 0.15s;
      }
      .live-chip:hover {
        border-color: var(--accent);
        box-shadow: 0 2px 8px rgba(27, 42, 74, 0.06);
      }
      .live-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--success);
      }

      /* ── Footer ── */
      .page-footer {
        max-width: 560px;
        margin: 2.5rem auto 0;
        padding-top: 1.5rem;
        border-top: 1px solid var(--border);
        display: flex;
        justify-content: center;
        gap: 18px;
        font-size: 0.78rem;
      }
      .page-footer a {
        color: var(--muted);
        text-decoration: none;
      }
      .page-footer a:hover { color: var(--accent); }
    `)}
  </head>
  <body>
    <main>
      <section class="hero">
        <div class="logo">${logoHtml("44px")}</div>
        <span class="source">${escapeHtml(marketingSource)}</span>
        <h1>${escapeHtml(marketingName)}</h1>
        <p class="lead">Build a website with an AI coding agent. Deploy it in one step.</p>
      </section>

      <section class="get-started">
        <div class="agent-blocks">
          <p class="section-label">1. Connect your agent</p>
          <p class="build-hint">Pick the agent you use. Copy the prompt below and paste it in. Your browser may open once to sign you in.</p>
          ${agents.map((agent) => `
          <div class="agent-block">
            <div class="agent-header">
              <span class="agent-ico">${escapeHtml(agent.letter)}</span>
              <span class="agent-name">${escapeHtml(agent.name)}</span>
            </div>
            <p class="agent-hint">Paste into ${escapeHtml(agent.name)}:</p>
            <div class="prompt-block" data-prompt="${escapeHtml(agent.prompt)}">
              ${escapeHtml(agent.prompt)}
              <button class="copy-btn" type="button" title="Copy to clipboard">${clipboardSvg}</button>
            </div>
          </div>
          `).join("")}
        </div>

        <div class="build-section">
          <p class="section-label">2. Tell it what to build</p>
          <div class="build-block">
            <div class="build-header">Try this, or describe your own idea</div>
            <p class="build-hint">Your agent will write the code, set up the repo, and put it online for you.</p>
            <div class="prompt-block" data-prompt="${escapeHtml(buildPrompt)}" id="build-prompt">
              ${escapeHtml(buildPrompt)}
              <button class="copy-btn" type="button" title="Copy to clipboard">${clipboardSvg}</button>
            </div>
          </div>
        </div>
      </section>

      <div class="existing-repo">
        <button class="existing-toggle" onclick="this.classList.toggle('open');this.nextElementSibling.classList.toggle('open')">
          <span class="arrow">&#9654;</span> Already have a GitHub repo?
        </button>
        <div class="existing-body">
          <form class="repo-form" method="get" action="${escapeHtml(`${serviceBaseUrl}/github/setup`)}">
            <input type="text" name="repositoryFullName" placeholder="owner/repo" aria-label="GitHub repository" />
            <button type="submit">Check</button>
          </form>
        </div>
      </div>

      ${liveProjectCount > 0 ? `
      <section class="live-projects">
        <p class="section-label">Live projects</p>
        <div class="live-list">${liveProjects.map((project) => `
          <a class="live-chip" href="${escapeHtml(project.deploymentUrl)}">
            <span class="live-dot"></span>
            ${escapeHtml(project.projectName)}
          </a>
        `).join("")}</div>
      </section>
      ` : ""}

      <footer class="page-footer">
        ${installUrl ? `<a href="${escapeHtml(installUrl)}">GitHub App</a>` : ""}
        <a href="${escapeHtml(`${oauthBaseUrl}/projects/control`)}">Project admin</a>
        <a href="${escapeHtml(repositoryUrl)}">GitHub</a>
      </footer>
    </main>

    <script>
    const clipboardIcon = ${JSON.stringify(clipboardSvg)};
    const checkIcon = ${JSON.stringify(checkSvg)};

    document.querySelectorAll('.prompt-block').forEach(block => {
      const copyBtn = block.querySelector('.copy-btn');
      const promptText = block.dataset.prompt;

      function doCopy() {
        navigator.clipboard.writeText(promptText).then(() => {
          copyBtn.innerHTML = checkIcon;
          copyBtn.classList.add('copied');
          setTimeout(() => {
            copyBtn.innerHTML = clipboardIcon;
            copyBtn.classList.remove('copied');
          }, 2000);
        });
      }

      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        doCopy();
      });
      block.addEventListener('click', doCopy);
    });
    </script>
  </body>
</html>`);
});

deployServiceApp.get("/github/app", (c) => {
  const serviceBaseUrl = resolveServiceBaseUrl(c.env, c.req.raw.url);
  const appSlug = resolveGitHubAppSlug(c.env);

  return c.json({
    appName: resolveGitHubAppName(c.env),
    appId: resolveGitHubAppId(c.env),
    appSlug,
    installUrl: appSlug ? githubAppInstallUrl(appSlug) : undefined,
    mcpUrl: `${serviceBaseUrl}/mcp`,
    guidedInstallUrlTemplate: appSlug ? `${serviceBaseUrl}/github/install?repositoryFullName={owner}/{repo}&projectName={projectName}` : undefined,
    repositoryStatusUrlTemplate: `${serviceBaseUrl}/api/repositories/{owner}/{repo}/status`,
    setupUrl: `${serviceBaseUrl}/github/setup`,
    webhookUrl: `${serviceBaseUrl}/github/webhook`,
    manifestOrg: resolveGitHubAppManifestOrg(c.env),
    registerUrl: `${serviceBaseUrl}/github/register`,
    manifestUrl: `${serviceBaseUrl}/github/manifest`
  });
});

deployServiceApp.get("/github/manifest", (c) => {
  const serviceBaseUrl = resolveServiceBaseUrl(c.env, c.req.raw.url);
  const manifest = buildGitHubAppManifest(c.env, serviceBaseUrl);

  return c.json({
    owner: {
      type: "organization",
      login: resolveGitHubAppManifestOrg(c.env)
    },
    registrationUrl: githubManifestRegistrationUrl(c.env),
    manifest
  });
});

deployServiceApp.get("/github/register", (c) => {
  const serviceBaseUrl = resolveServiceBaseUrl(c.env, c.req.raw.url);
  const appName = resolveGitHubAppName(c.env);
  const manifestOrg = resolveGitHubAppManifestOrg(c.env);
  const manifest = buildGitHubAppManifest(c.env, serviceBaseUrl);
  const state = crypto.randomUUID();
  const configuredSlug = resolveGitHubAppSlug(c.env);
  const registrationUrl = `${githubManifestRegistrationUrl(c.env)}?state=${encodeURIComponent(state)}`;
  const response = c.html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(appName)} Registration</title>
    ${faviconLink()}
    ${baseStyles(`
      .manifest {
        margin-top: 18px;
        padding: 16px;
        border: 1px solid var(--border);
        border-radius: var(--radius-notice);
        background: var(--code-bg);
      }
      .manifest p { margin: 0.4rem 0; }
      form { margin: 0; }
    `)}
  </head>
  <body>
    <main>
      <section class="card">
        <div class="logo">${logoHtml("44px")}</div>
        <h1>${escapeHtml(appName)} Registration</h1>
        ${configuredSlug ? `<div class="notice"><p><strong>Already configured:</strong> <code>GITHUB_APP_SLUG=${escapeHtml(configuredSlug)}</code>. Only continue if you intend to replace the existing app.</p></div>` : ""}
        <div class="actions">
          <form action="${escapeHtml(registrationUrl)}" method="post">
            <input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}" />
            <button class="button" type="submit">Create the GitHub App in ${escapeHtml(manifestOrg)}</button>
          </form>
          <a class="button secondary" href="${escapeHtml(`${serviceBaseUrl}/github/manifest`)}">View manifest JSON</a>
        </div>
        <div class="manifest">
          <h2>Registration target</h2>
          <p><strong>Webhook URL:</strong> <code>${escapeHtml(`${serviceBaseUrl}/github/webhook`)}</code></p>
          <p><strong>Setup URL:</strong> <code>${escapeHtml(`${serviceBaseUrl}/github/setup`)}</code></p>
          <p><strong>Redirect URL:</strong> <code>${escapeHtml(`${serviceBaseUrl}/github/manifest/callback`)}</code></p>
          <p><strong>Permissions:</strong> <code>Checks: Read &amp; write</code>, <code>Contents: Read</code>, <code>Metadata: Read</code></p>
          <p><strong>Webhook events:</strong> <code>Push</code></p>
          <p><strong>Installability:</strong> <code>Any account</code></p>
        </div>
      </section>
    </main>
  </body>
</html>`);
  response.headers.set(
    "Set-Cookie",
    serializeCookie(GITHUB_MANIFEST_STATE_COOKIE, state, {
      httpOnly: true,
      maxAge: GITHUB_MANIFEST_STATE_MAX_AGE_SECONDS,
      path: "/",
      sameSite: "Lax",
      secure: true
    })
  );
  response.headers.set("Cache-Control", "no-store");
  return response;
});

deployServiceApp.get("/github/manifest/callback", async (c) => {
  const serviceBaseUrl = resolveServiceBaseUrl(c.env, c.req.raw.url);
  const appName = resolveGitHubAppName(c.env);
  const code = c.req.query("code");
  const returnedState = c.req.query("state");
  const expectedState = parseCookieHeader(c.req.header("cookie")).get(GITHUB_MANIFEST_STATE_COOKIE);

  const clearStateCookie = serializeCookie(GITHUB_MANIFEST_STATE_COOKIE, "", {
    httpOnly: true,
    maxAge: 0,
    path: "/",
    sameSite: "Lax",
    secure: true
  });

  if (!code) {
    const response = c.html(renderManifestErrorPage(appName, "GitHub did not provide a manifest code.", serviceBaseUrl), 400);
    response.headers.set("Set-Cookie", clearStateCookie);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  if (!returnedState || !expectedState || returnedState !== expectedState) {
    const response = c.html(
      renderManifestErrorPage(
        appName,
        "The GitHub App registration state did not match. Start the manifest flow again from /github/register.",
        serviceBaseUrl
      ),
      400
    );
    response.headers.set("Set-Cookie", clearStateCookie);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  try {
    const registration = await createGitHubAppFromManifest(code, {
      apiBaseUrl: resolveGitHubApiBaseUrl(c.env)
    });
    const response = c.html(renderManifestSuccessPage(c.env, serviceBaseUrl, registration));
    response.headers.set("Set-Cookie", clearStateCookie);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    const response = c.html(
      renderManifestErrorPage(appName, asHttpError(error).message, serviceBaseUrl),
      asHttpError(error).status
    );
    response.headers.set("Set-Cookie", clearStateCookie);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
});

deployServiceApp.get("/github/install", async (c) => {
  const appSlug = resolveGitHubAppSlug(c.env);
  const serviceBaseUrl = resolveServiceBaseUrl(c.env, c.req.raw.url);
  const appName = resolveGitHubAppName(c.env);
  const marketingName = "Kale Deploy";
  const installContext = readGitHubInstallContext(c.req.raw.headers.get("cookie") ?? undefined, c.env, serviceBaseUrl);
  const repositoryQuery = c.req.query("repositoryFullName");
  const repositoryUrlQuery = c.req.query("repositoryUrl");
  const projectNameQuery = c.req.query("projectName");
  const requestedContext = parseOptionalRepositoryContext({
    repositoryFullName: repositoryQuery ?? undefined,
    repositoryUrl: repositoryUrlQuery ?? undefined,
    projectName: projectNameQuery ?? undefined
  }, c.env, serviceBaseUrl);
  const nextContext = requestedContext ?? installContext;
  let repositoryLifecycle:
    | RepositoryLifecyclePayload
    | undefined;

  if (nextContext) {
    const repository = parseRepositoryReference({
      repositoryFullName: nextContext.repositoryFullName
    });
    const lifecycle = await buildRepositoryLifecycleState(c.env, c.req.raw.url, repository, nextContext.projectName);
    repositoryLifecycle = lifecycle.payload;
  }

  const continueUrl = appSlug ? githubAppInstallUrl(appSlug) : undefined;
  const primaryAction = repositoryLifecycle
    ? renderRepositoryInstallActions({
        lifecycle: repositoryLifecycle,
        appName,
        continueUrl,
        serviceBaseUrl
      })
    : `<div class="actions">
          ${continueUrl
            ? `<a class="button" href="${escapeHtml(continueUrl)}">Continue to GitHub</a>`
            : `<a class="button" href="${escapeHtml(`${serviceBaseUrl}/github/register`)}">Set up GitHub for Kale Deploy</a>`}
          <a class="button secondary" href="${escapeHtml(`${serviceBaseUrl}/github/setup`)}">View setup progress</a>
        </div>
        <form class="lookup-form" method="get" action="${escapeHtml(`${serviceBaseUrl}/github/install`)}">
          <label for="repositoryFullName">Open the GitHub step for a specific repo</label>
          <input id="repositoryFullName" type="text" name="repositoryFullName" placeholder="owner/repo" />
          <button class="button" type="submit">Open this repo</button>
        </form>
        <div class="notice"><p>Kale Deploy uses the GitHub app named <strong>${escapeHtml(appName)}</strong>.</p></div>`;

  const installOverview = repositoryLifecycle
    ? renderRepositoryLifecycleOverview({
        lifecycle: repositoryLifecycle,
        appName,
        serviceBaseUrl,
        flowPhase: "install"
      })
    : `<div class="notice"><p>Continue to GitHub to connect a repository to Kale Deploy.</p></div>`;

  const installDetails = repositoryLifecycle
    ? renderRepositoryDeveloperDetails({
        lifecycle: repositoryLifecycle,
        serviceBaseUrl,
        oauthBaseUrl: resolveMcpOauthBaseUrl(c.env, c.req.raw.url)
      })
    : "";

  const installLiveRefresh = repositoryLifecycle
    ? renderRepositoryLiveRefreshPanel({
        lifecycle: repositoryLifecycle,
        phase: "install",
        appName,
        installReturnObserved: false
      })
    : "";

  const response = c.html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(marketingName)} GitHub Setup</title>
    ${faviconLink()}
    ${baseStyles(`
      .status-banner {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 14px 18px;
        border-radius: var(--radius-notice);
        font-weight: 600;
        font-size: 1.1rem;
        margin-bottom: 16px;
        background: var(--notice-bg);
        color: var(--accent);
        border: 1px solid var(--border);
      }
      .state-grid {
        display: grid;
        gap: 16px;
        margin: 18px 0;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      }
      .state-card {
        border: 1px solid var(--border);
        border-radius: var(--radius-notice);
        background: #fafbfd;
        padding: 16px;
      }
      .state-card.primary {
        background: linear-gradient(180deg, #f8fbff 0%, #eef4fb 100%);
      }
      .state-card h2,
      .state-card h3 {
        margin: 0 0 10px;
      }
      .state-card h2 {
        font-size: 1.2rem;
      }
      .state-card h3 {
        font-size: 1rem;
      }
      .state-label {
        margin: 0 0 10px;
        color: var(--accent);
        font-size: 0.82rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .state-card p:last-child {
        margin-bottom: 0;
      }
      .quick-links {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin: 18px 0 0;
      }
      .live-refresh-result {
        margin-top: 12px;
      }
      .live-refresh-result p {
        margin: 0;
      }
      .details-grid {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 6px 16px;
        margin-top: 18px;
        padding: 16px;
        border-radius: var(--radius-notice);
        background: var(--code-bg);
        border: 1px solid var(--border);
      }
      .detail-label { font-weight: 600; color: var(--muted); font-size: 0.92rem; }
      .detail-value { overflow-wrap: break-word; min-width: 0; }
      .detail-value code { font-size: 0.85em; }
      details.dev-details {
        margin-top: 18px;
        border-top: 1px solid var(--border);
        padding-top: 14px;
      }
      details.dev-details summary {
        cursor: pointer;
        font-size: 0.9rem;
        font-weight: 600;
        color: var(--muted);
      }
      .lookup-form {
        display: grid;
        gap: 10px;
        margin-top: 18px;
      }
      .lookup-form input {
        width: 100%;
        padding: 12px 14px;
        border: 1px solid var(--border);
        border-radius: 12px;
        font: inherit;
      }
      .lookup-form label {
        font-size: 0.92rem;
        color: var(--muted);
        font-weight: 600;
      }
      .section-muted { opacity: 0.75; }
      .section-muted h2 { font-size: 1.05rem; }
    `)}
  </head>
  <body>
    <main>
      <section class="card">
        <div class="logo">${logoHtml("44px")}</div>
        <div class="status-banner"><span aria-hidden="true">&#10132;</span> Connect GitHub</div>
        ${installOverview}
        ${primaryAction}
        ${installDetails}
        ${installLiveRefresh}
      </section>
    </main>
  </body>
</html>`);

  if (nextContext) {
    response.headers.set("Set-Cookie", serializeCookie(
      GITHUB_INSTALL_CONTEXT_COOKIE,
      JSON.stringify(nextContext),
      {
        httpOnly: true,
        maxAge: GITHUB_INSTALL_CONTEXT_MAX_AGE_SECONDS,
        path: resolveCookiePath(serviceBaseUrl),
        sameSite: "Lax",
        secure: serviceBaseUrl.startsWith("https://")
      }
    ));
  }

  response.headers.set("Cache-Control", "no-store");
  return response;
});

deployServiceApp.get("/github/setup", async (c) => {
  const serviceBaseUrl = resolveServiceBaseUrl(c.env, c.req.raw.url);
  const installationId = c.req.query("installation_id");
  const setupAction = c.req.query("setup_action");
  const appName = resolveGitHubAppName(c.env);
  const marketingName = "Kale Deploy";
  const appSlug = resolveGitHubAppSlug(c.env);
  const installUrl = appSlug ? githubAppInstallUrl(appSlug) : undefined;
  const cookieHeader = c.req.raw.headers.get("cookie");
  const cookieContext = readGitHubInstallContext(cookieHeader ?? undefined, c.env, serviceBaseUrl);
  const queryContext = parseOptionalRepositoryContext({
    repositoryFullName: c.req.query("repositoryFullName") ?? undefined,
    repositoryUrl: c.req.query("repositoryUrl") ?? undefined,
    projectName: c.req.query("projectName") ?? undefined
  }, c.env, serviceBaseUrl);
  const installContext = queryContext ?? cookieContext;
  let repositoryLifecycle:
    | RepositoryLifecyclePayload
    | undefined;

  if (installContext) {
    const repository = parseRepositoryReference({
      repositoryFullName: installContext.repositoryFullName
    });
    const lifecycle = await buildRepositoryLifecycleState(c.env, c.req.raw.url, repository, installContext.projectName);
    repositoryLifecycle = lifecycle.payload;
  }

  const bannerByStage = repositoryLifecycle
    ? {
        live: { className: "status-ready", icon: "&#10003;", label: "Live" },
        build_running: { className: "status-pending", icon: "&#8635;", label: "Building" },
        build_queued: { className: "status-pending", icon: "&#9719;", label: "Build queued" },
        build_failed: { className: "status-danger", icon: "&#9888;", label: "Build failed" },
        github_install: { className: "status-pending", icon: "&#9719;", label: "GitHub needed" },
        awaiting_push: { className: "status-ready", icon: "&#10148;", label: "Ready to deploy" },
        name_conflict: { className: "status-danger", icon: "&#9888;", label: "Name taken" },
        app_setup: { className: "status-config", icon: "&#9881;", label: "Setup needed" }
      }[repositoryLifecycle.workflowStage]
    : undefined;

  const statusBanner = bannerByStage
    ? `<div id="setup-status-banner" class="status-banner ${bannerByStage.className}"><span id="setup-status-banner-icon" class="status-icon">${bannerByStage.icon}</span> <span id="setup-status-banner-label">${escapeHtml(bannerByStage.label)}</span></div>`
    : "";

  const oauthBaseUrl = resolveMcpOauthBaseUrl(c.env, c.req.raw.url);

  const setupContent = repositoryLifecycle
    ? renderSetupPageContent({
        lifecycle: repositoryLifecycle,
        appName,
        serviceBaseUrl,
        oauthBaseUrl,
        installUrl,
        installReturnObserved: Boolean(installationId || setupAction)
      })
    : `<div class="actions">
          ${installUrl
            ? `<a class="button" href="${escapeHtml(installUrl)}">Connect GitHub</a>`
            : `<a class="button" href="${escapeHtml(`${serviceBaseUrl}/github/register`)}">Set up GitHub for Kale Deploy</a>`}
        </div>
        <form class="lookup-form" method="get" action="${escapeHtml(`${serviceBaseUrl}/github/setup`)}">
          <label for="repositoryFullName">Check an existing repo</label>
          <input id="repositoryFullName" type="text" name="repositoryFullName" placeholder="owner/repo" />
          <button class="button" type="submit">Check repository</button>
        </form>`;

  const projectDetails = repositoryLifecycle
    ? renderRepositoryDeveloperDetails({
        lifecycle: repositoryLifecycle,
        serviceBaseUrl,
        oauthBaseUrl
      })
    : "";

  const showProgress = repositoryLifecycle
    && repositoryLifecycle.workflowStage !== "live"
    && repositoryLifecycle.workflowStage !== "name_conflict";

  const lifecycleSteps = showProgress
    ? renderLifecycleSteps(repositoryLifecycle!.workflowStage)
    : "";

  const setupLiveRefresh = showProgress
    && repositoryLifecycle!.workflowStage !== "app_setup"
    ? renderRepositoryLiveRefreshPanel({
        lifecycle: repositoryLifecycle!,
        phase: "setup",
        appName,
        installReturnObserved: Boolean(installationId || setupAction)
      })
    : "";

  const response = c.html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(marketingName)} Setup</title>
    ${faviconLink()}
    ${baseStyles(`
      .status-banner {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 14px 18px;
        border-radius: var(--radius-notice);
        font-weight: 600;
        font-size: 1.1rem;
        margin-bottom: 16px;
      }
      .status-icon { font-size: 1.3rem; }
      .status-ready { background: #edf7f0; color: var(--success); border: 1px solid #b8dcc4; }
      .status-pending { background: var(--notice-bg); color: var(--accent); border: 1px solid var(--border); }
      .status-config { background: #f3f4f6; color: var(--muted); border: 1px solid var(--border); }
      .status-danger { background: #fff0ed; color: var(--error); border: 1px solid #efc6be; }
      .setup-primary {
        margin: 12px 0 16px;
      }
      .setup-primary h2 {
        margin: 0 0 6px;
        font-size: 1.2rem;
      }
      .setup-primary p {
        margin: 0;
        color: var(--muted);
      }
      .notice-error {
        background: #fff3f1;
        border-color: #f3b8ad;
      }
      .state-grid {
        display: grid;
        gap: 16px;
        margin: 18px 0;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      }
      .state-card {
        border: 1px solid var(--border);
        border-radius: var(--radius-notice);
        background: #fafbfd;
        padding: 16px;
      }
      .state-card.primary {
        background: linear-gradient(180deg, #f8fbff 0%, #eef4fb 100%);
      }
      .state-card h2,
      .state-card h3 {
        margin: 0 0 10px;
      }
      .state-card h2 {
        font-size: 1.2rem;
      }
      .state-card h3 {
        font-size: 1rem;
      }
      .state-label {
        margin: 0 0 10px;
        color: var(--accent);
        font-size: 0.82rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .state-card p:last-child {
        margin-bottom: 0;
      }
      .quick-links {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin: 18px 0 0;
      }
      .live-refresh-result {
        margin-top: 12px;
      }
      .live-refresh-result p {
        margin: 0;
      }
      .details-grid {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 6px 16px;
        margin-top: 18px;
        padding: 16px;
        border-radius: var(--radius-notice);
        background: var(--code-bg);
        border: 1px solid var(--border);
      }
      .detail-label { font-weight: 600; color: var(--muted); font-size: 0.92rem; }
      .detail-value { overflow-wrap: break-word; min-width: 0; }
      .detail-value code { font-size: 0.85em; }
      details.dev-details {
        margin-top: 18px;
        border-top: 1px solid var(--border);
        padding-top: 14px;
      }
      details.dev-details summary {
        cursor: pointer;
        font-size: 0.9rem;
        font-weight: 600;
        color: var(--muted);
      }
      .lookup-form {
        display: grid;
        gap: 10px;
        margin-top: 18px;
      }
      .lookup-form input {
        width: 100%;
        padding: 12px 14px;
        border: 1px solid var(--border);
        border-radius: 12px;
        font: inherit;
      }
      .lookup-form label {
        font-size: 0.92rem;
        color: var(--muted);
        font-weight: 600;
      }
      .lifecycle-list {
        margin: 18px 0 0;
        padding: 0;
        list-style: none;
        display: grid;
        gap: 10px;
      }
      .lifecycle-list li {
        display: flex;
        gap: 10px;
        align-items: flex-start;
        padding: 10px 12px;
        border: 1px solid var(--border);
        border-radius: 12px;
        background: #fafbfd;
      }
      .lifecycle-list li.active {
        border-color: var(--accent);
        background: var(--notice-bg);
      }
      .lifecycle-step {
        width: 26px;
        height: 26px;
        border-radius: 999px;
        background: var(--code-bg);
        color: var(--accent);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 0.84rem;
        font-weight: 700;
        flex: 0 0 auto;
      }
      .lifecycle-step-copy strong {
        display: block;
        color: var(--ink);
      }
      .section-muted { opacity: 0.75; }
      .section-muted h2 { font-size: 1.05rem; }
    `)}
  </head>
  <body>
    <main>
      <section class="card">
        <div class="logo">${logoHtml("44px")}</div>
        ${statusBanner}
        ${setupContent}
        ${projectDetails}
        ${setupLiveRefresh}
        ${lifecycleSteps}
      </section>
    </main>
  </body>
</html>`);

  response.headers.set("Cache-Control", "no-store");
  if (installContext) {
    response.headers.set("Set-Cookie", serializeCookie(
      GITHUB_INSTALL_CONTEXT_COOKIE,
      JSON.stringify(installContext),
      {
        httpOnly: true,
        maxAge: GITHUB_INSTALL_CONTEXT_MAX_AGE_SECONDS,
        path: resolveCookiePath(serviceBaseUrl),
        sameSite: "Lax",
        secure: serviceBaseUrl.startsWith("https://")
      }
    ));
  }

  return response;
});

deployServiceApp.post("/github/webhook", async (c) => {
  const signatureValid = await verifyGitHubWebhookSignature(c.req.raw, c.env.GITHUB_WEBHOOK_SECRET);
  if (!signatureValid) {
    return c.json({ error: "Invalid GitHub webhook signature." }, 401);
  }

  const eventName = c.req.header("x-github-event") ?? "unknown";
  const deliveryId = c.req.header("x-github-delivery") ?? undefined;
  const payload = await c.req.json<Record<string, unknown>>();

  try {
    if (eventName === "ping") {
      return c.json({ accepted: true, eventName }, 202);
    }

    if (eventName === "push") {
      return await handlePushWebhook(c.env, c.req.raw.url, payload as PushWebhookPayload, deliveryId);
    }

    return c.json({ accepted: true, eventName, ignored: true }, 202);
  } catch (error) {
    const httpError = asHttpError(error);
    return c.json({ error: httpError.message }, { status: httpError.status });
  }
});

deployServiceApp.get("/api/auth/session", async (c) => {
  return c.json({
    error: "CAIL Deploy no longer mints bearer tokens here. Use standard MCP OAuth discovery through /mcp."
  }, 410);
});

// Reserved for future project-admin actions such as per-project secrets.
// Ordinary deploys should not send users through this second GitHub auth step.
deployServiceApp.get("/api/github/user-auth/start", async (c) => {
  const serviceBaseUrl = resolveServiceBaseUrl(c.env, c.req.raw.url);
  const oauthBaseUrl = resolveMcpOauthBaseUrl(c.env, c.req.raw.url);

  try {
    const identity = await requireCloudflareAccessIdentity(c.req.raw, c.env);
    const authConfig = resolveGitHubUserAuthConfig(c.env, serviceBaseUrl);
    const repositoryContext = parseOptionalRepositoryContext({
      repositoryFullName: c.req.query("repositoryFullName") ?? undefined,
      repositoryUrl: c.req.query("repositoryUrl") ?? undefined,
      projectName: c.req.query("projectName") ?? undefined
    }, c.env, serviceBaseUrl);
    const standaloneProjectName = !repositoryContext && c.req.query("projectName")
      ? normalizeRequestedProjectName(
          c.req.query("projectName") ?? "",
          resolveReservedProjectNames(c.env, serviceBaseUrl)
        )
      : undefined;
    const state = await createGitHubUserAuthStateToken({
      secret: resolveMcpOauthSecret(c.env),
      issuer: serviceBaseUrl,
      subject: identity.subject,
      email: identity.email,
      repositoryFullName: repositoryContext?.repositoryFullName,
      projectName: repositoryContext?.projectName ?? standaloneProjectName,
      returnTo: normalizeOptionalGitHubUserAuthReturnTo(c.req.query("returnTo"), [serviceBaseUrl, oauthBaseUrl])
    });

    return Response.redirect(buildGitHubUserAuthorizeUrl(authConfig, state), 302);
  } catch (error) {
    const httpError = asHttpError(error);
    return c.html(renderGitHubUserAuthErrorPage(httpError.message, serviceBaseUrl), httpError.status);
  }
});

deployServiceApp.get("/github/user-auth/callback", async (c) => {
  const serviceBaseUrl = resolveServiceBaseUrl(c.env, c.req.raw.url);
  const code = c.req.query("code");
  const state = c.req.query("state");

  try {
    if (!code || !state) {
      throw new HttpError(400, "GitHub did not return the user authorization code and state.");
    }

    const authConfig = resolveGitHubUserAuthConfig(c.env, serviceBaseUrl);
    const statePayload = await verifyGitHubUserAuthStateToken({
      secret: resolveMcpOauthSecret(c.env),
      issuer: serviceBaseUrl,
      token: state
    });
    const tokenResponse = await exchangeGitHubUserCode({
      clientId: authConfig.clientId,
      clientSecret: authConfig.clientSecret,
      code,
      redirectUri: authConfig.callbackUrl,
      apiBaseUrl: c.env.GITHUB_API_BASE_URL
    });
    const userClient = createGitHubUserClient({
      accessToken: tokenResponse.accessToken,
      accessTokenExpiresAt: tokenResponse.accessTokenExpiresAt,
      apiBaseUrl: c.env.GITHUB_API_BASE_URL
    });
    const githubUser = await userClient.getAuthenticatedUser();
    const encryptionKey = resolveControlPlaneEncryptionKey(c.env);
    const accessTokenEncrypted = await sealStoredToken(encryptionKey, tokenResponse.accessToken);
    const refreshTokenEncrypted = tokenResponse.refreshToken
      ? await sealStoredToken(encryptionKey, tokenResponse.refreshToken)
      : undefined;
    const now = new Date().toISOString();

    await deleteGitHubUserAuthByGitHubUserId(c.env.CONTROL_PLANE_DB, githubUser.id);
    await putGitHubUserAuth(c.env.CONTROL_PLANE_DB, {
      accessSubject: statePayload.subject,
      accessEmail: statePayload.email,
      githubUserId: githubUser.id,
      githubLogin: githubUser.login,
      accessTokenEncrypted,
      accessTokenExpiresAt: tokenResponse.accessTokenExpiresAt,
      refreshTokenEncrypted,
      refreshTokenExpiresAt: tokenResponse.refreshTokenExpiresAt,
      createdAt: now,
      updatedAt: now
    });

    const repositoryContext = statePayload.repositoryFullName
      ? parseOptionalRepositoryContext(
          {
            repositoryFullName: statePayload.repositoryFullName,
            projectName: statePayload.projectName
          },
          { PROJECT_HOST_SUFFIX: undefined, DEPLOY_SERVICE_BASE_URL: serviceBaseUrl },
          serviceBaseUrl
        )
      : undefined;
    const setupUrl = repositoryContext
      ? `${serviceBaseUrl}/github/setup?repositoryFullName=${encodeURIComponent(repositoryContext.repositoryFullName)}&projectName=${encodeURIComponent(repositoryContext.projectName)}`
      : `${serviceBaseUrl}/github/setup`;
    const continueUrl = statePayload.returnTo ?? setupUrl;
    const continueLabel = describeGitHubUserAuthContinueLabel({
      serviceBaseUrl,
      continueUrl,
      hasRepositoryContext: Boolean(repositoryContext)
    });
    const showHomeButton = continueUrl !== serviceBaseUrl;

    return c.html(renderGitHubUserAuthSuccessPage({
      serviceBaseUrl,
      githubLogin: githubUser.login,
      continueUrl,
      continueLabel,
      showHomeButton
    }));
  } catch (error) {
    const httpError = asHttpError(error);
    return c.html(renderGitHubUserAuthErrorPage(httpError.message, serviceBaseUrl), httpError.status);
  }
});

deployServiceApp.get("/api/projects", async (c) => {
  if (!isAuthorized(c.req.raw, c.env.DEPLOY_API_TOKEN)) {
    return c.json({ error: "Unauthorized." }, 401);
  }

  const projects = await listProjects(c.env.CONTROL_PLANE_DB);
  return c.json(projects);
});

deployServiceApp.post("/api/projects/register", async (c) => {
  try {
    await requireAgentRequestIdentity(c.req.raw, c.env);
  } catch (error) {
    const httpError = asHttpError(error);
    return protectedAgentApiAuthErrorResponse(c, c.env, httpError);
  }

  try {
    const body = await c.req.json<{
      repositoryUrl?: string;
      repositoryFullName?: string;
      projectName?: string;
    }>();
    const repository = parseRepositoryReference(body);
    const lifecycle = await buildRepositoryLifecycleState(c.env, c.req.raw.url, repository, body.projectName);
    return c.json(lifecycle.payload, lifecycle.httpStatus);
  } catch (error) {
    const httpError = asHttpError(error);
    return c.json({ error: httpError.message }, { status: httpError.status });
  }
});

deployServiceApp.get("/api/repositories/:owner/:repo/status", async (c) => {
  try {
    await requireAgentRequestIdentity(c.req.raw, c.env);
  } catch (error) {
    const httpError = asHttpError(error);
    return protectedAgentApiAuthErrorResponse(c, c.env, httpError);
  }

  try {
    const repository = {
      owner: c.req.param("owner"),
      repo: c.req.param("repo")
    };
    const lifecycle = await buildRepositoryLifecycleState(
      c.env,
      c.req.raw.url,
      repository,
      c.req.query("projectName") ?? undefined
    );
    return c.json(lifecycle.payload);
  } catch (error) {
    const httpError = asHttpError(error);
    return c.json({ error: httpError.message }, { status: httpError.status });
  }
});

deployServiceApp.post("/api/validate", async (c) => {
  try {
    await requireAgentRequestIdentity(c.req.raw, c.env);
  } catch (error) {
    const httpError = asHttpError(error);
    return protectedAgentApiAuthErrorResponse(c, c.env, httpError);
  }

  try {
    const body = await c.req.json<{
      repositoryUrl?: string;
      repositoryFullName?: string;
      ref?: string;
      projectName?: string;
    }>();
    const result = await queueValidationJob(c.env, c.req.raw.url, body);
    return c.json(result.body, { status: result.status });
  } catch (error) {
    const httpError = asHttpError(error);
    return c.json({ error: httpError.message }, { status: httpError.status });
  }
});

deployServiceApp.get("/api/projects/:projectName/status", async (c) => {
  try {
    await requireAgentRequestIdentity(c.req.raw, c.env);
  } catch (error) {
    const httpError = asHttpError(error);
    return protectedAgentApiAuthErrorResponse(c, c.env, httpError);
  }

  const result = await buildProjectStatusResponse(c.env, c.req.param("projectName"));
  return c.json(result.body, { status: result.status });
});

deployServiceApp.get("/api/projects/:projectName/secrets", async (c) => {
  let identity: AgentRequestIdentity;

  try {
    identity = await requireAgentRequestIdentity(c.req.raw, c.env);
  } catch (error) {
    const httpError = asHttpError(error);
    return protectedAgentApiAuthErrorResponse(c, c.env, httpError);
  }

  try {
    const authorization = await authorizeProjectSecretsAccess(
      c.env,
      c.req.raw.url,
      identity,
      c.req.param("projectName")
    );
    if (!authorization.ok) {
      return c.json(authorization.body, { status: authorization.status });
    }

    const payload = await buildProjectSecretsListPayload(c.env, authorization.project, authorization.githubLogin);
    return c.json(payload);
  } catch (error) {
    const httpError = asHttpError(error);
    return c.json({ error: httpError.message }, { status: httpError.status });
  }
});

deployServiceApp.put("/api/projects/:projectName/secrets/:secretName", async (c) => {
  let identity: AgentRequestIdentity;

  try {
    identity = await requireAgentRequestIdentity(c.req.raw, c.env);
  } catch (error) {
    const httpError = asHttpError(error);
    return protectedAgentApiAuthErrorResponse(c, c.env, httpError);
  }

  try {
    const authorization = await authorizeProjectSecretsAccess(
      c.env,
      c.req.raw.url,
      identity,
      c.req.param("projectName")
    );
    if (!authorization.ok) {
      return c.json(authorization.body, { status: authorization.status });
    }

    const body = await c.req.json<{ value?: string }>();
    const payload = await setProjectSecretValue(
      c.env,
      PROJECT_SECRETS_CONFIG,
      authorization,
      c.req.param("secretName"),
      body.value
    );
    return c.json(payload);
  } catch (error) {
    const httpError = asHttpError(error);
    return c.json({ error: httpError.message }, { status: httpError.status });
  }
});

deployServiceApp.delete("/api/projects/:projectName/secrets/:secretName", async (c) => {
  let identity: AgentRequestIdentity;

  try {
    identity = await requireAgentRequestIdentity(c.req.raw, c.env);
  } catch (error) {
    const httpError = asHttpError(error);
    return protectedAgentApiAuthErrorResponse(c, c.env, httpError);
  }

  try {
    const authorization = await authorizeProjectSecretsAccess(
      c.env,
      c.req.raw.url,
      identity,
      c.req.param("projectName")
    );
    if (!authorization.ok) {
      return c.json(authorization.body, { status: authorization.status });
    }

    const payload = await removeProjectSecretValue(
      c.env,
      PROJECT_SECRETS_CONFIG,
      authorization,
      c.req.param("secretName")
    );
    return c.json(payload);
  } catch (error) {
    const httpError = asHttpError(error);
    return c.json({ error: httpError.message }, { status: httpError.status });
  }
});

deployServiceApp.get("/projects/control", async (c) => {
  const oauthBaseUrl = resolveMcpOauthBaseUrl(c.env, c.req.raw.url);
  const serviceBaseUrl = resolveServiceBaseUrl(c.env, c.req.raw.url);
  const requestUrl = new URL(c.req.raw.url);

  if (requestUrl.origin !== new URL(oauthBaseUrl).origin) {
    const redirectUrl = new URL(`${oauthBaseUrl}/projects/control`);
    for (const [key, value] of requestUrl.searchParams.entries()) {
      redirectUrl.searchParams.append(key, value);
    }
    return Response.redirect(redirectUrl.toString(), 302);
  }

  let identity: CloudflareAccessRequestIdentity;

  try {
    identity = await requireCloudflareAccessIdentity(c.req.raw, c.env);
  } catch (error) {
    const httpError = asHttpError(error);
    return c.html(renderProjectControlPanelAuthErrorPage(httpError.message, oauthBaseUrl), httpError.status);
  }

  try {
    const projectNameInput = c.req.query("projectName") ?? undefined;
    const repositoryFullName = c.req.query("repositoryFullName") ?? undefined;
    const repositoryUrl = c.req.query("repositoryUrl") ?? undefined;

    if (projectNameInput?.trim()) {
      const projectName = normalizeRequestedProjectName(
        projectNameInput,
        resolveReservedProjectNames(c.env, serviceBaseUrl)
      );
      return Response.redirect(buildProjectControlPanelUrl(oauthBaseUrl, projectName), 302);
    }

    if (repositoryFullName?.trim() || repositoryUrl?.trim()) {
      const repositoryContext = parseOptionalRepositoryContext({
        repositoryFullName,
        repositoryUrl
      }, c.env, serviceBaseUrl);
      if (!repositoryContext) {
        throw new HttpError(400, "Enter a GitHub repository in owner/repo form.");
      }
      return Response.redirect(
        buildGuidedSetupUrl(serviceBaseUrl, repositoryContext.repositoryFullName, repositoryContext.projectName),
        302
      );
    }

    return c.html(renderProjectAdminEntryPage({
      oauthBaseUrl,
      serviceBaseUrl,
      signedInEmail: identity.email
    }));
  } catch (error) {
    const httpError = asHttpError(error);
    return c.html(renderProjectAdminEntryPage({
      oauthBaseUrl,
      serviceBaseUrl,
      signedInEmail: identity.email,
      errorMessage: httpError.message
    }), httpError.status === 400 || httpError.status === 409 ? 400 : httpError.status);
  }
});

deployServiceApp.get("/projects/:projectName/control", async (c) => {
  const oauthBaseUrl = resolveMcpOauthBaseUrl(c.env, c.req.raw.url);
  const requestUrl = new URL(c.req.raw.url);
  if (requestUrl.origin !== new URL(oauthBaseUrl).origin) {
    const redirectUrl = new URL(`${oauthBaseUrl}/projects/${encodeURIComponent(c.req.param("projectName"))}/control`);
    const flash = c.req.query("flash");
    const message = c.req.query("message");
    if (flash) {
      redirectUrl.searchParams.set("flash", flash);
    }
    if (message) {
      redirectUrl.searchParams.set("message", message);
    }
    return Response.redirect(redirectUrl.toString(), 302);
  }

  let identity: CloudflareAccessRequestIdentity;

  try {
    identity = await requireCloudflareAccessIdentity(c.req.raw, c.env);
  } catch (error) {
    const httpError = asHttpError(error);
    return c.html(renderProjectControlPanelAuthErrorPage(httpError.message, oauthBaseUrl), httpError.status);
  }

  const projectName = c.req.param("projectName");

  try {
    const authorization = await authorizeProjectSecretsAccess(c.env, c.req.raw.url, identity, projectName);
    const flash = readProjectControlFlash(c.req.raw.url);

    if (!authorization.ok) {
      const connectUrl = authorization.body.nextAction === "connect_github_user"
        ? buildGitHubUserSecretsConnectUrl(oauthBaseUrl, projectName, {
            returnTo: buildProjectControlPanelUrl(oauthBaseUrl, projectName)
          })
        : authorization.body.connectGitHubUserUrl;
      return c.html(renderProjectControlPanelGatePage({
        oauthBaseUrl,
        summary: authorization.body.summary,
        connectUrl,
        flash
      }), 403);
    }

    const [statusResult, secretsPayload, formToken] = await Promise.all([
      buildProjectStatusResponse(c.env, projectName, { includeSensitive: true }),
      buildProjectSecretsListPayload(c.env, authorization.project, authorization.githubLogin),
      createProjectControlFormToken({
        secret: resolveMcpOauthSecret(c.env),
        issuer: oauthBaseUrl,
        subject: identity.subject,
        projectName
      })
    ]);

    return c.html(renderProjectControlPanelPage({
      oauthBaseUrl,
      signedInEmail: identity.email,
      projectName: authorization.project.projectName,
      repositoryFullName: authorization.project.githubRepo,
      statusSlug: typeof statusResult.body.status === "string" ? statusResult.body.status : "unknown",
      deploymentUrl: typeof statusResult.body.deployment_url === "string" ? statusResult.body.deployment_url : authorization.project.deploymentUrl,
      buildLogUrl: typeof statusResult.body.build_log_url === "string" ? statusResult.body.build_log_url : undefined,
      errorMessage: typeof statusResult.body.error_message === "string" ? statusResult.body.error_message : undefined,
      updatedAt: typeof statusResult.body.updated_at === "string" ? statusResult.body.updated_at : authorization.project.updatedAt,
      repoUrl: `https://github.com/${authorization.project.githubRepo}`,
      setupUrl: buildGuidedSetupUrl(
        resolveServiceBaseUrl(c.env, c.req.raw.url),
        authorization.project.githubRepo,
        authorization.project.projectName
      ),
      secrets: {
        count: secretsPayload.count,
        secrets: secretsPayload.secrets
      },
      formToken,
      flash
    }));
  } catch (error) {
    const httpError = asHttpError(error);
    if (httpError.status === 404) {
      const connectUrl = buildGitHubUserSecretsConnectUrl(oauthBaseUrl, projectName, {
        returnTo: buildProjectControlPanelUrl(oauthBaseUrl, projectName)
      });
      return c.html(renderProjectControlPanelGatePage({
        oauthBaseUrl,
        summary: "Project settings are only visible to people who can manage this Kale project.",
        connectUrl
      }), 403);
    }

    return c.html(renderProjectControlPanelAuthErrorPage(httpError.message, oauthBaseUrl), httpError.status);
  }
});

deployServiceApp.post("/projects/:projectName/control/secrets", async (c) => {
  const oauthBaseUrl = resolveMcpOauthBaseUrl(c.env, c.req.raw.url);
  let identity: CloudflareAccessRequestIdentity;

  try {
    identity = await requireCloudflareAccessIdentity(c.req.raw, c.env);
  } catch (error) {
    const httpError = asHttpError(error);
    return c.html(renderProjectControlPanelAuthErrorPage(httpError.message, oauthBaseUrl), httpError.status);
  }

  const projectName = c.req.param("projectName");

  try {
    const form = await c.req.formData();
    await verifyProjectControlFormToken({
      secret: resolveMcpOauthSecret(c.env),
      issuer: oauthBaseUrl,
      token: getRequiredProjectControlFormField(form, "formToken"),
      subject: identity.subject,
      projectName
    });

    const authorization = await authorizeProjectSecretsAccess(c.env, c.req.raw.url, identity, projectName);
    if (!authorization.ok) {
      return Response.redirect(buildProjectControlPanelUrl(oauthBaseUrl, projectName, {
        flash: "error",
        message: authorization.body.summary
      }), 302);
    }

    const result = await setProjectSecretValue(
      c.env,
      PROJECT_SECRETS_CONFIG,
      authorization,
      getRequiredProjectControlFormField(form, "secretName"),
      getRequiredProjectControlFormField(form, "secretValue")
    );

    return Response.redirect(buildProjectControlPanelUrl(oauthBaseUrl, projectName, {
      flash: result.nextAction === "redeploy_to_apply_secret" ? "warning" : "success",
      message: result.warning ?? result.summary
    }), 302);
  } catch (error) {
    const httpError = asHttpError(error);
    return Response.redirect(buildProjectControlPanelUrl(oauthBaseUrl, projectName, {
      flash: "error",
      message: httpError.message
    }), 302);
  }
});

deployServiceApp.post("/projects/:projectName/control/secrets/:secretName/delete", async (c) => {
  const oauthBaseUrl = resolveMcpOauthBaseUrl(c.env, c.req.raw.url);
  let identity: CloudflareAccessRequestIdentity;

  try {
    identity = await requireCloudflareAccessIdentity(c.req.raw, c.env);
  } catch (error) {
    const httpError = asHttpError(error);
    return c.html(renderProjectControlPanelAuthErrorPage(httpError.message, oauthBaseUrl), httpError.status);
  }

  const projectName = c.req.param("projectName");

  try {
    const form = await c.req.formData();
    await verifyProjectControlFormToken({
      secret: resolveMcpOauthSecret(c.env),
      issuer: oauthBaseUrl,
      token: getRequiredProjectControlFormField(form, "formToken"),
      subject: identity.subject,
      projectName
    });

    const authorization = await authorizeProjectSecretsAccess(c.env, c.req.raw.url, identity, projectName);
    if (!authorization.ok) {
      return Response.redirect(buildProjectControlPanelUrl(oauthBaseUrl, projectName, {
        flash: "error",
        message: authorization.body.summary
      }), 302);
    }

    const result = await removeProjectSecretValue(
      c.env,
      PROJECT_SECRETS_CONFIG,
      authorization,
      c.req.param("secretName")
    );
    return Response.redirect(buildProjectControlPanelUrl(oauthBaseUrl, projectName, {
      flash: result.nextAction === "redeploy_to_apply_secret" ? "warning" : "success",
      message: result.warning ?? result.summary
    }), 302);
  } catch (error) {
    const httpError = asHttpError(error);
    return Response.redirect(buildProjectControlPanelUrl(oauthBaseUrl, projectName, {
      flash: "error",
      message: httpError.message
    }), 302);
  }
});

deployServiceApp.get("/api/build-jobs/:jobId/status", async (c) => {
  try {
    await requireAgentRequestIdentity(c.req.raw, c.env);
  } catch (error) {
    const httpError = asHttpError(error);
    return protectedAgentApiAuthErrorResponse(c, c.env, httpError);
  }

  const result = await buildBuildJobStatusResponse(c.env, c.req.param("jobId"));
  return c.json(result.body, { status: result.status });
});

deployServiceApp.all("/mcp", async (c) => {
  if (c.req.method === "OPTIONS") {
    return c.body(null, 204);
  }

  let identity: AgentRequestIdentity;

  try {
    identity = await requireMcpRequestIdentity(c.req.raw, c.env);
  } catch (error) {
    return oauthUnauthorizedResponse(c, c.env);
  }

  try {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    const server = createDeployServiceMcpServer(c.env, c.req.raw.url, identity);
    await server.connect(transport);

    const response = await transport.handleRequest(c.req.raw);
    await server.close();
    await transport.close();
    return response;
  } catch (error) {
    console.error("MCP request failed.", error);
    const httpError = asHttpError(error);
    return c.json({
      jsonrpc: "2.0",
      error: {
        code: -32603,
        message: httpError.message
      },
      id: null
    }, { status: httpError.status });
  }
});

deployServiceApp.post("/api/deployments", async (c) => {
  if (!isAuthorized(c.req.raw, c.env.DEPLOY_API_TOKEN)) {
    return c.json({ error: "Unauthorized." }, 401);
  }

  try {
    const form = await c.req.formData();
    const metadataField = form.get("metadata");
    if (typeof metadataField !== "string") {
      throw new HttpError(400, "Multipart field 'metadata' must be a JSON string.");
    }

    const metadata = parseDeploymentMetadata(metadataField);
    const files = collectUploadFiles(form, ["metadata"]);
    const result = await deployArtifact(c.env, metadata, files);
    return c.json({
      ok: true,
      deploymentId: result.deployment.deploymentId,
      deploymentUrl: result.project.deploymentUrl,
      project: result.project
    });
  } catch (error) {
    const httpError = asHttpError(error);
    return c.json({ error: httpError.message }, { status: httpError.status });
  }
});

deployServiceApp.get("/internal/build-jobs/:jobId/source", async (c) => {
  if (!isAuthorized(c.req.raw, c.env.BUILD_RUNNER_TOKEN)) {
    return c.json({ error: "Unauthorized." }, 401);
  }

  const job = await getBuildJob(c.env.CONTROL_PLANE_DB, c.req.param("jobId"));
  if (!job) {
    return c.json({ error: "Build job not found." }, 404);
  }

  try {
    const lease = await createBuildRunnerSourceLease(c.env, job);
    return c.json(lease);
  } catch (error) {
    const httpError = asHttpError(error);
    return c.json({ error: httpError.message }, { status: httpError.status });
  }
});

deployServiceApp.post("/internal/build-jobs/:jobId/start", async (c) => {
  if (!isAuthorized(c.req.raw, c.env.BUILD_RUNNER_TOKEN)) {
    return c.json({ error: "Unauthorized." }, 401);
  }

  const jobId = c.req.param("jobId");
  const job = await getBuildJob(c.env.CONTROL_PLANE_DB, jobId);
  if (!job) {
    return c.json({ error: "Build job not found." }, 404);
  }

  if (isCompletedJob(job)) {
    return c.json({ ok: true, alreadyCompleted: true, job });
  }

  try {
    const payload = await c.req.json<BuildRunnerStartPayload>();
    const startedAt = payload.startedAt ?? new Date().toISOString();
    const nextJob: BuildJobRecord = {
      ...job,
      status: "in_progress",
      runnerId: payload.runnerId ?? job.runnerId,
      startedAt: job.startedAt ?? startedAt,
      updatedAt: startedAt,
      buildLogUrl: payload.buildLogUrl ?? job.buildLogUrl
    };

    await putBuildJob(c.env.CONTROL_PLANE_DB, nextJob);
    const statusUrl = buildJobStatusUrl(resolveServiceBaseUrl(c.env, c.req.raw.url), jobId);
    await updateJobCheckRun(c.env, nextJob, {
      status: "in_progress",
      startedAt: nextJob.startedAt,
      detailsUrl: payload.buildLogUrl ?? job.buildLogUrl ?? statusUrl,
      output: checkRunOutput(
        job.eventName === "validate" ? "Validation in progress" : "Build in progress",
        payload.summary ?? defaultJobStartSummary(job.eventName),
        payload.text
      )
    });

    return c.json({ ok: true, job: nextJob });
  } catch (error) {
    const httpError = asHttpError(error);
    return c.json({ error: httpError.message }, { status: httpError.status });
  }
});

deployServiceApp.post("/internal/build-jobs/:jobId/complete", async (c) => {
  if (!isAuthorized(c.req.raw, c.env.BUILD_RUNNER_TOKEN)) {
    return c.json({ error: "Unauthorized." }, 401);
  }

  const jobId = c.req.param("jobId");
  const job = await getBuildJob(c.env.CONTROL_PLANE_DB, jobId);
  if (!job) {
    return c.json({ error: "Build job not found." }, 404);
  }

  if (isCompletedJob(job)) {
    return c.json({ ok: true, alreadyCompleted: true, job });
  }

  let currentJob = job;

  try {
    const { result, files } = await parseBuildCompletionRequest(c.req.raw);

    if (result.status === "failure") {
      const failedJob = await completeBuildJobFailure(c.env, currentJob, result, result.errorMessage ?? "Build failed.");
      return c.json({ ok: true, job: failedJob });
    }

    if (job.eventName === "validate") {
      const completedAt = result.completedAt ?? new Date().toISOString();
      const completedJob: BuildJobRecord = {
        ...job,
        status: "success",
        runnerId: result.runnerId ?? currentJob.runnerId,
        updatedAt: completedAt,
        completedAt,
        buildLogUrl: result.buildLogUrl ?? currentJob.buildLogUrl,
        projectName: currentJob.projectName
      };
      await putBuildJob(c.env.CONTROL_PLANE_DB, completedJob);
      await updateJobCheckRun(c.env, completedJob, {
        status: "completed",
        conclusion: "success",
        completedAt,
        detailsUrl: result.buildLogUrl ?? buildJobStatusUrl(resolveServiceBaseUrl(c.env, c.req.raw.url), job.jobId),
        output: checkRunOutput(
          "Validation passed",
          result.summary ?? "CAIL Validate built the Worker bundle successfully without deploying it.",
          result.text
        )
      });

      return c.json({ ok: true, job: completedJob });
    }

    if (!result.deployment) {
      throw new HttpError(400, "Successful build results must include deployment metadata.");
    }

    const workerFiles = getWorkerFiles(result.deployment.staticAssets, files);
    ensureUploadContainsMainModule(workerFiles, result.deployment.workerUpload.main_module);

    const deployingAt = new Date().toISOString();
    const deployingJob: BuildJobRecord = {
      ...job,
      status: "deploying",
      runnerId: result.runnerId ?? currentJob.runnerId,
      startedAt: currentJob.startedAt ?? deployingAt,
      updatedAt: deployingAt,
      buildLogUrl: result.buildLogUrl ?? currentJob.buildLogUrl
    };
    currentJob = deployingJob;
    await putBuildJob(c.env.CONTROL_PLANE_DB, deployingJob);
    await updateJobCheckRun(c.env, deployingJob, {
      status: "in_progress",
      startedAt: deployingJob.startedAt,
      detailsUrl: result.buildLogUrl ?? currentJob.buildLogUrl,
      output: checkRunOutput(
        "Deploying to Cloudflare",
        result.summary ?? "Build finished. CAIL Deploy is uploading the Worker bundle and provisioning bindings.",
        result.text
      )
    });

    const deploymentResult = await deployArtifact(
      c.env,
      {
        projectName: result.deployment.projectName,
        ownerLogin: job.repository.ownerLogin,
        githubRepo: job.repository.fullName,
        description: result.deployment.description,
        workerUpload: result.deployment.workerUpload,
        staticAssets: normalizeStaticAssets(result.deployment.staticAssets, result.deployment.projectName)
      },
      files,
      {
        jobId: job.jobId,
        headSha: job.headSha
      }
    );

    const completedAt = result.completedAt ?? new Date().toISOString();
    const completedJob: BuildJobRecord = {
      ...deployingJob,
      status: "success",
      updatedAt: completedAt,
      completedAt,
      projectName: deploymentResult.project.projectName,
      deploymentUrl: deploymentResult.project.deploymentUrl,
      deploymentId: deploymentResult.deployment.deploymentId
    };
    await putBuildJob(c.env.CONTROL_PLANE_DB, completedJob);
    await updateJobCheckRun(c.env, completedJob, {
      status: "completed",
      conclusion: "success",
      completedAt,
      detailsUrl: deploymentResult.project.deploymentUrl,
      output: checkRunOutput(
        "Deployment ready",
        result.summary ?? `Live at ${deploymentResult.project.deploymentUrl}`,
        result.text
      )
    });

    return c.json({
      ok: true,
      deploymentId: deploymentResult.deployment.deploymentId,
      deploymentUrl: deploymentResult.project.deploymentUrl,
      job: completedJob,
      project: deploymentResult.project
    });
  } catch (error) {
    const httpError = asHttpError(error);
    const failedJob = await completeBuildJobFailure(c.env, currentJob, undefined, httpError.message);
    return c.json({ error: failedJob.errorMessage }, { status: httpError.status });
  }
});

async function handlePushWebhook(
  env: Env,
  requestUrl: string,
  payload: PushWebhookPayload,
  deliveryId?: string
): Promise<Response> {
  assertPushWebhookPayload(payload);

  const installationId = payload.installation?.id;
  if (!installationId) {
    return Response.json({ accepted: true, eventName: "push", ignored: true, reason: "No GitHub App installation." }, { status: 202 });
  }

  const branchName = stripGitRef(payload.ref);
  if (payload.deleted || isDeletedCommit(payload.after)) {
    return Response.json({ accepted: true, eventName: "push", ignored: true, reason: "Deleted ref." }, { status: 202 });
  }

  if (branchName !== payload.repository.default_branch) {
    return Response.json(
      {
        accepted: true,
        eventName: "push",
        ignored: true,
        reason: `Push was for '${branchName}', not default branch '${payload.repository.default_branch}'.`
      },
      { status: 202 }
    );
  }

  if (deliveryId) {
    const claimed = await claimWebhookDelivery(env.CONTROL_PLANE_DB, deliveryId, "push", new Date().toISOString());
    if (!claimed) {
      const existingJob = await getBuildJobByDeliveryId(env.CONTROL_PLANE_DB, deliveryId);
      return Response.json(
        {
          accepted: true,
          eventName: "push",
          duplicate: true,
          jobId: existingJob?.jobId,
          status: existingJob?.status ?? "processing"
        },
        { status: 202 }
      );
    }
  }

  const github = getGitHubAppClient(env);
  const repository = toRepositoryRecord(payload);
  const serviceBaseUrl = resolveServiceBaseUrl(env, requestUrl);
  const reservedProjectNames = resolveReservedProjectNames(env, serviceBaseUrl);
  const repositoryFullName = repository.fullName;
  const projectName = await resolveRepositoryProjectName(
    env.CONTROL_PLANE_DB,
    repositoryFullName,
    repository.name,
    reservedProjectNames
  );
  const jobId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  let createdJob: BuildJobRecord | undefined;
  let checkRunId: number | undefined;

  try {
    const installationClient = await github.createInstallationClient(installationId);
    try {
      await assertRepositoryWithinJobLimits(
        env,
        repositoryFullName,
        projectName,
        "push",
        createdAt
      );
    } catch (error) {
      const httpError = asHttpError(error);
      if (httpError.status === 429) {
        const checkRun = await installationClient.createCheckRun({
          owner: repository.ownerLogin,
          repo: repository.name,
          name: "CAIL Deploy",
          headSha: payload.after,
          externalId: jobId,
          status: "completed",
          conclusion: "action_required",
          output: checkRunOutput(
            "Deployment limit reached",
            httpError.message
          )
        });

        const blockedJob: BuildJobRecord = {
          jobId,
          deliveryId,
          eventName: "push",
          installationId,
          repository,
          ref: payload.ref,
          headSha: payload.after,
          previousSha: payload.before,
          checkRunId: checkRun.id,
          status: "failure",
          projectName,
          createdAt,
          updatedAt: createdAt,
          completedAt: createdAt,
          errorKind: "build_failure",
          errorMessage: httpError.message
        };
        await putBuildJob(env.CONTROL_PLANE_DB, blockedJob);
        if (deliveryId) {
          await attachWebhookDeliveryJob(env.CONTROL_PLANE_DB, deliveryId, jobId);
        }

        return Response.json(
          {
            accepted: true,
            eventName: "push",
            jobId,
            checkRunId: checkRun.id,
            status: "blocked",
            error: httpError.message
          },
          { status: 202 }
        );
      }

      throw error;
    }

    const checkRun = await installationClient.createCheckRun({
      owner: repository.ownerLogin,
      repo: repository.name,
      name: "CAIL Deploy",
      headSha: payload.after,
      externalId: jobId,
      status: "queued",
      output: checkRunOutput(
        "Queued for build",
        "CAIL Deploy accepted the push and queued a managed build for the default branch."
      )
    });
    checkRunId = checkRun.id;

    const job: BuildJobRecord = {
      jobId,
      deliveryId,
      eventName: "push",
      installationId,
      repository,
      ref: payload.ref,
      headSha: payload.after,
      previousSha: payload.before,
      checkRunId: checkRun.id,
      status: "queued",
      projectName,
      createdAt,
      updatedAt: createdAt
    };
    createdJob = job;

    await putBuildJob(env.CONTROL_PLANE_DB, job);
    if (deliveryId) {
      await attachWebhookDeliveryJob(env.CONTROL_PLANE_DB, deliveryId, jobId);
    }

    const message = createBuildRunnerRequest(env, requestUrl, job, payload.head_commit?.timestamp);
    await env.BUILD_QUEUE.send(message, { contentType: "json" });

    return Response.json(
      {
        accepted: true,
        eventName: "push",
        jobId,
        checkRunId: checkRun.id,
        status: "queued"
      },
      { status: 202 }
    );
  } catch (error) {
    if (createdJob && checkRunId) {
      const failedAt = new Date().toISOString();
      const failedJob: BuildJobRecord = {
        ...createdJob,
        checkRunId,
        status: "failure",
        updatedAt: failedAt,
        completedAt: failedAt,
        errorMessage: asHttpError(error).message
      };
      await putBuildJob(env.CONTROL_PLANE_DB, failedJob);
      await updateJobCheckRun(env, failedJob, {
        status: "completed",
        conclusion: "failure",
        completedAt: failedAt,
        output: checkRunOutput("Build dispatch failed", failedJob.errorMessage ?? "Queue publish failed.")
      });
      return Response.json(
        {
          accepted: true,
          eventName: "push",
          jobId,
          checkRunId,
          status: "failure",
          error: failedJob.errorMessage
        },
        { status: 202 }
      );
    }

    if (deliveryId && !createdJob) {
      await releaseWebhookDelivery(env.CONTROL_PLANE_DB, deliveryId);
    }

    throw error;
  }
}

function createBuildRunnerRequest(
  env: Env,
  requestUrl: string,
  job: BuildJobRecord,
  pushedAt?: string
): BuildRunnerJobRequest {
  const serviceBaseUrl = resolveServiceBaseUrl(env, requestUrl);
  const gitHubApiBaseUrl = resolveGitHubApiBaseUrl(env);
  const reservedProjectNames = resolveReservedProjectNames(env, serviceBaseUrl);

  return {
    jobId: job.jobId,
    createdAt: job.createdAt,
    trigger: {
      event: job.eventName,
      deliveryId: job.deliveryId,
      ref: job.ref,
      headSha: job.headSha,
      previousSha: job.previousSha,
      pushedAt
    },
    repository: job.repository,
    source: {
      provider: "github",
      archiveUrl: `${gitHubApiBaseUrl}/repos/${job.repository.ownerLogin}/${job.repository.name}/tarball/${job.headSha}`,
      cloneUrl: job.repository.cloneUrl,
      ref: job.headSha,
      tokenUrl: `${serviceBaseUrl}/internal/build-jobs/${job.jobId}/source`
    },
    deployment: {
      publicBaseUrl: resolveProjectPublicBaseUrl(env),
      suggestedProjectName: job.projectName ?? suggestProjectName(job.repository.name, reservedProjectNames)
    },
    callback: {
      startUrl: `${serviceBaseUrl}/internal/build-jobs/${job.jobId}/start`,
      completeUrl: `${serviceBaseUrl}/internal/build-jobs/${job.jobId}/complete`
    }
  };
}

async function createBuildRunnerSourceLease(env: Env, job: BuildJobRecord): Promise<BuildRunnerSourceLease> {
  const github = getGitHubAppClient(env);
  const installationClient = await github.createInstallationClient(job.installationId);

  return {
    provider: "github",
    archiveUrl: `${resolveGitHubApiBaseUrl(env)}/repos/${job.repository.ownerLogin}/${job.repository.name}/tarball/${job.headSha}`,
    cloneUrl: job.repository.cloneUrl,
    ref: job.headSha,
    accessToken: installationClient.accessToken,
    accessTokenExpiresAt: installationClient.accessTokenExpiresAt
  };
}

async function parseBuildCompletionRequest(
  request: Request
): Promise<{ result: BuildRunnerCompletePayload; files: Array<{ name: string; file: File }> }> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const resultField = form.get("result");
    if (typeof resultField !== "string") {
      throw new HttpError(400, "Multipart field 'result' must be a JSON string.");
    }

    return {
      result: parseBuildRunnerResult(resultField),
      files: collectUploadFiles(form, ["result"])
    };
  }

  if (contentType.includes("application/json")) {
    const body = await request.text();
    return {
      result: parseBuildRunnerResult(body),
      files: []
    };
  }

  throw new HttpError(415, "Build runner completion must be JSON or multipart/form-data.");
}

async function completeBuildJobFailure(
  env: Env,
  job: BuildJobRecord,
  payload: BuildRunnerCompletePayload | undefined,
  errorMessage: string
): Promise<BuildJobRecord> {
  const completedAt = payload?.completedAt ?? new Date().toISOString();
  const conclusion = payload?.checkRunConclusion ?? "failure";
  const title = failureTitle(job.eventName, payload?.failureKind, conclusion);
  const serviceBaseUrl = resolveServiceBaseUrl(env, env.DEPLOY_SERVICE_BASE_URL ?? "https://cail.invalid");
  const failedJob: BuildJobRecord = {
    ...job,
    status: "failure",
    runnerId: payload?.runnerId ?? job.runnerId,
    updatedAt: completedAt,
    completedAt,
    buildLogUrl: payload?.buildLogUrl ?? job.buildLogUrl,
    errorKind: payload?.failureKind ?? "build_failure",
    errorMessage: payload?.summary ?? errorMessage,
    errorDetail: payload?.text
  };
  await putBuildJob(env.CONTROL_PLANE_DB, failedJob);
  await updateJobCheckRun(env, failedJob, {
    status: "completed",
    conclusion,
    completedAt,
    detailsUrl: payload?.buildLogUrl ?? job.buildLogUrl ?? buildJobStatusUrl(serviceBaseUrl, job.jobId),
    output: checkRunOutput(
      title,
      payload?.summary ?? errorMessage,
      payload?.text
    )
  });

  return failedJob;
}

async function authorizeProjectSecretsAccess(
  env: Env,
  requestUrl: string,
  identity: AgentRequestIdentity,
  projectName: string
): Promise<ProjectSecretsAuthorization> {
  const serviceBaseUrl = resolveServiceBaseUrl(env, requestUrl);
  const oauthBaseUrl = resolveMcpOauthBaseUrl(env, requestUrl);
  const connection = buildConnectionHealthPayload(env, serviceBaseUrl, identity);
  const connectGitHubUserUrl = buildGitHubUserSecretsConnectUrl(oauthBaseUrl, projectName);
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
  env: Env,
  authConfig: { clientId: string; clientSecret: string; callbackUrl: string; authorizeUrl: string },
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
  env: Env,
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

function buildGitHubUserSecretsConnectUrl(
  oauthBaseUrl: string,
  projectName: string,
  options?: { repositoryFullName?: string; returnTo?: string }
): string {
  const url = new URL(`${oauthBaseUrl}/api/github/user-auth/start`);
  url.searchParams.set("projectName", projectName);
  if (options?.repositoryFullName) {
    url.searchParams.set("repositoryFullName", options.repositoryFullName);
  }
  if (options?.returnTo) {
    url.searchParams.set("returnTo", options.returnTo);
  }
  return url.toString();
}

function isExpiredOrNearExpiry(expiresAt: string | undefined): boolean {
  if (!expiresAt) {
    return false;
  }

  return Date.parse(expiresAt) <= Date.now() + 60_000;
}

async function deployArtifact(
  env: Env,
  metadata: DeploymentMetadata,
  files: Array<{ name: string; file: File }>,
  options?: { jobId?: string; headSha?: string }
): Promise<DeployArtifactResult> {
  const cloudflareApiToken = resolveRequiredCloudflareApiToken(env);

  assertAllowedProjectName(metadata.projectName, env, env.DEPLOY_SERVICE_BASE_URL);
  const deploymentUrl = buildProjectDeploymentUrl(env, metadata.projectName);
  const repositoryFullName = formatRepositoryFullName(metadata.ownerLogin, metadata.githubRepo);
  const now = new Date().toISOString();
  const policy = await ensureProjectPolicy(env.CONTROL_PLANE_DB, repositoryFullName, metadata.projectName, now);
  assertDeploymentPolicy(metadata, policy);
  const projectClaim = await getProjectClaim(env.CONTROL_PLANE_DB, metadata.projectName, repositoryFullName);
  const existingRecord = projectClaim.project;
  const repositoryRecord = existingRecord ?? await getLatestProjectForRepository(env.CONTROL_PLANE_DB, repositoryFullName);
  if (projectClaim.conflict) {
    throw new HttpError(409, `Project name '${metadata.projectName}' is already claimed by another GitHub repository.`);
  }

  const reservedRecord: ProjectRecord = existingRecord ?? {
    projectName: metadata.projectName,
    ownerLogin: metadata.ownerLogin,
    githubRepo: metadata.githubRepo,
    description: metadata.description,
    deploymentUrl,
    databaseId: repositoryRecord?.databaseId,
    filesBucketName: repositoryRecord?.filesBucketName,
    cacheNamespaceId: repositoryRecord?.cacheNamespaceId,
    hasAssets: false,
    createdAt: now,
    updatedAt: now
  };

  if (!existingRecord) {
    await claimProjectName(env.CONTROL_PLANE_DB, reservedRecord);
    const claimed = await getProjectClaim(env.CONTROL_PLANE_DB, metadata.projectName, repositoryFullName);
    if (claimed.conflict) {
      throw new HttpError(409, `Project name '${metadata.projectName}' is already claimed by another GitHub repository.`);
    }
  }

  const deploymentId = crypto.randomUUID();
  const artifactPrefix = `deployments/${metadata.projectName}/${deploymentId}`;
  const staticAssets = normalizeStaticAssets(metadata.staticAssets, metadata.projectName);
  assertDeploymentUploadWithinLimit(metadata, files, policy.maxAssetBytes);
  const workerFiles = getWorkerFiles(staticAssets, files);
  ensureUploadContainsMainModule(workerFiles, metadata.workerUpload.main_module);
  const archiveManifest = createDeploymentArchiveManifest(metadata, workerFiles, staticAssets, options);
  const client = new CloudflareApiClient({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: cloudflareApiToken
  });

  const { databaseId, filesBucketName, cacheNamespaceId } = await resolveProjectResources(
    client,
    metadata,
    repositoryRecord,
    env.D1_LOCATION_HINT
  );
  await putProject(env.CONTROL_PLANE_DB, {
    ...reservedRecord,
    databaseId,
    filesBucketName,
    cacheNamespaceId,
    hasAssets: existingRecord?.hasAssets ?? false,
    latestDeploymentId: existingRecord?.latestDeploymentId,
    updatedAt: now
  });
  const staticAssetsResult = await prepareStaticAssetsUpload(client, env.WFP_NAMESPACE, metadata.projectName, staticAssets, files);
  const nextHasAssets = Boolean(staticAssets?.files.length || existingRecord?.hasAssets);
  const secretBindings = await buildProjectSecretBindings(env, PROJECT_SECRETS_CONFIG, metadata);
  const workerUpload = withProjectBindings(metadata, databaseId, {
    filesBucketName,
    cacheNamespaceId,
    secretBindings,
    existingHasAssets: existingRecord?.hasAssets ?? false,
    staticAssetsJwt: staticAssetsResult.completionJwt,
    staticAssetsConfig: staticAssets?.config ?? metadata.workerUpload.assets?.config
  });

  try {
    await client.uploadUserWorker(env.WFP_NAMESPACE, metadata.projectName, workerUpload, workerFiles);
  } catch (error) {
    const archive = await tryArchiveDeploymentManifest(env, artifactPrefix, archiveManifest);
    const failedDeployment: DeploymentRecord = {
      deploymentId,
      jobId: options?.jobId,
      projectName: metadata.projectName,
      ownerLogin: metadata.ownerLogin,
      githubRepo: metadata.githubRepo,
      headSha: options?.headSha,
      status: "failure",
      deploymentUrl,
      artifactPrefix,
      archiveKind: archive.archiveKind,
      manifestKey: archive.manifestKey,
      hasAssets: nextHasAssets,
      createdAt: new Date().toISOString()
    };
    await insertDeployment(env.CONTROL_PLANE_DB, failedDeployment);
    void cleanupExpiredFailedArtifacts(env);
    throw error;
  }

  const updatedAt = new Date().toISOString();
  const archive = await tryArchiveSuccessfulDeployment(
    env,
    artifactPrefix,
    archiveManifest,
    workerFiles,
    staticAssets,
    files
  );
  const project: ProjectRecord = {
    projectName: metadata.projectName,
    ownerLogin: metadata.ownerLogin,
    githubRepo: metadata.githubRepo,
    description: metadata.description,
    deploymentUrl,
    databaseId,
    filesBucketName,
    cacheNamespaceId,
    hasAssets: nextHasAssets,
    latestDeploymentId: deploymentId,
    createdAt: existingRecord?.createdAt ?? reservedRecord.createdAt,
    updatedAt
  };

  const deployment: DeploymentRecord = {
    deploymentId,
    jobId: options?.jobId,
    projectName: metadata.projectName,
    ownerLogin: metadata.ownerLogin,
    githubRepo: metadata.githubRepo,
    headSha: options?.headSha,
    status: "success",
    deploymentUrl,
    artifactPrefix,
    archiveKind: archive.archiveKind,
    manifestKey: archive.manifestKey,
    hasAssets: nextHasAssets,
    createdAt: updatedAt
  };

  await putProject(env.CONTROL_PLANE_DB, project);
  await insertDeployment(env.CONTROL_PLANE_DB, deployment);
  void enforceArtifactRetentionPolicy(env, project.projectName);

  return { project, deployment };
}

function assertDeploymentPolicy(
  metadata: DeploymentMetadata,
  policy: { aiEnabled: boolean; vectorizeEnabled: boolean; roomsEnabled: boolean }
): void {
  const invalidBindings: string[] = [];

  for (const binding of metadata.workerUpload.bindings ?? []) {
    switch (binding.type) {
      case "d1":
        if (binding.name !== "DB") {
          invalidBindings.push(`${binding.name} (${binding.type})`);
        }
        break;
      case "kv_namespace":
        if (binding.name !== "CACHE") {
          invalidBindings.push(`${binding.name} (${binding.type})`);
        }
        break;
      case "r2_bucket":
        if (binding.name !== "FILES") {
          invalidBindings.push(`${binding.name} (${binding.type})`);
        }
        break;
      case "secret_text":
        invalidBindings.push(`${binding.name} (${binding.type})`);
        break;
      case "ai":
        if (binding.name !== "AI" || !policy.aiEnabled) {
          invalidBindings.push(`${binding.name} (${binding.type})`);
        }
        break;
      case "vectorize":
        if (binding.name !== "VECTORIZE" || !policy.vectorizeEnabled) {
          invalidBindings.push(`${binding.name} (${binding.type})`);
        }
        break;
      case "durable_object_namespace":
        if (binding.name !== "ROOMS" || !policy.roomsEnabled) {
          invalidBindings.push(`${binding.name} (${binding.type})`);
        }
        break;
      default:
        invalidBindings.push(`${binding.name} (${binding.type})`);
        break;
    }
  }

  if (invalidBindings.length > 0) {
    throw new HttpError(
      403,
      `This deployment requests bindings that Kale Deploy does not allow by default: ${invalidBindings.join(", ")}. FILES and CACHE are supported only as the standard per-project bindings, while AI, Vectorize, and Rooms still require approval.`
    );
  }
}

function assertDeploymentUploadWithinLimit(
  metadata: DeploymentMetadata,
  files: Array<{ name: string; file: File }>,
  maxAssetBytes: number
): void {
  if (files.length === 0) {
    return;
  }

  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata)).byteLength;
  const totalBytes = files.reduce((sum, entry) => sum + entry.file.size, metadataBytes);

  if (totalBytes > maxAssetBytes) {
    throw new HttpError(
      413,
      `This deployment bundle is too large for Kale Deploy (${formatBytes(totalBytes)} uploaded, limit ${formatBytes(maxAssetBytes)}). This cap keeps the current deploy upload within Cloudflare's request envelope with room for multipart overhead.`
    );
  }
}

function createDeploymentArchiveManifest(
  metadata: DeploymentMetadata,
  workerFiles: Array<{ name: string; file: File }>,
  staticAssets: StaticAssetUpload | undefined,
  options?: { jobId?: string; headSha?: string }
) {
  return {
    jobId: options?.jobId,
    headSha: options?.headSha,
    workerFiles: workerFiles.map((entry) => ({
      name: entry.name,
      size: entry.file.size,
      contentType: entry.file.type || null
    })),
    staticAssets: staticAssets?.files ?? [],
    metadata
  };
}

async function tryArchiveSuccessfulDeployment(
  env: Env,
  artifactPrefix: string,
  manifest: ReturnType<typeof createDeploymentArchiveManifest>,
  workerFiles: Array<{ name: string; file: File }>,
  staticAssets: StaticAssetUpload | undefined,
  allFiles: Array<{ name: string; file: File }>
): Promise<DeploymentArchiveResult> {
  const manifestKey = `${artifactPrefix}/manifest.json`;

  try {
    await archiveDeploymentFiles(env, artifactPrefix, workerFiles, staticAssets, allFiles);
    await putArchiveManifest(env, manifestKey, manifest);
    return { archiveKind: "full", manifestKey };
  } catch (error) {
    console.error("Failed to archive full deployment bundle.", error);
    return tryArchiveDeploymentManifest(env, artifactPrefix, manifest);
  }
}

async function tryArchiveDeploymentManifest(
  env: Env,
  artifactPrefix: string,
  manifest: ReturnType<typeof createDeploymentArchiveManifest>
): Promise<DeploymentArchiveResult> {
  const manifestKey = `${artifactPrefix}/manifest.json`;

  try {
    await putArchiveManifest(env, manifestKey, manifest);
    return { archiveKind: "manifest", manifestKey };
  } catch (error) {
    console.error("Failed to archive deployment manifest.", error);
    return { archiveKind: "none" };
  }
}

async function archiveDeploymentFiles(
  env: Env,
  artifactPrefix: string,
  workerFiles: Array<{ name: string; file: File }>,
  staticAssets: StaticAssetUpload | undefined,
  allFiles: Array<{ name: string; file: File }>
): Promise<void> {
  const staticAssetPartNames = new Set(staticAssets?.files.map((entry) => entry.partName) ?? []);

  for (const entry of workerFiles) {
    await env.DEPLOYMENT_ARCHIVE.put(`${artifactPrefix}/worker/${sanitizeArtifactPath(entry.name)}`, entry.file, {
      httpMetadata: entry.file.type ? { contentType: entry.file.type } : undefined
    });
  }

  for (const entry of allFiles.filter((file) => staticAssetPartNames.has(file.name))) {
    const descriptor = staticAssets?.files.find((asset) => asset.partName === entry.name);
    await env.DEPLOYMENT_ARCHIVE.put(
      `${artifactPrefix}/assets/${sanitizeArtifactPath(descriptor?.path ?? entry.name)}`,
      entry.file,
      {
        httpMetadata: (descriptor?.contentType || entry.file.type)
          ? { contentType: descriptor?.contentType || entry.file.type }
          : undefined
      }
    );
  }
}

async function putArchiveManifest(
  env: Env,
  manifestKey: string,
  manifest: ReturnType<typeof createDeploymentArchiveManifest>
): Promise<void> {
  await env.DEPLOYMENT_ARCHIVE.put(manifestKey, JSON.stringify(manifest, null, 2), {
    httpMetadata: { contentType: "application/json" }
  });
}

async function enforceArtifactRetentionPolicy(env: Env, projectName: string): Promise<void> {
  try {
    await pruneOlderSuccessfulArtifacts(env, projectName);
    await cleanupExpiredFailedArtifacts(env);
  } catch (error) {
    console.error("Artifact retention cleanup failed.", error);
  }
}

async function pruneOlderSuccessfulArtifacts(env: Env, projectName: string): Promise<void> {
  const retained = await listRetainedSuccessfulDeployments(env.CONTROL_PLANE_DB, projectName);
  const keep = parseNonNegativeInteger(env.RETAIN_SUCCESSFUL_ARTIFACTS, DEFAULT_SUCCESSFUL_ARTIFACT_RETENTION);

  for (const deployment of retained.slice(keep)) {
    await deleteArtifactPrefix(env.DEPLOYMENT_ARCHIVE, deployment.artifactPrefix);
    await updateDeploymentArchiveState(env.CONTROL_PLANE_DB, deployment.deploymentId, "none");
  }
}

async function cleanupExpiredFailedArtifacts(env: Env): Promise<void> {
  const retentionDays = parseNonNegativeInteger(
    env.FAILED_ARTIFACT_RETENTION_DAYS,
    DEFAULT_FAILED_ARTIFACT_RETENTION_DAYS
  );
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const expired = await listExpiredRetainedFailedDeployments(env.CONTROL_PLANE_DB, cutoff);

  for (const deployment of expired) {
    await deleteArtifactPrefix(env.DEPLOYMENT_ARCHIVE, deployment.artifactPrefix);
    await updateDeploymentArchiveState(env.CONTROL_PLANE_DB, deployment.deploymentId, "none");
  }
}

async function deleteArtifactPrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;

  do {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    const keys = page.objects.map((object) => object.key);

    if (keys.length > 0) {
      await bucket.delete(keys);
    }

    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function updateJobCheckRun(
  env: Env,
  job: BuildJobRecord,
  update: {
    status: "queued" | "in_progress" | "completed";
    conclusion?: GitHubCheckRunConclusion;
    startedAt?: string;
    completedAt?: string;
    detailsUrl?: string;
    output: GitHubCheckRunOutput;
  }
): Promise<void> {
  const github = getGitHubAppClient(env);
  const installationClient = await github.createInstallationClient(job.installationId);
  await installationClient.updateCheckRun({
    owner: job.repository.ownerLogin,
    repo: job.repository.name,
    checkRunId: job.checkRunId,
    status: update.status,
    conclusion: update.conclusion,
    startedAt: update.startedAt,
    completedAt: update.completedAt,
    detailsUrl: update.detailsUrl,
    output: update.output
  });
}

function parseDeploymentMetadata(raw: string): DeploymentMetadata {
  try {
    const value = JSON.parse(raw) as DeploymentMetadata;
    if (!value?.projectName || !value?.ownerLogin || !value?.githubRepo || !value?.workerUpload?.main_module) {
      throw new Error();
    }
    return value;
  } catch {
    throw new HttpError(400, "Deployment metadata is missing required fields.");
  }
}

function parseBuildRunnerResult(raw: string): BuildRunnerCompletePayload {
  try {
    const value = JSON.parse(raw) as BuildRunnerCompletePayload;
    if (value?.status !== "success" && value?.status !== "failure") {
      throw new Error();
    }
    return value;
  } catch {
    throw new HttpError(400, "Build runner result is not valid JSON.");
  }
}

function collectUploadFiles(
  form: FormData,
  ignoredFields: string[]
): Array<{ name: string; file: File }> {
  const ignored = new Set(ignoredFields);
  const files: Array<{ name: string; file: File }> = [];

  for (const [key, value] of form.entries()) {
    if (ignored.has(key)) {
      continue;
    }

    if (value instanceof File) {
      files.push({ name: key, file: value });
    }
  }

  return files;
}

function getWorkerFiles(
  staticAssets: StaticAssetUpload | undefined,
  files: Array<{ name: string; file: File }>
): Array<{ name: string; file: File }> {
  const ignored = new Set(staticAssets?.files.map((entry) => entry.partName) ?? []);
  return files.filter((entry) => !ignored.has(entry.name));
}

function ensureUploadContainsMainModule(
  files: Array<{ name: string; file: File }>,
  mainModule: string
): void {
  if (!files.some((entry) => entry.name === mainModule)) {
    throw new HttpError(400, `Upload is missing the main module '${mainModule}'.`);
  }
}

async function provisionProjectDatabase(
  client: CloudflareApiClient,
  projectName: string,
  locationHint?: string
): Promise<string> {
  const database = await client.createD1Database(
    buildProjectScopedResourceName("cail", projectName, MAX_PROJECT_NAME_LENGTH),
    locationHint
  );
  return database.uuid;
}

async function resolveProjectResources(
  client: CloudflareApiClient,
  metadata: DeploymentMetadata,
  repositoryRecord: ProjectRecord | null,
  locationHint?: string
): Promise<{
  databaseId: string;
  filesBucketName?: string;
  cacheNamespaceId?: string;
}> {
  const databaseId = await resolveProjectDatabaseId(client, {
    projectName: metadata.projectName,
    existingDatabaseId: repositoryRecord?.databaseId,
    locationHint
  });

  const filesBucketName = requestsBinding(metadata, "r2_bucket", "FILES")
    ? await resolveProjectFilesBucketName(client, {
        projectName: metadata.projectName,
        existingBucketName: repositoryRecord?.filesBucketName
      })
    : undefined;

  const cacheNamespaceId = requestsBinding(metadata, "kv_namespace", "CACHE")
    ? await resolveProjectCacheNamespaceId(client, {
        projectName: metadata.projectName,
        existingNamespaceId: repositoryRecord?.cacheNamespaceId
      })
    : undefined;

  return { databaseId, filesBucketName, cacheNamespaceId };
}

async function resolveProjectDatabaseId(
  client: CloudflareApiClient,
  options: {
    projectName: string;
    existingDatabaseId?: string;
    locationHint?: string;
  }
): Promise<string> {
  if (options.existingDatabaseId) {
    return options.existingDatabaseId;
  }

  const databaseName = buildProjectScopedResourceName("cail", options.projectName, MAX_PROJECT_NAME_LENGTH);
  const existingDatabase = await client.findD1DatabaseByName(databaseName);
  if (existingDatabase) {
    return existingDatabase.uuid;
  }

  return await provisionProjectDatabase(client, options.projectName, options.locationHint);
}

async function resolveProjectCacheNamespaceId(
  client: CloudflareApiClient,
  options: {
    projectName: string;
    existingNamespaceId?: string;
  }
): Promise<string> {
  if (options.existingNamespaceId) {
    return options.existingNamespaceId;
  }

  const title = buildProjectScopedResourceName("kale-cache", options.projectName, 63);
  const existingNamespace = await client.findKvNamespaceByTitle(title);
  if (existingNamespace) {
    return existingNamespace.id;
  }

  const namespace = await client.createKvNamespace(title);
  return namespace.id;
}

async function resolveProjectFilesBucketName(
  client: CloudflareApiClient,
  options: {
    projectName: string;
    existingBucketName?: string;
  }
): Promise<string> {
  if (options.existingBucketName) {
    return options.existingBucketName;
  }

  const bucketName = buildProjectScopedResourceName("kale-files", options.projectName, 63);
  const existingBucket = await client.findR2BucketByName(bucketName);
  if (existingBucket) {
    return existingBucket.name;
  }

  const bucket = await client.createR2Bucket(bucketName);
  return bucket.name;
}

function buildProjectScopedResourceName(prefix: string, projectName: string, maxLength: number): string {
  const candidate = `${prefix}-${projectName}`;
  if (candidate.length <= maxLength) {
    return candidate;
  }

  const hash = stableProjectHash(projectName);
  const availableProjectChars = Math.max(8, maxLength - prefix.length - hash.length - 2);
  const trimmedProject = projectName.slice(0, availableProjectChars).replace(/-+$/u, "");
  return `${prefix}-${trimmedProject}-${hash}`;
}

function stableProjectHash(value: string): string {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}

function requestsBinding(
  metadata: DeploymentMetadata,
  type: WorkerBinding["type"],
  name: string
): boolean {
  return (metadata.workerUpload.bindings ?? []).some((binding) => binding.type === type && binding.name === name);
}

function withProjectBindings(
  metadata: DeploymentMetadata,
  databaseId: string,
  options: {
    filesBucketName?: string;
    cacheNamespaceId?: string;
    secretBindings?: WorkerBinding[];
    existingHasAssets: boolean;
    staticAssetsJwt?: string;
    staticAssetsConfig?: WorkerAssetsConfig;
  }
) {
  const existingBindings = metadata.workerUpload.bindings ?? [];
  let mergedBindings = upsertBinding(existingBindings, {
    type: "d1",
    name: "DB",
    id: databaseId
  });

  if (options.cacheNamespaceId) {
    mergedBindings = upsertBinding(mergedBindings, {
      type: "kv_namespace",
      name: "CACHE",
      namespace_id: options.cacheNamespaceId
    });
  }

  if (options.filesBucketName) {
    mergedBindings = upsertBinding(mergedBindings, {
      type: "r2_bucket",
      name: "FILES",
      bucket_name: options.filesBucketName
    });
  }

  for (const secretBinding of options.secretBindings ?? []) {
    mergedBindings = upsertBinding(mergedBindings, secretBinding);
  }

  const nextUpload = {
    ...metadata.workerUpload,
    bindings: mergedBindings,
    observability: metadata.workerUpload.observability ?? { enabled: true }
  };

  if (options.staticAssetsJwt) {
    return {
      ...nextUpload,
      keep_assets: false,
      assets: {
        jwt: options.staticAssetsJwt,
        ...(options.staticAssetsConfig ? { config: options.staticAssetsConfig } : {})
      }
    };
  }

  if (options.existingHasAssets) {
    return {
      ...nextUpload,
      keep_assets: true
    };
  }

  return nextUpload;
}

function upsertBinding(bindings: WorkerBinding[], nextBinding: WorkerBinding): WorkerBinding[] {
  const filtered = bindings.filter((binding) => binding.name !== nextBinding.name);
  filtered.push(nextBinding);
  return filtered;
}

function getGitHubAppClient(env: Env): GitHubAppClient {
  const appId = resolveGitHubAppId(env);
  const privateKey = resolveConfiguredEnvValue(env.GITHUB_APP_PRIVATE_KEY);

  if (!appId || !privateKey) {
    throw new HttpError(500, "Missing GitHub App configuration.");
  }

  return new GitHubAppClient({
    appId,
    privateKey,
    apiBaseUrl: env.GITHUB_API_BASE_URL
  });
}

function toRepositoryRecord(payload: PushWebhookPayload): GitHubRepositoryRecord {
  return {
    id: payload.repository.id,
    ownerLogin: payload.repository.owner.login,
    name: payload.repository.name,
    fullName: payload.repository.full_name,
    defaultBranch: payload.repository.default_branch,
    htmlUrl: payload.repository.html_url,
    cloneUrl: payload.repository.clone_url,
    private: payload.repository.private
  };
}

function assertPushWebhookPayload(payload: PushWebhookPayload): void {
  if (
    !payload?.ref ||
    !payload.after ||
    !payload.before ||
    !payload.repository?.name ||
    !payload.repository.full_name ||
    !payload.repository.default_branch ||
    !payload.repository.owner?.login
  ) {
    throw new HttpError(400, "Malformed GitHub push webhook payload.");
  }
}

function checkRunOutput(title: string, summary: string, text?: string): GitHubCheckRunOutput {
  return { title, summary, text };
}

function failureTitle(
  eventName: BuildJobEventName,
  failureKind: BuildRunnerCompletePayload["failureKind"] | undefined,
  conclusion: GitHubCheckRunConclusion
): string {
  if (failureKind === "unsupported") {
    return "Unsupported on CAIL";
  }

  if (failureKind === "needs_adaptation" || conclusion === "action_required") {
    return "Needs adaptation for CAIL";
  }

  return eventName === "validate" ? "Validation failed" : "Deployment failed";
}

function defaultJobStartSummary(eventName: BuildJobEventName): string {
  return eventName === "validate"
    ? "CAIL Validate picked up this ref on the managed build runner."
    : "CAIL Deploy picked up this commit on the managed build runner.";
}

function normalizeStaticAssets(
  staticAssets: StaticAssetUpload | undefined,
  projectName: string
): StaticAssetUpload | undefined {
  if (!staticAssets) {
    return undefined;
  }

  return {
    ...staticAssets,
    isolationKey: staticAssets.isolationKey ?? projectName
  };
}

function suggestProjectName(repositoryName: string, reservedProjectNames?: Iterable<string>): string {
  const normalized = repositoryName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 40)
    .replace(/-+$/g, "");

  const reserved = new Set(reservedProjectNames ?? []);
  const candidate = normalized || `project-${crypto.randomUUID().slice(0, 8)}`;
  if (!reserved.has(candidate)) {
    return candidate;
  }

  return appendProjectSuffix(candidate, "app");
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = parseNonNegativeInteger(value, fallback);
  return parsed > 0 ? parsed : fallback;
}

function sanitizeArtifactPath(path: string): string {
  return path.replace(/^\/+/, "");
}

function stripGitRef(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

function isDeletedCommit(sha: string): boolean {
  return /^0+$/.test(sha);
}

function isCompletedJob(job: BuildJobRecord): boolean {
  return job.status === "success" || job.status === "failure";
}

function isAuthorized(request: Request, expectedToken: string | undefined): boolean {
  if (!expectedToken) {
    return false;
  }

  return readBearerToken(request) === expectedToken;
}

async function requireAgentRequestIdentity(request: Request, env: Env): Promise<AgentRequestIdentity> {
  if (resolveAccessConfigFromEnv(env)) {
    return requireCloudflareAccessIdentity(request, env);
  }

  return {
    type: "anonymous",
    subject: "anonymous"
  };
}

async function requireMcpRequestIdentity(request: Request, env: Env): Promise<AuthenticatedAgentRequestIdentity> {
  const secret = resolveMcpOauthSecret(env);
  const bearerToken = readBearerToken(request);
  if (!bearerToken) {
    throw new HttpError(401, "Missing Bearer token.");
  }

  const payload = await verifyMcpAccessToken({
    token: bearerToken,
    secret,
    issuer: resolveMcpOauthBaseUrl(env, request.url)
  });

  return {
    type: "mcp_oauth",
    email: payload.email,
    subject: payload.subject
  };
}

async function requireCloudflareAccessIdentity(request: Request, env: Env): Promise<CloudflareAccessRequestIdentity> {
  const accessConfig = resolveAccessConfigFromEnv(env);
  if (!accessConfig) {
    throw new HttpError(503, "Cloudflare Access auth is not configured on this deployment.");
  }

  try {
    const identity = await verifyCloudflareAccessRequest(request, accessConfig);
    return {
      type: "cloudflare_access",
      email: identity.email,
      subject: identity.subject
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unauthorized.";
    if (message.includes("not allowed")) {
      throw new HttpError(403, message);
    }

    throw new HttpError(401, message);
  }
}

function resolveAccessConfigFromEnv(env: Env) {
  return resolveCloudflareAccessConfig({
    teamDomain: env.CLOUDFLARE_ACCESS_TEAM_DOMAIN,
    audience: env.CLOUDFLARE_ACCESS_AUD,
    allowedEmails: env.CLOUDFLARE_ACCESS_ALLOWED_EMAILS,
    allowedEmailDomains: env.CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS
  });
}

function resolveMcpOauthSecret(env: Env): string {
  const secret = resolveConfiguredEnvValue(env.MCP_OAUTH_TOKEN_SECRET);
  if (!secret) {
    throw new HttpError(503, "MCP OAuth is not configured on this deployment.");
  }

  return secret;
}

function resolveMcpOauthBaseUrl(env: Env, requestUrl: string): string {
  return resolveConfiguredEnvValue(env.MCP_OAUTH_BASE_URL)?.replace(/\/$/, "") ?? resolveServiceBaseUrl(env, requestUrl);
}

function buildOauthProtectedResourceMetadata(serviceBaseUrl: string, oauthBaseUrl: string) {
  return {
    resource: `${serviceBaseUrl}/mcp`,
    authorization_servers: [oauthBaseUrl],
    scopes_supported: [MCP_REQUIRED_SCOPE],
    resource_name: "CAIL Deploy MCP",
    resource_documentation: serviceBaseUrl
  };
}

function buildOauthAuthorizationServerMetadata(oauthBaseUrl: string, serviceDocumentationUrl: string) {
  return {
    issuer: oauthBaseUrl,
    authorization_endpoint: `${oauthBaseUrl}/api/oauth/authorize`,
    token_endpoint: `${oauthBaseUrl}/oauth/token`,
    registration_endpoint: `${oauthBaseUrl}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [MCP_REQUIRED_SCOPE],
    service_documentation: serviceDocumentationUrl
  };
}

function serveOauthProtectedResourceMetadata(c: Context<{ Bindings: Env }>) {
  const serviceBaseUrl = resolveServiceBaseUrl(c.env, c.req.raw.url);
  const oauthBaseUrl = resolveMcpOauthBaseUrl(c.env, c.req.raw.url);
  return c.json(buildOauthProtectedResourceMetadata(serviceBaseUrl, oauthBaseUrl), 200, {
    "cache-control": "public, max-age=300"
  });
}

function serveOauthAuthorizationServerMetadata(c: Context<{ Bindings: Env }>) {
  const serviceBaseUrl = resolveServiceBaseUrl(c.env, c.req.raw.url);
  const oauthBaseUrl = resolveMcpOauthBaseUrl(c.env, c.req.raw.url);
  return c.json(buildOauthAuthorizationServerMetadata(oauthBaseUrl, serviceBaseUrl), 200, {
    "cache-control": "public, max-age=300"
  });
}

function oauthUnauthorizedResponse(c: Context<{ Bindings: Env }>, env: Env): Response {
  const serviceBaseUrl = resolveServiceBaseUrl(env, c.req.raw.url);
  const resourceMetadataUrl = `${serviceBaseUrl}/.well-known/oauth-protected-resource/mcp`;
  return c.json(
    {
      error: "invalid_token",
      error_description: "A valid MCP OAuth access token is required."
    },
    401,
    {
      "WWW-Authenticate": `Bearer error="invalid_token", error_description="A valid MCP OAuth access token is required.", resource_metadata="${resourceMetadataUrl}"`
    }
  );
}

function protectedAgentApiAuthErrorResponse(
  c: Context<{ Bindings: Env }>,
  env: Env,
  error: HttpError
): Response {
  if (error.status !== 401 && error.status !== 403) {
    return c.json({ error: error.message }, { status: error.status });
  }

  const serviceBaseUrl = resolveServiceBaseUrl(env, c.req.raw.url);
  return c.json(buildProtectedAgentApiAuthErrorPayload(env, serviceBaseUrl, error), { status: error.status });
}

function buildProtectedAgentApiAuthErrorPayload(env: Env, serviceBaseUrl: string, error: HttpError) {
  const connection = buildConnectionHealthPayload(env, serviceBaseUrl);
  const notAllowed = error.status === 403;

  return {
    error: error.message,
    summary: notAllowed
      ? "Kale Deploy reached the institutional login layer, but this identity is not allowed to use the protected agent API."
      : "Kale Deploy is reachable, but this request is not authenticated yet.",
    nextAction: notAllowed ? "sign_in_with_allowed_cuny_email" : "complete_browser_login",
    mcpEndpoint: connection.mcpEndpoint,
    connectionHealthUrl: connection.connectionHealthUrl,
    oauthProtectedResourceMetadata: connection.oauthProtectedResourceMetadata,
    oauthAuthorizationMetadata: connection.oauthAuthorizationMetadata,
    authorizationUrl: connection.authorizationUrl
  };
}

function buildConnectionHealthPayload(env: Env, serviceBaseUrl: string, identity?: AgentRequestIdentity) {
  const oauthBaseUrl = resolveMcpOauthBaseUrl(env, serviceBaseUrl);
  const appSlug = resolveGitHubAppSlug(env);
  const appName = resolveGitHubAppName(env);
  const authenticated = Boolean(identity && identity.type !== "anonymous");

  return {
    ok: true,
    serviceName: "Kale Deploy",
    connectionHealthUrl: `${serviceBaseUrl}/.well-known/kale-connection.json`,
    mcpEndpoint: `${serviceBaseUrl}/mcp`,
    oauthProtectedResourceMetadata: `${serviceBaseUrl}/.well-known/oauth-protected-resource/mcp`,
    oauthAuthorizationMetadata: `${oauthBaseUrl}/.well-known/oauth-authorization-server`,
    authorizationUrl: `${oauthBaseUrl}/api/oauth/authorize`,
    githubAppName: appName,
    githubAppInstallUrl: appSlug ? githubAppInstallUrl(appSlug) : undefined,
    authenticated,
    identityType: identity?.type,
    email: identity && "email" in identity ? identity.email : undefined,
    nextAction: authenticated ? "register_project" : "connect_mcp_or_complete_browser_login",
    deploymentTrigger: "github_push_to_default_branch",
    localFolderUploadSupported: false,
    summary: authenticated
      ? "Kale Deploy is connected and authenticated. Register a repository or test a specific repo next."
      : "Kale Deploy is reachable. Connect the MCP endpoint, complete the browser login flow, and then verify the connection before deploying."
  };
}

function getRequiredOauthFormField(form: FormData, field: string): string {
  const value = form.get(field);
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `OAuth request is missing the required '${field}' field.`);
  }

  return value.trim();
}

function renderOauthAuthorizationErrorPage(message: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Kale Deploy Sign-In Error</title>
    ${faviconLink()}
    ${baseStyles("")}
  </head>
  <body>
    <main>
      <section class="card">
        <div class="logo">${logoHtml("44px")}</div>
        <h1>Sign-in could not continue</h1>
        <p>${escapeHtml(message)}</p>
        <p>Go back to your agent and try connecting again.</p>
      </section>
    </main>
  </body>
</html>`;
}

async function createProjectControlFormToken(input: {
  secret: string;
  issuer: string;
  subject: string;
  projectName: string;
}): Promise<string> {
  return new SignJWT({
    project_name: input.projectName
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(input.issuer)
    .setAudience("project-control-form")
    .setSubject(input.subject)
    .setIssuedAt()
    .setExpirationTime("30m")
    .sign(new TextEncoder().encode(input.secret));
}

async function verifyProjectControlFormToken(input: {
  secret: string;
  issuer: string;
  token: string;
  subject: string;
  projectName: string;
}): Promise<void> {
  const { payload } = await jwtVerify(input.token, new TextEncoder().encode(input.secret), {
    issuer: input.issuer,
    audience: "project-control-form",
    subject: input.subject
  });

  if (payload.project_name !== input.projectName) {
    throw new HttpError(403, "This form token does not belong to the current Kale project.");
  }
}

function getRequiredProjectControlFormField(form: FormData, field: string): string {
  const value = form.get(field);
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `Missing required form field '${field}'.`);
  }

  return value.trim();
}

function resolveServiceBaseUrl(env: Env, requestUrl: string): string {
  return env.DEPLOY_SERVICE_BASE_URL?.replace(/\/$/, "") ?? new URL(requestUrl).origin;
}

function resolveGitHubApiBaseUrl(env: Env): string {
  return env.GITHUB_API_BASE_URL?.replace(/\/$/, "") ?? "https://api.github.com";
}

function resolveGitHubAppName(env: Env): string {
  return env.GITHUB_APP_NAME?.trim() || "CAIL Deploy";
}

function resolveGitHubAppId(env: Env): string | undefined {
  return resolveConfiguredEnvValue(env.GITHUB_APP_ID);
}

function resolveGitHubAppSlug(env: Env): string | undefined {
  return resolveConfiguredEnvValue(env.GITHUB_APP_SLUG);
}

function resolveGitHubAppManifestOrg(env: Env): string {
  return env.GITHUB_APP_MANIFEST_ORG?.trim() || "CUNY-AI-Lab";
}

function resolveConfiguredEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || /^REPLACE_WITH_/i.test(trimmed)) {
    return undefined;
  }

  return trimmed;
}

function resolveRequiredCloudflareApiToken(env: Env): string {
  const token = resolveConfiguredEnvValue(env.CLOUDFLARE_API_TOKEN);
  if (!token) {
    throw new HttpError(500, "Missing CLOUDFLARE_API_TOKEN secret.");
  }

  return token;
}

function requireAuthenticatedIdentity(identity: AgentRequestIdentity): AuthenticatedAgentRequestIdentity {
  if (identity.type === "anonymous") {
    throw new HttpError(503, "Kale Deploy needs institutional sign-in before it can evaluate project admin access.");
  }

  return identity;
}

function resolveGitHubUserAuthConfig(
  env: Env,
  serviceBaseUrl: string
): {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  authorizeUrl: string;
} {
  const clientId = resolveConfiguredEnvValue(env.GITHUB_APP_CLIENT_ID);
  const clientSecret = resolveConfiguredEnvValue(env.GITHUB_APP_CLIENT_SECRET);

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

function tryResolveGitHubUserAuthConfig(
  env: Env,
  serviceBaseUrl: string
):
  | {
      clientId: string;
      clientSecret: string;
      callbackUrl: string;
      authorizeUrl: string;
    }
  | null {
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

function resolveControlPlaneEncryptionKey(env: Env): string {
  const secret = resolveConfiguredEnvValue(env.CONTROL_PLANE_ENCRYPTION_KEY);
  if (!secret) {
    throw new HttpError(503, "Encrypted project-admin storage is not configured on this deployment.");
  }

  return secret;
}

async function createGitHubUserAuthStateToken(input: {
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

async function verifyGitHubUserAuthStateToken(input: {
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

function normalizeOptionalGitHubUserAuthReturnTo(
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

async function sealStoredToken(secret: string, plaintext: string): Promise<string> {
  return JSON.stringify(await encryptStoredText(secret, plaintext));
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

function buildGitHubUserAuthorizeUrl(
  config: {
    clientId: string;
    callbackUrl: string;
    authorizeUrl: string;
  },
  state: string
): string {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.callbackUrl);
  url.searchParams.set("state", state);
  return url.toString();
}

function githubAppInstallUrl(appSlug: string): string {
  return `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new`;
}

function githubManifestRegistrationUrl(env: Env): string {
  return `https://github.com/organizations/${encodeURIComponent(resolveGitHubAppManifestOrg(env))}/settings/apps/new`;
}

function buildGitHubAppManifest(env: Env, serviceBaseUrl: string): GitHubAppManifest {
  const appName = resolveGitHubAppName(env);
  const webhookUrl = `${serviceBaseUrl}/github/webhook`;
  const setupUrl = `${serviceBaseUrl}/github/setup`;
  const redirectUrl = `${serviceBaseUrl}/github/manifest/callback`;
  const callbackUrl = `${serviceBaseUrl}/github/user-auth/callback`;

  return {
    name: appName,
    description: "GitHub-first deployment for CUNY AI Lab projects on Cloudflare Workers.",
    url: serviceBaseUrl,
    hook_attributes: {
      url: webhookUrl,
      active: true
    },
    redirect_url: redirectUrl,
    callback_urls: [callbackUrl],
    setup_url: setupUrl,
    public: true,
    default_events: ["push"],
    default_permissions: {
      checks: "write",
      contents: "read",
      metadata: "read"
    },
    request_oauth_on_install: false,
    setup_on_update: true
  };
}

function renderManifestSuccessPage(env: Env, serviceBaseUrl: string, registration: GitHubManifestConversion): string {
  const appName = registration.name ?? resolveGitHubAppName(env);
  const appId = String(registration.id);
  const appSlug = registration.slug;
  const installUrl = appSlug ? githubAppInstallUrl(appSlug) : undefined;
  const appUrl = registration.html_url;
  const ownerLogin = registration.owner?.login ?? resolveGitHubAppManifestOrg(env);
  const envSnippet = [
    `GITHUB_APP_ID=${appId}`,
    `GITHUB_APP_SLUG=${appSlug}`,
    `GITHUB_APP_NAME=${appName}`,
    registration.webhook_secret ? `GITHUB_WEBHOOK_SECRET=${registration.webhook_secret}` : ""
  ]
    .filter(Boolean)
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(appName)} Registered</title>
    ${faviconLink()}
    ${baseStyles(`
      :root { --accent: var(--success); --accent-hover: #157332; }
      .notice { background: #edf7f0; border-color: #b8dcc4; }
    `)}
  </head>
  <body>
    <main>
      <section class="card">
        <div class="logo">${logoHtml("44px")}</div>
        <h1>${escapeHtml(appName)} Registered</h1>
        <p>Copy these values into Cloudflare before you leave. GitHub only returns the private key PEM once.</p>
        <div class="actions">
          ${installUrl ? `<a class="button" href="${escapeHtml(installUrl)}">Install the GitHub App</a>` : ""}
          ${appUrl ? `<a class="button secondary" href="${escapeHtml(appUrl)}">Open the app in GitHub</a>` : ""}
          <a class="button secondary" href="${escapeHtml(`${serviceBaseUrl}/github/setup`)}">Back to setup</a>
        </div>
        <div class="notice">
          <p><strong>Next:</strong> put <code>GITHUB_APP_PRIVATE_KEY</code> and <code>GITHUB_WEBHOOK_SECRET</code> into Wrangler secrets, set <code>GITHUB_APP_ID</code> and <code>GITHUB_APP_SLUG</code> in Worker vars, and redeploy the deploy service.</p>
        </div>
        <h2>Worker vars</h2>
        <textarea readonly>${escapeHtml(envSnippet)}</textarea>
        <h2>Private key</h2>
        <textarea readonly>${escapeHtml(registration.pem ?? "GitHub did not return a PEM in the manifest conversion response.")}</textarea>
        <h2>Suggested next commands</h2>
        <textarea readonly>${escapeHtml(`npx wrangler secret put GITHUB_APP_PRIVATE_KEY --config packages/deploy-service/wrangler.jsonc
npx wrangler secret put GITHUB_WEBHOOK_SECRET --config packages/deploy-service/wrangler.jsonc
npx wrangler deploy --config packages/deploy-service/wrangler.jsonc`)}</textarea>
        <h2>What to verify</h2>
        <ol>
          <li>Open <code>${escapeHtml(`${serviceBaseUrl}/github/app`)}</code> and confirm the app ID and slug are now populated.</li>
          <li>Install the app on a test repository.</li>
          <li>Push to <code>main</code> and watch the GitHub check run.</li>
        </ol>
      </section>
    </main>
  </body>
</html>`;
}

function renderManifestErrorPage(appName: string, message: string, serviceBaseUrl: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(appName)} Registration Error</title>
    ${faviconLink()}
    ${baseStyles(`
      :root { --accent: var(--error); --accent-hover: #a82c18; }
    `)}
  </head>
  <body>
    <main>
      <section class="card">
        <div class="logo">${logoHtml("44px")}</div>
        <h1>${escapeHtml(appName)} Registration Error</h1>
        <p>${escapeHtml(message)}</p>
        <div class="actions">
          <a class="button" href="${escapeHtml(`${serviceBaseUrl}/github/register`)}">Start the manifest flow again</a>
          <a class="button secondary" href="${escapeHtml(`${serviceBaseUrl}/github/setup`)}">Back to setup</a>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }

  if (value < 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function isValidProjectName(projectName: string): boolean {
  return projectName.length <= MAX_PROJECT_NAME_LENGTH
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(projectName);
}

function assertAllowedProjectName(
  projectName: string,
  env: Pick<Env, "PROJECT_HOST_SUFFIX" | "DEPLOY_SERVICE_BASE_URL">,
  serviceBaseUrl?: string
): void {
  if (!isValidProjectName(projectName)) {
    throw new HttpError(400, `Project names must be lowercase kebab-case and no longer than ${MAX_PROJECT_NAME_LENGTH} characters.`);
  }

  if (resolveReservedProjectNames(env, serviceBaseUrl).has(projectName)) {
    throw new HttpError(409, `Project name '${projectName}' is reserved for platform use.`);
  }
}

function parseCookieHeader(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();

  if (!header) {
    return cookies;
  }

  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex);
    const value = trimmed.slice(separatorIndex + 1);
    cookies.set(key, decodeURIComponent(value));
  }

  return cookies;
}

function serializeCookie(
  name: string,
  value: string,
  options: {
    httpOnly?: boolean;
    maxAge?: number;
    path?: string;
    sameSite?: "Lax" | "Strict" | "None";
    secure?: boolean;
  }
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }

  if (options.path) {
    parts.push(`Path=${options.path}`);
  }

  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }

  if (options.secure) {
    parts.push("Secure");
  }

  if (options.httpOnly) {
    parts.push("HttpOnly");
  }

  return parts.join("; ");
}

export default {
  fetch(request: Request, env: Env, executionCtx: ExecutionContext) {
    return deployServiceApp.fetch(normalizeWorkerRequest(request, resolveBasePath(env.DEPLOY_SERVICE_BASE_URL)), env, executionCtx);
  }
};

function resolveBasePath(baseUrl: string | undefined): string {
  if (!baseUrl) {
    return "";
  }

  const pathname = new URL(baseUrl).pathname.replace(/\/$/, "");
  return pathname === "/" ? "" : pathname;
}

function resolveCookiePath(baseUrl: string | undefined): string {
  const basePath = resolveBasePath(baseUrl);
  return basePath || "/";
}

function normalizeWorkerRequest(request: Request, basePath: string): Request {
  if (!basePath) {
    return request;
  }

  const url = new URL(request.url);
  if (url.pathname === basePath) {
    url.pathname = "/";
    return new Request(url.toString(), request);
  }

  if (url.pathname.startsWith(`${basePath}/`)) {
    url.pathname = url.pathname.slice(basePath.length) || "/";
    return new Request(url.toString(), request);
  }

  return request;
}

function buildRuntimeManifest(env: Env, serviceBaseUrl: string) {
  const publicRuntimeUrl = resolvePublicRuntimeManifestUrl(env, serviceBaseUrl);
  const reservedProjectNames = Array.from(resolveReservedProjectNames(env, serviceBaseUrl)).sort();
  const oauthBaseUrl = resolveMcpOauthBaseUrl(env, serviceBaseUrl);
  const oauthAuthorizationMetadataUrl = `${oauthBaseUrl}/.well-known/oauth-authorization-server`;
  const oauthProtectedResourceMetadataUrl = `${serviceBaseUrl}/.well-known/oauth-protected-resource/mcp`;
  return {
    name: "cail-runtime",
    version: 1,
    provider: "cloudflare",
    deployment_model: "workers-for-platforms",
    build_surface: "github",
    build_execution: "cail-owned-runner",
    build_queue: "cloudflare-queues",
    control_plane_store: "d1",
    artifact_archive: "r2",
    public_base_url: resolveProjectPublicBaseUrl(env),
    install_base_url: serviceBaseUrl,
    well_known_runtime_url: publicRuntimeUrl,
    project_url_template: exampleProjectDeploymentUrl(env),
    project_name_pattern: `^(?=.{1,${MAX_PROJECT_NAME_LENGTH}}$)[a-z0-9]+(?:-[a-z0-9]+)*$`,
    reserved_project_names: reservedProjectNames,
    recommended_framework: "hono",
    good_fit_project_types: [
      "exhibit-site",
      "course-site",
      "guestbook-or-form",
      "small-api",
      "archive-or-bibliography"
    ],
    approval_required_project_types: [
      "lightweight-ai-interface",
      "vector-search",
      "realtime-room"
    ],
    default_limits: {
      max_validations_per_day: DEFAULT_PROJECT_POLICY.maxValidationsPerDay || null,
      max_deployments_per_day: DEFAULT_PROJECT_POLICY.maxDeploymentsPerDay || null,
      max_concurrent_builds: DEFAULT_PROJECT_POLICY.maxConcurrentBuilds,
      max_asset_bytes: DEFAULT_PROJECT_POLICY.maxAssetBytes
    },
    limit_rationale: {
      max_validations_per_day: "Not capped by default. Set only as an abuse-control override for a specific repository.",
      max_deployments_per_day: "Not capped by default. Set only as an abuse-control override for a specific repository.",
      max_concurrent_builds: "Limited because builds run on a shared Kale-owned runner.",
      max_asset_bytes: "Limited because Kale Deploy currently receives each build artifact as one multipart upload and must stay within Cloudflare request-body limits with headroom for Worker code and metadata."
    },
    approval_required_bindings: [
      "AI",
      "VECTORIZE",
      "ROOMS"
    ],
    self_service_bindings: [
      "DB",
      "FILES",
      "CACHE"
    ],
    binding_rationale: {
      DB: "Self-service because Kale already provisions one D1 database per project.",
      FILES: "Self-service because Kale provisions one isolated R2 bucket per project when the repository requests FILES.",
      CACHE: "Self-service because Kale provisions one isolated KV namespace per project when the repository requests CACHE.",
      AI: "Approval-only because model usage is directly billable.",
      VECTORIZE: "Approval-only because vector storage and queries are directly billable.",
      ROOMS: "Approval-only because realtime state creates an always-on shared backend surface that needs moderation."
    },
    languages: ["typescript", "javascript"],
    local_preflight: {
      commands: [
        "npm run check",
        "npx wrangler dev"
      ],
      notes: [
        "Run npm run check before every push.",
        "Use wrangler dev for Worker-shaped runtime testing before GitHub deployment."
      ]
    },
    deployment_ready_repository: {
      required_files: [
        "package.json",
        "wrangler.jsonc",
        "src/index.ts",
        "AGENTS.md"
      ],
      expected_routes: ["/", "/api/health"],
      required_scripts: ["check", "dev"],
      must_not_include: [
        "app.listen(...)",
        "python-runtime",
        "native-node-modules",
        "filesystem-backed-runtime-state"
      ]
    },
    agent_api: {
      runtime_manifest: publicRuntimeUrl,
      mcp_endpoint: `${serviceBaseUrl}/mcp`,
      connection_health: `${serviceBaseUrl}/.well-known/kale-connection.json`,
      oauth_authorization_metadata: oauthAuthorizationMetadataUrl,
      oauth_protected_resource_metadata: oauthProtectedResourceMetadataUrl,
      repository_status_template: `${serviceBaseUrl}/api/repositories/{owner}/{repo}/status`,
      register_project: `${serviceBaseUrl}/api/projects/register`,
      validate_project: `${serviceBaseUrl}/api/validate`,
      build_job_status_template: `${serviceBaseUrl}/api/build-jobs/{jobId}/status`,
      project_status_template: `${serviceBaseUrl}/api/projects/{projectName}/status`,
      project_secrets_template: `${serviceBaseUrl}/api/projects/{projectName}/secrets`,
      github_install: `${serviceBaseUrl}/github/install`,
      github_setup: `${serviceBaseUrl}/github/setup`,
      auth: {
        scheme: "oauth2.1",
        broker: "mcp_oauth_with_cloudflare_access_authorization",
        headless_bootstrap_supported: false,
        browser_session_required_for_authorization: true,
        human_handoff_rules: [
          "If register_project or get_repository_status returns guidedInstallUrl, stop and give that URL to the user.",
          "GitHub repository approval is still a browser step for the user, even when the rest of the loop is agent-driven.",
          "Project secret management may ask the user to confirm their GitHub account separately, because secret changes require repo write/admin access."
        ],
        required_for: [
          "repository_status_template",
          "register_project",
          "validate_project",
          "project_status_template",
          "build_job_status_template",
          "project_secrets_template"
        ]
      }
    },
    mcp: {
      transport: "streamable_http",
      endpoint: `${serviceBaseUrl}/mcp`,
      auth: {
        scheme: "oauth2.1",
        authorization_metadata_url: oauthAuthorizationMetadataUrl,
        protected_resource_metadata_url: oauthProtectedResourceMetadataUrl,
        dynamic_client_registration_endpoint: `${oauthBaseUrl}/oauth/register`,
        browser_login_url: `${oauthBaseUrl}/api/oauth/authorize`
      },
      tools: [
        "get_runtime_manifest",
        "test_connection",
        "get_repository_status",
        "register_project",
        "validate_project",
        "get_project_status",
        "get_build_job_status",
        "list_project_secrets",
        "set_project_secret",
        "delete_project_secret"
      ]
    },
    disallowed: [
      "python",
      "native-node-modules",
      "long-running-cpu-bound-jobs",
      "traditional-node-server-processes",
      "filesystem-backed-runtime-state"
    ],
    bindings: [
      { name: "DB", type: "d1", required: true, scope: "per-project", enabled_by_default: true },
      { name: "FILES", type: "r2", required: false, scope: "per-project", enabled_by_default: true, self_service: true },
      { name: "CACHE", type: "kv", required: false, scope: "per-project", enabled_by_default: true, self_service: true },
      { name: "AI", type: "ai", required: false, scope: "shared", enabled_by_default: false, approval_required: true },
      { name: "VECTORIZE", type: "vectorize", required: false, scope: "shared-or-per-project", enabled_by_default: false, approval_required: true },
      { name: "ROOMS", type: "durable_object_namespace", required: false, scope: "shared", enabled_by_default: false, approval_required: true }
    ]
  };
}

function createDeployServiceMcpServer(
  env: Env,
  requestUrl: string,
  identity: AgentRequestIdentity
): McpServer {
  const serviceBaseUrl = resolveServiceBaseUrl(env, requestUrl);
  const server = new McpServer(
    {
      name: "cail-deploy",
      version: "0.1.0"
    },
    {
      instructions: [
        "Use register_project to determine the canonical slug and guided GitHub install URL.",
        "Use validate_project for a build-only check before asking the user to go live.",
        "If guidedInstallUrl is present, the next step still requires a human browser handoff to GitHub.",
        "CAIL Deploy uses standard MCP OAuth on /mcp; let your harness open the browser login flow automatically.",
        "Only use the GitHub user-authorization step when managing sensitive project-admin features such as secrets."
      ].join(" "),
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator()
    }
  );

  server.registerTool(
    "get_runtime_manifest",
    {
      title: "Get runtime manifest",
      description: "Return the current CAIL Deploy runtime manifest, including the agent API and MCP endpoint.",
      inputSchema: {}
    },
    async () =>
      createMcpToolResult(
        "Returned the current CAIL Deploy runtime manifest.",
        buildRuntimeManifest(env, serviceBaseUrl)
      )
  );

  server.registerTool(
    "test_connection",
    {
      title: "Test connection",
      description: "Confirm that Kale Deploy is authenticated and return the next step, optionally for a specific repository.",
      inputSchema: {
        repository: z.string().optional().describe("Optional GitHub repository as owner/repo or a full GitHub URL."),
        projectName: z.string().optional().describe("Optional requested project slug override.")
      }
    },
    async ({ repository, projectName }) => {
      if (repository) {
        const repositoryRef = parseRepositoryInput(repository);
        const lifecycle = await buildRepositoryLifecycleState(env, requestUrl, repositoryRef, projectName);
        return createMcpToolResult(
          `Kale Deploy is connected and authenticated. ${lifecycle.payload.summary}`,
          {
            ...buildConnectionHealthPayload(env, serviceBaseUrl, identity),
            nextAction: lifecycle.payload.nextAction,
            summary: `Kale Deploy is connected and authenticated. ${lifecycle.payload.summary}`,
            repositoryStatus: lifecycle.payload
          }
        );
      }

      return createMcpToolResult(
        "Kale Deploy is connected and authenticated.",
        {
          ...buildConnectionHealthPayload(env, serviceBaseUrl, identity),
          nextAction: "register_project",
          summary: "Kale Deploy is connected and authenticated. Call register_project for the repository you want to deploy next."
        }
      );
    }
  );

  server.registerTool(
    "get_repository_status",
    {
      title: "Get repository status",
      description: "Return the repo-first lifecycle state for a GitHub repository, including slug, install coverage, and next action.",
      inputSchema: {
        repository: z.string().describe("GitHub repository as owner/repo or a full GitHub URL."),
        projectName: z.string().optional().describe("Optional requested project slug override.")
      }
    },
    async ({ repository, projectName }) => {
      const repositoryRef = parseRepositoryInput(repository);
      const lifecycle = await buildRepositoryLifecycleState(env, requestUrl, repositoryRef, projectName);
      return createMcpToolResult(lifecycle.payload.summary, lifecycle.payload);
    }
  );

  server.registerTool(
    "register_project",
    {
      title: "Register project",
      description: "Determine the canonical project slug and install state for a repository before the first push.",
      inputSchema: {
        repository: z.string().describe("GitHub repository as owner/repo or a full GitHub URL."),
        projectName: z.string().optional().describe("Optional requested project slug override.")
      }
    },
    async ({ repository, projectName }) => {
      const repositoryRef = parseRepositoryInput(repository);
      const lifecycle = await buildRepositoryLifecycleState(env, requestUrl, repositoryRef, projectName);
      return createMcpToolResult(lifecycle.payload.summary, lifecycle.payload);
    }
  );

  server.registerTool(
    "validate_project",
    {
      title: "Validate project",
      description: "Queue a build-only validation job for a GitHub branch or commit without deploying it.",
      inputSchema: {
        repository: z.string().describe("GitHub repository as owner/repo or a full GitHub URL."),
        ref: z.string().optional().describe("Branch, tag, or commit to validate. Defaults to the repo default branch."),
        projectName: z.string().optional().describe("Optional requested project slug override.")
      }
    },
    async ({ repository, ref, projectName }) => {
      const validation = await queueValidationJob(env, requestUrl, {
        ...parseRepositoryBody(repository),
        ref,
        projectName
      });

      if (validation.status >= 400) {
        return createMcpToolErrorResult(
          extractMcpErrorMessage(validation.body),
          validation.body as Record<string, unknown>
        );
      }

      return createMcpToolResult(
        `Validation queued for ${repository}${ref ? ` at ${ref}` : ""}.`,
        validation.body
      );
    }
  );

  server.registerTool(
    "get_project_status",
    {
      title: "Get project status",
      description: "Return the current deployment lifecycle state for a project slug.",
      inputSchema: {
        projectName: z.string().describe(`Kale project slug in lowercase kebab-case, up to ${MAX_PROJECT_NAME_LENGTH} characters.`)
      }
    },
    async ({ projectName }) => {
      const status = await buildProjectStatusResponse(env, projectName);
      if (status.status >= 400) {
        return createMcpToolErrorResult(
          extractMcpErrorMessage(status.body),
          status.body as Record<string, unknown>
        );
      }

      return createMcpToolResult(
        summarizeProjectStatusPayload(status.body as Record<string, unknown>),
        status.body
      );
    }
  );

  server.registerTool(
    "get_build_job_status",
    {
      title: "Get build job status",
      description: "Return the current lifecycle state for a queued, running, passed, or failed build job.",
      inputSchema: {
        jobId: z.string().describe("Build job ID returned by validate_project or deployment status.")
      }
    },
    async ({ jobId }) => {
      const status = await buildBuildJobStatusResponse(env, jobId);
      if (status.status >= 400) {
        return createMcpToolErrorResult(
          extractMcpErrorMessage(status.body),
          status.body as Record<string, unknown>
        );
      }

      return createMcpToolResult(
        summarizeBuildJobStatusPayload(status.body as Record<string, unknown>),
        status.body
      );
    }
  );

  server.registerTool(
    "list_project_secrets",
    {
      title: "List project secrets",
      description: "List stored secret names for a Kale project. Secret values are never returned.",
      inputSchema: {
        projectName: z.string().describe(`Kale project slug in lowercase kebab-case, up to ${MAX_PROJECT_NAME_LENGTH} characters.`)
      }
    },
    async ({ projectName }) => {
      const authorization = await authorizeProjectSecretsAccess(env, requestUrl, identity, projectName);
      if (!authorization.ok) {
        return createMcpToolErrorResult(authorization.body.summary, authorization.body);
      }

      const payload = await buildProjectSecretsListPayload(env, authorization.project, authorization.githubLogin);
      return createMcpToolResult(payload.summary, payload);
    }
  );

  server.registerTool(
    "set_project_secret",
    {
      title: "Set project secret",
      description: "Create or update a project secret. Secret values are write-only and never returned.",
      inputSchema: {
        projectName: z.string().describe(`Kale project slug in lowercase kebab-case, up to ${MAX_PROJECT_NAME_LENGTH} characters.`),
        secretName: z.string().describe("Secret name, usually uppercase like OPENAI_API_KEY."),
        value: z.string().describe("Secret value to store for this project.")
      }
    },
    async ({ projectName, secretName, value }) => {
      const authorization = await authorizeProjectSecretsAccess(env, requestUrl, identity, projectName);
      if (!authorization.ok) {
        return createMcpToolErrorResult(authorization.body.summary, authorization.body);
      }

      const payload = await setProjectSecretValue(env, PROJECT_SECRETS_CONFIG, authorization, secretName, value);
      return createMcpToolResult(payload.summary, payload);
    }
  );

  server.registerTool(
    "delete_project_secret",
    {
      title: "Delete project secret",
      description: "Remove a stored project secret by name.",
      inputSchema: {
        projectName: z.string().describe(`Kale project slug in lowercase kebab-case, up to ${MAX_PROJECT_NAME_LENGTH} characters.`),
        secretName: z.string().describe("Secret name to remove.")
      }
    },
    async ({ projectName, secretName }) => {
      const authorization = await authorizeProjectSecretsAccess(env, requestUrl, identity, projectName);
      if (!authorization.ok) {
        return createMcpToolErrorResult(authorization.body.summary, authorization.body);
      }

      const payload = await removeProjectSecretValue(env, PROJECT_SECRETS_CONFIG, authorization, secretName);
      return createMcpToolResult(payload.summary, payload);
    }
  );

  server.registerResource(
    "runtime-manifest",
    "cail://runtime/manifest",
    {
      mimeType: "application/json",
      description: "CAIL Deploy runtime manifest"
    },
    async () => ({
      contents: [
        {
          uri: "cail://runtime/manifest",
          mimeType: "application/json",
          text: JSON.stringify(buildRuntimeManifest(env, serviceBaseUrl), null, 2)
        }
      ]
    })
  );

  server.registerResource(
    "mcp-auth-model",
    "cail://runtime/auth",
    {
      mimeType: "application/json",
      description: "Authentication requirements for the CAIL Deploy MCP server"
    },
    async () => ({
      contents: [
        {
          uri: "cail://runtime/auth",
          mimeType: "application/json",
          text: JSON.stringify(
            {
              identityType: identity.type,
              notes: [
                "CAIL Deploy uses standard MCP OAuth on /mcp.",
                "Your harness should discover /.well-known/oauth-protected-resource/mcp, open the browser login flow, and store the returned token automatically."
              ]
            },
            null,
            2
          )
        }
      ]
    })
  );

  return server;
}

function createMcpToolResult<TPayload extends Record<string, unknown>>(text: string, payload: TPayload) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: payload
  };
}

function createMcpToolErrorResult<TPayload extends Record<string, unknown>>(text: string, payload: TPayload) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: payload,
    isError: true
  };
}

function parseRepositoryInput(repository: string): { owner: string; repo: string } {
  return parseRepositoryReference(parseRepositoryBody(repository));
}

function parseRepositoryBody(repository: string): {
  repositoryFullName?: string;
  repositoryUrl?: string;
} {
  const trimmed = repository.trim();
  return /^https?:\/\//i.test(trimmed)
    ? { repositoryUrl: trimmed }
    : { repositoryFullName: trimmed };
}

function extractMcpErrorMessage(body: unknown): string {
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    return body.error;
  }

  return "Request failed.";
}

function summarizeProjectStatusPayload(payload: Record<string, unknown>): string {
  const projectName = typeof payload.projectName === "string" ? payload.projectName : "project";
  const status = typeof payload.status === "string" ? payload.status : "unknown";
  const deploymentUrl = typeof payload.deployment_url === "string" ? payload.deployment_url : undefined;
  const errorMessage = typeof payload.error_message === "string" ? payload.error_message : undefined;

  if (status === "live" && deploymentUrl) {
    return `${projectName} is live at ${deploymentUrl}.`;
  }

  if (errorMessage) {
    return `${projectName} is ${status}: ${errorMessage}`;
  }

  return `${projectName} is currently ${status}.`;
}

function summarizeBuildJobStatusPayload(payload: Record<string, unknown>): string {
  const jobId = typeof payload.jobId === "string" ? payload.jobId : "build job";
  const status = typeof payload.status === "string" ? payload.status : "unknown";
  const errorMessage = typeof payload.error_message === "string" ? payload.error_message : undefined;

  if (errorMessage) {
    return `${jobId} is ${status}: ${errorMessage}`;
  }

  return `${jobId} is currently ${status}.`;
}

function parseRepositoryReference(body: {
  repositoryUrl?: string;
  repositoryFullName?: string;
}): { owner: string; repo: string } {
  if (body.repositoryFullName) {
    const match = body.repositoryFullName.trim().match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
    if (match) {
      return { owner: match[1], repo: stripGitSuffix(match[2]) };
    }
  }

  if (body.repositoryUrl) {
    let url: URL;
    try {
      url = new URL(body.repositoryUrl);
    } catch {
      throw new HttpError(400, "Repository URL must be a valid GitHub URL.");
    }

    if (url.hostname !== "github.com") {
      throw new HttpError(400, "Repository URL must point to github.com.");
    }

    const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length < 2) {
      throw new HttpError(400, "Repository URL must include owner and repository name.");
    }

    return {
      owner: parts[0],
      repo: stripGitSuffix(parts[1])
    };
  }

  throw new HttpError(400, "Provide repositoryUrl or repositoryFullName.");
}

function normalizeRequestedProjectName(projectName: string, reservedProjectNames?: Iterable<string>): string {
  const normalized = projectName.trim().toLowerCase();
  if (!isValidProjectName(normalized)) {
    throw new HttpError(400, `Project names must be lowercase kebab-case and no longer than ${MAX_PROJECT_NAME_LENGTH} characters.`);
  }

  if (reservedProjectNames && new Set(reservedProjectNames).has(normalized)) {
    throw new HttpError(409, `Project name '${normalized}' is reserved for platform use.`);
  }

  return normalized;
}

function stripGitSuffix(repositoryName: string): string {
  return repositoryName.replace(/\.git$/i, "");
}

function normalizeValidationRef(ref: string | undefined, fallbackRef: string): string {
  const normalized = ref?.trim();
  if (!normalized) {
    return fallbackRef;
  }

  return stripGitRef(normalized.replace(/^refs\/tags\//, ""));
}

function buildGuidedGitHubInstallUrl(
  serviceBaseUrl: string,
  repositoryFullName: string,
  projectName: string
): string {
  const url = new URL(`${serviceBaseUrl.replace(/\/$/, "")}/github/install`);
  url.searchParams.set("repositoryFullName", repositoryFullName);
  url.searchParams.set("projectName", projectName);
  return url.toString();
}

function formatRepositoryFullName(owner: string, repo: string): string {
  const normalizedOwner = owner.trim().toLowerCase();
  const normalizedRepo = stripGitSuffix(repo.trim().toLowerCase());
  return normalizedRepo.includes("/") ? normalizedRepo : `${normalizedOwner}/${normalizedRepo}`;
}

async function buildRepositoryLifecycleState(
  env: Env,
  requestUrl: string,
  repository: { owner: string; repo: string },
  requestedProjectName?: string,
  options?: { includeSensitive?: boolean }
): Promise<{
  httpStatus: 200 | 409;
  payload: RepositoryLifecyclePayload & { error?: string };
}> {
  const serviceBaseUrl = resolveServiceBaseUrl(env, requestUrl);
  const reservedProjectNames = resolveReservedProjectNames(env, serviceBaseUrl);
  const projectName = requestedProjectName
    ? normalizeRequestedProjectName(requestedProjectName, reservedProjectNames)
    : suggestProjectName(repository.repo, reservedProjectNames);
  const projectUrl = buildProjectDeploymentUrl(env, projectName);
  const appSlug = resolveGitHubAppSlug(env);
  const installUrl = appSlug ? githubAppInstallUrl(appSlug) : undefined;
  const repositoryFullName = formatRepositoryFullName(repository.owner, repository.repo);
  const guidedInstallUrl = appSlug
    ? buildGuidedGitHubInstallUrl(serviceBaseUrl, repositoryFullName, projectName)
    : undefined;

  let installation: GitHubRepositoryInstallation | null = null;
  if (appSlug && resolveGitHubAppId(env) && resolveConfiguredEnvValue(env.GITHUB_APP_PRIVATE_KEY)) {
    installation = await getGitHubAppClient(env).getRepositoryInstallation(repository.owner, repository.repo);
  }

  const projectClaim = await getProjectClaim(env.CONTROL_PLANE_DB, projectName, repositoryFullName);
  const installStatus = !appSlug
    ? "app_unconfigured"
    : installation
      ? "installed"
      : "not_installed";
  const lifecycleStatus = resolveProjectLifecycleStatus(projectClaim.project, projectClaim.latestJob);
  const workflow = resolveRepositoryWorkflowState({
    installStatus,
    lifecycleStatus,
    buildStatus: projectClaim.latestJob?.status,
    conflict: projectClaim.conflict,
    projectName,
    claimedRepositoryFullName: projectClaim.claimedRepositoryFullName
  });

  const payload: RepositoryLifecyclePayload = {
    ok: !projectClaim.conflict,
    repository: {
      ownerLogin: repository.owner,
      name: repository.repo,
      fullName: repositoryFullName,
      htmlUrl: `https://github.com/${repository.owner}/${repository.repo}`
    },
    projectName,
    projectUrl,
    projectAvailable: !projectClaim.conflict,
    existingRepositoryFullName: projectClaim.claimedRepositoryFullName,
    suggestedProjectUrl: projectUrl,
    suggestedProjectNames: projectClaim.conflict
      ? await suggestAvailableProjectNames(env, projectName, repository, repositoryFullName)
      : undefined,
    installStatus,
    installUrl,
    guidedInstallUrl,
    setupUrl: `${serviceBaseUrl}/github/setup`,
    statusUrl: `${serviceBaseUrl}/api/projects/${projectName}/status`,
    repositoryStatusUrl: `${serviceBaseUrl}/api/repositories/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/status`,
    validateUrl: `${serviceBaseUrl}/api/validate`,
    nextAction: workflow.nextAction,
    summary: workflow.summary,
    workflowStage: workflow.stage,
    installed: Boolean(installation),
    installationId: installation?.id,
    latestStatus: lifecycleStatus,
    buildStatus: projectClaim.latestJob?.status,
    buildJobId: projectClaim.latestJob?.jobId,
    buildJobStatusUrl: projectClaim.latestJob?.jobId
      ? buildJobStatusUrl(serviceBaseUrl, projectClaim.latestJob.jobId)
      : undefined,
    deploymentUrl: projectClaim.latestJob?.deploymentUrl ?? projectClaim.project?.deploymentUrl,
    errorKind: projectClaim.latestJob?.errorKind,
    errorMessage: projectClaim.latestJob?.errorMessage,
    ...(options?.includeSensitive ? { errorDetail: projectClaim.latestJob?.errorDetail } : {}),
    updatedAt: projectClaim.latestJob?.updatedAt ?? projectClaim.project?.updatedAt
  };

  if (projectClaim.conflict) {
    return {
      httpStatus: 409,
      payload: {
        ...payload,
        error: "Project name is already reserved by a different repository."
      }
    };
  }

  return {
    httpStatus: 200,
    payload
  };
}

async function queueValidationJob(
  env: Env,
  requestUrl: string,
  body: {
    repositoryUrl?: string;
    repositoryFullName?: string;
    ref?: string;
    projectName?: string;
  }
): Promise<{ status: ApiResponseStatus; body: Record<string, unknown> }> {
  const repositoryRef = parseRepositoryReference(body);
  const appSlug = resolveGitHubAppSlug(env);
  const installUrl = appSlug ? githubAppInstallUrl(appSlug) : undefined;
  const serviceBaseUrl = resolveServiceBaseUrl(env, requestUrl);
  const reservedProjectNames = resolveReservedProjectNames(env, serviceBaseUrl);

  if (!appSlug || !resolveGitHubAppId(env) || !resolveConfiguredEnvValue(env.GITHUB_APP_PRIVATE_KEY)) {
    throw new HttpError(500, "GitHub App support is not configured on this deployment.");
  }

  const github = getGitHubAppClient(env);
  const installation = await github.getRepositoryInstallation(repositoryRef.owner, repositoryRef.repo);
  if (!installation) {
    return {
      status: 409,
      body: {
        ok: false,
        error: "The CAIL Deploy GitHub App is not installed on this repository.",
        repository: {
          ownerLogin: repositoryRef.owner,
          name: repositoryRef.repo,
          fullName: `${repositoryRef.owner}/${repositoryRef.repo}`,
          htmlUrl: `https://github.com/${repositoryRef.owner}/${repositoryRef.repo}`
        },
        installStatus: "not_installed",
        installUrl,
        setupUrl: `${serviceBaseUrl}/github/setup`,
        nextAction: "install_github_app"
      }
    };
  }

  const installationClient = await github.createInstallationClient(installation.id);
  const githubRepository = await fetchGitHubRepositoryForValidation(
    installationClient,
    repositoryRef.owner,
    repositoryRef.repo
  );
  const repository = toRepositoryRecordFromGitHub(githubRepository);
  const ref = normalizeValidationRef(body.ref, repository.defaultBranch);
  const commit = await fetchGitHubCommitForValidation(
    installationClient,
    repository.ownerLogin,
    repository.name,
    ref
  );
  const projectName = body.projectName
    ? normalizeRequestedProjectName(body.projectName, reservedProjectNames)
    : await resolveRepositoryProjectName(
        env.CONTROL_PLANE_DB,
        repository.fullName,
        repository.name,
        reservedProjectNames
      );
  const now = new Date().toISOString();
  const repositoryFullName = repository.fullName;

  try {
    await assertRepositoryWithinJobLimits(
      env,
      repositoryFullName,
      projectName,
      "validate",
      now
    );
  } catch (error) {
    const httpError = asHttpError(error);
    if (httpError.status === 429) {
      return {
        status: 429,
        body: {
          ok: false,
          error: httpError.message,
          repository: {
            ownerLogin: repository.ownerLogin,
            name: repository.name,
            fullName: repository.fullName,
            htmlUrl: repository.htmlUrl
          },
          projectName,
          projectUrlPreview: buildProjectDeploymentUrl(env, projectName),
          nextAction: /active build/i.test(httpError.message)
            ? "wait_for_active_build"
            : "wait_for_limit_reset"
        }
      };
    }

    throw error;
  }

  const jobId = crypto.randomUUID();
  const statusUrl = `${serviceBaseUrl}/api/build-jobs/${jobId}/status`;
  const checkRun = await installationClient.createCheckRun({
    owner: repository.ownerLogin,
    repo: repository.name,
    name: "CAIL Validate",
    headSha: commit.sha,
    externalId: jobId,
    detailsUrl: statusUrl,
    status: "queued",
    startedAt: now,
    output: checkRunOutput(
      "Validation queued",
      "CAIL Deploy accepted this validation request and queued a build-only check.",
      "This run will build the Worker bundle without deploying it."
    )
  });

  const job: BuildJobRecord = {
    jobId,
    eventName: "validate",
    installationId: installation.id,
    repository,
    ref,
    headSha: commit.sha,
    checkRunId: checkRun.id,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    projectName
  };
  await putBuildJob(env.CONTROL_PLANE_DB, job);

  try {
    await env.BUILD_QUEUE.send(createBuildRunnerRequest(env, requestUrl, job));
  } catch (error) {
    const failedJob = await completeBuildJobFailure(
      env,
      job,
      {
        status: "failure",
        completedAt: new Date().toISOString(),
        summary: "Validation could not be queued.",
        errorMessage: error instanceof Error ? error.message : "Validation queueing failed."
      },
      error instanceof Error ? error.message : "Validation queueing failed."
    );

    return {
      status: 500,
      body: {
        ok: false,
        error: failedJob.errorMessage ?? "Validation queueing failed.",
        jobId,
        statusUrl,
        checkRunId: checkRun.id
      }
    };
  }

  return {
    status: 202,
    body: {
      ok: true,
      jobId,
      jobKind: "validation",
      repository: {
        ownerLogin: repository.ownerLogin,
        name: repository.name,
        fullName: repository.fullName,
        htmlUrl: repository.htmlUrl
      },
      ref,
      headSha: commit.sha,
      projectName,
      projectUrlPreview: buildProjectDeploymentUrl(env, projectName),
      status: "queued",
      buildStatus: "queued",
      statusUrl,
      checkRunId: checkRun.id,
      checkRunUrl: checkRun.html_url,
      nextAction: "poll_status"
    }
  };
}

async function assertRepositoryWithinJobLimits(
  env: Env,
  githubRepo: string,
  projectName: string,
  eventName: "push" | "validate",
  now: string
): Promise<void> {
  const policy = await ensureProjectPolicy(env.CONTROL_PLANE_DB, githubRepo, projectName, now);
  const activeBuilds = await countActiveBuildJobsForRepository(env.CONTROL_PLANE_DB, githubRepo);
  if (policy.maxConcurrentBuilds > 0 && activeBuilds >= policy.maxConcurrentBuilds) {
    throw new HttpError(
      429,
      `Kale Deploy already has ${policy.maxConcurrentBuilds} active build${policy.maxConcurrentBuilds === 1 ? "" : "s"} for this repository. Wait for the current build to finish before starting another one.`
    );
  }

  const usageDate = now.slice(0, 10);
  const currentCount = await countBuildJobsForRepositoryOnDate(
    env.CONTROL_PLANE_DB,
    githubRepo,
    eventName,
    usageDate
  );
  const limit = eventName === "validate" ? policy.maxValidationsPerDay : policy.maxDeploymentsPerDay;
  if (limit > 0 && currentCount >= limit) {
    throw new HttpError(
      429,
      eventName === "validate"
        ? `This repository has reached its daily validation limit (${limit}/day). Try again tomorrow or reduce how often you run validate.`
        : `This repository has reached its daily deployment limit (${limit}/day). Push again tomorrow or wait until the limit is raised.`
    );
  }
}

async function resolveRepositoryProjectName(
  db: D1Database,
  repositoryFullName: string,
  repositoryName: string,
  reservedProjectNames: Set<string>
): Promise<string> {
  const preferredProjectName = await getPreferredProjectNameForRepository(db, repositoryFullName);
  if (preferredProjectName) {
    return preferredProjectName;
  }

  return suggestProjectName(repositoryName, reservedProjectNames);
}

async function buildProjectStatusResponse(
  env: Env,
  projectName: string,
  options?: { includeSensitive?: boolean }
): Promise<{ status: ApiResponseStatus; body: Record<string, unknown> }> {
  if (!isValidProjectName(projectName)) {
    return {
      status: 400,
      body: {
        error: `Project names must be lowercase kebab-case and no longer than ${MAX_PROJECT_NAME_LENGTH} characters.`
      }
    };
  }

  const [project, latestJob] = await Promise.all([
    getProject(env.CONTROL_PLANE_DB, projectName),
    getLatestBuildJobForProject(env.CONTROL_PLANE_DB, projectName)
  ]);

  if (!project && !latestJob) {
    return {
      status: 404,
      body: { error: "Project not found." }
    };
  }

  const lifecycleStatus = resolveProjectLifecycleStatus(project, latestJob);
  return {
    status: 200,
    body: {
      projectName,
      status: lifecycleStatus,
      build_status: latestJob?.status,
      deployment_url: latestJob?.deploymentUrl ?? project?.deploymentUrl,
      deployment_id: latestJob?.deploymentId ?? project?.latestDeploymentId,
      error_kind: latestJob?.errorKind,
      error_message: latestJob?.errorMessage,
      ...(options?.includeSensitive ? { error_detail: latestJob?.errorDetail } : {}),
      ...(options?.includeSensitive ? { build_log_url: latestJob?.buildLogUrl } : {}),
      job_id: latestJob?.jobId,
      check_run_id: latestJob?.checkRunId,
      created_at: latestJob?.createdAt ?? project?.createdAt,
      updated_at: latestJob?.updatedAt ?? project?.updatedAt,
      started_at: latestJob?.startedAt,
      completed_at: latestJob?.completedAt
    }
  };
}

async function buildBuildJobStatusResponse(
  env: Env,
  jobId: string,
  options?: { includeSensitive?: boolean }
): Promise<{ status: ApiResponseStatus; body: Record<string, unknown> }> {
  const job = await getBuildJob(env.CONTROL_PLANE_DB, jobId);
  if (!job) {
    return {
      status: 404,
      body: { error: "Build job not found." }
    };
  }

  return {
    status: 200,
    body: {
      jobId: job.jobId,
      jobKind: job.eventName === "validate" ? "validation" : "deployment",
      event_name: job.eventName,
      status: normalizeBuildJobLifecycleStatus(job.eventName, job.status),
      build_status: job.status,
      repository: {
        ownerLogin: job.repository.ownerLogin,
        name: job.repository.name,
        fullName: job.repository.fullName,
        htmlUrl: job.repository.htmlUrl
      },
      ref: job.ref,
      head_sha: job.headSha,
      project_name: job.projectName,
      deployment_url: job.deploymentUrl,
      deployment_id: job.deploymentId,
      error_kind: job.errorKind,
      error_message: job.errorMessage,
      ...(options?.includeSensitive ? { error_detail: job.errorDetail } : {}),
      ...(options?.includeSensitive ? { build_log_url: job.buildLogUrl } : {}),
      check_run_id: job.checkRunId,
      created_at: job.createdAt,
      updated_at: job.updatedAt,
      started_at: job.startedAt,
      completed_at: job.completedAt
    }
  };
}

function renderRepositoryLifecycleActions(input: {
  lifecycle: RepositoryLifecyclePayload;
  installUrl?: string;
  appName: string;
  serviceBaseUrl: string;
  oauthBaseUrl: string;
}): string {
  const { lifecycle, installUrl, appName, serviceBaseUrl, oauthBaseUrl } = input;
  const settingsUrl = buildProjectControlPanelUrl(oauthBaseUrl, lifecycle.projectName);

  switch (lifecycle.workflowStage) {
    case "app_setup":
      return `<div class="actions">
          <a class="button" href="${escapeHtml(`${serviceBaseUrl}/github/register`)}">Set up GitHub for Kale Deploy</a>
          <a class="button secondary" href="${escapeHtml(`${serviceBaseUrl}/github/app`)}">Learn about the ${escapeHtml(appName)} app</a>
        </div>`;
    case "github_install":
      return `<div class="actions">
          ${installUrl
            ? `<a class="button" href="${escapeHtml(lifecycle.guidedInstallUrl ?? installUrl)}">Connect GitHub for this repo</a>`
            : ""}
        </div>`;
    case "awaiting_push":
      return `<div class="notice"><p>Your repository is connected. Push to <code>main</code> when you are ready to put the first version online.</p></div>
        <div class="actions">
          <a class="button secondary" href="${escapeHtml(settingsUrl)}">Project settings</a>
        </div>`;
    case "build_queued":
    case "build_running":
      return `<div class="actions">
          <a class="button" href="${escapeHtml(buildGuidedSetupUrl(serviceBaseUrl, lifecycle.repository.fullName, lifecycle.projectName))}">View setup progress</a>
          <a class="button secondary" href="${escapeHtml(settingsUrl)}">Project settings</a>
          ${lifecycle.deploymentUrl ? `<a class="button secondary" href="${escapeHtml(lifecycle.deploymentUrl)}">Open live site</a>` : ""}
        </div>`;
    case "build_failed":
      return `<div class="actions">
          <a class="button" href="${escapeHtml(buildGuidedSetupUrl(serviceBaseUrl, lifecycle.repository.fullName, lifecycle.projectName))}">Review what happened</a>
          <a class="button secondary" href="${escapeHtml(settingsUrl)}">Project settings</a>
          ${lifecycle.buildJobStatusUrl ? `<a class="button secondary" href="${escapeHtml(lifecycle.buildJobStatusUrl)}">Open build details</a>` : ""}
        </div>`;
    case "live":
      return `<div class="actions">
          ${lifecycle.deploymentUrl ? `<a class="button" href="${escapeHtml(lifecycle.deploymentUrl)}">Open live site</a>` : ""}
          <a class="button secondary" href="${escapeHtml(settingsUrl)}">Project settings</a>
          <a class="button secondary" href="${escapeHtml(buildGuidedSetupUrl(serviceBaseUrl, lifecycle.repository.fullName, lifecycle.projectName))}">View setup progress</a>
        </div>`;
    case "name_conflict":
      return `<div class="notice">
          <p>That project name is taken. Try one of these instead:</p>
          <div class="actions">
            ${(lifecycle.suggestedProjectNames ?? []).map((suggestion) => `
              <a class="button secondary" href="${escapeHtml(buildGuidedGitHubInstallUrl(serviceBaseUrl, lifecycle.repository.fullName, suggestion.projectName))}">${escapeHtml(suggestion.projectName)}</a>
            `).join("")}
          </div>
        </div>`;
    default:
      return "";
  }
}

function renderRepositoryInstallActions(input: {
  lifecycle: RepositoryLifecyclePayload;
  appName: string;
  continueUrl?: string;
  serviceBaseUrl: string;
}): string {
  const { lifecycle, appName, continueUrl, serviceBaseUrl } = input;
  const setupUrl = buildGuidedSetupUrl(serviceBaseUrl, lifecycle.repository.fullName, lifecycle.projectName);

  switch (lifecycle.workflowStage) {
    case "app_setup":
      return `<div class="actions">
          <a class="button" href="${escapeHtml(`${serviceBaseUrl}/github/register`)}">Set up GitHub for Kale Deploy</a>
          <a class="button secondary" href="${escapeHtml(`${serviceBaseUrl}/github/app`)}">Learn about the ${escapeHtml(appName)} app</a>
        </div>`;
    case "github_install":
      return `<div class="actions">
          ${continueUrl
            ? `<a class="button" href="${escapeHtml(continueUrl)}">Continue to GitHub</a>`
            : ""}
          <a class="button secondary" href="${escapeHtml(setupUrl)}">View setup progress</a>
        </div>`;
    case "name_conflict":
      return `<div class="notice">
          <p>This repo needs a different public project name before the GitHub install step is useful.</p>
          <div class="actions">
            ${(lifecycle.suggestedProjectNames ?? []).map((suggestion) => `
              <a class="button secondary" href="${escapeHtml(buildGuidedGitHubInstallUrl(serviceBaseUrl, lifecycle.repository.fullName, suggestion.projectName))}">${escapeHtml(suggestion.projectName)}</a>
            `).join("")}
          </div>
        </div>`;
    default:
      return `<div class="actions">
          <a class="button" href="${escapeHtml(setupUrl)}">View setup progress</a>
          ${continueUrl ? `<a class="button secondary" href="${escapeHtml(continueUrl)}">Open GitHub again</a>` : ""}
        </div>
        <div class="notice"><p>This repository is already connected to CAIL.</p></div>`;
  }
}

function renderSetupPageContent(input: {
  lifecycle: RepositoryLifecyclePayload;
  appName: string;
  serviceBaseUrl: string;
  oauthBaseUrl: string;
  installUrl?: string;
  installReturnObserved?: boolean;
}): string {
  const { lifecycle, appName, serviceBaseUrl, oauthBaseUrl, installUrl, installReturnObserved } = input;
  const settingsUrl = buildProjectControlPanelUrl(oauthBaseUrl, lifecycle.projectName);
  const stage = describeRepositorySetupStage(lifecycle, appName, {
    installReturnObserved,
    flowPhase: "setup"
  });

  // ── Actions ──
  let actions: string;
  switch (lifecycle.workflowStage) {
    case "app_setup":
      actions = `<div class="actions">
          <a class="button" href="${escapeHtml(`${serviceBaseUrl}/github/register`)}">Set up GitHub for Kale Deploy</a>
        </div>`;
      break;
    case "github_install":
      actions = installUrl
        ? `<div class="actions">
            <a class="button" href="${escapeHtml(lifecycle.guidedInstallUrl ?? installUrl)}">Connect GitHub for this repo</a>
          </div>`
        : "";
      break;
    case "awaiting_push":
      actions = `<div class="actions">
          <a class="button secondary" href="${escapeHtml(settingsUrl)}">Project settings</a>
        </div>`;
      break;
    case "build_queued":
    case "build_running":
      actions = `<div class="actions">
          <a class="button secondary" href="${escapeHtml(settingsUrl)}">Project settings</a>
          ${lifecycle.deploymentUrl ? `<a class="button secondary" href="${escapeHtml(lifecycle.deploymentUrl)}">Open live site</a>` : ""}
        </div>`;
      break;
    case "build_failed":
      actions = `<div class="actions">
          <a class="button secondary" href="${escapeHtml(settingsUrl)}">Project settings</a>
          ${lifecycle.buildJobStatusUrl ? `<a class="button secondary" href="${escapeHtml(lifecycle.buildJobStatusUrl)}">Build details</a>` : ""}
        </div>`;
      break;
    case "live":
      actions = `<div class="actions">
          ${lifecycle.deploymentUrl ? `<a class="button" href="${escapeHtml(lifecycle.deploymentUrl)}">Open live site</a>` : ""}
          <a class="button secondary" href="${escapeHtml(settingsUrl)}">Project settings</a>
        </div>`;
      break;
    case "name_conflict":
      actions = `<div class="notice">
          <div class="actions">
            ${(lifecycle.suggestedProjectNames ?? []).map((suggestion) => `
              <a class="button secondary" href="${escapeHtml(buildGuidedGitHubInstallUrl(serviceBaseUrl, lifecycle.repository.fullName, suggestion.projectName))}">${escapeHtml(suggestion.projectName)}</a>
            `).join("")}
          </div>
        </div>`;
      break;
    default:
      actions = `<div class="actions">
          <a class="button secondary" href="${escapeHtml(serviceBaseUrl)}">Return to Kale Deploy</a>
        </div>`;
  }

  // ── Failure notice ──
  const failureNotice = lifecycle.errorMessage
    ? `<div class="notice notice-error"><p><strong>Build error:</strong> ${escapeHtml(lifecycle.errorMessage)}${lifecycle.errorDetail ? `<br /><code>${escapeHtml(lifecycle.errorDetail)}</code>` : ""}</p></div>`
    : "";

  return `<div class="setup-primary">
      <h2 id="current-state-headline">${escapeHtml(stage.headline)}</h2>
      <p id="current-state-summary">${escapeHtml(stage.summary)}</p>
    </div>
    ${failureNotice}
    ${actions}`;
}

function renderRepositoryLifecycleOverview(input: {
  lifecycle: RepositoryLifecyclePayload;
  appName: string;
  serviceBaseUrl: string;
  installationId?: string;
  setupAction?: string;
  flowPhase?: "install" | "setup";
}): string {
  const { lifecycle, appName, serviceBaseUrl, installationId, setupAction, flowPhase = "setup" } = input;
  const setupUrl = buildGuidedSetupUrl(serviceBaseUrl, lifecycle.repository.fullName, lifecycle.projectName);
  const repositoryCoverage = describeRepositoryCoverage(lifecycle, appName);
  const stage = describeRepositorySetupStage(lifecycle, appName, {
    installReturnObserved: Boolean(installationId || setupAction),
    flowPhase
  });
  const handoffSummary = installationId || setupAction
    ? `GitHub redirected here${installationId ? ` after installation ${installationId}` : ""}${setupAction ? ` with setup action '${setupAction}'` : ""}.`
    : undefined;
  const refreshLabel = flowPhase === "install" ? "View setup progress" : "Refresh this page";

  return `<div class="state-grid">
      <section class="state-card primary">
        <p class="state-label">Status</p>
        <h2 id="current-state-headline">${escapeHtml(stage.headline)}</h2>
        <p id="current-state-summary">${escapeHtml(lifecycle.summary)}</p>
        <p id="github-handoff-summary"${handoffSummary ? "" : " hidden"}>${handoffSummary ? `<strong>You came back from GitHub:</strong> ${escapeHtml(handoffSummary)}` : ""}</p>
        <div class="quick-links">
          <a class="button secondary" href="${escapeHtml(setupUrl)}">${escapeHtml(refreshLabel)}</a>
        </div>
      </section>
      <section class="state-card">
        <p class="state-label">GitHub</p>
        <h3 id="repository-coverage-title">${escapeHtml(repositoryCoverage.title)}</h3>
        <p id="repository-coverage-body">${escapeHtml(repositoryCoverage.body)}</p>
      </section>
      <section class="state-card">
        <p class="state-label">Next step</p>
        <h3 id="user-next-title">${escapeHtml(stage.userTitle)}</h3>
        <p id="user-next-body">${escapeHtml(stage.userBody)}</p>
      </section>
      <section class="state-card">
        <p class="state-label">Behind the scenes</p>
        <h3 id="agent-next-title">${escapeHtml(stage.agentTitle)}</h3>
        <p id="agent-next-body">${escapeHtml(stage.agentBody)}</p>
      </section>
    </div>`;
}

function renderRepositoryLiveRefreshPanel(input: {
  lifecycle: RepositoryLifecyclePayload;
  phase: "install" | "setup";
  appName: string;
  installReturnObserved: boolean;
}): string {
  const setupStagePresentation = buildRepositorySetupStagePresentationMap(input.appName, {
    installReturnObserved: input.installReturnObserved,
    flowPhase: input.phase
  });
  const coveragePresentation = buildRepositoryCoveragePresentationMap(input.appName);
  const bannerPresentation = buildRepositoryBannerPresentationMap();
  const bootstrap = serializeJsonForHtml({
    phase: input.phase,
    installReturnObserved: input.installReturnObserved,
    coveragePresentation,
    setupStagePresentation,
    bannerPresentation,
    lifecycle: input.lifecycle
  });

  return `<div id="live-refresh-panel" style="margin-top: 16px;">
      <div class="actions">
        <button class="button secondary" type="button" id="live-refresh-button">Check for updates</button>
      </div>
      <div id="live-refresh-result" class="live-refresh-result"></div>
    </div>
    <script id="repository-live-refresh-bootstrap" type="application/json">${bootstrap}</script>
    <script>${renderRepositoryLiveRefreshScript()}</script>`;
}

function renderRepositoryDeveloperDetails(input: {
  lifecycle: RepositoryLifecyclePayload;
  serviceBaseUrl: string;
  oauthBaseUrl: string;
}): string {
  const { lifecycle, serviceBaseUrl, oauthBaseUrl } = input;

  return `<details class="dev-details">
      <summary>Developer details</summary>
      <div class="details-grid">
        <div class="detail-label">Repository</div><div class="detail-value"><a href="${escapeHtml(lifecycle.repository.htmlUrl)}"><code>${escapeHtml(lifecycle.repository.fullName)}</code></a></div>
        <div class="detail-label">Project</div><div class="detail-value"><code>${escapeHtml(lifecycle.projectName)}</code></div>
        <div class="detail-label">Public URL</div><div class="detail-value"><code>${escapeHtml(lifecycle.projectUrl)}</code></div>
        <div class="detail-label">Settings URL</div><div class="detail-value"><code>${escapeHtml(buildProjectControlPanelUrl(oauthBaseUrl, lifecycle.projectName))}</code></div>
        <div class="detail-label">Repo status API</div><div class="detail-value"><code>${escapeHtml(lifecycle.repositoryStatusUrl)}</code></div>
        <div class="detail-label">Project status API</div><div class="detail-value"><code>${escapeHtml(lifecycle.statusUrl)}</code></div>
        <div class="detail-label">Validate API</div><div class="detail-value"><code>${escapeHtml(lifecycle.validateUrl)}</code></div>
        <div class="detail-label">Setup URL</div><div class="detail-value"><code>${escapeHtml(buildGuidedSetupUrl(serviceBaseUrl, lifecycle.repository.fullName, lifecycle.projectName))}</code></div>
        ${lifecycle.buildJobStatusUrl ? `<div class="detail-label">Build job</div><div class="detail-value"><code>${escapeHtml(lifecycle.buildJobStatusUrl)}</code></div>` : ""}
        ${lifecycle.deploymentUrl ? `<div class="detail-label">Live deployment</div><div class="detail-value"><a href="${escapeHtml(lifecycle.deploymentUrl)}"><code>${escapeHtml(lifecycle.deploymentUrl)}</code></a></div>` : ""}
      </div>
    </details>`;
}

function buildGuidedSetupUrl(
  serviceBaseUrl: string,
  repositoryFullName: string,
  projectName?: string
): string {
  const url = new URL(`${serviceBaseUrl.replace(/\/$/, "")}/github/setup`);
  url.searchParams.set("repositoryFullName", repositoryFullName);
  if (projectName) {
    url.searchParams.set("projectName", projectName);
  }
  return url.toString();
}

async function getProjectClaim(
  db: D1Database,
  projectName: string,
  repositoryFullName: string
): Promise<{
  project: ProjectRecord | null;
  latestJob: BuildJobRecord | null;
  claimedRepositoryFullName?: string;
  conflict: boolean;
}> {
  const [project, latestJob] = await Promise.all([
    getProject(db, projectName),
    getLatestBuildJobForProject(db, projectName)
  ]);
  const claimedRepositoryFullName = project
    ? formatRepositoryFullName(project.ownerLogin, project.githubRepo)
    : latestJob
      ? formatRepositoryFullName(latestJob.repository.ownerLogin, latestJob.repository.name)
      : undefined;

  return {
    project,
    latestJob,
    claimedRepositoryFullName,
    conflict: Boolean(claimedRepositoryFullName && claimedRepositoryFullName !== repositoryFullName)
  };
}

function resolveRepositoryWorkflowState(input: {
  installStatus: RepositoryInstallStatus;
  lifecycleStatus: "not_deployed" | "queued" | "running" | "live" | "failed";
  buildStatus?: BuildJobStatus;
  conflict: boolean;
  projectName: string;
  claimedRepositoryFullName?: string;
}): {
  nextAction:
    | "configure_github_app"
    | "install_github_app"
    | "choose_different_project_name"
    | "push_to_default_branch"
    | "poll_status"
    | "inspect_failure"
    | "view_live_project";
  stage: RepositoryWorkflowStage;
  summary: string;
} {
  if (input.conflict) {
    return {
      nextAction: "choose_different_project_name",
      stage: "name_conflict",
      summary: `The name '${input.projectName}' is taken by ${input.claimedRepositoryFullName ?? "another repository"}.`
    };
  }

  if (input.lifecycleStatus === "queued") {
    return {
      nextAction: "poll_status",
      stage: "build_queued",
      summary: "Your build is in the queue."
    };
  }

  if (input.lifecycleStatus === "running") {
    return {
      nextAction: "poll_status",
      stage: "build_running",
      summary: "Building now."
    };
  }

  if (input.lifecycleStatus === "failed") {
    return {
      nextAction: "inspect_failure",
      stage: "build_failed",
      summary: "The last build failed."
    };
  }

  if (input.lifecycleStatus === "live") {
    return {
      nextAction: "view_live_project",
      stage: "live",
      summary: "Your site is live."
    };
  }

  if (input.installStatus === "app_unconfigured") {
    return {
      nextAction: "configure_github_app",
      stage: "app_setup",
      summary: "The shared GitHub app needs to be created before any repo can deploy."
    };
  }

  if (input.installStatus === "not_installed") {
    return {
      nextAction: "install_github_app",
      stage: "github_install",
      summary: "This repo needs GitHub access."
    };
  }

  return {
    nextAction: "push_to_default_branch",
    stage: "awaiting_push",
    summary: "Connected. Push to deploy."
  };
}

async function suggestAvailableProjectNames(
  env: Env,
  requestedProjectName: string,
  repository: { owner: string; repo: string },
  repositoryFullName: string
): Promise<Array<{ projectName: string; projectUrl: string }>> {
  const candidates = buildProjectNameCandidates(requestedProjectName, repository);
  const suggestions: Array<{ projectName: string; projectUrl: string }> = [];

  for (const candidate of candidates) {
    if (candidate === requestedProjectName) {
      continue;
    }

    const claim = await getProjectClaim(env.CONTROL_PLANE_DB, candidate, repositoryFullName);
    if (claim.conflict) {
      continue;
    }

    suggestions.push({
      projectName: candidate,
      projectUrl: buildProjectDeploymentUrl(env, candidate)
    });

    if (suggestions.length >= 5) {
      break;
    }
  }

  return suggestions;
}

function buildProjectNameCandidates(
  requestedProjectName: string,
  repository: { owner: string; repo: string }
): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  const ownerFragment = normalizeProjectNameFragment(repository.owner);
  const repoFragment = normalizeProjectNameFragment(repository.repo);

  const addCandidate = (value: string | undefined) => {
    if (!value || seen.has(value) || !isValidProjectName(value)) {
      return;
    }

    seen.add(value);
    candidates.push(value);
  };

  if (ownerFragment && !requestedProjectName.endsWith(`-${ownerFragment}`)) {
    addCandidate(appendProjectSuffix(requestedProjectName, ownerFragment));
  }

  if (repoFragment && repoFragment !== requestedProjectName && !requestedProjectName.endsWith(`-${repoFragment}`)) {
    addCandidate(appendProjectSuffix(requestedProjectName, repoFragment));
  }

  for (let suffix = 2; suffix <= 6; suffix += 1) {
    addCandidate(appendProjectSuffix(requestedProjectName, String(suffix)));
  }

  if (ownerFragment) {
    for (let suffix = 2; suffix <= 3; suffix += 1) {
      addCandidate(appendProjectSuffix(requestedProjectName, `${ownerFragment}-${suffix}`));
    }
  }

  return candidates;
}

function appendProjectSuffix(base: string, suffix: string): string {
  const normalizedSuffix = normalizeProjectNameFragment(suffix);
  if (!normalizedSuffix) {
    return base;
  }

  const maxLength = 63;
  const separator = "-";
  const availableBaseLength = maxLength - separator.length - normalizedSuffix.length;
  const trimmedBase = base
    .slice(0, Math.max(availableBaseLength, 1))
    .replace(/-+$/g, "");

  return `${trimmedBase}${separator}${normalizedSuffix}`;
}

function normalizeProjectNameFragment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function parseOptionalRepositoryContext(body: {
  repositoryUrl?: string;
  repositoryFullName?: string;
  projectName?: string;
}, env: Pick<Env, "PROJECT_HOST_SUFFIX" | "DEPLOY_SERVICE_BASE_URL">, serviceBaseUrl?: string): {
  repositoryFullName: string;
  projectName: string;
} | undefined {
  if (!body.repositoryUrl && !body.repositoryFullName) {
    return undefined;
  }

  const repository = parseRepositoryReference(body);
  const reservedProjectNames = resolveReservedProjectNames(env, serviceBaseUrl);
  return {
    repositoryFullName: formatRepositoryFullName(repository.owner, repository.repo),
    projectName: body.projectName
      ? normalizeRequestedProjectName(body.projectName, reservedProjectNames)
      : suggestProjectName(repository.repo, reservedProjectNames)
  };
}

function readGitHubInstallContext(
  cookieHeader: string | undefined,
  env: Pick<Env, "PROJECT_HOST_SUFFIX" | "DEPLOY_SERVICE_BASE_URL">,
  serviceBaseUrl?: string
):
  | { repositoryFullName: string; projectName: string }
  | undefined {
  const raw = parseCookieHeader(cookieHeader).get(GITHUB_INSTALL_CONTEXT_COOKIE);
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as {
      repositoryFullName?: string;
      projectName?: string;
    };
    if (!parsed.repositoryFullName) {
      return undefined;
    }

    const repository = parseRepositoryReference({
      repositoryFullName: parsed.repositoryFullName
    });
    const reservedProjectNames = resolveReservedProjectNames(env, serviceBaseUrl);
    return {
      repositoryFullName: formatRepositoryFullName(repository.owner, repository.repo),
      projectName: parsed.projectName
        ? normalizeRequestedProjectName(parsed.projectName, reservedProjectNames)
        : suggestProjectName(repository.repo, reservedProjectNames)
    };
  } catch {
    return undefined;
  }
}

function buildJobStatusUrl(serviceBaseUrl: string, jobId: string): string {
  return `${serviceBaseUrl.replace(/\/$/, "")}/api/build-jobs/${jobId}/status`;
}

function toRepositoryRecordFromGitHub(repository: GitHubRepository): GitHubRepositoryRecord {
  return {
    id: repository.id,
    ownerLogin: repository.owner.login,
    name: repository.name,
    fullName: repository.full_name,
    defaultBranch: repository.default_branch,
    htmlUrl: repository.html_url,
    cloneUrl: repository.clone_url,
    private: repository.private
  };
}

async function fetchGitHubRepositoryForValidation(
  installationClient: GitHubInstallationClient,
  owner: string,
  repo: string
): Promise<GitHubRepository> {
  try {
    return await installationClient.getRepository(owner, repo);
  } catch (error) {
    throw new HttpError(404, error instanceof Error ? error.message : "GitHub repository lookup failed.");
  }
}

async function fetchGitHubCommitForValidation(
  installationClient: GitHubInstallationClient,
  owner: string,
  repo: string,
  ref: string
): Promise<{ sha: string }> {
  try {
    return await installationClient.getCommit(owner, repo, ref);
  } catch (error) {
    throw new HttpError(404, error instanceof Error ? error.message : "GitHub ref lookup failed.");
  }
}

function resolveProjectLifecycleStatus(
  project: ProjectRecord | null,
  latestJob: BuildJobRecord | null
): "not_deployed" | "queued" | "running" | "live" | "failed" {
  if (!latestJob) {
    return project ? "live" : "not_deployed";
  }

  return normalizeBuildJobStatus(latestJob.status);
}

function normalizeBuildJobStatus(
  status: BuildJobStatus
): "queued" | "running" | "live" | "failed" {
  switch (status) {
    case "queued":
      return "queued";
    case "in_progress":
    case "deploying":
      return "running";
    case "success":
      return "live";
    case "failure":
      return "failed";
  }
}

function normalizeBuildJobLifecycleStatus(
  eventName: BuildJobEventName,
  status: BuildJobStatus
): "queued" | "running" | "live" | "passed" | "failed" {
  const normalized = normalizeBuildJobStatus(status);
  if (eventName === "validate" && normalized === "live") {
    return "passed";
  }

  return normalized;
}

function buildProjectDeploymentUrl(env: Env, projectName: string): string {
  const projectHostSuffix = env.PROJECT_HOST_SUFFIX?.trim().replace(/^\.+|\.+$/g, "");
  if (projectHostSuffix) {
    return `https://${projectName}.${projectHostSuffix}`;
  }

  return `${env.PROJECT_BASE_URL.replace(/\/$/, "")}/${projectName}`;
}

function exampleProjectDeploymentUrl(env: Env): string {
  return buildProjectDeploymentUrl(env, "<project-name>");
}

function resolveProjectPublicBaseUrl(env: Env): string {
  const projectHostSuffix = env.PROJECT_HOST_SUFFIX?.trim().replace(/^\.+|\.+$/g, "");
  if (projectHostSuffix) {
    return `https://${projectHostSuffix}`;
  }

  return env.PROJECT_BASE_URL.replace(/\/$/, "");
}

function resolvePublicRuntimeManifestUrl(env: Env, serviceBaseUrl: string): string {
  const projectHostSuffix = env.PROJECT_HOST_SUFFIX?.trim().replace(/^\.+|\.+$/g, "");
  if (projectHostSuffix) {
    return `https://runtime.${projectHostSuffix}/.well-known/cail-runtime.json`;
  }

  return `${serviceBaseUrl.replace(/\/$/, "")}/.well-known/cail-runtime.json`;
}

function resolveReservedProjectNames(
  env: Pick<Env, "PROJECT_HOST_SUFFIX" | "DEPLOY_SERVICE_BASE_URL">,
  serviceBaseUrl?: string
): Set<string> {
  const reserved = new Set<string>();
  const projectHostSuffix = env.PROJECT_HOST_SUFFIX?.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!projectHostSuffix) {
    return reserved;
  }

  const resolvedServiceBaseUrl = serviceBaseUrl ?? env.DEPLOY_SERVICE_BASE_URL ?? "https://deploy.invalid";

  let runtimeHostname: string | undefined;
  try {
    runtimeHostname = new URL(resolvePublicRuntimeManifestUrl(env as Env, resolvedServiceBaseUrl)).hostname.toLowerCase();
  } catch {
    runtimeHostname = undefined;
  }

  if (!runtimeHostname || !runtimeHostname.endsWith(`.${projectHostSuffix}`)) {
    return reserved;
  }

  const candidate = runtimeHostname.slice(0, -(projectHostSuffix.length + 1));
  if (isValidProjectName(candidate)) {
    reserved.add(candidate);
  }

  return reserved;
}
