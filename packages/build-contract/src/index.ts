export type RuntimeLane = "dedicated_worker" | "shared_static" | "shared_app";

export * from "./shared-static";

export type ProjectRecord = {
  projectName: string;
  ownerLogin: string;
  githubRepo: string;
  description?: string;
  deploymentUrl: string;
  databaseId?: string;
  filesBucketName?: string;
  cacheNamespaceId?: string;
  runtimeLane?: RuntimeLane;
  recommendedRuntimeLane?: RuntimeLane;
  hasAssets: boolean;
  latestDeploymentId?: string;
  createdAt: string;
  updatedAt: string;
};

export type DeploymentRecord = {
  deploymentId: string;
  jobId?: string;
  projectName: string;
  ownerLogin: string;
  githubRepo: string;
  headSha?: string;
  status: "success" | "failure";
  deploymentUrl: string;
  artifactPrefix: string;
  archiveKind: "none" | "manifest" | "full";
  manifestKey?: string;
  runtimeLane?: RuntimeLane;
  recommendedRuntimeLane?: RuntimeLane;
  hasAssets: boolean;
  createdAt: string;
};

export type WorkerBinding =
  | { type: "d1"; name: string; id: string }
  | { type: "kv_namespace"; name: string; namespace_id: string }
  | { type: "r2_bucket"; name: string; bucket_name: string }
  | { type: "secret_text"; name: string; text: string }
  | { type: "assets"; name: string }
  | { type: "ai"; name: string }
  | { type: "vectorize"; name: string; index_name: string }
  | { type: "durable_object_namespace"; name: string; class_name: string; script_name?: string };

export type WorkerAssetsConfig = {
  html_handling?: string;
  not_found_handling?: string;
  run_worker_first?: boolean | string[];
};

export type RuntimeEvidenceFramework =
  | "astro"
  | "next"
  | "nuxt"
  | "sveltekit"
  | "vite"
  | "unknown";

export type RuntimeEvidenceClassification =
  | "shared_static_eligible"
  | "dedicated_required"
  | "unknown";

export type RuntimeEvidenceConfidence = "high" | "medium" | "low";

export type RuntimeEvidenceBasis =
  | "astro_server_output"
  | "astro_static_output"
  | "bindings_present"
  | "generic_assets_only"
  | "kale_static_project_contract_incomplete"
  | "kale_static_project_manifest"
  | "kale_static_project_manifest_mismatch"
  | "next_output_export"
  | "no_static_assets"
  | "nuxt_generate"
  | "run_worker_first"
  | "static_asset_headers_file"
  | "static_asset_redirects_file"
  | "sveltekit_adapter_static"
  | "vite_build_script";

export type RuntimeEvidence = {
  source: "build_runner";
  framework: RuntimeEvidenceFramework;
  classification: RuntimeEvidenceClassification;
  confidence: RuntimeEvidenceConfidence;
  basis: RuntimeEvidenceBasis[];
  summary: string;
};

export type WorkerUploadMetadata = {
  main_module: string;
  compatibility_date: string;
  compatibility_flags?: string[];
  bindings?: WorkerBinding[];
  keep_bindings?: string[];
  keep_assets?: boolean;
  assets?: {
    jwt?: string;
    config?: WorkerAssetsConfig;
  };
  observability?: {
    enabled: boolean;
  };
};

export type StaticAssetDescriptor = {
  path: string;
  partName: string;
  contentType?: string;
};

export type StaticAssetUpload = {
  config?: WorkerAssetsConfig;
  isolationKey?: string;
  files: StaticAssetDescriptor[];
};

export type DeploymentMetadata = {
  projectName: string;
  ownerLogin: string;
  githubRepo: string;
  description?: string;
  requestedRuntimeLane?: RuntimeLane;
  runtimeEvidence?: RuntimeEvidence;
  workerUpload: WorkerUploadMetadata;
  staticAssets?: StaticAssetUpload;
};

export type GitHubRepositoryRecord = {
  id: number;
  ownerLogin: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  htmlUrl: string;
  cloneUrl: string;
  private: boolean;
};

export type BuildJobEventName = "push" | "validate";

export type BuildJobStatus =
  | "queued"
  | "in_progress"
  | "deploying"
  | "success"
  | "failure";

export type BuildJobRecord = {
  jobId: string;
  deliveryId?: string;
  eventName: BuildJobEventName;
  installationId: number;
  repository: GitHubRepositoryRecord;
  ref: string;
  headSha: string;
  previousSha?: string;
  checkRunId: number;
  status: BuildJobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  projectName?: string;
  deploymentUrl?: string;
  deploymentId?: string;
  buildLogUrl?: string;
  errorKind?: BuildRunnerFailureKind;
  errorMessage?: string;
  errorDetail?: string;
  runnerId?: string;
};

export type BuildRunnerJobRequest = {
  jobId: string;
  createdAt: string;
  trigger: {
    event: BuildJobEventName;
    deliveryId?: string;
    ref: string;
    headSha: string;
    previousSha?: string;
    pushedAt?: string;
  };
  repository: GitHubRepositoryRecord;
  source: {
    provider: "github";
    archiveUrl: string;
    cloneUrl: string;
    ref: string;
    tokenUrl: string;
  };
  deployment: {
    publicBaseUrl: string;
    suggestedProjectName: string;
  };
  callback: {
    startUrl: string;
    completeUrl: string;
  };
};

export type BuildRunnerStartPayload = {
  runnerId?: string;
  startedAt?: string;
  summary?: string;
  text?: string;
  buildLogUrl?: string;
};

export type BuildRunnerArtifact = {
  projectName: string;
  description?: string;
  runtimeEvidence?: RuntimeEvidence;
  workerUpload: WorkerUploadMetadata;
  staticAssets?: StaticAssetUpload;
};

export type BuildRunnerFailureKind =
  | "build_failure"
  | "needs_adaptation"
  | "unsupported";

export type BuildRunnerCheckRunConclusion =
  | "action_required"
  | "failure"
  | "neutral";

export type BuildRunnerCompletePayload = {
  status: "success" | "failure";
  runnerId?: string;
  completedAt?: string;
  summary?: string;
  text?: string;
  buildLogUrl?: string;
  errorMessage?: string;
  failureKind?: BuildRunnerFailureKind;
  checkRunConclusion?: BuildRunnerCheckRunConclusion;
  deployment?: BuildRunnerArtifact;
};

export type BuildRunnerSourceLease = {
  provider: "github";
  archiveUrl: string;
  cloneUrl: string;
  ref: string;
  accessToken: string;
  accessTokenExpiresAt?: string;
};

export type CloudflareEnvelope<T> = {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
};

export type D1CreateResult = {
  uuid: string;
  name: string;
};

export type WorkersAssetsUploadSessionResult = {
  jwt: string;
  buckets?: string[][];
};

export type WorkersAssetsUploadResult = {
  jwt?: string;
};
