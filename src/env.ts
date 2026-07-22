export interface TestWorkflowInstance {
  sendEvent(event: { type: string; payload: unknown }): Promise<void>;
}

export interface TestWorkflowBinding {
  create(options: { id: string; params: ReleaseWorkflowParams }): Promise<{ id: string }>;
  get(id: string): TestWorkflowInstance;
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

export interface Env {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  LOADER: WorkerLoaderLike;
  DISPATCHER: DispatchNamespaceLike;
  RELEASE_WORKFLOW: TestWorkflowBinding;
  AUTH_MODE: string;
  TEST_PRINCIPALS_JSON?: string;
  CAIL_IDENTITY_JWKS?: string;
  CAIL_IDENTITY_ISSUER?: string;
  OPERATIONAL_SUBJECTS_JSON?: string;
  SERVICE_AUDIENCE: string;
  SERVICE_RELEASE?: string;
  RUN_ID: string;
  CAIL_AUTHORIZATION_SERVER?: string;
  WFP_ACCOUNT_ID: string;
  WFP_NAMESPACE: string;
  CLOUDFLARE_API_TOKEN?: string;
  ALLOW_PRODUCTION_TARGET?: string;
}
