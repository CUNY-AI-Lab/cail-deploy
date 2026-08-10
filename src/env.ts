import {
  CAIL_EVENT_CATALOG,
  createCailLogger,
  type CailLogEnvironment,
  type CailLogger,
  workersStructuredSink,
} from "@cuny-ai-lab/cail-log";

export const CAIL_LOG_SERVICE = "kale-release-control-plane" as const;
export const CAIL_LOG_PRODUCT = "kale-deploy" as const;
export const CAIL_LOG_SUBJECT_VERSION = "v1" as const;

const CAIL_ENVIRONMENTS = ["production", "staging", "test"] as const;

export type CailEnvironment = (typeof CAIL_ENVIRONMENTS)[number];

export type LoggingContext = Readonly<{
  environment: CailEnvironment;
  release: string;
  product: typeof CAIL_LOG_PRODUCT;
  logger: CailLogger<typeof CAIL_EVENT_CATALOG, "platform">;
}>;

/** Accept only the deployment labels owned by this service. */
export function parseCailEnvironment(value: unknown): CailEnvironment | null {
  return typeof value === "string" && CAIL_ENVIRONMENTS.includes(value as CailEnvironment)
    ? (value as CailEnvironment)
    : null;
}

export interface TestWorkflowInstance {
  sendEvent(event: { type: string; payload: unknown }): Promise<void>;
}

export interface TestWorkflowBinding {
  create(options: { id: string; params: ReleaseWorkflowParams }): Promise<{ id: string }>;
  get(id: string): Promise<TestWorkflowInstance>;
}

export interface ReleaseWorkflowParams {
  projectId: string;
  releaseId: string;
  revisionId: string;
  requestId: string;
  logSubject?: string;
  admittedAt: string;
}

export interface WorkerLoaderLike {
  load(options: {
    compatibilityDate: string;
    compatibilityFlags?: string[];
    mainModule: string;
    modules: Record<string, string>;
    globalOutbound: null;
  }): { getEntrypoint(): { fetch(request: Request): Promise<Response> } };
}

export interface DispatchNamespaceLike {
  get(name: string): { fetch(request: Request): Promise<Response> };
}

export interface OAuthAuthorizationRequest {
  responseType: string;
  clientId: string;
  redirectUri: string;
  scope: string[];
  state: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  resource?: string | string[];
}

export interface OAuthClient {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
}

export interface OAuthHelpersLike {
  parseAuthRequest(request: Request): Promise<OAuthAuthorizationRequest>;
  lookupClient(clientId: string): Promise<OAuthClient | null>;
  completeAuthorization(options: {
    request: OAuthAuthorizationRequest;
    userId: string;
    metadata: Record<string, never>;
    scope: string[];
    props: unknown;
  }): Promise<{ redirectTo: string }>;
}

export interface Env {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER?: OAuthHelpersLike;
  LOADER: WorkerLoaderLike;
  DISPATCHER: DispatchNamespaceLike;
  RELEASE_WORKFLOW: TestWorkflowBinding;
  AUTH_MODE: string;
  /** Explicit deployment label used by cail-log resource identity. */
  CAIL_ENVIRONMENT: string;
  TEST_PRINCIPALS_JSON?: string;
  CAIL_IDENTITY_JWKS?: string;
  CAIL_IDENTITY_ISSUER?: string;
  /** One exact trusted issuer; absent means the canonical CAIL issuer. */
  CAIL_TRUSTED_IDENTITY_ISSUER?: string;
  SERVICE_AUDIENCE: string;
  PUBLIC_BASE_URL: string;
  SERVICE_RELEASE?: string;
  RUN_ID: string;
  WFP_ACCOUNT_ID: string;
  WFP_NAMESPACE: string;
  WFP_PUBLISH_TIMEOUT_MS?: string;
  /**
   * Optional internal HTTP service binding used by local full-lifecycle gates.
   * Production omits it and calls Cloudflare's public API with the isolated
   * publisher token.
   */
  WFP_API?: Fetcher;
  PREVIEW_TIMEOUT_MS?: string;
  CLOUDFLARE_API_TOKEN?: string;
  ALLOW_PRODUCTION_TARGET?: string;
}

/**
 * Validate and snapshot the resource identity shared by release events.
 *
 * No environment fallback is allowed: a missing, empty, or drifted binding
 * must be rejected before the logger or an event sink is reached. cail-log
 * remains the owner of release and resource-field validation.
 */
export function readLoggingContext(
  env: Pick<Env, "CAIL_ENVIRONMENT" | "SERVICE_RELEASE">,
): LoggingContext | null {
  const environment = parseCailEnvironment(env.CAIL_ENVIRONMENT);
  if (!environment) return null;

  const release = env.SERVICE_RELEASE ?? "uncommitted";
  try {
    const logger = createCailLogger({
      service: CAIL_LOG_SERVICE,
      release,
      env: environment as CailLogEnvironment,
      sourceClass: "platform",
      subjectVersion: CAIL_LOG_SUBJECT_VERSION,
      catalog: CAIL_EVENT_CATALOG,
      sink: workersStructuredSink,
    });
    return Object.freeze({
      environment,
      release,
      product: CAIL_LOG_PRODUCT,
      logger,
    });
  } catch {
    // Keep malformed resource identity out of both readiness and event sinks.
    return null;
  }
}
