import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  OAuthProvider,
  getOAuthApi,
  type OAuthHelpers,
  type OAuthProviderOptions
} from "@cloudflare/workers-oauth-provider";

import { createDeployServiceMcpServer as createDeployServiceMcpSurface } from "./deploy-service-mcp";
import { HttpError, asHttpError } from "./http-error";
import {
  authorizeProjectSecretsAccess,
  buildGitHubUserAuthorizeUrl,
  buildGitHubUserSecretsConnectUrl,
  createGitHubUserAuthStateToken,
  normalizeOptionalGitHubUserAuthReturnTo,
  resolveControlPlaneEncryptionKey,
  resolveGitHubUserAuthConfig,
  sealStoredToken,
  verifyGitHubUserAuthStateToken,
  type AgentRequestIdentity,
  type AuthenticatedAgentRequestIdentity,
  type ProjectSecretsAuthorization
} from "./project-admin-auth";
import { baseStyles, escapeHtml, faviconLink, logoHtml, serializeJsonForHtml } from "./ui";
import {
  type RepositoryInstallStatus,
  type RepositoryWorkflowStage
} from "./repository-lifecycle-presentation";
import {
  buildGuidedSetupUrl,
  renderGitHubRegisterPage,
  renderManifestErrorPage,
  renderManifestSuccessPage,
  renderOauthAuthorizationErrorPage,
  renderOauthLoopbackContinuePage
} from "./repository-onboarding-ui";
import {
  createGitHubInstallResponse,
  createGitHubSetupResponse
} from "./repository-onboarding-controller";
import {
  describeGitHubUserAuthContinueLabel,
  renderGitHubUserAuthErrorPage,
  renderGitHubUserAuthSuccessPage,
} from "./project-control-ui";
import {
  createProjectAdminEntryResponse,
  createProjectControlPanelResponse,
  createProjectControlProjectDeleteResponse,
  createProjectControlSecretDeleteResponse,
  createProjectControlSecretSetResponse
} from "./project-control-controller";
import {
  buildFeaturedProjectsAdminRecords,
  clearFeaturedProjectForLiveProject,
  createFeaturedProjectsAdminPageResponse,
  createFeaturedProjectsAdminUpdateResponse,
  setFeaturedProjectForLiveProject
} from "./featured-projects-controller";
import { renderFeaturedProjectsPage } from "./featured-projects-ui";
import {
  buildHarnessPromptContext,
  buildConnectionClientUpdatePolicy,
  buildConnectionLocalWrapperStatus,
  buildConnectionDynamicSkillPolicy,
  buildConnectionHarnessCatalog,
  buildLandingPageHarnessInstallInstructions,
  buildRuntimeClientUpdatePolicy,
  buildRuntimeDynamicSkillPolicy,
  buildRuntimeHarnessCatalog
} from "./harness-onboarding";
import {
  ensurePrimaryProjectDomainLabel
} from "./project-domains";
import {
  buildProjectSecretBindings,
  buildProjectSecretsListPayload,
  removeProjectSecretValue,
  setProjectSecretValue,
  type ProjectSecretsAccessContext
} from "./project-secrets";
import {
  assertProjectDeleteConfirmation,
  deleteProjectFromKale,
  resumePendingProjectDeletionBacklogs
} from "./project-delete";
import {
  canAutoPromoteToSharedStatic,
  DEFAULT_RUNTIME_LANE,
  recommendRuntimeLane
} from "./runtime-lanes";
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
  deleteProjectByName,
  deleteProjectDomain,
  deleteGitHubUserAuthByGitHubUserId,
  deleteFeaturedProject,
  deleteOwnerCapacityOverride,
  ensureProjectPolicy,
  getBuildJob,
  getBuildJobByDeliveryId,
  getFeaturedProject,
  getDeployment,
  getLatestBuildJobForProject,
  getLatestProjectForRepository,
  getOwnerCapacityOverride,
  getPrimaryProjectDomainForProject,
  getProjectDeletionBacklog,
  listProjectDeletionBacklogs,
  listLiveDedicatedWorkerProjectsForOwner,
  listOwnerCapacityOverrides,
  getPreferredProjectNameForRepository,
  getProjectDomain,
  getProject,
  listActiveBuildJobsForRepository,
  listExpiredRetainedFailedDeployments,
  listFeaturedProjects,
  listProjects,
  listRetainedSuccessfulDeploymentsForRepository,
  putFeaturedProject,
  putGitHubUserAuth,
  putBuildJob,
  putOwnerCapacityOverride,
  putProjectDomain,
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
  type GitHubCheckRunConclusion,
  type GitHubCheckRunOutput,
  type GitHubAppManifest,
  type GitHubRepository,
  type GitHubRepositoryInstallation,
  verifyGitHubWebhookSignature
} from "./lib/github";
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
  RuntimeEvidence,
  StaticAssetUpload,
  WorkerAssetsConfig,
  WorkerBinding
} from "@cuny-ai-lab/build-contract";
import {
  buildLoadedSharedStaticManifest,
  collectSharedStaticValidationPaths,
  normalizeSharedStaticPath,
  resolveSharedStaticRequest,
  stripLeadingSlash
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
  CLOUDFLARE_R2_ACCESS_KEY_ID?: string;
  CLOUDFLARE_R2_SECRET_ACCESS_KEY?: string;
  CLOUDFLARE_ACCESS_AUD?: string;
  CLOUDFLARE_ACCESS_ALLOWED_EMAILS?: string;
  CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS?: string;
  CLOUDFLARE_ACCESS_TEAM_DOMAIN?: string;
  KALE_ADMIN_EMAILS?: string;
  FEATURED_PROJECT_ADMIN_EMAILS?: string;
  DEFAULT_MAX_LIVE_DEDICATED_WORKERS_PER_OWNER?: string;
  MCP_OAUTH_BASE_URL?: string;
  PROJECT_CONTROL_FORM_TOKEN_SECRET?: string;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER?: OAuthHelpers;
  WFP_NAMESPACE: string;
  PROJECT_BASE_URL: string;
  PROJECT_HOST_SUFFIX?: string;
  GATEWAY_PREVIEW_TOKEN?: string;
  SHARED_STATIC_VALIDATION_ATTEMPTS?: string;
  SHARED_STATIC_VALIDATION_RETRY_MS?: string;
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

type ProjectLifecycleStatus = "not_deployed" | "queued" | "running" | "live" | "failed";

type CloudflareAccessRequestIdentity = {
  type: "cloudflare_access";
  subject: string;
  email: string;
};

// `McpAuthProps` is the application payload the workers-oauth-provider carries through
// grants, access tokens, and refresh tokens. It is populated in `/api/oauth/authorize`
// after Cloudflare Access authenticates the user, or by the `resolveExternalToken`
// callback for Kale personal access tokens. The provider pre-validates the bearer
// token on every `/mcp` request and surfaces this payload as `ctx.props`.
export type McpAuthProps = {
  email: string;
  subject: string;
  source: "mcp_oauth" | "mcp_pat";
  scope?: string[];
  clientId?: string;
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
  latestStatus: ProjectLifecycleStatus;
  servingStatus: "live" | "not_deployed";
  buildStatus?: BuildJobStatus;
  buildJobId?: string;
  buildJobStatusUrl?: string;
  deploymentUrl?: string;
  errorKind?: string;
  errorMessage?: string;
  errorHint?: string;
  errorDetail?: string;
  updatedAt?: string;
};

type ApiResponseStatus = 200 | 202 | 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 502 | 503;

export const deployServiceApp = new Hono<{ Bindings: Env }>();
const DEFAULT_SUCCESSFUL_ARTIFACT_RETENTION = 2;
const DEFAULT_FAILED_ARTIFACT_RETENTION_DAYS = 7;
const DEFAULT_MAX_LIVE_DEDICATED_WORKERS_PER_OWNER = 5;
const DEFAULT_SHARED_STATIC_VALIDATION_ATTEMPTS = 15;
const DEFAULT_SHARED_STATIC_VALIDATION_RETRY_MS = 8_000;
const SHARED_STATIC_VALIDATION_FETCH_BUDGET = 30;
const STALE_QUEUED_BUILD_WINDOW_MS = 10 * 60 * 1000;
const STALE_STARTED_BUILD_WINDOW_MS = 2 * 60 * 60 * 1000;
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
const PROJECT_DELETE_CONFIG = {
  resolveRequiredCloudflareApiToken
};
const PROJECT_ADMIN_AUTH_DEPENDENCIES = {
  resolveServiceBaseUrl,
  resolveMcpOauthBaseUrl,
  buildConnectionHealthPayload
};

const mcpCors = cors({
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
});

deployServiceApp.use("/mcp", mcpCors);
deployServiceApp.use("/mcp/*", mcpCors);

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

deployServiceApp.use("*", async (c, next) => {
  c.executionCtx.waitUntil(
    resumePendingProjectDeletionBacklogs(c.env, PROJECT_DELETE_CONFIG, { limit: 1 }).catch((error) => {
      console.error("Pending project deletion cleanup failed.", { error });
    })
  );
  await next();
});

deployServiceApp.get("/healthz", (c) => c.json({ ok: true }));

deployServiceApp.get("/.well-known/kale-runtime.json", (c) => {
  const serviceBaseUrl = resolveServiceBaseUrl(c.env, c.req.raw.url);
  return c.json(buildRuntimeManifest(c.env, serviceBaseUrl), 200, {
    "cache-control": "public, max-age=300"
  });
});

deployServiceApp.get("/.well-known/kale-connection.json", (c) => {
  const serviceBaseUrl = resolveServiceBaseUrl(c.env, c.req.raw.url);
  return c.json(buildConnectionHealthPayload(
    c.env,
    serviceBaseUrl,
    undefined,
    {
      harnessId: c.req.query("harness") ?? undefined,
      localBundleVersion: c.req.query("localBundleVersion") ?? undefined
    }
  ), 200, {
    "cache-control": "public, max-age=300"
  });
});

// `/mcp/ping` is served via the OAuth provider's apiHandler (the provider handles 401s
// for missing/invalid tokens and only dispatches here when it has already validated a
// bearer grant). See `handleMcpPing` below and the default export for wiring.
export function handleMcpPing(request: Request, env: Env, props: McpAuthProps): Response {
  const serviceBaseUrl = resolveServiceBaseUrl(env, request.url);
  const url = new URL(request.url);
  const identity: AgentRequestIdentity = {
    type: props.source,
    email: props.email,
    subject: props.subject
  };
  return Response.json(buildConnectionHealthPayload(
    env,
    serviceBaseUrl,
    identity,
    {
      harnessId: url.searchParams.get("harness") ?? undefined,
      localBundleVersion: url.searchParams.get("localBundleVersion") ?? undefined
    }
  ));
}

// `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource[/mcp]`
// are implemented by the Cloudflare Workers OAuth Provider wrapper (see the default export
// at the bottom of this module). Dynamic client registration (`/oauth/register`) and the
// token endpoint (`/oauth/token`) are also served by the provider. The only OAuth handler
// Kale still implements directly is the browser-facing authorize endpoint below, which is
// where Cloudflare Access captures institutional identity and hands it back to the
// provider via `completeAuthorization`.

deployServiceApp.get("/api/oauth/authorize", async (c) => {
  const oauthProvider = c.env.OAUTH_PROVIDER;
  if (!oauthProvider) {
    return c.html(
      renderOauthAuthorizationErrorPage("OAuth provider is not wired into this deployment."),
      503
    );
  }

  let authRequest;
  try {
    authRequest = await oauthProvider.parseAuthRequest(c.req.raw);
  } catch (error) {
    const httpError = asHttpError(error);
    return c.html(renderOauthAuthorizationErrorPage(httpError.message), httpError.status);
  }

  try {
    const client = await oauthProvider.lookupClient(authRequest.clientId);
    if (!client) {
      throw new HttpError(400, "Unknown OAuth client.");
    }
    if (!client.redirectUris.includes(authRequest.redirectUri)) {
      throw new HttpError(400, "OAuth redirect URI is not registered for this client.");
    }

    const identity = await requireCloudflareAccessIdentity(c.req.raw, c.env);

    const grantedScope = normalizeMcpAuthorizationScopes(authRequest.scope);
    const props: McpAuthProps = {
      email: identity.email,
      subject: identity.subject,
      source: "mcp_oauth",
      scope: grantedScope,
      clientId: authRequest.clientId
    };

    const { redirectTo } = await oauthProvider.completeAuthorization({
      request: authRequest,
      userId: identity.email,
      metadata: {
        email: identity.email,
        subject: identity.subject,
        clientName: client.clientName ?? null
      },
      scope: grantedScope,
      props
    });

    const redirectUrl = new URL(redirectTo);
    if (isLoopbackRedirectUri(redirectUrl)) {
      return c.html(renderOauthLoopbackContinuePage({
        callbackUrl: redirectUrl.toString(),
        appName: client.clientName ?? "your agent"
      }));
    }
    return Response.redirect(redirectUrl.toString(), 302);
  } catch (error) {
    const httpError = asHttpError(error);
    return c.html(renderOauthAuthorizationErrorPage(httpError.message), httpError.status);
  }
});

function isLoopbackRedirectUri(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  return url.protocol === "http:" && (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

// ── MCP token bridge (Claude Code fallback) ─────────────────────────
// Behind Cloudflare Access. Lets the user generate a personal MCP token
// that they can paste into their agent when the OAuth browser flow is broken.

deployServiceApp.get("/connect", async (c) => {
  try {
    const identity = await requireCloudflareAccessIdentity(c.req.raw, c.env);
    const serviceBaseUrl = resolveServiceBaseUrl(c.env, c.req.raw.url);

    const existing = await c.env.CONTROL_PLANE_DB.prepare(
      "SELECT created_at, expires_at FROM mcp_tokens WHERE email = ? AND revoked_at IS NULL AND datetime(expires_at) > datetime('now') ORDER BY created_at DESC LIMIT 1"
    ).bind(identity.email).first<{ created_at: string; expires_at: string }>();

    return c.html(renderConnectPage({
      serviceBaseUrl,
      email: identity.email,
      hasActiveToken: !!existing,
      activeTokenCreatedAt: existing?.created_at,
      activeTokenExpiresAt: existing?.expires_at
    }));
  } catch (error) {
    const httpError = asHttpError(error);
    return c.html(renderConnectPage({ error: httpError.message }), httpError.status);
  }
});

deployServiceApp.post("/connect/generate", async (c) => {
  try {
    const identity = await requireCloudflareAccessIdentity(c.req.raw, c.env);

    // Revoke any existing tokens for this user.
    await c.env.CONTROL_PLANE_DB.prepare(
      "UPDATE mcp_tokens SET revoked_at = datetime('now') WHERE email = ? AND revoked_at IS NULL"
    ).bind(identity.email).run();

    // Generate a new token: kale_pat_ + 48 random bytes (base64url).
    const randomBytes = new Uint8Array(48);
    crypto.getRandomValues(randomBytes);
    const tokenSuffix = btoa(String.fromCharCode(...randomBytes))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    const token = `kale_pat_${tokenSuffix}`;

    const hash = await hashPatToken(token);
    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().replace("Z", "").split(".")[0];

    await c.env.CONTROL_PLANE_DB.prepare(
      "INSERT INTO mcp_tokens (token_hash, email, subject, label, expires_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(hash, identity.email, identity.subject, "Generated from /connect", expiresAt).run();

    const serviceBaseUrl = resolveServiceBaseUrl(c.env, c.req.raw.url);
    return c.html(renderConnectPage({
      serviceBaseUrl,
      email: identity.email,
      generatedToken: token,
      hasActiveToken: true,
      activeTokenExpiresAt: expiresAt
    }));
  } catch (error) {
    const httpError = asHttpError(error);
    return c.html(renderConnectPage({ error: httpError.message }), httpError.status);
  }
});

deployServiceApp.post("/connect/revoke", async (c) => {
  try {
    const identity = await requireCloudflareAccessIdentity(c.req.raw, c.env);
    await c.env.CONTROL_PLANE_DB.prepare(
      "UPDATE mcp_tokens SET revoked_at = datetime('now') WHERE email = ? AND revoked_at IS NULL"
    ).bind(identity.email).run();

    const serviceBaseUrl = resolveServiceBaseUrl(c.env, c.req.raw.url);
    return c.html(renderConnectPage({
      serviceBaseUrl,
      email: identity.email,
      hasActiveToken: false,
      revokedMessage: "Token revoked. You can generate a new one."
    }));
  } catch (error) {
    const httpError = asHttpError(error);
    return c.html(renderConnectPage({ error: httpError.message }), httpError.status);
  }
});

deployServiceApp.get("/", async (c) => {
  const serviceBaseUrl = resolveServiceBaseUrl(c.env, c.req.raw.url);
  const oauthBaseUrl = resolveMcpOauthBaseUrl(c.env, c.req.raw.url);
  const appName = resolveGitHubAppName(c.env);
  const appSlug = resolveGitHubAppSlug(c.env);
  const installUrl = appSlug ? githubAppInstallUrl(appSlug) : undefined;
  const runtimeManifestUrl = resolvePublicRuntimeManifestUrl(c.env, serviceBaseUrl);
  const repositoryUrl = "https://github.com/CUNY-AI-Lab/CAIL-deploy";
  const featuredProjects = (await listFeaturedProjects(c.env.CONTROL_PLANE_DB)).slice(0, 6);
  const showcaseProjects = featuredProjects.length > 0
    ? featuredProjects
    : (await listProjects(c.env.CONTROL_PLANE_DB)).slice(0, 6);
  const showcaseProjectCount = showcaseProjects.length;
  const showcaseLabel = featuredProjects.length > 0 ? "Featured projects" : "Live projects";
  const marketingName = "Kale Deploy";
  const marketingSource = "From the CUNY AI Lab";
  const buildPrompt = `Build me a small web app with ${marketingName} and put it online so I can see it live.`;
  const harnessPromptContext = buildHarnessPromptContext(marketingName, serviceBaseUrl);
  const agents = buildLandingPageHarnessInstallInstructions(harnessPromptContext);
  const renderAgentInstallPanel = (agent: ReturnType<typeof buildLandingPageHarnessInstallInstructions>[number], index: number) => {
    const notesHtml = agent.installNotes.length > 0
      ? `<ul class="install-notes">${agent.installNotes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>`
      : "";

    if (agent.installMode === "app_ui") {
      const fallbackHtml = agent.manualFallback
        ? `
          <div class="install-fallback">
            <p class="install-fallback-label">Manual fallback</p>
            <div class="prompt-block" data-prompt="${escapeHtml(agent.manualFallback.instruction)}">${escapeHtml(agent.manualFallback.instruction)}<button class="copy-btn" type="button" title="Copy to clipboard">${clipboardSvg}</button></div>
            <p class="tab-hint">${escapeHtml(agent.manualFallback.hint)}</p>
            ${agent.manualFallback.notes.length > 0 ? `<ul class="install-notes install-notes-subtle">${agent.manualFallback.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>` : ""}
          </div>
        `
        : "";

      return `<div class="tab-panel${index === 0 ? " active" : ""}" data-idx="${index}" role="tabpanel">
        <div class="install-ui-card">
          <p class="install-ui-copy">${escapeHtml(agent.instruction)}</p>
        </div>
        <p class="tab-hint">${escapeHtml(agent.hint)}</p>
        ${notesHtml}
        ${fallbackHtml}
      </div>`;
    }

    return `<div class="tab-panel${index === 0 ? " active" : ""}" data-idx="${index}" role="tabpanel">
      <div class="prompt-block" data-prompt="${escapeHtml(agent.instruction)}">${escapeHtml(agent.instruction)}<button class="copy-btn" type="button" title="Copy to clipboard">${clipboardSvg}</button></div>
      <p class="tab-hint">${escapeHtml(agent.hint)}</p>
      ${notesHtml}
    </div>`;
  };

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
    <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,700;9..144,800&family=Outfit:wght@400;500;600;700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,500&display=swap" rel="stylesheet" />
    ${faviconLink()}
    ${baseStyles(`
      :root { --font-body: "Outfit", system-ui, sans-serif; }

      @keyframes fadeUp {
        from { opacity: 0; transform: translateY(16px); }
        to { opacity: 1; transform: translateY(0); }
      }

      /* ── Hero ── */
      .hero {
        text-align: center;
        padding: 3.5rem 0 2.75rem;
        animation: fadeUp 0.5s ease-out;
      }
      .hero .logo { margin: 0 auto 1rem; }
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
        margin: 0 auto 0.5rem;
        font-family: 'Source Serif 4', Georgia, serif;
        font-size: 1.15rem;
        color: var(--muted);
        line-height: 1.6;
      }
      .hero .sub-lead {
        max-width: 46ch;
        margin: 0 auto 2rem;
        font-size: 0.92rem;
        color: var(--muted);
        line-height: 1.65;
      }

      /* ── How it works ── */
      .how-it-works {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        margin: 0 auto;
        padding: 1rem 1.5rem;
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 14px;
        max-width: 460px;
        box-shadow: 0 2px 8px rgba(27, 42, 74, 0.04);
        flex-wrap: wrap;
      }
      .how-step {
        display: flex;
        align-items: center;
        gap: 7px;
        font-size: 0.8rem;
        font-weight: 600;
        color: var(--ink);
      }
      .how-num {
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background: var(--accent);
        color: white;
        font-size: 0.68rem;
        font-weight: 700;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }
      .how-arrow {
        color: var(--border);
        font-size: 1rem;
      }

      /* ── Step sections ── */
      .step-section {
        max-width: 560px;
        margin: 2.25rem auto 0;
        animation: fadeUp 0.5s ease-out 0.1s both;
      }
      .step-header { margin-bottom: 1rem; }
      .step-badge {
        display: inline-block;
        padding: 3px 10px;
        background: var(--notice-bg);
        border: 1px solid rgba(59, 107, 204, 0.2);
        border-radius: 999px;
        font-size: 0.68rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--accent);
        margin-bottom: 8px;
      }
      .step-section h2 {
        font-size: 1.05rem;
        font-weight: 700;
        color: var(--ink);
        margin: 0 0 5px;
      }
      .step-desc {
        font-size: 0.86rem;
        color: var(--muted);
        margin: 0 0 14px;
        line-height: 1.55;
      }

      /* ── Agent tabs ── */
      .agent-tabs {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 12px;
        overflow: hidden;
        box-shadow: 0 1px 4px rgba(27, 42, 74, 0.05);
      }
      .tab-bar {
        display: flex;
        gap: 2px;
        padding: 5px 5px 0;
        background: var(--bg);
        border-bottom: 1px solid var(--border);
      }
      .tab-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 11px 7px;
        border: 1px solid transparent;
        border-bottom: none;
        background: transparent;
        border-radius: 7px 7px 0 0;
        font: inherit;
        font-size: 0.78rem;
        font-weight: 600;
        color: var(--muted);
        cursor: pointer;
        position: relative;
        bottom: -1px;
        transition: color 0.15s;
      }
      .tab-btn:hover { color: var(--ink); }
      .tab-btn.active {
        color: var(--ink);
        background: var(--panel);
        border-color: var(--border);
        border-bottom-color: var(--panel);
      }
      .tab-ico {
        width: 18px;
        height: 18px;
        border-radius: 5px;
        background: linear-gradient(135deg, var(--accent), var(--teal));
        color: white;
        font-size: 0.62rem;
        font-weight: 800;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }
      .tab-panel { display: none; }
      .tab-panel.active { display: block; }
      .tab-panel .prompt-block {
        margin: 0;
        border-radius: 0;
      }
      .install-ui-card {
        margin: 0;
        padding: 14px 14px 10px;
        background: linear-gradient(180deg, rgba(59, 107, 204, 0.06), rgba(23, 162, 184, 0.04));
        border-bottom: 1px solid var(--border);
      }
      .install-ui-label,
      .install-fallback-label {
        margin: 0 0 0.45rem;
        font-size: 0.72rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--teal);
      }
      .install-ui-copy {
        margin: 0;
        font-size: 0.92rem;
        line-height: 1.6;
        color: var(--ink);
      }
      .install-fallback {
        margin: 8px 8px 10px;
        border: 1px solid var(--border);
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.82);
        padding: 10px 10px 8px;
      }
      .install-fallback .prompt-block {
        margin: 0;
        border-radius: 8px;
      }
      .install-notes {
        margin: 0;
        padding: 0 24px 12px 28px;
        color: var(--muted);
        font-size: 0.76rem;
        line-height: 1.55;
      }
      .install-notes-subtle {
        padding: 0 0 0 18px;
        font-size: 0.72rem;
      }

      /* ── Prompt blocks (shared) ── */
      .prompt-block {
        position: relative;
        margin: 0 8px 8px;
        background: var(--code-bg);
        border-radius: 8px;
        padding: 9px 36px 9px 11px;
        font-family: var(--font-mono);
        font-size: 0.78rem;
        line-height: 1.45;
        color: var(--ink);
        white-space: pre-wrap;
        word-break: break-word;
        cursor: pointer;
        transition: background 0.15s;
      }
      .prompt-block:hover { background: #e4eaf2; }
      .copy-btn {
        position: absolute;
        top: 7px;
        right: 7px;
        width: 26px;
        height: 26px;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: var(--muted);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: color 0.15s, background 0.15s;
      }
      .copy-btn:hover { background: var(--border); color: var(--ink); }
      .copy-btn.copied { color: var(--success); }

      /* ── Build block ── */
      .build-block {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 12px;
        box-shadow: 0 1px 4px rgba(27, 42, 74, 0.05);
        overflow: hidden;
        transition: border-color 0.2s, box-shadow 0.2s;
      }
      .build-block:hover {
        border-color: var(--accent);
        box-shadow: 0 4px 16px rgba(59, 107, 204, 0.08);
      }
      .build-header {
        display: flex;
        align-items: center;
        gap: 9px;
        padding: 10px 12px 0;
      }
      .build-ico {
        width: 24px;
        height: 24px;
        border-radius: 7px;
        background: linear-gradient(135deg, var(--accent), var(--teal));
        color: white;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }
      .build-ico svg { width: 14px; height: 14px; }
      .build-label {
        font-weight: 700;
        font-size: 0.82rem;
        color: var(--ink);
      }
      .build-hint {
        font-size: 0.7rem;
        color: var(--muted);
        padding: 4px 12px 0;
        margin: 0;
        opacity: 0.85;
        line-height: 1.5;
      }
      .build-block .prompt-block {
        margin: 6px 8px 8px;
        border-radius: 8px;
        padding: 7px 36px 7px 11px;
      }

      /* ── Tab hint ── */
      .tab-hint {
        font-size: 0.7rem;
        color: var(--muted);
        padding: 4px 11px 6px;
        margin: 0;
        opacity: 0.8;
      }

      /* ── Existing repo ── */
      .existing-section {
        max-width: 560px;
        margin: 2.25rem auto 0;
        padding-top: 1.75rem;
        border-top: 1px solid var(--border);
        animation: fadeUp 0.5s ease-out 0.3s both;
      }
      .existing-section h3 {
        font-size: 0.92rem;
        font-weight: 700;
        color: var(--ink);
        margin: 0 0 4px;
      }
      .existing-section > p {
        font-size: 0.82rem;
        color: var(--muted);
        margin: 0 0 12px;
        line-height: 1.5;
      }
      .repo-form { display: flex; gap: 8px; }
      .repo-form input {
        flex: 1;
        padding: 9px 14px;
        border: 1px solid var(--border);
        border-radius: 10px;
        font: inherit;
        font-size: 0.88rem;
        background: var(--panel);
        color: var(--ink);
      }
      .repo-form input::placeholder { color: var(--muted); opacity: 0.7; }
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
      .live-section {
        max-width: 560px;
        margin: 2rem auto 0;
        animation: fadeUp 0.5s ease-out 0.4s both;
      }
      .live-label {
        font-size: 0.72rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: var(--muted);
        margin: 0 0 10px;
      }
      .live-list { display: flex; flex-wrap: wrap; gap: 8px; }
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
        flex-shrink: 0;
      }

      /* ── Footer ── */
      .page-footer {
        max-width: 560px;
        margin: 2.5rem auto 0;
        padding-top: 1.5rem;
        border-top: 1px solid var(--border);
        display: flex;
        justify-content: center;
        gap: 20px;
        font-size: 0.8rem;
      }
      .page-footer a {
        color: var(--muted);
        text-decoration: none;
        transition: color 0.15s;
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
        <p class="lead">A web publishing tool from the CUNY AI Lab.</p>
        <p class="sub-lead">Describe what you want to build to your AI coding agent. It writes the code and puts it online at a CUNY URL.</p>
        <div class="how-it-works">
          <div class="how-step"><span class="how-num">1</span>Install once</div>
          <span class="how-arrow">&#8594;</span>
          <div class="how-step"><span class="how-num">2</span>Describe your idea</div>
          <span class="how-arrow">&#8594;</span>
          <div class="how-step"><span class="how-num">3</span>Get a live URL</div>
        </div>
      </section>

      <section class="step-section">
        <div class="step-header">
          <span class="step-badge">Step 1</span>
          <h2>Add Kale to your agent</h2>
          <p class="step-desc">Use this install step once in your AI agent. After that, it can build and deploy apps for you.</p>
        </div>
        <div class="agent-tabs">
          <div class="tab-bar" role="tablist">
            ${agents.map((agent, i) => `<button class="tab-btn${i === 0 ? " active" : ""}" data-idx="${i}" role="tab" aria-selected="${i === 0 ? "true" : "false"}"><span class="tab-ico">${escapeHtml(agent.letter)}</span>${escapeHtml(agent.name)}</button>`).join("")}
          </div>
          ${agents.map((agent, i) => renderAgentInstallPanel(agent, i)).join("")}
        </div>
      </section>

      <section class="step-section" style="animation-delay:0.2s">
        <div class="step-header">
          <span class="step-badge">Step 2</span>
          <h2>Tell your agent what to build</h2>
        </div>
        <div class="build-block">
          <div class="build-header">
            <span class="build-ico"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13 12 3"/><path d="M12 3v4"/><path d="M12 3H8"/></svg></span>
            <span class="build-label">Starter prompt</span>
          </div>
          <p class="build-hint">Copy this into your agent, or describe your own idea in plain language.</p>
          <div class="prompt-block" data-prompt="${escapeHtml(buildPrompt)}" id="build-prompt">${escapeHtml(buildPrompt)}<button class="copy-btn" type="button" title="Copy to clipboard">${clipboardSvg}</button></div>
        </div>
      </section>

      <section class="existing-section">
        <h3>Already have a GitHub repo?</h3>
        <p>Enter your repository name to connect it with ${escapeHtml(marketingName)}.</p>
        <form class="repo-form" method="get" action="${escapeHtml(`${serviceBaseUrl}/github/setup`)}">
          <input type="text" name="repositoryFullName" placeholder="owner/repo" aria-label="GitHub repository" />
          <button type="submit">Connect</button>
        </form>
      </section>

      ${showcaseProjectCount > 0 ? `
      <section class="live-section">
        <p class="live-label">${escapeHtml(showcaseLabel)}</p>
        <div class="live-list">${showcaseProjects.map((project) => `
          <a class="live-chip" href="${escapeHtml(project.deploymentUrl)}">
            <span class="live-dot"></span>
            ${escapeHtml(project.projectName)}
          </a>
        `).join("")}</div>
      </section>
      ` : ""}

      <footer class="page-footer">
        ${installUrl ? `<a href="${escapeHtml(installUrl)}">Install GitHub App</a>` : ""}
        <a href="${escapeHtml(`${serviceBaseUrl}/featured`)}">Featured Projects</a>
        <a href="${escapeHtml(`${serviceBaseUrl}/projects/control`)}">My Projects</a>
        <a href="${escapeHtml(repositoryUrl)}">GitHub</a>
      </footer>
    </main>

    <script>
    const clipboardIcon = ${JSON.stringify(clipboardSvg)};
    const checkIcon = ${JSON.stringify(checkSvg)};

    document.querySelectorAll('.prompt-block').forEach(block => {
      const copyBtn = block.querySelector('.copy-btn');
      const promptText = block.dataset.prompt;
      if (!copyBtn || !promptText) {
        return;
      }

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

    document.querySelectorAll('.tab-bar').forEach(tabBar => {
      tabBar.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const tabs = tabBar.closest('.agent-tabs');
          const idx = btn.dataset.idx;
          tabs.querySelectorAll('.tab-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.idx === idx);
            b.setAttribute('aria-selected', b.dataset.idx === idx ? 'true' : 'false');
          });
          tabs.querySelectorAll('.tab-panel').forEach(p => {
            p.classList.toggle('active', p.dataset.idx === idx);
          });
        });
      });
    });
    </script>
  </body>
</html>`);
});

deployServiceApp.get("/featured", async (c) => {
  const serviceBaseUrl = resolveServiceBaseUrl(c.env, c.req.raw.url);
  const projects = await listFeaturedProjects(c.env.CONTROL_PLANE_DB);
  return c.html(renderFeaturedProjectsPage({
    serviceBaseUrl,
    projects
  }));
});

deployServiceApp.get("/featured/control", async (c) => {
  return createFeaturedProjectsAdminPageResponse({
    env: c.env,
    request: c.req.raw,
    requireFeaturedProjectAdminIdentity,
    resolveServiceBaseUrl,
    listProjects: (env) => listProjects(env.CONTROL_PLANE_DB),
    listFeaturedProjects: (env) => listFeaturedProjects(env.CONTROL_PLANE_DB),
    resolveProjectControlFormTokenSecret
  });
});

deployServiceApp.post("/featured/control", async (c) => {
  return createFeaturedProjectsAdminUpdateResponse({
    env: c.env,
    request: c.req.raw,
    requireFeaturedProjectAdminIdentity,
    resolveServiceBaseUrl,
    resolveProjectControlFormTokenSecret,
    getProject: (env, projectName) => getProject(env.CONTROL_PLANE_DB, projectName),
    getFeaturedProject: (env, githubRepo) => getFeaturedProject(env.CONTROL_PLANE_DB, githubRepo),
    putFeaturedProject: (env, feature) => putFeaturedProject(env.CONTROL_PLANE_DB, feature),
    deleteFeaturedProject: (env, githubRepo) => deleteFeaturedProject(env.CONTROL_PLANE_DB, githubRepo)
  });
});

deployServiceApp.get("/api/admin/overview", async (c) => {
  return runProtectedAdminApiAction(c, async () => {
    return c.json(await buildAdminOverviewPayload(c.env));
  });
});

deployServiceApp.put("/api/admin/owners/:ownerLogin/capacity", async (c) => {
  return runProtectedAdminApiAction(c, async () => {
    const ownerLogin = normalizeOwnerLoginRouteParam(c.req.param("ownerLogin"));
    const body = await parseAdminOwnerCapacityOverrideRequestBody(c.req.raw);
    const now = new Date().toISOString();
    const existing = await getOwnerCapacityOverride(c.env.CONTROL_PLANE_DB, ownerLogin);
    const override = {
      ownerLogin,
      maxLiveDedicatedWorkers: parseAdminOwnerCapacityLimit(body.maxLiveDedicatedWorkers),
      note: typeof body.note === "string" && body.note.trim() ? body.note.trim() : undefined,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    await putOwnerCapacityOverride(c.env.CONTROL_PLANE_DB, override);

    return c.json({
      ok: true,
      summary: override.maxLiveDedicatedWorkers === 0
        ? `${ownerLogin} now has no dedicated-worker cap override limit.`
        : `${ownerLogin} can now run up to ${override.maxLiveDedicatedWorkers} live dedicated-worker projects.`,
      ownerLogin: override.ownerLogin,
      capacityOverride: {
        maxLiveDedicatedWorkers: override.maxLiveDedicatedWorkers,
        note: override.note
      }
    });
  });
});

deployServiceApp.delete("/api/admin/owners/:ownerLogin/capacity", async (c) => {
  return runProtectedAdminApiAction(c, async () => {
    const ownerLogin = normalizeOwnerLoginRouteParam(c.req.param("ownerLogin"));
    await deleteOwnerCapacityOverride(c.env.CONTROL_PLANE_DB, ownerLogin);
    return c.json({
      ok: true,
      summary: `${ownerLogin} now uses the default dedicated-worker cap again.`,
      ownerLogin,
      capacityOverride: null
    });
  });
});

deployServiceApp.put("/api/admin/projects/:projectName/featured", async (c) => {
  return runProtectedAdminApiAction(c, async () => {
    const body = await parseAdminFeaturedProjectRequestBody(c.req.raw);
    const { project, feature } = await setFeaturedProjectForLiveProject({
      env: c.env,
      projectName: c.req.param("projectName"),
      getProject: (env, projectName) => getProject(env.CONTROL_PLANE_DB, projectName),
      getFeaturedProject: (env, githubRepo) => getFeaturedProject(env.CONTROL_PLANE_DB, githubRepo),
      putFeaturedProject: (env, featuredProject) => putFeaturedProject(env.CONTROL_PLANE_DB, featuredProject),
      headline: typeof body.headline === "string" && body.headline.trim() ? body.headline.trim() : undefined,
      sortOrder: parseAdminFeaturedProjectSortOrder(body.sortOrder)
    });

    return c.json({
      ok: true,
      summary: `${project.projectName} is now featured.`,
      projectName: project.projectName,
      githubRepo: feature.githubRepo,
      featured: {
        enabled: true,
        headline: feature.headline,
        sortOrder: feature.sortOrder
      }
    });
  });
});

deployServiceApp.delete("/api/admin/projects/:projectName/featured", async (c) => {
  return runProtectedAdminApiAction(c, async () => {
    const project = await clearFeaturedProjectForLiveProject({
      env: c.env,
      projectName: c.req.param("projectName"),
      getProject: (env, projectName) => getProject(env.CONTROL_PLANE_DB, projectName),
      deleteFeaturedProject: (env, githubRepo) => deleteFeaturedProject(env.CONTROL_PLANE_DB, githubRepo)
    });

    return c.json({
      ok: true,
      summary: `${project.projectName} is no longer featured.`,
      projectName: project.projectName,
      githubRepo: project.githubRepo,
      featured: {
        enabled: false
      }
    });
  });
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
  const response = c.html(renderGitHubRegisterPage({
    appName,
    manifestOrg,
    configuredSlug,
    registrationUrl,
    manifestJson: JSON.stringify(manifest),
    serviceBaseUrl
  }));
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
    const appName = registration.name ?? resolveGitHubAppName(c.env);
    const appSlug = registration.slug;
    const installUrl = appSlug ? githubAppInstallUrl(appSlug) : undefined;
    const envSnippet = [
      `GITHUB_APP_ID=${String(registration.id)}`,
      `GITHUB_APP_SLUG=${appSlug}`,
      `GITHUB_APP_NAME=${appName}`,
      registration.webhook_secret ? `GITHUB_WEBHOOK_SECRET=${registration.webhook_secret}` : ""
    ]
      .filter(Boolean)
      .join("\n");
    const response = c.html(renderManifestSuccessPage({
      appName,
      serviceBaseUrl,
      installUrl,
      appUrl: registration.html_url,
      envSnippet,
      pem: registration.pem
    }));
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
  return createGitHubInstallResponse({
    env: c.env,
    requestUrl: c.req.raw.url,
    cookieHeader: c.req.raw.headers.get("cookie") ?? undefined,
    repositoryFullName: c.req.query("repositoryFullName") ?? undefined,
    repositoryUrl: c.req.query("repositoryUrl") ?? undefined,
    projectName: c.req.query("projectName") ?? undefined,
    appName: resolveGitHubAppName(c.env),
    marketingName: "Kale Deploy",
    appSlug: resolveGitHubAppSlug(c.env),
    readGitHubInstallContext,
    parseOptionalRepositoryContext,
    parseRepositoryReference,
    buildRepositoryLifecycleState,
    resolveServiceBaseUrl,
    resolveMcpOauthBaseUrl,
    githubAppInstallUrl,
    serializeCookie,
    resolveCookiePath,
    installContextCookieName: GITHUB_INSTALL_CONTEXT_COOKIE,
    installContextMaxAgeSeconds: GITHUB_INSTALL_CONTEXT_MAX_AGE_SECONDS
  });
});

deployServiceApp.get("/github/setup", async (c) => {
  return createGitHubSetupResponse({
    env: c.env,
    requestUrl: c.req.raw.url,
    cookieHeader: c.req.raw.headers.get("cookie") ?? undefined,
    repositoryFullName: c.req.query("repositoryFullName") ?? undefined,
    repositoryUrl: c.req.query("repositoryUrl") ?? undefined,
    projectName: c.req.query("projectName") ?? undefined,
    installationId: c.req.query("installation_id") ?? undefined,
    setupAction: c.req.query("setup_action") ?? undefined,
    appName: resolveGitHubAppName(c.env),
    marketingName: "Kale Deploy",
    appSlug: resolveGitHubAppSlug(c.env),
    readGitHubInstallContext,
    parseOptionalRepositoryContext,
    parseRepositoryReference,
    buildRepositoryLifecycleState,
    resolveServiceBaseUrl,
    resolveMcpOauthBaseUrl,
    githubAppInstallUrl,
    serializeCookie,
    resolveCookiePath,
    installContextCookieName: GITHUB_INSTALL_CONTEXT_COOKIE,
    installContextMaxAgeSeconds: GITHUB_INSTALL_CONTEXT_MAX_AGE_SECONDS
  });
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
    error: "Kale Deploy no longer mints bearer tokens here. Use standard MCP OAuth discovery through /mcp."
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
      secret: resolveProjectControlFormTokenSecret(c.env),
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
      secret: resolveProjectControlFormTokenSecret(c.env),
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
  return runProtectedAgentApiAction(c, async () => {
    const body = await c.req.json<{
      repositoryUrl?: string;
      repositoryFullName?: string;
      projectName?: string;
    }>();
    const repository = parseRepositoryReference(body);
    const lifecycle = await buildRepositoryLifecycleState(c.env, c.req.raw.url, repository, body.projectName);
    return c.json(lifecycle.payload, lifecycle.httpStatus);
  });
});

deployServiceApp.get("/api/repositories/:owner/:repo/status", async (c) => {
  return runProtectedAgentApiAction(c, async () => {
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
  });
});

deployServiceApp.post("/api/validate", async (c) => {
  return runProtectedAgentApiAction(c, async () => {
    const body = await c.req.json<{
      repositoryUrl?: string;
      repositoryFullName?: string;
      ref?: string;
      projectName?: string;
    }>();
    const result = await queueValidationJob(c.env, c.req.raw.url, body);
    return c.json(result.body, { status: result.status });
  });
});

deployServiceApp.get("/api/projects/:projectName/status", async (c) => {
  return runProtectedAgentApiAction(c, async () => {
    const result = await buildProjectStatusResponse(c.env, c.req.param("projectName"));
    return c.json(result.body, { status: result.status });
  });
});

deployServiceApp.get("/api/projects/:projectName/secrets", async (c) => {
  return runProjectAdminAgentApiAction(c, c.req.param("projectName"), async (authorization) =>
    buildProjectSecretsListPayload(c.env, authorization.project, authorization.githubLogin)
  );
});

deployServiceApp.put("/api/projects/:projectName/secrets/:secretName", async (c) => {
  return runProjectAdminAgentApiAction(c, c.req.param("projectName"), async (authorization) => {
    const body = await c.req.json<{ value?: string }>();
    return setProjectSecretValue(
      c.env,
      PROJECT_SECRETS_CONFIG,
      authorization,
      c.req.param("secretName"),
      body.value
    );
  });
});

deployServiceApp.delete("/api/projects/:projectName/secrets/:secretName", async (c) => {
  return runProjectAdminAgentApiAction(c, c.req.param("projectName"), async (authorization) =>
    removeProjectSecretValue(
      c.env,
      PROJECT_SECRETS_CONFIG,
      authorization,
      c.req.param("secretName")
    )
  );
});

deployServiceApp.delete("/api/projects/:projectName", async (c) => {
  return runProjectAdminAgentApiAction(c, c.req.param("projectName"), async (authorization) => {
    let body: { confirmProjectName?: string };
    try {
      body = await c.req.json<{ confirmProjectName?: string }>();
    } catch {
      throw new HttpError(400, "Provide confirmProjectName in the request body to confirm permanent deletion.");
    }

    assertProjectDeleteConfirmation(c.req.param("projectName"), body.confirmProjectName);
    return deleteProjectFromKale(c.env, PROJECT_DELETE_CONFIG, authorization, {
      scheduleBackgroundCleanup: (task) => c.executionCtx.waitUntil(task)
    });
  });
});

deployServiceApp.get("/projects/control", async (c) => {
  return createProjectAdminEntryResponse({
    env: c.env,
    request: c.req.raw,
    requireCloudflareAccessIdentity,
    resolveServiceBaseUrl,
    normalizeRequestedProjectName,
    resolveReservedProjectNames,
    parseOptionalRepositoryContext
  });
});

deployServiceApp.get("/projects/:projectName/control", async (c) => {
  return createProjectControlPanelResponse({
    env: c.env,
    request: c.req.raw,
    projectName: c.req.param("projectName"),
    ...PROJECT_CONTROL_ROUTE_DEPENDENCIES,
    buildProjectStatusResponse,
    buildProjectSecretsListPayload,
  });
});

deployServiceApp.post("/projects/:projectName/control/secrets", async (c) => {
  return createProjectControlSecretSetResponse({
    env: c.env,
    request: c.req.raw,
    projectName: c.req.param("projectName"),
    ...PROJECT_CONTROL_ROUTE_DEPENDENCIES,
    setProjectSecretValue: (env, authorization, secretName, value) =>
      setProjectSecretValue(env, PROJECT_SECRETS_CONFIG, authorization, secretName, value)
  });
});

deployServiceApp.post("/projects/:projectName/control/secrets/:secretName/delete", async (c) => {
  return createProjectControlSecretDeleteResponse({
    env: c.env,
    request: c.req.raw,
    projectName: c.req.param("projectName"),
    secretName: c.req.param("secretName"),
    ...PROJECT_CONTROL_ROUTE_DEPENDENCIES,
    removeProjectSecretValue: (env, authorization, secretName) =>
      removeProjectSecretValue(env, PROJECT_SECRETS_CONFIG, authorization, secretName)
  });
});

deployServiceApp.post("/projects/:projectName/control/delete", async (c) => {
  return createProjectControlProjectDeleteResponse({
    env: c.env,
    request: c.req.raw,
    projectName: c.req.param("projectName"),
    ...PROJECT_CONTROL_ROUTE_DEPENDENCIES,
    deleteProject: (env, authorization) =>
      deleteProjectFromKale(env, PROJECT_DELETE_CONFIG, authorization, {
        scheduleBackgroundCleanup: (task) => c.executionCtx.waitUntil(task)
      })
  });
});

async function runProjectAdminAgentApiAction<TPayload extends Record<string, unknown>>(
  c: Context<{ Bindings: Env }>,
  projectName: string,
  action: (authorization: ProjectSecretsAccessContext) => Promise<TPayload>
): Promise<Response> {
  return runProtectedAgentApiAction(c, async (identity) => {
    const authorization = await authorizeProjectAdminAction(c.env, c.req.raw.url, identity, projectName);
    if (!authorization.ok) {
      return c.json(authorization.body, { status: authorization.status });
    }

    const payload = await action(authorization);
    return c.json(payload);
  });
}

async function runProtectedAdminApiAction(
  c: Context<{ Bindings: Env }>,
  action: (identity: AuthenticatedAgentRequestIdentity) => Promise<Response>
): Promise<Response> {
  let identity: AuthenticatedAgentRequestIdentity;

  try {
    identity = await requireKaleAdminMcpIdentity(c.req.raw, c.env);
  } catch (error) {
    const httpError = asHttpError(error);
    return protectedAdminApiAuthErrorResponse(c, c.env, httpError);
  }

  try {
    return await action(identity);
  } catch (error) {
    const httpError = asHttpError(error);
    return c.json({ error: httpError.message }, { status: httpError.status });
  }
}

async function runProtectedAgentApiAction(
  c: Context<{ Bindings: Env }>,
  action: (identity: AgentRequestIdentity) => Promise<Response>
): Promise<Response> {
  let identity: AgentRequestIdentity;

  try {
    identity = await requireAgentRequestIdentity(c.req.raw, c.env);
  } catch (error) {
    const httpError = asHttpError(error);
    return protectedAgentApiAuthErrorResponse(c, c.env, httpError);
  }

  try {
    return await action(identity);
  } catch (error) {
    const httpError = asHttpError(error);
    return c.json({ error: httpError.message }, { status: httpError.status });
  }
}

async function buildAdminOverviewPayload(env: Env) {
  const [projects, featuredProjects, deletionBacklogs, ownerCapacityOverrides] = await Promise.all([
    listProjects(env.CONTROL_PLANE_DB),
    listFeaturedProjects(env.CONTROL_PLANE_DB),
    listProjectDeletionBacklogs(env.CONTROL_PLANE_DB, 100),
    listOwnerCapacityOverrides(env.CONTROL_PLANE_DB)
  ]);
  const adminProjects = buildFeaturedProjectsAdminRecords(projects, featuredProjects);

  return {
    summary: `${adminProjects.length} live repositories, ${featuredProjects.length} featured projects, ${deletionBacklogs.length} pending deletion cleanups, ${ownerCapacityOverrides.length} owner cap overrides.`,
    projectCount: adminProjects.length,
    featuredProjectCount: featuredProjects.length,
    deletionBacklogCount: deletionBacklogs.length,
    ownerCapacityOverrideCount: ownerCapacityOverrides.length,
    projects: adminProjects,
    featuredProjects,
    deletionBacklogs,
    ownerCapacityOverrides
  };
}

async function parseAdminFeaturedProjectRequestBody(
  request: Request
): Promise<{ headline?: string; sortOrder?: number | string }> {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    throw new HttpError(400, "Admin featured project updates require a valid JSON body.");
  }

  if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
    throw new HttpError(400, "Admin featured project updates require a JSON object body.");
  }

  return rawBody as { headline?: string; sortOrder?: number | string };
}

function parseAdminFeaturedProjectSortOrder(value: number | string | undefined): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new HttpError(400, "Featured project order must be a non-negative number.");
    }
    return Math.trunc(value);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return 100;
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new HttpError(400, "Featured project order must be a non-negative number.");
    }
    return parsed;
  }

  return 100;
}

async function parseAdminOwnerCapacityOverrideRequestBody(
  request: Request
): Promise<{ maxLiveDedicatedWorkers?: number | string; note?: string }> {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    throw new HttpError(400, "Admin owner capacity updates require a valid JSON body.");
  }

  if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
    throw new HttpError(400, "Admin owner capacity updates require a JSON object body.");
  }

  return rawBody as { maxLiveDedicatedWorkers?: number | string; note?: string };
}

function parseAdminOwnerCapacityLimit(value: number | string | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  throw new HttpError(400, "maxLiveDedicatedWorkers must be a non-negative integer.");
}

function normalizeOwnerLoginRouteParam(value: string): string {
  const ownerLogin = value.trim().toLowerCase();
  if (!ownerLogin || !/^[a-z0-9](?:-?[a-z0-9]){0,38}$/i.test(ownerLogin)) {
    throw new HttpError(400, "Owner login must be a valid GitHub owner name.");
  }

  return ownerLogin;
}

deployServiceApp.get("/api/build-jobs/:jobId/status", async (c) => {
  return runProtectedAgentApiAction(c, async () => {
    const result = await buildBuildJobStatusResponse(c.env, c.req.param("jobId"));
    return c.json(result.body, { status: result.status });
  });
});

// The `/mcp` route is served by the OAuth provider's `apiHandler` (see the default export
// at the bottom of this module). The provider validates the Bearer access token, looks up
// the associated grant, decrypts the stored `McpAuthProps`, and only then dispatches the
// request to the handler. That means this Hono app never needs to see an unauthenticated
// `/mcp` request; the provider returns 401 with a WWW-Authenticate header on its own.
export async function dispatchMcpRequest(
  request: Request,
  env: Env,
  executionCtx: ExecutionContext,
  props: McpAuthProps
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }
  if (request.method === "GET") {
    return Response.json({ error: "SSE streaming is not supported in stateless mode." }, { status: 405 });
  }

  const identity: AgentRequestIdentity = {
    type: props.source,
    email: props.email,
    subject: props.subject
  };

  try {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    const server = createDeployServiceMcpServer(env, request.url, identity, executionCtx);
    await server.connect(transport);

    const response = await transport.handleRequest(request);
    await server.close();
    await transport.close();
    return response;
  } catch (error) {
    console.error("MCP request failed.", error);
    const httpError = asHttpError(error);
    return Response.json({
      jsonrpc: "2.0",
      error: {
        code: -32603,
        message: httpError.message
      },
      id: null
    }, { status: httpError.status });
  }
}

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
          result.summary ?? "Kale Validate built the Worker bundle successfully without deploying it.",
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
        result.summary ?? "Build finished. Kale Deploy is uploading the Worker bundle and provisioning bindings.",
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
        runtimeEvidence: result.deployment.runtimeEvidence,
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
  const existingProject = await getLatestProjectForRepository(env.CONTROL_PLANE_DB, repositoryFullName);
  const installationClient = await github.createInstallationClient(installationId);
  if (!existingProject && !await installationClient.fileExists(
    repository.ownerLogin,
    repository.name,
    "kale.project.json",
    payload.after
  )) {
    return Response.json(
      {
        accepted: true,
        eventName: "push",
        ignored: true,
        reason: "Repository is not registered with Kale and does not declare kale.project.json at this commit."
      },
      { status: 202 }
    );
  }
  const projectName = existingProject?.projectName
    ?? await resolveRepositoryProjectName(
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
          name: "Kale Deploy",
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
      name: "Kale Deploy",
      headSha: payload.after,
      externalId: jobId,
      status: "queued",
      output: checkRunOutput(
        "Queued for build",
        "Kale Deploy accepted the push and queued a managed build for the default branch."
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
  try {
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
  } catch (error) {
    console.error(`[deploy-service] failed to update failed build check-run for job=${job.jobId}`, error);
  }

  return failedJob;
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
  const repositoryFullName = formatRepositoryFullName(metadata.ownerLogin, metadata.githubRepo);
  const now = new Date().toISOString();
  const policy = await ensureProjectPolicy(env.CONTROL_PLANE_DB, repositoryFullName, metadata.projectName, now);
  assertDeploymentPolicy(metadata, policy);
  const projectClaim = await getProjectClaim(env.CONTROL_PLANE_DB, metadata.projectName, repositoryFullName);
  const existingRecord = projectClaim.project;
  const repositoryRecord = existingRecord ?? await getLatestProjectForRepository(env.CONTROL_PLANE_DB, repositoryFullName);
  const laneSourceRecord = existingRecord ?? repositoryRecord;
  const recommendedRuntimeLane = recommendRuntimeLane(metadata);
  const projectSecretBindings = await buildProjectSecretBindings(env, PROJECT_SECRETS_CONFIG, metadata);
  const sharedStaticCandidate =
    canAutoPromoteToSharedStatic(metadata)
    && projectSecretBindings.length === 0;
  if (projectClaim.conflict) {
    throw new HttpError(409, `Project name '${metadata.projectName}' is already claimed by another GitHub repository.`);
  }
  const alreadyCountedDedicatedRepo = laneSourceRecord?.runtimeLane === "dedicated_worker";
  if (!sharedStaticCandidate && !alreadyCountedDedicatedRepo) {
    await assertOwnerWithinDedicatedWorkerCapacity(env, metadata.ownerLogin, repositoryFullName);
  }

  const priorProjectNameDomain = await getProjectDomain(env.CONTROL_PLANE_DB, metadata.projectName);
  const hadPrimaryProjectDomain = Boolean(
    await getPrimaryProjectDomainForProject(env.CONTROL_PLANE_DB, metadata.projectName)
  );
  const primaryDomainLabel = await ensurePrimaryProjectDomainLabel(
    env,
    metadata.projectName,
    repositoryFullName,
    now
  );
  const deploymentUrl = buildProjectDeploymentUrl(env, primaryDomainLabel);

  const reservedRecord: ProjectRecord = existingRecord ?? {
    projectName: metadata.projectName,
    ownerLogin: metadata.ownerLogin,
    githubRepo: metadata.githubRepo,
    description: metadata.description,
    deploymentUrl,
    databaseId: repositoryRecord?.databaseId,
    filesBucketName: repositoryRecord?.filesBucketName,
    cacheNamespaceId: repositoryRecord?.cacheNamespaceId,
    runtimeLane: repositoryRecord?.runtimeLane ?? DEFAULT_RUNTIME_LANE,
    recommendedRuntimeLane:
      repositoryRecord?.recommendedRuntimeLane
      ?? DEFAULT_RUNTIME_LANE,
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
  const artifactPrefix = buildRepositoryScopedArtifactPrefix(repositoryFullName, deploymentId);
  const staticAssets = normalizeStaticAssets(metadata.staticAssets, metadata.projectName);
  assertDeploymentUploadWithinLimit(metadata, files, policy.maxAssetBytes);
  const workerFiles = getWorkerFiles(staticAssets, files);
  ensureUploadContainsMainModule(workerFiles, metadata.workerUpload.main_module);
  const archiveManifest = createDeploymentArchiveManifest(metadata, workerFiles, staticAssets, options);
  const existingWorkerHasAssets = laneSourceRecord?.runtimeLane === "dedicated_worker" && (laneSourceRecord.hasAssets ?? false);
  const client = new CloudflareApiClient({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: cloudflareApiToken
  });
  const provisionalResources = sharedStaticCandidate
    ? {
        databaseId: repositoryRecord?.databaseId,
        filesBucketName: repositoryRecord?.filesBucketName,
        cacheNamespaceId: repositoryRecord?.cacheNamespaceId
      }
    : await resolveProjectResources(
        client,
        metadata,
        repositoryRecord,
        env.D1_LOCATION_HINT
      );
  let {
    databaseId,
    filesBucketName,
    cacheNamespaceId
  } = provisionalResources;
  await putProject(env.CONTROL_PLANE_DB, {
    ...reservedRecord,
    databaseId,
    filesBucketName,
    cacheNamespaceId,
    runtimeLane: existingRecord?.runtimeLane ?? reservedRecord.runtimeLane,
    recommendedRuntimeLane: existingRecord?.recommendedRuntimeLane ?? reservedRecord.recommendedRuntimeLane,
    hasAssets: existingRecord?.hasAssets ?? false,
    latestDeploymentId: existingRecord?.latestDeploymentId,
    updatedAt: now
  });
  const previewHasAssets = Boolean(staticAssets?.files.length);
  const liveDedicatedHasAssets = Boolean(staticAssets?.files.length || existingWorkerHasAssets);

  try {
    await uploadWorkerScript(client, env.WFP_NAMESPACE, metadata.projectName, metadata, workerFiles, {
      databaseId: sharedStaticCandidate ? undefined : databaseId,
      filesBucketName: sharedStaticCandidate ? undefined : filesBucketName,
      cacheNamespaceId: sharedStaticCandidate ? undefined : cacheNamespaceId,
      secretBindings: sharedStaticCandidate ? undefined : projectSecretBindings,
      existingHasAssets: sharedStaticCandidate ? false : existingWorkerHasAssets,
      staticAssets,
      files
    });
  } catch (error) {
    const archive = await tryArchiveDeploymentManifest(env, artifactPrefix, archiveManifest);
    await recordFailedDeployment(env, {
      deploymentId,
      jobId: options?.jobId,
      projectName: metadata.projectName,
      ownerLogin: metadata.ownerLogin,
      githubRepo: metadata.githubRepo,
      headSha: options?.headSha,
      deploymentUrl,
      artifactPrefix,
      archive,
      runtimeLane: DEFAULT_RUNTIME_LANE,
      recommendedRuntimeLane,
      hasAssets: sharedStaticCandidate ? previewHasAssets : liveDedicatedHasAssets
    });
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
  let currentRuntimeLane: ProjectRecord["runtimeLane"] = DEFAULT_RUNTIME_LANE;
  if (sharedStaticCandidate && archive.archiveKind === "full" && staticAssets) {
    if (laneSourceRecord?.runtimeLane === "shared_static") {
      await putProject(env.CONTROL_PLANE_DB, {
        ...reservedRecord,
        databaseId,
        filesBucketName,
        cacheNamespaceId,
        runtimeLane: DEFAULT_RUNTIME_LANE,
        recommendedRuntimeLane,
        hasAssets: liveDedicatedHasAssets,
        latestDeploymentId: existingRecord?.latestDeploymentId,
        updatedAt
      });
    }

    const validation = await validateSharedStaticCandidate(
      deploymentUrl,
      staticAssets,
      files,
      deploymentId,
      resolveSharedStaticValidationOptions(env)
    );
    if (validation.matches) {
      if (validation.attemptsUsed > 1) {
        console.info(
          `Shared static validation matched after ${validation.attemptsUsed} attempts for ${metadata.projectName}.`
        );
      }
      currentRuntimeLane = "shared_static";
    } else {
      console.warn(
        `Shared static validation kept the deployment on a dedicated Worker after ${validation.attemptsUsed} attempts.`,
        validation.reason
      );
    }
  }

  if (currentRuntimeLane === "dedicated_worker" && sharedStaticCandidate && !alreadyCountedDedicatedRepo) {
    try {
      await assertOwnerWithinDedicatedWorkerCapacity(env, metadata.ownerLogin, repositoryFullName);
    } catch (error) {
      await rollbackCapacityRejectedDedicatedWorkerDeploy(
        env,
        client,
        {
          repositoryFullName,
          projectName: metadata.projectName,
          primaryDomainLabel,
          createdProjectClaim: !existingRecord,
          priorProjectNameDomain,
          hadPrimaryProjectDomain,
          existingRecord,
          artifactPrefix
        }
      );
      throw error;
    }
  }

  const nextHasAssets = currentRuntimeLane === "shared_static"
    ? Boolean(staticAssets?.files.length)
    : liveDedicatedHasAssets;

  const project: ProjectRecord = {
    projectName: metadata.projectName,
    ownerLogin: metadata.ownerLogin,
    githubRepo: metadata.githubRepo,
    description: metadata.description,
    deploymentUrl,
    databaseId,
    filesBucketName,
    cacheNamespaceId,
    runtimeLane: currentRuntimeLane,
    recommendedRuntimeLane,
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
    runtimeLane: currentRuntimeLane,
    recommendedRuntimeLane,
    hasAssets: nextHasAssets,
    createdAt: updatedAt
  };

  await insertDeployment(env.CONTROL_PLANE_DB, deployment);
  await putProject(env.CONTROL_PLANE_DB, project);
  if (currentRuntimeLane === "shared_static") {
    await tryDeleteWorkerScript(client, env.WFP_NAMESPACE, metadata.projectName, "dedicated Worker for a shared static deployment");
  }
  void enforceArtifactRetentionPolicy(env, project.githubRepo);

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
      `This deployment requests bindings that Kale Deploy does not allow by default: ${invalidBindings.join(", ")}. FILES and CACHE are supported only as the standard repo-scoped bindings, while AI, Vectorize, and Rooms still require approval.`
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

async function uploadWorkerScript(
  client: CloudflareApiClient,
  namespace: string,
  scriptName: string,
  metadata: DeploymentMetadata,
  workerFiles: Array<{ name: string; file: File }>,
  options: {
    databaseId?: string;
    filesBucketName?: string;
    cacheNamespaceId?: string;
    secretBindings?: WorkerBinding[];
    existingHasAssets: boolean;
    staticAssets: StaticAssetUpload | undefined;
    files: Array<{ name: string; file: File }>;
  }
): Promise<void> {
  const staticAssetsResult = await prepareStaticAssetsUpload(
    client,
    namespace,
    scriptName,
    options.staticAssets,
    options.files
  );
  const workerUpload = withProjectBindings(metadata, options.databaseId, {
    filesBucketName: options.filesBucketName,
    cacheNamespaceId: options.cacheNamespaceId,
    secretBindings: options.secretBindings,
    existingHasAssets: options.existingHasAssets,
    staticAssetsJwt: staticAssetsResult.completionJwt,
    staticAssetsConfig: options.staticAssets?.config ?? metadata.workerUpload.assets?.config
  });

  await client.uploadUserWorker(namespace, scriptName, workerUpload, workerFiles);
}

async function tryDeleteWorkerScript(
  client: CloudflareApiClient,
  namespace: string,
  scriptName: string,
  description: string
): Promise<void> {
  try {
    await client.deleteUserWorker(namespace, scriptName);
  } catch (error) {
    console.error(`Failed to remove ${description}.`, error);
  }
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

async function recordFailedDeployment(
  env: Env,
  input: {
    deploymentId: string;
    jobId?: string;
    projectName: string;
    ownerLogin: string;
    githubRepo: string;
    headSha?: string;
    deploymentUrl: string;
    artifactPrefix: string;
    archive: DeploymentArchiveResult;
    runtimeLane: ProjectRecord["runtimeLane"];
    recommendedRuntimeLane: ProjectRecord["recommendedRuntimeLane"];
    hasAssets: boolean;
  }
): Promise<void> {
  const failedDeployment: DeploymentRecord = {
    deploymentId: input.deploymentId,
    jobId: input.jobId,
    projectName: input.projectName,
    ownerLogin: input.ownerLogin,
    githubRepo: input.githubRepo,
    headSha: input.headSha,
    status: "failure",
    deploymentUrl: input.deploymentUrl,
    artifactPrefix: input.artifactPrefix,
    archiveKind: input.archive.archiveKind,
    manifestKey: input.archive.manifestKey,
    runtimeLane: input.runtimeLane,
    recommendedRuntimeLane: input.recommendedRuntimeLane,
    hasAssets: input.hasAssets,
    createdAt: new Date().toISOString()
  };
  await insertDeployment(env.CONTROL_PLANE_DB, failedDeployment);
  void cleanupExpiredFailedArtifacts(env);
}

async function validateSharedStaticCandidate(
  deploymentUrl: string,
  staticAssets: StaticAssetUpload,
  files: Array<{ name: string; file: File }>,
  cacheBustKey: string,
  options: {
    attempts: number;
    retryMs: number;
    maxFetches: number;
  }
): Promise<{ matches: boolean; reason?: string; attemptsUsed: number }> {
  const manifest = buildLoadedSharedStaticManifest({
    staticAssets: staticAssets.files,
    metadata: {
      staticAssets: {
        config: staticAssets.config
      }
    }
  });
  const assetBodies = await loadSharedStaticAssetBodies(staticAssets, files);
  const probePaths = collectSharedStaticValidationPaths(manifest);
  let remainingFetches = options.maxFetches;
  let lastFailure: { matches: boolean; reason?: string; attemptsUsed: number } = {
    matches: false,
    reason: "Shared static validation did not run.",
    attemptsUsed: 0
  };

  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    if (remainingFetches <= 0) {
      return {
        matches: false,
        reason: "Shared static validation reached its public fetch budget before confirming the deployment.",
        attemptsUsed: attempt
      };
    }

    const result = await validateSharedStaticCandidateOnce(
      deploymentUrl,
      manifest,
      assetBodies,
      probePaths,
      `${cacheBustKey}-${attempt}`,
      remainingFetches
    );
    remainingFetches -= result.fetchesUsed;
    if (result.matches) {
      return {
        ...result,
        attemptsUsed: attempt + 1
      };
    }

    lastFailure = {
      ...result,
      attemptsUsed: attempt + 1
    };
    if (remainingFetches <= 0) {
      return {
        ...lastFailure,
        reason: lastFailure.reason
          ? `${lastFailure.reason} Shared static validation stopped at the public fetch budget.`
          : "Shared static validation reached its public fetch budget before confirming the deployment."
      };
    }

    if (attempt < options.attempts - 1 && options.retryMs > 0) {
      await delay(options.retryMs);
    }
  }

  return lastFailure;
}

async function validateSharedStaticCandidateOnce(
  deploymentUrl: string,
  manifest: ReturnType<typeof buildLoadedSharedStaticManifest>,
  assetBodies: Map<string, Uint8Array>,
  probePaths: string[],
  cacheBustKey: string,
  maxFetches: number
): Promise<{ matches: boolean; reason?: string; fetchesUsed: number }> {
  let fetchesUsed = 0;

  for (const probePath of probePaths) {
    const normalizedPath = normalizeSharedStaticPath(probePath);
    if (!normalizedPath) {
      return { matches: false, reason: `Invalid shared static probe path '${probePath}'.`, fetchesUsed };
    }

    if (fetchesUsed >= maxFetches) {
      return {
        matches: false,
        reason: "Shared static validation reached its public fetch budget before checking all probe paths.",
        fetchesUsed
      };
    }
    const expected = resolveSharedStaticRequest(manifest, normalizedPath);
    const actual = await fetchSharedStaticValidationResponse(deploymentUrl, probePath, cacheBustKey);
    fetchesUsed += 1;
    if (!actual) {
      return { matches: false, reason: `Validation fetch failed for '${probePath}'.`, fetchesUsed };
    }

    const unexpectedHeader = findUnexpectedSharedStaticHeader(actual.headers);
    if (unexpectedHeader) {
      return {
        matches: false,
        reason: `Response for '${probePath}' included '${unexpectedHeader}', which indicates request-time Worker behavior that shared static hosting would drop.`,
        fetchesUsed
      };
    }

    if (expected.kind === "redirect") {
      if (actual.status < 300 || actual.status >= 400) {
        return { matches: false, reason: `Expected a redirect for '${probePath}' but received ${actual.status}.`, fetchesUsed };
      }

      const location = actual.headers.get("location");
      if (!location) {
        return { matches: false, reason: `Redirect for '${probePath}' did not include a Location header.`, fetchesUsed };
      }

      const resolvedLocation = new URL(location, deploymentUrl).pathname;
      if (resolvedLocation !== expected.locationPath) {
        return {
          matches: false,
          reason: `Expected '${probePath}' to redirect to '${expected.locationPath}' but received '${resolvedLocation}'.`,
          fetchesUsed
        };
      }
      continue;
    }

    if (expected.kind === "not_found") {
      if (actual.status !== 404) {
        return { matches: false, reason: `Expected '${probePath}' to return 404 but received ${actual.status}.`, fetchesUsed };
      }

      if (!matchesSharedStaticNotFoundBody(await actual.text())) {
        return {
          matches: false,
          reason: `Expected '${probePath}' to match the shared static 404 response body.`,
          fetchesUsed
        };
      }
      continue;
    }

    if (actual.status !== expected.status) {
      return {
        matches: false,
        reason: `Expected '${probePath}' to return ${expected.status} but received ${actual.status}.`,
        fetchesUsed
      };
    }

    const expectedBody = assetBodies.get(expected.assetPath);
    if (!expectedBody) {
      return {
        matches: false,
        reason: `Static asset '${expected.assetPath}' was missing from the validation set.`,
        fetchesUsed
      };
    }

    const expectedContentType = manifest.assets.get(expected.assetPath)?.contentType;
    if (!matchesExpectedContentType(actual.headers.get("content-type"), expectedContentType)) {
      return {
        matches: false,
        reason: `Expected '${probePath}' to return content type '${expectedContentType ?? "unknown"}', but received '${actual.headers.get("content-type") ?? "none"}'.`,
        fetchesUsed
      };
    }

    const actualBody = new Uint8Array(await actual.arrayBuffer());
    if (!equalUint8Arrays(actualBody, expectedBody)) {
      return {
        matches: false,
        reason: `Response body for '${probePath}' did not match the shared static asset.`,
        fetchesUsed
      };
    }
  }

  return { matches: true, fetchesUsed };
}

const SHARED_STATIC_DISALLOWED_RESPONSE_HEADERS = [
  "access-control-allow-credentials",
  "access-control-allow-methods",
  "access-control-allow-origin",
  "clear-site-data",
  "content-security-policy",
  "content-security-policy-report-only",
  "cross-origin-embedder-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
  "permissions-policy",
  "referrer-policy",
  "set-cookie",
  "www-authenticate",
  "x-content-type-options",
  "x-frame-options"
] as const;

function findUnexpectedSharedStaticHeader(headers: Headers): string | undefined {
  return SHARED_STATIC_DISALLOWED_RESPONSE_HEADERS.find((headerName) => headers.has(headerName));
}

function matchesExpectedContentType(actual: string | null, expected: string | undefined): boolean {
  if (!expected) {
    return true;
  }

  if (!actual) {
    return false;
  }

  return normalizeContentType(actual) === normalizeContentType(expected);
}

function matchesSharedStaticNotFoundBody(body: string): boolean {
  return body.length === 0 || body === "Not found.";
}

function normalizeContentType(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

async function fetchSharedStaticValidationResponse(
  deploymentUrl: string,
  probePath: string,
  cacheBustKey: string
): Promise<Response | null> {
  let publicBaseUrl: URL;
  try {
    publicBaseUrl = new URL(deploymentUrl.endsWith("/") ? deploymentUrl : `${deploymentUrl}/`);
  } catch {
    return null;
  }

  const targetUrl = new URL(stripLeadingSlash(probePath), publicBaseUrl);
  targetUrl.searchParams.set("__kale_validate", cacheBustKey);

  try {
    return await fetch(targetUrl.toString(), {
      headers: {
        accept: "*/*",
        "cache-control": "no-cache, no-store",
        pragma: "no-cache"
      },
      redirect: "manual"
    });
  } catch {
    return null;
  }
}

async function loadSharedStaticAssetBodies(
  staticAssets: StaticAssetUpload,
  files: Array<{ name: string; file: File }>
): Promise<Map<string, Uint8Array>> {
  const fileMap = new Map(files.map((entry) => [entry.name, entry.file]));
  const assetBodies = new Map<string, Uint8Array>();

  for (const asset of staticAssets.files) {
    const normalizedPath = normalizeSharedStaticPath(asset.path);
    if (!normalizedPath) {
      continue;
    }

    const file = fileMap.get(asset.partName);
    if (!file) {
      throw new Error(`Static asset part '${asset.partName}' was not included in the upload.`);
    }

    assetBodies.set(normalizedPath, new Uint8Array(await file.arrayBuffer()));
  }

  return assetBodies;
}

function equalUint8Arrays(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }

  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function resolvePositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function resolveSharedStaticValidationOptions(
  env: Pick<Env, "SHARED_STATIC_VALIDATION_ATTEMPTS" | "SHARED_STATIC_VALIDATION_RETRY_MS">
): { attempts: number; retryMs: number; maxFetches: number } {
  const requestedAttempts = resolvePositiveInteger(env.SHARED_STATIC_VALIDATION_ATTEMPTS)
    ?? DEFAULT_SHARED_STATIC_VALIDATION_ATTEMPTS;

  return {
    attempts: Math.min(requestedAttempts, DEFAULT_SHARED_STATIC_VALIDATION_ATTEMPTS),
    retryMs: parseNonNegativeInteger(
      env.SHARED_STATIC_VALIDATION_RETRY_MS,
      DEFAULT_SHARED_STATIC_VALIDATION_RETRY_MS
    ),
    maxFetches: SHARED_STATIC_VALIDATION_FETCH_BUDGET
  };
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

async function enforceArtifactRetentionPolicy(env: Env, githubRepo: string): Promise<void> {
  try {
    await pruneOlderSuccessfulArtifacts(env, githubRepo);
    await cleanupExpiredFailedArtifacts(env);
  } catch (error) {
    console.error("Artifact retention cleanup failed.", error);
  }
}

async function pruneOlderSuccessfulArtifacts(env: Env, githubRepo: string): Promise<void> {
  const retained = await listRetainedSuccessfulDeploymentsForRepository(env.CONTROL_PLANE_DB, githubRepo);
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
    if (
      !value?.projectName
      || !value?.ownerLogin
      || !value?.githubRepo
      || !value?.workerUpload?.main_module
      || (
        value.requestedRuntimeLane !== undefined
        && value.requestedRuntimeLane !== "dedicated_worker"
        && value.requestedRuntimeLane !== "shared_static"
        && value.requestedRuntimeLane !== "shared_app"
      )
      || !isValidRuntimeEvidence(value.runtimeEvidence)
    ) {
      throw new Error();
    }
    return value;
  } catch {
    throw new HttpError(400, "Deployment metadata is missing required fields.");
  }
}

function isValidRuntimeEvidence(value: DeploymentMetadata["runtimeEvidence"]): boolean {
  if (!value) {
    return true;
  }

  const validFrameworks = new Set(["astro", "next", "nuxt", "sveltekit", "vite", "unknown"]);
  const validClassifications = new Set(["shared_static_eligible", "dedicated_required", "unknown"]);
  const validConfidence = new Set(["high", "medium", "low"]);
  const validBasis = new Set([
    "astro_server_output",
    "astro_static_output",
    "bindings_present",
    "generic_assets_only",
    "kale_static_project_contract_incomplete",
    "kale_static_project_manifest",
    "kale_static_project_manifest_mismatch",
    "next_output_export",
    "no_static_assets",
    "nuxt_generate",
    "run_worker_first",
    "static_asset_headers_file",
    "static_asset_redirects_file",
    "sveltekit_adapter_static",
    "vite_build_script"
  ]);

  return (
    value.source === "build_runner"
    && validFrameworks.has(value.framework)
    && validClassifications.has(value.classification)
    && validConfidence.has(value.confidence)
    && Array.isArray(value.basis)
    && value.basis.every((entry) => validBasis.has(entry))
    && typeof value.summary === "string"
  );
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
  githubRepo: string,
  locationHint?: string
): Promise<string> {
  const database = await client.createD1Database(
    buildRepositoryScopedResourceName("cail", githubRepo, MAX_PROJECT_NAME_LENGTH),
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
    githubRepo: metadata.githubRepo,
    existingDatabaseId: repositoryRecord?.databaseId,
    locationHint
  });

  const filesBucketName = requestsBinding(metadata, "r2_bucket", "FILES")
    ? await resolveProjectFilesBucketName(client, {
        githubRepo: metadata.githubRepo,
        existingBucketName: repositoryRecord?.filesBucketName
      })
    : undefined;

  const cacheNamespaceId = requestsBinding(metadata, "kv_namespace", "CACHE")
    ? await resolveProjectCacheNamespaceId(client, {
        githubRepo: metadata.githubRepo,
        existingNamespaceId: repositoryRecord?.cacheNamespaceId
      })
    : undefined;

  return { databaseId, filesBucketName, cacheNamespaceId };
}

async function resolveProjectDatabaseId(
  client: CloudflareApiClient,
  options: {
    githubRepo: string;
    existingDatabaseId?: string;
    locationHint?: string;
  }
): Promise<string> {
  if (options.existingDatabaseId) {
    return options.existingDatabaseId;
  }

  const databaseName = buildRepositoryScopedResourceName("cail", options.githubRepo, MAX_PROJECT_NAME_LENGTH);
  const existingDatabase = await client.findD1DatabaseByName(databaseName);
  if (existingDatabase) {
    return existingDatabase.uuid;
  }

  return await provisionProjectDatabase(client, options.githubRepo, options.locationHint);
}

async function resolveProjectCacheNamespaceId(
  client: CloudflareApiClient,
  options: {
    githubRepo: string;
    existingNamespaceId?: string;
  }
): Promise<string> {
  if (options.existingNamespaceId) {
    return options.existingNamespaceId;
  }

  const title = buildRepositoryScopedResourceName("kale-cache", options.githubRepo, 63);
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
    githubRepo: string;
    existingBucketName?: string;
  }
): Promise<string> {
  if (options.existingBucketName) {
    return options.existingBucketName;
  }

  const bucketName = buildRepositoryScopedResourceName("kale-files", options.githubRepo, 63);
  const existingBucket = await client.findR2BucketByName(bucketName);
  if (existingBucket) {
    return existingBucket.name;
  }

  const bucket = await client.createR2Bucket(bucketName);
  return bucket.name;
}

function buildRepositoryScopedResourceName(prefix: string, githubRepo: string, maxLength: number): string {
  const repositoryKey = normalizeRepositoryScopedKey(githubRepo);
  const candidate = `${prefix}-${repositoryKey}`;
  if (candidate.length <= maxLength) {
    return candidate;
  }

  const hash = stableScopedHash(githubRepo);
  const availableProjectChars = Math.max(8, maxLength - prefix.length - hash.length - 2);
  const trimmedProject = repositoryKey.slice(0, availableProjectChars).replace(/-+$/u, "");
  return `${prefix}-${trimmedProject}-${hash}`;
}

function buildRepositoryScopedArtifactPrefix(githubRepo: string, deploymentId: string): string {
  const [owner, repo] = githubRepo.split("/", 2);
  const ownerSegment = sanitizeArtifactPath(owner || "owner");
  const repoSegment = sanitizeArtifactPath(repo || normalizeRepositoryScopedKey(githubRepo));
  return `deployments/repos/${ownerSegment}/${repoSegment}/${deploymentId}`;
}

function normalizeRepositoryScopedKey(githubRepo: string): string {
  const normalized = githubRepo
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-+/gu, "-");
  return normalized || "repo";
}

function stableScopedHash(value: string): string {
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
  databaseId: string | undefined,
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
  let mergedBindings = databaseId
    ? upsertBinding(existingBindings, {
        type: "d1",
        name: "DB",
        id: databaseId
      })
    : existingBindings.filter((binding) => binding.name !== "DB");

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
    return "Unsupported on Kale";
  }

  if (failureKind === "needs_adaptation" || conclusion === "action_required") {
    return "Needs adaptation for Kale";
  }

  return eventName === "validate" ? "Validation failed" : "Deployment failed";
}

function defaultJobStartSummary(eventName: BuildJobEventName): string {
  return eventName === "validate"
    ? "Kale Validate picked up this ref on the managed build runner."
    : "Kale Deploy picked up this commit on the managed build runner.";
}

function staleBuildTitle(job: BuildJobRecord): string {
  if (job.startedAt) {
    return job.eventName === "validate" ? "Validation stalled" : "Deployment stalled";
  }

  return job.eventName === "validate" ? "Validation queue expired" : "Deployment queue expired";
}

function staleBuildSummary(job: BuildJobRecord): string {
  if (job.startedAt) {
    return job.eventName === "validate"
      ? "Kale marked this validation as failed because it stopped reporting progress for too long. Run validate again to retry."
      : "Kale marked this deployment as failed because it stopped reporting progress for too long. Push again to retry.";
  }

  return job.eventName === "validate"
    ? "Kale marked this validation as failed because it stayed queued too long without starting. Run validate again to retry."
    : "Kale marked this deployment as failed because it stayed queued too long without starting. Push again to retry.";
}

function isStaleActiveBuildJob(job: BuildJobRecord, nowMs: number): boolean {
  const referenceTimestamp = Date.parse(job.updatedAt);
  if (!Number.isFinite(referenceTimestamp)) {
    return false;
  }

  const staleWindowMs = job.startedAt ? STALE_STARTED_BUILD_WINDOW_MS : STALE_QUEUED_BUILD_WINDOW_MS;
  return referenceTimestamp <= nowMs - staleWindowMs;
}

async function expireStaleActiveBuildJobsForRepository(
  env: Env,
  githubRepo: string,
  now: string
): Promise<void> {
  const activeJobs = await listActiveBuildJobsForRepository(env.CONTROL_PLANE_DB, githubRepo);
  if (activeJobs.length === 0) {
    return;
  }

  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) {
    return;
  }

  const serviceBaseUrl = env.DEPLOY_SERVICE_BASE_URL ?? "https://cail.invalid";
  const staleJobs = activeJobs.filter((job) => isStaleActiveBuildJob(job, nowMs));

  for (const job of staleJobs) {
    const failedJob: BuildJobRecord = {
      ...job,
      status: "failure",
      updatedAt: now,
      completedAt: now,
      errorKind: "build_failure",
      errorMessage: staleBuildSummary(job),
      errorDetail: undefined
    };

    await putBuildJob(env.CONTROL_PLANE_DB, failedJob);

    try {
      await updateJobCheckRun(env, failedJob, {
        status: "completed",
        conclusion: "failure",
        completedAt: now,
        detailsUrl: job.buildLogUrl ?? buildJobStatusUrl(serviceBaseUrl, job.jobId),
        output: checkRunOutput(staleBuildTitle(job), staleBuildSummary(job))
      });
    } catch (error) {
      console.error(`[deploy-service] failed to update stale build check-run for job=${job.jobId}`, error);
    }
  }
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

function resolveMaxLiveDedicatedWorkersPerOwner(env: Pick<Env, "DEFAULT_MAX_LIVE_DEDICATED_WORKERS_PER_OWNER">): number {
  return parseNonNegativeInteger(
    env.DEFAULT_MAX_LIVE_DEDICATED_WORKERS_PER_OWNER,
    DEFAULT_MAX_LIVE_DEDICATED_WORKERS_PER_OWNER
  );
}

async function resolveMaxLiveDedicatedWorkersPerOwnerForOwner(
  env: Pick<Env, "CONTROL_PLANE_DB" | "DEFAULT_MAX_LIVE_DEDICATED_WORKERS_PER_OWNER">,
  ownerLogin: string
): Promise<number> {
  const normalizedOwner = ownerLogin.trim().toLowerCase();
  const override = await getOwnerCapacityOverride(env.CONTROL_PLANE_DB, normalizedOwner);
  return override?.maxLiveDedicatedWorkers ?? resolveMaxLiveDedicatedWorkersPerOwner(env);
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

// Resolves a Kale personal access token (`kale_pat_*`) issued via the `/connect` page
// into an `McpAuthProps` payload, suitable to hand back to the OAuth provider's
// `resolveExternalToken` callback. Returns `null` when the token is unknown,
// revoked, or expired.
export async function resolveMcpPatProps(token: string, env: Env): Promise<McpAuthProps | null> {
  const hash = await hashPatToken(token);
  const row = await env.CONTROL_PLANE_DB.prepare(
    "SELECT email, subject, expires_at, revoked_at FROM mcp_tokens WHERE token_hash = ?"
  ).bind(hash).first<{ email: string; subject: string; expires_at: string; revoked_at: string | null }>();

  if (!row || row.revoked_at) {
    return null;
  }
  if (new Date(row.expires_at + "Z") < new Date()) {
    return null;
  }

  return {
    email: row.email,
    subject: row.subject,
    source: "mcp_pat",
    scope: [MCP_REQUIRED_SCOPE]
  };
}

async function hashPatToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
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

async function requireFeaturedProjectAdminIdentity(
  request: Request,
  env: Env
): Promise<CloudflareAccessRequestIdentity> {
  const identity = await requireCloudflareAccessIdentity(request, env);
  assertConfiguredEmail(identity.email, resolveFeaturedProjectAdminEmails(env), {
    unavailableMessage: "Featured project curation is not configured on this deployment.",
    forbiddenMessage: "Featured project curation is only available to Kale editors."
  });

  return identity;
}

async function requireKaleAdminMcpIdentity(
  request: Request,
  env: Env
): Promise<AuthenticatedAgentRequestIdentity> {
  const bearerToken = readBearerToken(request);
  if (!bearerToken) {
    throw new HttpError(401, "Missing Bearer token.");
  }

  let props: McpAuthProps | null = null;
  if (bearerToken.startsWith("kale_pat_")) {
    props = await resolveMcpPatProps(bearerToken, env);
  } else if (env.OAUTH_PROVIDER) {
    const tokenData = await env.OAUTH_PROVIDER.unwrapToken<McpAuthProps>(bearerToken);
    if (tokenData) {
      props = tokenData.grant.props;
    }
  }

  if (!props) {
    throw new HttpError(401, "Invalid or expired Bearer token.");
  }
  if (props.source !== "mcp_oauth") {
    throw new HttpError(403, "Kale admin operations require a short-lived MCP OAuth session, not a personal access token.");
  }

  assertConfiguredEmail(props.email, resolveKaleAdminEmails(env), {
    unavailableMessage: "Kale admin operations are not configured on this deployment.",
    forbiddenMessage: "Kale admin operations are only available to Kale administrators."
  });

  return {
    type: "mcp_oauth",
    email: props.email,
    subject: props.subject
  };
}

function resolveAccessConfigFromEnv(env: Env) {
  return resolveCloudflareAccessConfig({
    teamDomain: env.CLOUDFLARE_ACCESS_TEAM_DOMAIN,
    audience: env.CLOUDFLARE_ACCESS_AUD,
    allowedEmails: env.CLOUDFLARE_ACCESS_ALLOWED_EMAILS,
    allowedEmailDomains: env.CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS
  });
}

function resolveKaleAdminEmails(env: Env): Set<string> {
  return new Set(
    splitConfiguredList(resolveConfiguredEnvValue(env.KALE_ADMIN_EMAILS)).map((value) =>
      value.toLowerCase()
    )
  );
}

function resolveFeaturedProjectAdminEmails(env: Env): Set<string> {
  return new Set(
    [
      ...splitConfiguredList(resolveConfiguredEnvValue(env.KALE_ADMIN_EMAILS)),
      ...splitConfiguredList(resolveConfiguredEnvValue(env.FEATURED_PROJECT_ADMIN_EMAILS))
    ].map((value) =>
      value.toLowerCase()
    )
  );
}

function assertConfiguredEmail(
  email: string,
  allowedEmails: Set<string>,
  messages: {
    unavailableMessage: string;
    forbiddenMessage: string;
  }
): void {
  if (allowedEmails.size === 0) {
    throw new HttpError(503, messages.unavailableMessage);
  }
  if (!allowedEmails.has(email.toLowerCase())) {
    throw new HttpError(403, messages.forbiddenMessage);
  }
}

function hasKaleAdminEmail(email: string | undefined, env: Env): boolean {
  return typeof email === "string" && resolveKaleAdminEmails(env).has(email.toLowerCase());
}

// The OAuth provider itself owns access/refresh/authorization-code token secrets in KV.
// `resolveProjectControlFormTokenSecret` is the unrelated HMAC used for browser form CSRF
// tokens on the project-control page, and shares configuration with the old OAuth secret
// during the migration.
function resolveProjectControlFormTokenSecret(env: Env): string {
  const secret = resolveConfiguredEnvValue(env.PROJECT_CONTROL_FORM_TOKEN_SECRET);
  if (!secret) {
    throw new HttpError(503, "Project control form token signing is not configured on this deployment.");
  }

  return secret;
}

function splitConfiguredList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveMcpOauthBaseUrl(env: Env, requestUrl: string): string {
  return resolveConfiguredEnvValue(env.MCP_OAUTH_BASE_URL)?.replace(/\/$/, "") ?? resolveServiceBaseUrl(env, requestUrl);
}

function renderConnectPage(input: {
  serviceBaseUrl?: string;
  email?: string;
  hasActiveToken?: boolean;
  activeTokenCreatedAt?: string;
  activeTokenExpiresAt?: string;
  generatedToken?: string;
  revokedMessage?: string;
  error?: string;
}): string {
  const { serviceBaseUrl, email, hasActiveToken, activeTokenCreatedAt, activeTokenExpiresAt, generatedToken, revokedMessage, error } = input;
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect your agent — Kale Deploy</title>
${faviconLink()}
${baseStyles(`
  .connect-card { max-width: 560px; margin: 40px auto; background: var(--panel); border-radius: var(--radius-card); box-shadow: var(--shadow-card); padding: 32px; }
  .connect-card h1 { font-size: 1.25rem; margin: 0 0 8px; }
  .connect-card p { color: var(--muted); font-size: 0.92rem; line-height: 1.5; margin: 0 0 16px; }
  .token-box { background: var(--code-bg); border: 1px solid var(--border); border-radius: var(--radius-code); padding: 12px 14px; font-family: var(--font-mono); font-size: 0.82rem; word-break: break-all; line-height: 1.4; margin: 12px 0; position: relative; }
  .copy-btn { position: absolute; top: 8px; right: 8px; padding: 4px 10px; font-size: 0.78rem; border: 1px solid var(--border); border-radius: 4px; background: var(--panel); cursor: pointer; color: var(--muted); }
  .copy-btn:hover { background: var(--code-bg); color: var(--ink); }
  .action-btn { display: inline-block; padding: 10px 24px; font-size: 0.92rem; font-weight: 600; border: none; border-radius: var(--radius-button); cursor: pointer; text-decoration: none; }
  .btn-primary { background: var(--accent); color: #fff; }
  .btn-primary:hover { background: var(--accent-hover); }
  .btn-danger { background: transparent; color: var(--error); border: 1px solid var(--error); font-size: 0.82rem; padding: 6px 14px; }
  .btn-danger:hover { background: #fef2f2; }
  .step { display: flex; gap: 12px; margin: 12px 0; }
  .step-num { flex-shrink: 0; width: 28px; height: 28px; background: var(--accent); color: #fff; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 0.82rem; font-weight: 700; }
  .step-text { font-size: 0.88rem; line-height: 1.5; color: var(--ink); padding-top: 3px; }
  .step-text code { background: var(--code-bg); padding: 2px 6px; border-radius: 3px; font-family: var(--font-mono); font-size: 0.82rem; }
  .notice { background: var(--notice-bg); border-radius: var(--radius-notice); padding: 12px 16px; font-size: 0.88rem; margin: 16px 0; }
  .notice-success { background: #f0fdf4; border: 1px solid #bbf7d0; }
  .notice-warning { background: #fffbeb; border: 1px solid #fde68a; }
  .token-status { font-size: 0.82rem; color: var(--muted); margin: 8px 0; }
  .actions { display: flex; gap: 12px; align-items: center; margin-top: 20px; }
`)}
</head><body>
<div class="connect-card">
  ${logoHtml("36px")}
  <h1>Connect your agent</h1>
  ${error ? `<div class="notice notice-warning">${escapeHtml(error)}</div>` : ""}
  ${revokedMessage ? `<div class="notice notice-success">${escapeHtml(revokedMessage)}</div>` : ""}
  ${!email ? `<p>Sign in with your CUNY email to generate a connection token.</p>` : generatedToken ? `
    <p>Here is your token. Copy it and paste it into your agent chat.</p>
    <div class="token-box">
      <button class="copy-btn" onclick="navigator.clipboard.writeText(this.parentElement.querySelector('.token-value').textContent).then(() => { this.textContent = 'Copied!'; setTimeout(() => this.textContent = 'Copy', 1500); })">Copy</button>
      <span class="token-value">${escapeHtml(generatedToken)}</span>
    </div>
    <div class="notice notice-success">
      <strong>Next:</strong> Paste this token into your agent chat. Your agent will use it to connect to Kale Deploy.
    </div>
    <p class="token-status">This token expires in 90 days. You can revoke it or generate a new one at any time from this page.</p>
    <div class="notice">If you are connecting Kale from more than one computer, reuse this same token on the other machine. Generating a new token here will revoke the old one.</div>
    <div class="actions">
      <form method="POST" action="${serviceBaseUrl}/connect/revoke"><button type="submit" class="action-btn btn-danger">Revoke token</button></form>
    </div>
  ` : `
    <p>Signed in as <strong>${escapeHtml(email)}</strong></p>
    ${hasActiveToken ? `
      <div class="notice">You have an active token (created ${escapeHtml(activeTokenCreatedAt ?? "")}, expires ${escapeHtml(activeTokenExpiresAt ?? "")}). Generating a new one will replace it. If you use Kale on more than one computer, reuse the same token there for now.</div>
    ` : `
      <p>Generate a token so your AI agent can connect to Kale Deploy on your behalf.</p>
    `}
    <div class="step"><span class="step-num">1</span><span class="step-text">Click <strong>Generate token</strong> below</span></div>
    <div class="step"><span class="step-num">2</span><span class="step-text">Copy the token</span></div>
    <div class="step"><span class="step-num">3</span><span class="step-text">Paste it into your agent chat</span></div>
    <div class="actions">
      <form method="POST" action="${serviceBaseUrl}/connect/generate"><button type="submit" class="action-btn btn-primary">${hasActiveToken ? "Replace token" : "Generate token"}</button></form>
      ${hasActiveToken ? `<form method="POST" action="${serviceBaseUrl}/connect/revoke"><button type="submit" class="action-btn btn-danger">Revoke</button></form>` : ""}
    </div>
  `}
</div>
</body></html>`;
}

// OAuth authorization-server and protected-resource metadata endpoints are served by the
// Cloudflare Workers OAuth Provider wrapper (see default export). The provider reads the
// configured `authorizeEndpoint`, `tokenEndpoint`, and `clientRegistrationEndpoint` plus
// `scopesSupported` and `resourceMetadata` options to produce RFC 8414 / RFC 9728 output.
//
// `oauthUnauthorizedResponse` is kept only for legacy 401 fallbacks inside routes that do
// not run through the provider's API handler (for example, project-admin endpoints that
// the provider does not cover). The provider itself handles 401 with WWW-Authenticate for
// all `/mcp` requests.
function oauthUnauthorizedResponse(
  c: Context<{ Bindings: Env }>,
  env: Env,
  error?: HttpError,
  bearerToken?: string
): Response {
  const serviceBaseUrl = resolveServiceBaseUrl(env, c.req.raw.url);
  const resourceMetadataUrl = `${serviceBaseUrl}/.well-known/oauth-protected-resource/mcp`;
  const authError = buildMcpUnauthorizedPayload(serviceBaseUrl, error, bearerToken);
  return c.json(
    authError.body,
    401,
    {
      "WWW-Authenticate": `Bearer error="invalid_token", error_description="${authError.errorDescription}", resource_metadata="${resourceMetadataUrl}"`
    }
  );
}

function buildMcpUnauthorizedPayload(serviceBaseUrl: string, error?: HttpError, bearerToken?: string) {
  const connectUrl = `${serviceBaseUrl}/connect`;
  const message = error?.message ?? "";

  if (bearerToken?.startsWith("kale_pat_")) {
    if (message === "Token has expired.") {
      return {
        errorDescription: `Your Kale token has expired. Visit ${connectUrl} to generate a new one.`,
        body: {
          error: "invalid_token" as const,
          error_description: `Your Kale token has expired. Visit ${connectUrl} to generate a new one.`,
          connect_url: connectUrl,
          auth_mode: "personal_access_token",
          reason: "token_expired"
        }
      };
    }
    if (message === "Token has been revoked.") {
      return {
        errorDescription: `Your Kale token has been revoked. Visit ${connectUrl} to generate a new one.`,
        body: {
          error: "invalid_token" as const,
          error_description: `Your Kale token has been revoked. Visit ${connectUrl} to generate a new one.`,
          connect_url: connectUrl,
          auth_mode: "personal_access_token",
          reason: "token_revoked"
        }
      };
    }
    if (message === "Invalid token.") {
      return {
        errorDescription: `Your Kale token is invalid. Visit ${connectUrl} to generate a new one.`,
        body: {
          error: "invalid_token" as const,
          error_description: `Your Kale token is invalid. Visit ${connectUrl} to generate a new one.`,
          connect_url: connectUrl,
          auth_mode: "personal_access_token",
          reason: "token_invalid"
        }
      };
    }
  }

  return {
    errorDescription: "A valid MCP OAuth access token is required.",
    body: {
      error: "invalid_token" as const,
      error_description: "A valid MCP OAuth access token is required."
    }
  };
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

function protectedAdminApiAuthErrorResponse(
  c: Context<{ Bindings: Env }>,
  env: Env,
  error: HttpError
): Response {
  if (error.status !== 401 && error.status !== 403) {
    return c.json({ error: error.message }, { status: error.status });
  }

  const serviceBaseUrl = resolveServiceBaseUrl(env, c.req.raw.url);
  return c.json(buildProtectedAdminApiAuthErrorPayload(env, serviceBaseUrl, error), { status: error.status });
}

function buildProtectedAgentApiAuthErrorPayload(env: Env, serviceBaseUrl: string, error: HttpError) {
  const service = buildPublicServiceMetadata(env, serviceBaseUrl);
  const notAllowed = error.status === 403;

  return {
    error: error.message,
    summary: notAllowed
      ? "Kale Deploy reached the institutional login layer, but this identity is not allowed to use the protected agent API."
      : "Kale Deploy is reachable, but this request is not authenticated yet.",
    nextAction: notAllowed ? "sign_in_with_allowed_cuny_email" : "complete_browser_login",
    mcpEndpoint: service.mcpEndpoint,
    connectionHealthUrl: service.connectionHealthUrl,
    oauthProtectedResourceMetadata: service.oauthProtectedResourceMetadata,
    oauthAuthorizationMetadata: service.oauthAuthorizationMetadata,
    authorizationUrl: service.authorizationUrl
  };
}

function buildProtectedAdminApiAuthErrorPayload(env: Env, serviceBaseUrl: string, error: HttpError) {
  const service = buildPublicServiceMetadata(env, serviceBaseUrl);
  const message = error.message;

  if (error.status === 403 && /short-lived MCP OAuth session/i.test(message)) {
    return {
      error: message,
      summary: "Kale admin operations require a short-lived MCP OAuth session before the admin API can continue.",
      nextAction: "complete_browser_login",
      mcpEndpoint: service.mcpEndpoint,
      connectionHealthUrl: service.connectionHealthUrl,
      oauthProtectedResourceMetadata: service.oauthProtectedResourceMetadata,
      oauthAuthorizationMetadata: service.oauthAuthorizationMetadata,
      authorizationUrl: service.authorizationUrl
    };
  }

  if (error.status === 403) {
    return {
      error: message,
      summary: "Kale reached the admin API, but this signed-in identity is not allowlisted for Kale administration.",
      nextAction: "sign_in_with_allowed_admin_account",
      mcpEndpoint: service.mcpEndpoint,
      connectionHealthUrl: service.connectionHealthUrl,
      oauthProtectedResourceMetadata: service.oauthProtectedResourceMetadata,
      oauthAuthorizationMetadata: service.oauthAuthorizationMetadata,
      authorizationUrl: service.authorizationUrl
    };
  }

  return {
    error: message,
    summary: "Kale admin operations are reachable, but this request is not authenticated yet.",
    nextAction: "complete_browser_login",
    mcpEndpoint: service.mcpEndpoint,
    connectionHealthUrl: service.connectionHealthUrl,
    oauthProtectedResourceMetadata: service.oauthProtectedResourceMetadata,
    oauthAuthorizationMetadata: service.oauthAuthorizationMetadata,
    authorizationUrl: service.authorizationUrl
  };
}

function buildPublicServiceMetadata(env: Env, serviceBaseUrl: string) {
  const serviceName = "Kale Deploy";
  const oauthBaseUrl = serviceBaseUrl;
  const appSlug = resolveGitHubAppSlug(env);

  return {
    serviceName,
    serviceBaseUrl,
    oauthBaseUrl,
    connectionHealthUrl: `${serviceBaseUrl}/.well-known/kale-connection.json`,
    mcpEndpoint: `${serviceBaseUrl}/mcp`,
    oauthProtectedResourceMetadata: `${serviceBaseUrl}/.well-known/oauth-protected-resource/mcp`,
    oauthAuthorizationMetadata: `${oauthBaseUrl}/.well-known/oauth-authorization-server`,
    publicOauthAuthorizationMetadata: `${serviceBaseUrl}/.well-known/oauth-authorization-server`,
    authorizationUrl: `${serviceBaseUrl}/api/oauth/authorize`,
    githubAppName: resolveGitHubAppName(env),
    githubAppInstallUrl: appSlug ? githubAppInstallUrl(appSlug) : undefined,
    harnessPromptContext: buildHarnessPromptContext(serviceName, serviceBaseUrl)
  };
}

function normalizeMcpAuthorizationScopes(requestedScopes: string[]): string[] {
  const scopes = requestedScopes.length > 0 ? requestedScopes : [MCP_REQUIRED_SCOPE];
  const uniqueScopes = Array.from(new Set(scopes.map((scope) => scope.trim()).filter(Boolean)));
  const unsupportedScopes = uniqueScopes.filter((scope) => scope !== MCP_REQUIRED_SCOPE);

  if (unsupportedScopes.length > 0 || !uniqueScopes.includes(MCP_REQUIRED_SCOPE)) {
    throw new HttpError(
      400,
      `Unsupported OAuth scope requested. Kale Deploy requires exactly '${MCP_REQUIRED_SCOPE}'.`
    );
  }

  return [MCP_REQUIRED_SCOPE];
}

function hasRequiredMcpScope(props: McpAuthProps): boolean {
  return Array.isArray(props.scope) && props.scope.includes(MCP_REQUIRED_SCOPE);
}

function buildConnectionHealthPayload(
  env: Env,
  serviceBaseUrl: string,
  identity?: AgentRequestIdentity,
  wrapperCheck?: {
    harnessId?: string;
    localBundleVersion?: string;
  }
) {
  const service = buildPublicServiceMetadata(env, serviceBaseUrl);
  const authenticated = Boolean(identity && identity.type !== "anonymous");

  const wrapperStatus = buildConnectionLocalWrapperStatus(
    service.harnessPromptContext,
    wrapperCheck?.harnessId,
    wrapperCheck?.localBundleVersion
  );
  const summaryWithWarning = buildConnectionHealthSummary(authenticated, wrapperStatus);

  return {
    ok: true,
    serviceName: service.serviceName,
    connectionHealthUrl: service.connectionHealthUrl,
    mcpEndpoint: service.mcpEndpoint,
    oauthProtectedResourceMetadata: service.oauthProtectedResourceMetadata,
    oauthAuthorizationMetadata: service.oauthAuthorizationMetadata,
    authorizationUrl: service.authorizationUrl,
    githubAppName: service.githubAppName,
    githubAppInstallUrl: service.githubAppInstallUrl,
    authenticated,
    identityType: identity?.type,
    email: identity && "email" in identity ? identity.email : undefined,
    dynamicSkillPolicy: buildConnectionDynamicSkillPolicy(),
    clientUpdatePolicy: buildConnectionClientUpdatePolicy(),
    harnesses: buildConnectionHarnessCatalog(service.harnessPromptContext),
    localWrapperStatus: wrapperStatus,
    nextAction: authenticated ? "register_project" : "connect_mcp_or_complete_browser_login",
    deploymentTrigger: "github_push_to_default_branch",
    localFolderUploadSupported: false,
    summary: summaryWithWarning
  };
}

function buildConnectionHealthSummary(
  authenticated: boolean,
  wrapperStatus?: ReturnType<typeof buildConnectionLocalWrapperStatus>
) {
  const summary = authenticated
    ? "Kale Deploy is connected and authenticated. Register a repository or test a specific repo next."
    : "Kale Deploy is reachable. Connect the MCP endpoint, complete the browser login flow, and then verify the connection before deploying.";

  return wrapperStatus?.warning
    ? `${summary} ${wrapperStatus.summary}`
    : summary;
}

function getRequiredOauthFormField(form: FormData, field: string): string {
  const value = form.get(field);
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `OAuth request is missing the required '${field}' field.`);
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
  return env.GITHUB_APP_NAME?.trim() || "Kale Deploy";
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

// Default handler: the Hono app. Hono's public routes (landing page, /connect, GitHub
// webhooks, JSON APIs, /api/oauth/authorize) all live here. The OAuth provider wraps this
// and only routes `/mcp*` traffic away to the apiHandler after validating the bearer.
const honoDefaultHandler: ExportedHandler<Env> = {
  fetch(request: Request, env: Env, executionCtx: ExecutionContext) {
    return deployServiceApp.fetch(
      normalizeWorkerRequest(request, resolveBasePath(env.DEPLOY_SERVICE_BASE_URL)),
      env,
      executionCtx
    );
  }
};

// API handler: authenticated `/mcp*` traffic. The provider has already validated the
// access token and populated `ctx.props` with the `McpAuthProps` we attached in
// `/api/oauth/authorize` (or reconstructed via `resolveMcpPatProps`).
const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const normalized = normalizeWorkerRequest(request, resolveBasePath(env.DEPLOY_SERVICE_BASE_URL));
    const url = new URL(normalized.url);
    const props = (ctx as ExecutionContext & { props?: McpAuthProps }).props;
    if (!props || !props.email || !props.subject) {
      return Response.json(
        { error: "invalid_token", error_description: "Missing MCP identity props." },
        { status: 401 }
      );
    }
    if (!hasRequiredMcpScope(props)) {
      return Response.json(
        { error: "insufficient_scope", error_description: `The '${MCP_REQUIRED_SCOPE}' OAuth scope is required.` },
        {
          status: 403,
          headers: {
            "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${MCP_REQUIRED_SCOPE}"`
          }
        }
      );
    }

    if (url.pathname === "/mcp/ping") {
      return handleMcpPing(normalized, env, props);
    }
    if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
      return dispatchMcpRequest(normalized, env, ctx, props);
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }
};

function createOAuthProviderOptions(serviceBaseUrl: string): OAuthProviderOptions<Env> {
  const baseUrl = serviceBaseUrl.replace(/\/$/, "");
  return {
    apiRoute: [`${baseUrl}/mcp`],
    apiHandler: mcpApiHandler,
    defaultHandler: honoDefaultHandler,
    authorizeEndpoint: `${baseUrl}/api/oauth/authorize`,
    tokenEndpoint: `${baseUrl}/oauth/token`,
    clientRegistrationEndpoint: `${baseUrl}/oauth/register`,
    scopesSupported: [MCP_REQUIRED_SCOPE],
    accessTokenTTL: 3600,
    refreshTokenTTL: 30 * 24 * 60 * 60,
    allowPlainPKCE: false,
    resourceMetadata: {
      resource: `${baseUrl}/mcp`,
      authorization_servers: [new URL(baseUrl).origin],
      scopes_supported: [MCP_REQUIRED_SCOPE],
      resource_name: "Kale Deploy MCP"
    },
    async resolveExternalToken({ token, env }) {
      if (!token.startsWith("kale_pat_")) {
        return null;
      }
      const props = await resolveMcpPatProps(token, env);
      if (!props) {
        return null;
      }
      return { props };
    }
  };
}

export default {
  fetch(request: Request, env: Env, executionCtx: ExecutionContext) {
    const serviceBaseUrl = resolveServiceBaseUrl(env, request.url);
    const oauthOptions = createOAuthProviderOptions(serviceBaseUrl);
    env.OAUTH_PROVIDER = getOAuthApi(oauthOptions, env);
    return new OAuthProvider<Env>(oauthOptions).fetch(
      rewriteRequestForOAuthProvider(request, serviceBaseUrl),
      env,
      executionCtx
    );
  }
};

function rewriteRequestForOAuthProvider(request: Request, serviceBaseUrl: string): Request {
  const serviceBase = new URL(serviceBaseUrl);
  const basePath = resolveBasePath(serviceBaseUrl);
  const url = new URL(request.url);

  url.protocol = serviceBase.protocol;
  url.host = serviceBase.host;

  if (url.pathname === "/.well-known/openid-configuration") {
    url.pathname = "/.well-known/oauth-authorization-server";
  } else if (basePath && url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
    url.pathname = rebaseOAuthProviderPath(url.pathname, basePath);
  }

  return new Request(url.toString(), request);
}

function rebaseOAuthProviderPath(pathname: string, basePath: string): string {
  if (pathname === "/.well-known/oauth-authorization-server"
    || pathname === `/.well-known/oauth-authorization-server${basePath}`
    || pathname === "/.well-known/openid-configuration"
    || pathname === `/.well-known/openid-configuration${basePath}`) {
    return "/.well-known/oauth-authorization-server";
  }

  if (pathname === "/.well-known/oauth-protected-resource") {
    return `/.well-known/oauth-protected-resource${basePath}`;
  }

  if (pathname === "/.well-known/oauth-protected-resource/mcp"
    || pathname === `/.well-known/oauth-protected-resource${basePath}/mcp`) {
    return `/.well-known/oauth-protected-resource${basePath}/mcp`;
  }

  return `${basePath}${pathname === "/" ? "" : pathname}`;
}

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
  const service = buildPublicServiceMetadata(env, serviceBaseUrl);
  const publicRuntimeUrl = resolvePublicRuntimeManifestUrl(env, serviceBaseUrl);
  const reservedProjectNames = Array.from(resolveReservedProjectNames(env, serviceBaseUrl)).sort();
  return {
    name: "kale-runtime",
    version: 1,
    provider: "cloudflare",
    deployment_model: "workers-for-platforms",
    build_surface: "github",
    build_execution: "kale-owned-runner",
    build_queue: "cloudflare-queues",
    control_plane_store: "d1",
    artifact_archive: "r2",
    public_base_url: resolveProjectPublicBaseUrl(env),
    install_base_url: serviceBaseUrl,
    well_known_runtime_url: publicRuntimeUrl,
    project_url_template: exampleProjectDeploymentUrl(env),
    project_name_pattern: `^(?=.{1,${MAX_PROJECT_NAME_LENGTH}}$)[a-z0-9]+(?:-[a-z0-9]+)*$`,
    reserved_project_names: reservedProjectNames,
    agent_build_default: "choose-the-lightest-worker-compatible-shape",
    scaffold_shape_required: true,
    scaffold_shape_options: ["static", "worker"],
    preferred_worker_framework: "hono",
    static_project_marker_file: "kale.project.json",
    static_project_shape_value: "static_site",
    worker_project_shape_value: "worker_app",
    static_project_assets_directory_hint: "public",
    static_project_request_time_logic_key: "requestTimeLogic",
    static_project_request_time_logic_value: "none",
    worker_project_request_time_logic_value: "allowed",
    dynamic_skill_policy: buildRuntimeDynamicSkillPolicy(),
    client_update_policy: buildRuntimeClientUpdatePolicy(),
    agent_harnesses: buildRuntimeHarnessCatalog(service.harnessPromptContext),
    agent_build_guidance: [
      "Pick a starter shape explicitly: static for pure publishing sites, worker for projects that need request-time behavior.",
      "If the project is mostly content or simple publishing, prefer a pure static project with kale.project.json, a Wrangler assets directory, and no request-time Worker routes, response headers, _headers file, or _redirects file.",
      "If the project needs request-time routing, middleware, or a small API, Hono is the preferred Worker framework.",
      "Do not introduce a heavy SPA stack or a traditional Node server unless the project clearly requires it."
    ],
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
      max_asset_bytes: DEFAULT_PROJECT_POLICY.maxAssetBytes,
      max_live_dedicated_workers_per_owner: resolveMaxLiveDedicatedWorkersPerOwner(env)
    },
    limit_rationale: {
      max_validations_per_day: "Not capped by default. Set only as an abuse-control override for a specific repository.",
      max_deployments_per_day: "Not capped by default. Set only as an abuse-control override for a specific repository.",
      max_concurrent_builds: "Limited because builds run on a shared Kale-owned runner.",
      max_asset_bytes: "Limited because Kale Deploy currently receives each build artifact as one multipart upload and must stay within Cloudflare request-body limits with headroom for Worker code and metadata.",
      max_live_dedicated_workers_per_owner: "Limited because dedicated workers consume Kale-owned isolated runtime capacity. The default cap is applied per GitHub owner."
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
      DB: "Self-service because Kale provisions one repo-scoped D1 database for each repository.",
      FILES: "Self-service because Kale provisions one repo-scoped R2 bucket when the repository requests FILES.",
      CACHE: "Self-service because Kale provisions one repo-scoped KV namespace when the repository requests CACHE.",
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
        "kale.project.json",
        "wrangler.jsonc",
        "src/index.ts",
        "AGENTS.md"
      ],
      expected_routes: ["/"],
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
      mcp_endpoint: service.mcpEndpoint,
      connection_health: service.connectionHealthUrl,
      oauth_authorization_metadata: service.publicOauthAuthorizationMetadata,
      oauth_protected_resource_metadata: service.oauthProtectedResourceMetadata,
      repository_status_template: `${serviceBaseUrl}/api/repositories/{owner}/{repo}/status`,
      register_project: `${serviceBaseUrl}/api/projects/register`,
      validate_project: `${serviceBaseUrl}/api/validate`,
      build_job_status_template: `${serviceBaseUrl}/api/build-jobs/{jobId}/status`,
      project_status_template: `${serviceBaseUrl}/api/projects/{projectName}/status`,
      project_secrets_template: `${serviceBaseUrl}/api/projects/{projectName}/secrets`,
      project_delete_template: `${serviceBaseUrl}/api/projects/{projectName}`,
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
          "If a harness cannot complete MCP OAuth reliably, send the user to /connect to generate a Kale token and configure the MCP server with an Authorization: Bearer header.",
          "Sensitive project-admin actions like secrets and project deletion may ask the user to confirm their GitHub account separately, because they require repo write/admin access.",
          "The browser settings page is a private admin surface. Use it only for project-admin tasks such as secrets or project deletion, not for ordinary deploy or status work."
        ],
        required_for: [
          "repository_status_template",
          "register_project",
          "validate_project",
          "project_status_template",
          "build_job_status_template",
          "project_secrets_template",
          "project_delete_template"
        ]
      }
    },
    mcp: {
      transport: "streamable_http",
      endpoint: service.mcpEndpoint,
      auth: {
        scheme: "oauth2.1",
        authorization_metadata_url: service.publicOauthAuthorizationMetadata,
        protected_resource_metadata_url: service.oauthProtectedResourceMetadata,
        dynamic_client_registration_endpoint: `${serviceBaseUrl}/oauth/register`,
        browser_login_url: service.authorizationUrl
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
        "delete_project_secret",
        "delete_project"
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
      { name: "DB", type: "d1", required: true, scope: "per-repository", enabled_by_default: true },
      { name: "FILES", type: "r2", required: false, scope: "per-repository", enabled_by_default: true, self_service: true },
      { name: "CACHE", type: "kv", required: false, scope: "per-repository", enabled_by_default: true, self_service: true },
      { name: "AI", type: "ai", required: false, scope: "shared", enabled_by_default: false, approval_required: true },
      { name: "VECTORIZE", type: "vectorize", required: false, scope: "shared-or-per-project", enabled_by_default: false, approval_required: true },
      { name: "ROOMS", type: "durable_object_namespace", required: false, scope: "shared", enabled_by_default: false, approval_required: true }
    ]
  };
}

function createDeployServiceMcpServer(
  env: Env,
  requestUrl: string,
  identity: AgentRequestIdentity,
  executionContext: ExecutionContext
) {
  const serviceBaseUrl = resolveServiceBaseUrl(env, requestUrl);
  const adminEnabled = identity.type === "mcp_oauth"
    && hasKaleAdminEmail("email" in identity ? identity.email : undefined, env);
  return createDeployServiceMcpSurface({
    serviceBaseUrl,
    identityType: identity.type,
    maxProjectNameLength: MAX_PROJECT_NAME_LENGTH,
    getRuntimeManifest: () => buildRuntimeManifest(env, serviceBaseUrl),
    getConnectionHealth: (input) => buildConnectionHealthPayload(
      env,
      serviceBaseUrl,
      identity,
      {
        harnessId: input?.harness,
        localBundleVersion: input?.localBundleVersion
      }
    ),
    getRepositoryLifecycle: async (repository, projectName) =>
      (await buildRepositoryLifecycleState(env, requestUrl, repository, projectName)).payload,
    queueValidation: async (input) => queueValidationJob(env, requestUrl, input),
    getProjectStatus: async (projectName) => buildProjectStatusResponse(env, projectName, { includeSensitive: true }),
    summarizeProjectStatus: summarizeProjectStatusPayload,
    getBuildJobStatus: async (jobId) => buildBuildJobStatusResponse(env, jobId, { includeSensitive: true }),
    summarizeBuildJobStatus: summarizeBuildJobStatusPayload,
    listProjectSecrets: async (projectName) =>
      runProjectAdminMcpAction(env, requestUrl, identity, projectName, (authorization) =>
        buildProjectSecretsListPayload(env, authorization.project, authorization.githubLogin)
      ),
    setProjectSecret: async (projectName, secretName, value) =>
      runProjectAdminMcpAction(env, requestUrl, identity, projectName, (authorization) =>
        setProjectSecretValue(env, PROJECT_SECRETS_CONFIG, authorization, secretName, value)
      ),
    deleteProjectSecret: async (projectName, secretName) =>
      runProjectAdminMcpAction(env, requestUrl, identity, projectName, (authorization) =>
        removeProjectSecretValue(env, PROJECT_SECRETS_CONFIG, authorization, secretName)
      ),
    deleteProject: async (projectName, confirmProjectName) =>
      runProjectAdminMcpAction(env, requestUrl, identity, projectName, async (authorization) => {
        assertProjectDeleteConfirmation(projectName, confirmProjectName);
        return deleteProjectFromKale(env, PROJECT_DELETE_CONFIG, authorization, {
          scheduleBackgroundCleanup: (task) => executionContext.waitUntil(task)
        });
      }),
    getAdminOverview: adminEnabled
      ? async () => {
          const payload = await buildAdminOverviewPayload(env);
          return {
            status: 200,
            summary: payload.summary,
            body: payload
          };
        }
      : undefined,
    setFeaturedProject: adminEnabled
      ? async (projectName, headline, sortOrder) => {
          const { project, feature } = await setFeaturedProjectForLiveProject({
            env,
            projectName,
            getProject: (env, projectName) => getProject(env.CONTROL_PLANE_DB, projectName),
            getFeaturedProject: (env, githubRepo) => getFeaturedProject(env.CONTROL_PLANE_DB, githubRepo),
            putFeaturedProject: (env, featuredProject) => putFeaturedProject(env.CONTROL_PLANE_DB, featuredProject),
            headline: typeof headline === "string" && headline.trim() ? headline.trim() : undefined,
            sortOrder: parseAdminFeaturedProjectSortOrder(sortOrder)
          });
          return {
            status: 200,
            summary: `${project.projectName} is now featured.`,
            body: {
              ok: true,
              summary: `${project.projectName} is now featured.`,
              projectName: project.projectName,
              githubRepo: feature.githubRepo,
              featured: {
                enabled: true,
                headline: feature.headline,
                sortOrder: feature.sortOrder
              }
            }
          };
        }
      : undefined,
    unfeatureProject: adminEnabled
      ? async (projectName) => {
          const project = await clearFeaturedProjectForLiveProject({
            env,
            projectName,
            getProject: (env, projectName) => getProject(env.CONTROL_PLANE_DB, projectName),
            deleteFeaturedProject: (env, githubRepo) => deleteFeaturedProject(env.CONTROL_PLANE_DB, githubRepo)
          });
          return {
            status: 200,
            summary: `${project.projectName} is no longer featured.`,
            body: {
              ok: true,
              summary: `${project.projectName} is no longer featured.`,
              projectName: project.projectName,
              githubRepo: project.githubRepo,
              featured: {
                enabled: false
              }
            }
          };
        }
      : undefined,
    setOwnerCapacityOverride: adminEnabled
      ? async (ownerLogin, maxLiveDedicatedWorkers, note) => {
          const normalizedOwnerLogin = normalizeOwnerLoginRouteParam(ownerLogin);
          const now = new Date().toISOString();
          const existing = await getOwnerCapacityOverride(env.CONTROL_PLANE_DB, normalizedOwnerLogin);
          const override = {
            ownerLogin: normalizedOwnerLogin,
            maxLiveDedicatedWorkers: parseAdminOwnerCapacityLimit(maxLiveDedicatedWorkers),
            note: typeof note === "string" && note.trim() ? note.trim() : undefined,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now
          };
          await putOwnerCapacityOverride(env.CONTROL_PLANE_DB, override);
          return {
            status: 200,
            summary: override.maxLiveDedicatedWorkers === 0
              ? `${override.ownerLogin} now has no dedicated-worker cap override limit.`
              : `${override.ownerLogin} can now run up to ${override.maxLiveDedicatedWorkers} live dedicated-worker projects.`,
            body: {
              ok: true,
              ownerLogin: override.ownerLogin,
              capacityOverride: {
                maxLiveDedicatedWorkers: override.maxLiveDedicatedWorkers,
                note: override.note
              }
            }
          };
        }
      : undefined,
    clearOwnerCapacityOverride: adminEnabled
      ? async (ownerLogin) => {
          const normalizedOwnerLogin = normalizeOwnerLoginRouteParam(ownerLogin);
          await deleteOwnerCapacityOverride(env.CONTROL_PLANE_DB, normalizedOwnerLogin);
          return {
            status: 200,
            summary: `${normalizedOwnerLogin} now uses the default dedicated-worker cap again.`,
            body: {
              ok: true,
              ownerLogin: normalizedOwnerLogin,
              capacityOverride: null
            }
          };
        }
      : undefined
  });
}

const PROJECT_CONTROL_ROUTE_DEPENDENCIES = {
  requireCloudflareAccessIdentity,
  resolveServiceBaseUrl,
  resolveProjectControlFormTokenSecret,
  authorizeProjectSecretsAccess: authorizeBrowserProjectAdminAction
};

function authorizeBrowserProjectAdminAction(
  env: Env,
  requestUrl: string,
  identity: AuthenticatedAgentRequestIdentity,
  projectName: string
): Promise<ProjectSecretsAuthorization> {
  return authorizeProjectAdminAction(env, requestUrl, identity, projectName);
}

async function authorizeProjectAdminAction(
  env: Env,
  requestUrl: string,
  identity: AgentRequestIdentity,
  projectName: string
): Promise<ProjectSecretsAuthorization> {
  return authorizeProjectSecretsAccess(
    env,
    requestUrl,
    identity,
    projectName,
    PROJECT_ADMIN_AUTH_DEPENDENCIES
  );
}

async function runProjectAdminMcpAction<TPayload extends Record<string, unknown> & { summary: string }>(
  env: Env,
  requestUrl: string,
  identity: AgentRequestIdentity,
  projectName: string,
  action: (authorization: ProjectSecretsAccessContext) => Promise<TPayload>
): Promise<{ status: number; body: Record<string, unknown>; summary: string }> {
  try {
    const authorization = await authorizeProjectAdminAction(env, requestUrl, identity, projectName);
    if (!authorization.ok) {
      return {
        status: authorization.status,
        body: authorization.body,
        summary: authorization.body.summary
      };
    }

    const payload = await action(authorization);
    return {
      status: 200,
      body: payload,
      summary: payload.summary
    };
  } catch (error) {
    const httpError = asHttpError(error);
    return {
      status: httpError.status,
      body: { error: httpError.message },
      summary: httpError.message
    };
  }
}

function summarizeProjectStatusPayload(payload: Record<string, unknown>): string {
  const projectName = typeof payload.projectName === "string" ? payload.projectName : "project";
  const status = typeof payload.status === "string" ? payload.status : "unknown";
  const deploymentUrl = typeof payload.deployment_url === "string" ? payload.deployment_url : undefined;
  const errorMessage = typeof payload.error_message === "string" ? payload.error_message : undefined;
  const errorHint = typeof payload.error_hint === "string" ? payload.error_hint : undefined;

  if (status === "live" && deploymentUrl && errorMessage) {
    return `${projectName} is live at ${deploymentUrl}, but the latest build failed: ${errorMessage}${errorHint ? ` ${errorHint}` : ""}`;
  }

  if (status === "live" && deploymentUrl) {
    return `${projectName} is live at ${deploymentUrl}.`;
  }

  if (errorMessage) {
    return `${projectName} is ${status}: ${errorMessage}${errorHint ? ` ${errorHint}` : ""}`;
  }

  return `${projectName} is currently ${status}.`;
}

function summarizeBuildJobStatusPayload(payload: Record<string, unknown>): string {
  const jobId = typeof payload.jobId === "string" ? payload.jobId : "build job";
  const status = typeof payload.status === "string" ? payload.status : "unknown";
  const errorMessage = typeof payload.error_message === "string" ? payload.error_message : undefined;
  const errorHint = typeof payload.error_hint === "string" ? payload.error_hint : undefined;
  const hasDetail = typeof payload.error_detail === "string" && payload.error_detail.length > 0;

  if (errorMessage) {
    return `${jobId} is ${status}: ${errorMessage}${errorHint ? ` ${errorHint}` : ""}${hasDetail ? " Build output is included in the error_detail field." : ""}`;
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
  const deletionBacklog = await getProjectDeletionBacklog(env.CONTROL_PLANE_DB, repositoryFullName);

  if (deletionBacklog) {
    return {
      httpStatus: 409,
      payload: {
        ok: false,
        error: "Kale is still finishing cleanup for the last delete request on this repository.",
        repository: {
          ownerLogin: repository.owner,
          name: repository.repo,
          fullName: repositoryFullName,
          htmlUrl: `https://github.com/${repository.owner}/${repository.repo}`
        },
        projectName,
        projectUrl,
        projectAvailable: false,
        existingRepositoryFullName: repositoryFullName,
        suggestedProjectUrl: projectUrl,
        installStatus: !appSlug ? "app_unconfigured" : "installed",
        installUrl: appSlug ? githubAppInstallUrl(appSlug) : undefined,
        guidedInstallUrl,
        setupUrl: `${serviceBaseUrl}/github/setup`,
        statusUrl: `${serviceBaseUrl}/api/projects/${projectName}/status`,
        repositoryStatusUrl: `${serviceBaseUrl}/api/repositories/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/status`,
        validateUrl: `${serviceBaseUrl}/api/validate`,
        nextAction: "wait_for_delete_cleanup",
        summary: `Kale is still finishing cleanup for ${deletionBacklog.projectName}. Wait a minute, then check again before re-registering this repository.`,
        workflowStage: "cleanup_pending",
        installed: Boolean(appSlug),
        latestStatus: "not_deployed",
        servingStatus: "not_deployed",
        updatedAt: deletionBacklog.updatedAt
      }
    };
  }

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
  const servingStatus = resolveProjectServingStatus(projectClaim.project);
  const errorHint = buildFailureHint(projectClaim.latestJob);
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
    servingStatus,
    buildStatus: projectClaim.latestJob?.status,
    buildJobId: projectClaim.latestJob?.jobId,
    buildJobStatusUrl: projectClaim.latestJob?.jobId
      ? buildJobStatusUrl(serviceBaseUrl, projectClaim.latestJob.jobId)
      : undefined,
    deploymentUrl: projectClaim.latestJob?.deploymentUrl ?? projectClaim.project?.deploymentUrl,
    errorKind: projectClaim.latestJob?.errorKind,
    errorMessage: projectClaim.latestJob?.errorMessage,
    errorHint,
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
        error: "The Kale Deploy GitHub App is not installed on this repository.",
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
    name: "Kale Validate",
    headSha: commit.sha,
    externalId: jobId,
    detailsUrl: statusUrl,
    status: "queued",
    startedAt: now,
    output: checkRunOutput(
      "Validation queued",
      "Kale Deploy accepted this validation request and queued a build-only check.",
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
  await expireStaleActiveBuildJobsForRepository(env, githubRepo, now);
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

async function assertOwnerWithinDedicatedWorkerCapacity(
  env: Env,
  ownerLogin: string,
  githubRepoToExclude: string
): Promise<void> {
  const limit = await resolveMaxLiveDedicatedWorkersPerOwnerForOwner(env, ownerLogin);
  if (limit <= 0) {
    return;
  }

  const liveDedicatedWorkers = await listLiveDedicatedWorkerProjectsForOwner(
    env.CONTROL_PLANE_DB,
    ownerLogin,
    { excludeGithubRepo: githubRepoToExclude }
  );
  if (liveDedicatedWorkers.length < limit) {
    return;
  }

  const activeProjectNames = liveDedicatedWorkers
    .map((project) => project.projectName)
    .filter(Boolean)
    .slice(0, limit + 1)
    .join(", ");

  throw new HttpError(
    429,
    `Kale Deploy caps live dedicated-worker projects at ${limit} per GitHub owner. ${ownerLogin} already has ${liveDedicatedWorkers.length} live dedicated-worker project${liveDedicatedWorkers.length === 1 ? "" : "s"}${activeProjectNames ? `: ${activeProjectNames}.` : "."} Delete one or move one onto the shared static lane before deploying another dedicated worker.`
  );
}

async function rollbackCapacityRejectedDedicatedWorkerDeploy(
  env: Env,
  client: CloudflareApiClient,
  input: {
    repositoryFullName: string;
    projectName: string;
    primaryDomainLabel: string;
    createdProjectClaim: boolean;
    priorProjectNameDomain: Awaited<ReturnType<typeof getProjectDomain>>;
    hadPrimaryProjectDomain: boolean;
    existingRecord: ProjectRecord | null;
    artifactPrefix: string;
  }
): Promise<void> {
  try {
    await tryDeleteWorkerScript(client, env.WFP_NAMESPACE, input.projectName, "capacity-rejected dedicated Worker preview");
    await deleteArtifactPrefix(env.DEPLOYMENT_ARCHIVE, input.artifactPrefix);

    if (input.createdProjectClaim) {
      await deleteProjectByName(env.CONTROL_PLANE_DB, input.projectName);

      if (input.priorProjectNameDomain) {
        await putProjectDomain(env.CONTROL_PLANE_DB, input.priorProjectNameDomain);
      } else if (!input.hadPrimaryProjectDomain) {
        await deleteProjectDomain(env.CONTROL_PLANE_DB, input.primaryDomainLabel);
      }
    } else if (input.existingRecord?.runtimeLane === "shared_static") {
      await putProject(env.CONTROL_PLANE_DB, input.existingRecord);
    }
  } catch (cleanupError) {
    console.error(
      `Failed to fully roll back a capacity-rejected dedicated-worker deploy for ${input.repositoryFullName}.`,
      cleanupError
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

  const projectState = await loadProjectLookupState(env.CONTROL_PLANE_DB, projectName);
  const runtimeEvidence = await loadArchivedRuntimeEvidence(env, projectState.project);
  const errorHint = buildFailureHint(projectState.latestJob);

  if (!projectState.project && !projectState.latestJob) {
    return {
      status: 404,
      body: { error: "Project not found." }
    };
  }

  return {
    status: 200,
    body: {
      projectName,
      status: projectState.lifecycleStatus,
      serving_status: resolveProjectServingStatus(projectState.project),
      latest_build_status: projectState.latestJob?.status,
      build_status: projectState.latestJob?.status,
      deployment_url: projectState.latestJob?.deploymentUrl ?? projectState.project?.deploymentUrl,
      deployment_id: projectState.latestJob?.deploymentId ?? projectState.project?.latestDeploymentId,
      runtime_lane: projectState.project?.runtimeLane ?? DEFAULT_RUNTIME_LANE,
      recommended_runtime_lane:
        projectState.project?.recommendedRuntimeLane
        ?? projectState.project?.runtimeLane
        ?? DEFAULT_RUNTIME_LANE,
      ...buildRuntimeEvidenceStatusFields(runtimeEvidence),
      error_kind: projectState.latestJob?.errorKind,
      error_message: projectState.latestJob?.errorMessage,
      error_hint: errorHint,
      ...(options?.includeSensitive ? { error_detail: projectState.latestJob?.errorDetail } : {}),
      ...(options?.includeSensitive ? { build_log_url: projectState.latestJob?.buildLogUrl } : {}),
      job_id: projectState.latestJob?.jobId,
      check_run_id: projectState.latestJob?.checkRunId,
      created_at: projectState.latestJob?.createdAt ?? projectState.project?.createdAt,
      updated_at: projectState.latestJob?.updatedAt ?? projectState.project?.updatedAt,
      started_at: projectState.latestJob?.startedAt,
      completed_at: projectState.latestJob?.completedAt
    }
  };
}

async function loadArchivedRuntimeEvidence(
  env: Env,
  project: Pick<ProjectRecord, "projectName" | "latestDeploymentId"> | null
): Promise<RuntimeEvidence | undefined> {
  if (!project?.latestDeploymentId) {
    return undefined;
  }

  const deployment = await getDeployment(env.CONTROL_PLANE_DB, project.latestDeploymentId);
  const manifestKey = deployment?.manifestKey
    ?? `deployments/${project.projectName}/${project.latestDeploymentId}/manifest.json`;
  const manifestObject = await env.DEPLOYMENT_ARCHIVE.get(manifestKey);
  if (!manifestObject) {
    return undefined;
  }

  try {
    const manifest = JSON.parse(await manifestObject.text()) as {
      metadata?: {
        runtimeEvidence?: DeploymentMetadata["runtimeEvidence"];
      };
    };
    return isValidRuntimeEvidence(manifest.metadata?.runtimeEvidence)
      ? manifest.metadata?.runtimeEvidence
      : undefined;
  } catch {
    return undefined;
  }
}

function buildRuntimeEvidenceStatusFields(evidence: RuntimeEvidence | undefined): Record<string, unknown> {
  if (!evidence) {
    return {};
  }

  return {
    runtime_evidence_framework: evidence.framework,
    runtime_evidence_classification: evidence.classification,
    runtime_evidence_confidence: evidence.confidence,
    runtime_evidence_basis: evidence.basis,
    runtime_evidence_summary: evidence.summary
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
      error_hint: buildFailureHint(job),
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
  const projectState = await loadProjectLookupState(db, projectName);

  return {
    project: projectState.project,
    latestJob: projectState.latestJob,
    claimedRepositoryFullName: projectState.claimedRepositoryFullName,
    conflict: Boolean(
      projectState.claimedRepositoryFullName
      && projectState.claimedRepositoryFullName !== repositoryFullName
    )
  };
}

async function loadProjectLookupState(
  db: D1Database,
  projectName: string
): Promise<{
  project: ProjectRecord | null;
  latestJob: BuildJobRecord | null;
  claimedRepositoryFullName?: string;
  lifecycleStatus: ProjectLifecycleStatus;
}> {
  const [project, latestJob, domain] = await Promise.all([
    getProject(db, projectName),
    getLatestBuildJobForProject(db, projectName),
    getProjectDomain(db, projectName)
  ]);

  return {
    project,
    latestJob,
    claimedRepositoryFullName: resolveClaimedRepositoryFullName(project, latestJob, domain),
    lifecycleStatus: resolveProjectLifecycleStatus(project, latestJob)
  };
}

function resolveClaimedRepositoryFullName(
  project: ProjectRecord | null,
  latestJob: BuildJobRecord | null,
  domain: Awaited<ReturnType<typeof getProjectDomain>>
): string | undefined {
  if (project) {
    return formatRepositoryFullName(project.ownerLogin, project.githubRepo);
  }

  if (domain) {
    return domain.githubRepo;
  }

  if (latestJob) {
    return formatRepositoryFullName(latestJob.repository.ownerLogin, latestJob.repository.name);
  }

  return undefined;
}

function resolveRepositoryWorkflowState(input: {
  installStatus: RepositoryInstallStatus;
  lifecycleStatus: ProjectLifecycleStatus;
  buildStatus?: BuildJobStatus;
  conflict: boolean;
  projectName: string;
  claimedRepositoryFullName?: string;
}): {
  nextAction:
    | "configure_github_app"
    | "install_github_app"
    | "choose_different_project_name"
    | "wait_for_delete_cleanup"
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
    if (input.buildStatus === "failure") {
      return {
        nextAction: "inspect_failure",
        stage: "live",
        summary: "The site is live, but the latest build failed."
      };
    }

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
): ProjectLifecycleStatus {
  if (!latestJob) {
    return project ? "live" : "not_deployed";
  }

  if (project && latestJob.status === "failure") {
    return "live";
  }

  return normalizeBuildJobStatus(latestJob.status);
}

function normalizeBuildJobStatus(
  status: BuildJobStatus
): Exclude<ProjectLifecycleStatus, "not_deployed"> {
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

function resolveProjectServingStatus(project: ProjectRecord | null): "live" | "not_deployed" {
  return project ? "live" : "not_deployed";
}

function buildFailureHint(job: BuildJobRecord | null | undefined): string | undefined {
  if (!job?.errorMessage) {
    return undefined;
  }

  switch (job.errorKind) {
    case "needs_adaptation":
      return "Check the build job details for the required Kale project shape or Worker compatibility change.";
    case "unsupported":
      return "This project type must be ported to a Cloudflare Workers-compatible app before Kale can deploy it.";
    default:
      return "Check the build job details for the build output and fix the reported error.";
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
    return `https://runtime.${projectHostSuffix}/.well-known/kale-runtime.json`;
  }

  return `${serviceBaseUrl.replace(/\/$/, "")}/.well-known/kale-runtime.json`;
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
