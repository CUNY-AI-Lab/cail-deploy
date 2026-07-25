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
  TEST_PRINCIPALS_JSON?: string;
  CAIL_IDENTITY_JWKS?: string;
  CAIL_IDENTITY_ISSUER?: string;
  /** Comma-separated trusted issuers; absent means the canonical CAIL pair. */
  CAIL_TRUSTED_IDENTITY_ISSUERS?: string;
  SERVICE_AUDIENCE: string;
  PUBLIC_BASE_URL: string;
  SERVICE_RELEASE?: string;
  RUN_ID: string;
  WFP_ACCOUNT_ID: string;
  WFP_NAMESPACE: string;
  WFP_PUBLISH_TIMEOUT_MS?: string;
  PREVIEW_TIMEOUT_MS?: string;
  CLOUDFLARE_API_TOKEN?: string;
  ALLOW_PRODUCTION_TARGET?: string;
}
