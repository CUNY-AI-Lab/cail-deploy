import type {
  BuildJobRecord,
  BuildJobStatus,
  DeploymentRecord,
  GitHubRepositoryRecord,
  ProjectRecord
} from "@cuny-ai-lab/build-contract";

export type ProjectPolicySettings = {
  aiEnabled: boolean;
  vectorizeEnabled: boolean;
  roomsEnabled: boolean;
  maxValidationsPerDay: number;
  maxDeploymentsPerDay: number;
  maxConcurrentBuilds: number;
  maxAssetBytes: number;
};

export type ProjectPolicyRecord = ProjectPolicySettings & {
  githubRepo: string;
  projectName?: string;
  createdAt: string;
  updatedAt: string;
};

export type GitHubUserAuthRecord = {
  accessSubject: string;
  accessEmail: string;
  githubUserId: number;
  githubLogin: string;
  accessTokenEncrypted: string;
  accessTokenExpiresAt?: string;
  refreshTokenEncrypted?: string;
  refreshTokenExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectSecretRecord = {
  githubRepo: string;
  projectName: string;
  secretName: string;
  ciphertext: string;
  iv: string;
  githubUserId: number;
  githubLogin: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectSecretMetadata = {
  githubRepo: string;
  projectName: string;
  secretName: string;
  githubUserId: number;
  githubLogin: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectDomainRecord = {
  domainLabel: string;
  projectName: string;
  githubRepo: string;
  isPrimary: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ProjectDeletionBacklogRecord = {
  githubRepo: string;
  projectName: string;
  requestedAt: string;
  updatedAt: string;
  workerScriptNames: string[];
  databaseIds: string[];
  filesBucketNames: string[];
  cacheNamespaceIds: string[];
  artifactPrefixes: string[];
  lastError?: string;
};

export const DEFAULT_PROJECT_POLICY: ProjectPolicySettings = Object.freeze({
  aiEnabled: false,
  vectorizeEnabled: false,
  roomsEnabled: false,
  maxValidationsPerDay: 0,
  maxDeploymentsPerDay: 0,
  maxConcurrentBuilds: 1,
  maxAssetBytes: 90 * 1024 * 1024
});

type ProjectRow = {
  project_name: string;
  owner_login: string;
  github_repo: string;
  description: string | null;
  deployment_url: string;
  database_id: string | null;
  files_bucket_name: string | null;
  cache_namespace_id: string | null;
  runtime_lane: "dedicated_worker" | "shared_static" | "shared_app" | null;
  recommended_runtime_lane: "dedicated_worker" | "shared_static" | "shared_app" | null;
  has_assets: number;
  latest_deployment_id: string | null;
  created_at: string;
  updated_at: string;
};

type DeploymentRow = {
  deployment_id: string;
  job_id: string | null;
  project_name: string;
  owner_login: string;
  github_repo: string;
  head_sha: string | null;
  status: "success" | "failure";
  deployment_url: string;
  artifact_prefix: string;
  archive_kind: "none" | "manifest" | "full";
  manifest_key: string | null;
  runtime_lane: "dedicated_worker" | "shared_static" | "shared_app" | null;
  recommended_runtime_lane: "dedicated_worker" | "shared_static" | "shared_app" | null;
  has_assets: number;
  created_at: string;
};

type BuildJobRow = {
  job_id: string;
  delivery_id: string | null;
  event_name: "push" | "validate";
  installation_id: number;
  repository_json: string;
  ref: string;
  head_sha: string;
  previous_sha: string | null;
  check_run_id: number;
  status: BuildJobStatus;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  project_name: string | null;
  deployment_url: string | null;
  deployment_id: string | null;
  build_log_url: string | null;
  error_kind: "build_failure" | "needs_adaptation" | "unsupported" | null;
  error_message: string | null;
  error_detail: string | null;
  runner_id: string | null;
};

type OauthUsedGrantRow = {
  jti: string;
};

type ProjectPolicyRow = {
  github_repo: string;
  project_name: string | null;
  ai_enabled: number;
  vectorize_enabled: number;
  rooms_enabled: number;
  max_validations_per_day: number;
  max_deployments_per_day: number;
  max_concurrent_builds: number;
  max_asset_bytes: number;
  created_at: string;
  updated_at: string;
};

type CountRow = {
  count: number;
};

type GitHubUserAuthRow = {
  access_subject: string;
  access_email: string;
  github_user_id: number;
  github_login: string;
  access_token_encrypted: string;
  access_token_expires_at: string | null;
  refresh_token_encrypted: string | null;
  refresh_token_expires_at: string | null;
  created_at: string;
  updated_at: string;
};

type ProjectSecretRow = {
  github_repo: string;
  project_name: string;
  secret_name: string;
  ciphertext: string;
  iv: string;
  github_user_id: number;
  github_login: string;
  created_at: string;
  updated_at: string;
};

type ProjectDomainRow = {
  domain_label: string;
  project_name: string;
  github_repo: string;
  is_primary: number;
  created_at: string;
  updated_at: string;
};

type ProjectDeletionBacklogRow = {
  github_repo: string;
  project_name: string;
  requested_at: string;
  updated_at: string;
  worker_script_names_json: string;
  database_ids_json: string;
  files_bucket_names_json: string;
  cache_namespace_ids_json: string;
  artifact_prefixes_json: string;
  last_error: string | null;
};

export async function listProjects(db: D1Database): Promise<ProjectRecord[]> {
  const session = db.withSession("first-primary");
  const result = await session.prepare(`
    SELECT
      project_name,
      owner_login,
      github_repo,
      description,
      deployment_url,
      database_id,
      files_bucket_name,
      cache_namespace_id,
      runtime_lane,
      recommended_runtime_lane,
      has_assets,
      latest_deployment_id,
      created_at,
      updated_at
    FROM projects
    WHERE latest_deployment_id IS NOT NULL
    ORDER BY updated_at DESC
  `).all<ProjectRow>();

  return result.results.map(toProjectRecord);
}

export async function getProject(db: D1Database, projectName: string): Promise<ProjectRecord | null> {
  const session = db.withSession("first-primary");
  const row = await session.prepare(`
    SELECT
      project_name,
      owner_login,
      github_repo,
      description,
      deployment_url,
      database_id,
      files_bucket_name,
      cache_namespace_id,
      runtime_lane,
      recommended_runtime_lane,
      has_assets,
      latest_deployment_id,
      created_at,
      updated_at
    FROM projects
    WHERE project_name = ?
  `).bind(projectName).first<ProjectRow>();

  return row ? toProjectRecord(row) : null;
}

export async function getLatestProjectForRepository(
  db: D1Database,
  githubRepo: string
): Promise<ProjectRecord | null> {
  const session = db.withSession("first-primary");
  const row = await session.prepare(`
    SELECT
      project_name,
      owner_login,
      github_repo,
      description,
      deployment_url,
      database_id,
      files_bucket_name,
      cache_namespace_id,
      runtime_lane,
      recommended_runtime_lane,
      has_assets,
      latest_deployment_id,
      created_at,
      updated_at
    FROM projects
    WHERE github_repo = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `).bind(githubRepo).first<ProjectRow>();

  return row ? toProjectRecord(row) : null;
}

export async function listProjectsForRepository(
  db: D1Database,
  githubRepo: string
): Promise<ProjectRecord[]> {
  const session = db.withSession("first-primary");
  const result = await session.prepare(`
    SELECT
      project_name,
      owner_login,
      github_repo,
      description,
      deployment_url,
      database_id,
      files_bucket_name,
      cache_namespace_id,
      runtime_lane,
      recommended_runtime_lane,
      has_assets,
      latest_deployment_id,
      created_at,
      updated_at
    FROM projects
    WHERE github_repo = ?
    ORDER BY updated_at DESC
  `).bind(githubRepo).all<ProjectRow>();

  return result.results.map(toProjectRecord);
}

export async function getProjectPolicy(
  db: D1Database,
  githubRepo: string
): Promise<ProjectPolicyRecord | null> {
  const session = db.withSession("first-primary");
  const row = await session.prepare(`
    SELECT
      github_repo,
      project_name,
      ai_enabled,
      vectorize_enabled,
      rooms_enabled,
      max_validations_per_day,
      max_deployments_per_day,
      max_concurrent_builds,
      max_asset_bytes,
      created_at,
      updated_at
    FROM project_policies
    WHERE github_repo = ?
  `).bind(githubRepo).first<ProjectPolicyRow>();

  return row ? toProjectPolicyRecord(row) : null;
}

export async function resolveProjectPolicy(
  db: D1Database,
  githubRepo: string
): Promise<ProjectPolicySettings> {
  const policy = await getProjectPolicy(db, githubRepo);
  if (!policy) {
    return { ...DEFAULT_PROJECT_POLICY };
  }

  return {
    aiEnabled: policy.aiEnabled,
    vectorizeEnabled: policy.vectorizeEnabled,
    roomsEnabled: policy.roomsEnabled,
    maxValidationsPerDay: policy.maxValidationsPerDay,
    maxDeploymentsPerDay: policy.maxDeploymentsPerDay,
    maxConcurrentBuilds: policy.maxConcurrentBuilds,
    maxAssetBytes: policy.maxAssetBytes
  };
}

export async function getPreferredProjectNameForRepository(
  db: D1Database,
  githubRepo: string
): Promise<string | undefined> {
  const [policy, project] = await Promise.all([
    getProjectPolicy(db, githubRepo),
    getLatestProjectForRepository(db, githubRepo)
  ]);

  return policy?.projectName ?? project?.projectName;
}

export async function getProjectDomain(
  db: D1Database,
  domainLabel: string
): Promise<ProjectDomainRecord | null> {
  const session = db.withSession("first-primary");
  const row = await session.prepare(`
    SELECT
      domain_label,
      project_name,
      github_repo,
      is_primary,
      created_at,
      updated_at
    FROM project_domains
    WHERE domain_label = ?
  `).bind(domainLabel).first<ProjectDomainRow>();

  return row ? toProjectDomainRecord(row) : null;
}

export async function getPrimaryProjectDomainForProject(
  db: D1Database,
  projectName: string
): Promise<ProjectDomainRecord | null> {
  const session = db.withSession("first-primary");
  const row = await session.prepare(`
    SELECT
      domain_label,
      project_name,
      github_repo,
      is_primary,
      created_at,
      updated_at
    FROM project_domains
    WHERE project_name = ?
      AND is_primary = 1
    LIMIT 1
  `).bind(projectName).first<ProjectDomainRow>();

  return row ? toProjectDomainRecord(row) : null;
}

export async function listProjectDomainsForProject(
  db: D1Database,
  projectName: string
): Promise<ProjectDomainRecord[]> {
  const session = db.withSession("first-primary");
  const result = await session.prepare(`
    SELECT
      domain_label,
      project_name,
      github_repo,
      is_primary,
      created_at,
      updated_at
    FROM project_domains
    WHERE project_name = ?
    ORDER BY is_primary DESC, domain_label ASC
  `).bind(projectName).all<ProjectDomainRow>();

  return result.results.map(toProjectDomainRecord);
}

export async function listProjectDomainsForRepository(
  db: D1Database,
  githubRepo: string
): Promise<ProjectDomainRecord[]> {
  const session = db.withSession("first-primary");
  const result = await session.prepare(`
    SELECT
      domain_label,
      project_name,
      github_repo,
      is_primary,
      created_at,
      updated_at
    FROM project_domains
    WHERE github_repo = ?
    ORDER BY is_primary DESC, domain_label ASC
  `).bind(githubRepo).all<ProjectDomainRow>();

  return result.results.map(toProjectDomainRecord);
}

export async function putProjectDomain(
  db: D1Database,
  record: ProjectDomainRecord
): Promise<void> {
  await db.prepare(`
    INSERT INTO project_domains (
      domain_label,
      project_name,
      github_repo,
      is_primary,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(domain_label) DO UPDATE SET
      project_name = excluded.project_name,
      github_repo = excluded.github_repo,
      is_primary = excluded.is_primary,
      updated_at = excluded.updated_at
  `).bind(
    record.domainLabel,
    record.projectName,
    record.githubRepo,
    record.isPrimary ? 1 : 0,
    record.createdAt,
    record.updatedAt
  ).run();
}

export async function deleteProjectDomain(
  db: D1Database,
  domainLabel: string
): Promise<void> {
  await db.prepare(`
    DELETE FROM project_domains
    WHERE domain_label = ?
  `).bind(domainLabel).run();
}

export async function updateProjectDeploymentUrl(
  db: D1Database,
  projectName: string,
  deploymentUrl: string,
  updatedAt: string
): Promise<void> {
  await db.prepare(`
    UPDATE projects
    SET deployment_url = ?, updated_at = ?
    WHERE project_name = ?
  `).bind(deploymentUrl, updatedAt, projectName).run();

  await db.prepare(`
    UPDATE build_jobs
    SET deployment_url = ?
    WHERE project_name = ?
      AND deployment_url IS NOT NULL
  `).bind(deploymentUrl, projectName).run();

  await db.prepare(`
    UPDATE deployments
    SET deployment_url = ?
    WHERE project_name = ?
  `).bind(deploymentUrl, projectName).run();
}

export async function putGitHubUserAuth(
  db: D1Database,
  record: GitHubUserAuthRecord
): Promise<void> {
  await db.prepare(`
    INSERT INTO github_user_auth (
      access_subject,
      access_email,
      github_user_id,
      github_login,
      access_token_encrypted,
      access_token_expires_at,
      refresh_token_encrypted,
      refresh_token_expires_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(access_subject) DO UPDATE SET
      access_email = excluded.access_email,
      github_user_id = excluded.github_user_id,
      github_login = excluded.github_login,
      access_token_encrypted = excluded.access_token_encrypted,
      access_token_expires_at = excluded.access_token_expires_at,
      refresh_token_encrypted = excluded.refresh_token_encrypted,
      refresh_token_expires_at = excluded.refresh_token_expires_at,
      updated_at = excluded.updated_at
  `).bind(
    record.accessSubject,
    record.accessEmail,
    record.githubUserId,
    record.githubLogin,
    record.accessTokenEncrypted,
    record.accessTokenExpiresAt ?? null,
    record.refreshTokenEncrypted ?? null,
    record.refreshTokenExpiresAt ?? null,
    record.createdAt,
    record.updatedAt
  ).run();
}

export async function getGitHubUserAuth(
  db: D1Database,
  accessSubject: string
): Promise<GitHubUserAuthRecord | null> {
  const session = db.withSession("first-primary");
  const row = await session.prepare(`
    SELECT
      access_subject,
      access_email,
      github_user_id,
      github_login,
      access_token_encrypted,
      access_token_expires_at,
      refresh_token_encrypted,
      refresh_token_expires_at,
      created_at,
      updated_at
    FROM github_user_auth
    WHERE access_subject = ?
  `).bind(accessSubject).first<GitHubUserAuthRow>();

  return row ? toGitHubUserAuthRecord(row) : null;
}

export async function deleteGitHubUserAuthByGitHubUserId(
  db: D1Database,
  githubUserId: number
): Promise<void> {
  await db.prepare(`
    DELETE FROM github_user_auth
    WHERE github_user_id = ?
  `).bind(githubUserId).run();
}

export async function listProjectSecretMetadataForRepository(
  db: D1Database,
  githubRepo: string
): Promise<ProjectSecretMetadata[]> {
  const session = db.withSession("first-primary");
  const result = await session.prepare(`
    SELECT
      github_repo,
      project_name,
      secret_name,
      github_user_id,
      github_login,
      created_at,
      updated_at
    FROM project_secrets
    WHERE github_repo = ?
    ORDER BY secret_name ASC
  `).bind(githubRepo).all<Omit<ProjectSecretRow, "ciphertext" | "iv">>();

  return result.results.map((row) => ({
    githubRepo: row.github_repo,
    projectName: row.project_name,
    secretName: row.secret_name,
    githubUserId: row.github_user_id,
    githubLogin: row.github_login,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

export async function listProjectSecretsForRepository(
  db: D1Database,
  githubRepo: string
): Promise<ProjectSecretRecord[]> {
  const session = db.withSession("first-primary");
  const result = await session.prepare(`
    SELECT
      github_repo,
      project_name,
      secret_name,
      ciphertext,
      iv,
      github_user_id,
      github_login,
      created_at,
      updated_at
    FROM project_secrets
    WHERE github_repo = ?
    ORDER BY secret_name ASC
  `).bind(githubRepo).all<ProjectSecretRow>();

  return result.results.map(toProjectSecretRecord);
}

export async function putProjectSecret(
  db: D1Database,
  record: ProjectSecretRecord
): Promise<void> {
  await db.prepare(`
    INSERT INTO project_secrets (
      github_repo,
      project_name,
      secret_name,
      ciphertext,
      iv,
      github_user_id,
      github_login,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(github_repo, secret_name) DO UPDATE SET
      project_name = excluded.project_name,
      ciphertext = excluded.ciphertext,
      iv = excluded.iv,
      github_user_id = excluded.github_user_id,
      github_login = excluded.github_login,
      updated_at = excluded.updated_at
  `).bind(
    record.githubRepo,
    record.projectName,
    record.secretName,
    record.ciphertext,
    record.iv,
    record.githubUserId,
    record.githubLogin,
    record.createdAt,
    record.updatedAt
  ).run();
}

export async function deleteProjectSecretForRepository(
  db: D1Database,
  githubRepo: string,
  secretName: string
): Promise<void> {
  await db.prepare(`
    DELETE FROM project_secrets
    WHERE github_repo = ?
      AND secret_name = ?
  `).bind(githubRepo, secretName).run();
}

export async function ensureProjectPolicy(
  db: D1Database,
  githubRepo: string,
  projectName: string | undefined,
  now: string
): Promise<ProjectPolicySettings> {
  await db.prepare(`
    INSERT INTO project_policies (
      github_repo,
      project_name,
      ai_enabled,
      vectorize_enabled,
      rooms_enabled,
      max_validations_per_day,
      max_deployments_per_day,
      max_concurrent_builds,
      max_asset_bytes,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(github_repo) DO UPDATE SET
      project_name = COALESCE(excluded.project_name, project_name),
      updated_at = excluded.updated_at
  `).bind(
    githubRepo,
    projectName ?? null,
    DEFAULT_PROJECT_POLICY.aiEnabled ? 1 : 0,
    DEFAULT_PROJECT_POLICY.vectorizeEnabled ? 1 : 0,
    DEFAULT_PROJECT_POLICY.roomsEnabled ? 1 : 0,
    DEFAULT_PROJECT_POLICY.maxValidationsPerDay,
    DEFAULT_PROJECT_POLICY.maxDeploymentsPerDay,
    DEFAULT_PROJECT_POLICY.maxConcurrentBuilds,
    DEFAULT_PROJECT_POLICY.maxAssetBytes,
    now,
    now
  ).run();

  return await resolveProjectPolicy(db, githubRepo);
}

export async function countBuildJobsForRepositoryOnDate(
  db: D1Database,
  githubRepo: string,
  eventName: "push" | "validate",
  usageDate: string
): Promise<number> {
  const session = db.withSession("first-primary");
  const row = await session.prepare(`
    SELECT COUNT(*) AS count
    FROM build_jobs
    WHERE event_name = ?
      AND json_extract(repository_json, '$.fullName') = ?
      AND substr(created_at, 1, 10) = ?
  `).bind(eventName, githubRepo, usageDate).first<CountRow>();

  return Number(row?.count ?? 0);
}

export async function countActiveBuildJobsForRepository(
  db: D1Database,
  githubRepo: string
): Promise<number> {
  const session = db.withSession("first-primary");
  const row = await session.prepare(`
    SELECT COUNT(*) AS count
    FROM build_jobs
    WHERE json_extract(repository_json, '$.fullName') = ?
      AND status IN ('queued', 'in_progress', 'deploying')
  `).bind(githubRepo).first<CountRow>();

  return Number(row?.count ?? 0);
}

export async function listActiveBuildJobsForRepository(
  db: D1Database,
  githubRepo: string
): Promise<BuildJobRecord[]> {
  const session = db.withSession("first-primary");
  const result = await session.prepare(`
    SELECT
      job_id,
      delivery_id,
      event_name,
      installation_id,
      repository_json,
      ref,
      head_sha,
      previous_sha,
      check_run_id,
      status,
      created_at,
      updated_at,
      started_at,
      completed_at,
      project_name,
      deployment_url,
      deployment_id,
      build_log_url,
      error_kind,
      error_message,
      error_detail,
      runner_id
    FROM build_jobs
    WHERE json_extract(repository_json, '$.fullName') = ?
      AND status IN ('queued', 'in_progress', 'deploying')
    ORDER BY created_at ASC
  `).bind(githubRepo).all<BuildJobRow>();

  return result.results.map(toBuildJobRecord);
}

export async function putProject(db: D1Database, project: ProjectRecord): Promise<void> {
  await db.prepare(`
    INSERT INTO projects (
      project_name,
      owner_login,
      github_repo,
      description,
      deployment_url,
      database_id,
      files_bucket_name,
      cache_namespace_id,
      runtime_lane,
      recommended_runtime_lane,
      has_assets,
      latest_deployment_id,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_name) DO UPDATE SET
      owner_login = excluded.owner_login,
      github_repo = excluded.github_repo,
      description = excluded.description,
      deployment_url = excluded.deployment_url,
      database_id = excluded.database_id,
      files_bucket_name = excluded.files_bucket_name,
      cache_namespace_id = excluded.cache_namespace_id,
      runtime_lane = excluded.runtime_lane,
      recommended_runtime_lane = excluded.recommended_runtime_lane,
      has_assets = excluded.has_assets,
      latest_deployment_id = excluded.latest_deployment_id,
      updated_at = excluded.updated_at
  `).bind(
    project.projectName,
    project.ownerLogin,
    project.githubRepo,
    project.description ?? null,
    project.deploymentUrl,
    project.databaseId ?? null,
    project.filesBucketName ?? null,
    project.cacheNamespaceId ?? null,
    project.runtimeLane ?? "dedicated_worker",
    project.recommendedRuntimeLane ?? project.runtimeLane ?? "dedicated_worker",
    project.hasAssets ? 1 : 0,
    project.latestDeploymentId ?? null,
    project.createdAt,
    project.updatedAt
  ).run();
}

export async function claimProjectName(db: D1Database, project: ProjectRecord): Promise<void> {
  await db.prepare(`
    INSERT INTO projects (
      project_name,
      owner_login,
      github_repo,
      description,
      deployment_url,
      database_id,
      files_bucket_name,
      cache_namespace_id,
      runtime_lane,
      recommended_runtime_lane,
      has_assets,
      latest_deployment_id,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_name) DO NOTHING
  `).bind(
    project.projectName,
    project.ownerLogin,
    project.githubRepo,
    project.description ?? null,
    project.deploymentUrl,
    project.databaseId ?? null,
    project.filesBucketName ?? null,
    project.cacheNamespaceId ?? null,
    project.runtimeLane ?? "dedicated_worker",
    project.recommendedRuntimeLane ?? project.runtimeLane ?? "dedicated_worker",
    project.hasAssets ? 1 : 0,
    project.latestDeploymentId ?? null,
    project.createdAt,
    project.updatedAt
  ).run();
}

export async function insertDeployment(db: D1Database, deployment: DeploymentRecord): Promise<void> {
  await db.prepare(`
    INSERT INTO deployments (
      deployment_id,
      job_id,
      project_name,
      owner_login,
      github_repo,
      head_sha,
      status,
      deployment_url,
      artifact_prefix,
      archive_kind,
      manifest_key,
      runtime_lane,
      recommended_runtime_lane,
      has_assets,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    deployment.deploymentId,
    deployment.jobId ?? null,
    deployment.projectName,
    deployment.ownerLogin,
    deployment.githubRepo,
    deployment.headSha ?? null,
    deployment.status,
    deployment.deploymentUrl,
    deployment.artifactPrefix,
    deployment.archiveKind,
    deployment.manifestKey ?? null,
    deployment.runtimeLane ?? "dedicated_worker",
    deployment.recommendedRuntimeLane ?? deployment.runtimeLane ?? "dedicated_worker",
    deployment.hasAssets ? 1 : 0,
    deployment.createdAt
  ).run();
}

export async function updateDeploymentArchiveState(
  db: D1Database,
  deploymentId: string,
  archiveKind: "none" | "manifest" | "full",
  manifestKey?: string
): Promise<void> {
  await db.prepare(`
    UPDATE deployments
    SET archive_kind = ?, manifest_key = ?
    WHERE deployment_id = ?
  `).bind(archiveKind, manifestKey ?? null, deploymentId).run();
}

export async function listRetainedSuccessfulDeployments(
  db: D1Database,
  projectName: string
): Promise<DeploymentRecord[]> {
  const session = db.withSession("first-primary");
  const result = await session.prepare(`
    SELECT
      deployment_id,
      job_id,
      project_name,
      owner_login,
      github_repo,
      head_sha,
      status,
      deployment_url,
      artifact_prefix,
      archive_kind,
      manifest_key,
      runtime_lane,
      recommended_runtime_lane,
      has_assets,
      created_at
    FROM deployments
    WHERE project_name = ?
      AND status = 'success'
      AND archive_kind = 'full'
    ORDER BY created_at DESC
  `).bind(projectName).all<DeploymentRow>();

  return result.results.map(toDeploymentRecord);
}

export async function listRetainedSuccessfulDeploymentsForRepository(
  db: D1Database,
  githubRepo: string
): Promise<DeploymentRecord[]> {
  const session = db.withSession("first-primary");
  const result = await session.prepare(`
    SELECT
      deployment_id,
      job_id,
      project_name,
      owner_login,
      github_repo,
      head_sha,
      status,
      deployment_url,
      artifact_prefix,
      archive_kind,
      manifest_key,
      runtime_lane,
      recommended_runtime_lane,
      has_assets,
      created_at
    FROM deployments
    WHERE github_repo = ?
      AND status = 'success'
      AND archive_kind = 'full'
    ORDER BY created_at DESC
  `).bind(githubRepo).all<DeploymentRow>();

  return result.results.map(toDeploymentRecord);
}

export async function listExpiredRetainedFailedDeployments(
  db: D1Database,
  cutoffIso: string
): Promise<DeploymentRecord[]> {
  const session = db.withSession("first-primary");
  const result = await session.prepare(`
    SELECT
      deployment_id,
      job_id,
      project_name,
      owner_login,
      github_repo,
      head_sha,
      status,
      deployment_url,
      artifact_prefix,
      archive_kind,
      manifest_key,
      runtime_lane,
      recommended_runtime_lane,
      has_assets,
      created_at
    FROM deployments
    WHERE status = 'failure'
      AND archive_kind != 'none'
      AND created_at < ?
    ORDER BY created_at ASC
  `).bind(cutoffIso).all<DeploymentRow>();

  return result.results.map(toDeploymentRecord);
}

export async function listDeploymentsForProject(
  db: D1Database,
  projectName: string
): Promise<DeploymentRecord[]> {
  const session = db.withSession("first-primary");
  const result = await session.prepare(`
    SELECT
      deployment_id,
      job_id,
      project_name,
      owner_login,
      github_repo,
      head_sha,
      status,
      deployment_url,
      artifact_prefix,
      archive_kind,
      manifest_key,
      runtime_lane,
      recommended_runtime_lane,
      has_assets,
      created_at
    FROM deployments
    WHERE project_name = ?
    ORDER BY created_at DESC
  `).bind(projectName).all<DeploymentRow>();

  return result.results.map(toDeploymentRecord);
}

export async function listDeploymentsForRepository(
  db: D1Database,
  githubRepo: string
): Promise<DeploymentRecord[]> {
  const session = db.withSession("first-primary");
  const result = await session.prepare(`
    SELECT
      deployment_id,
      job_id,
      project_name,
      owner_login,
      github_repo,
      head_sha,
      status,
      deployment_url,
      artifact_prefix,
      archive_kind,
      manifest_key,
      runtime_lane,
      recommended_runtime_lane,
      has_assets,
      created_at
    FROM deployments
    WHERE github_repo = ?
    ORDER BY created_at DESC
  `).bind(githubRepo).all<DeploymentRow>();

  return result.results.map(toDeploymentRecord);
}

export async function getDeployment(
  db: D1Database,
  deploymentId: string
): Promise<DeploymentRecord | null> {
  const session = db.withSession("first-primary");
  const row = await session.prepare(`
    SELECT
      deployment_id,
      job_id,
      project_name,
      owner_login,
      github_repo,
      head_sha,
      status,
      deployment_url,
      artifact_prefix,
      archive_kind,
      manifest_key,
      runtime_lane,
      recommended_runtime_lane,
      has_assets,
      created_at
    FROM deployments
    WHERE deployment_id = ?
  `).bind(deploymentId).first<DeploymentRow>();

  return row ? toDeploymentRecord(row) : null;
}

export async function unpublishProjectsForRepository(
  db: D1Database,
  githubRepo: string,
  updatedAt: string
): Promise<void> {
  await db.prepare(`
    UPDATE projects
    SET latest_deployment_id = NULL,
        updated_at = ?
    WHERE github_repo = ?
  `).bind(updatedAt, githubRepo).run();
}

export async function deleteRepositoryControlPlaneState(
  db: D1Database,
  githubRepo: string
): Promise<void> {
  await db.prepare(`
    DELETE FROM webhook_deliveries
    WHERE job_id IN (
      SELECT job_id
      FROM build_jobs
      WHERE json_extract(repository_json, '$.fullName') = ?
    )
  `).bind(githubRepo).run();

  await db.prepare(`
    DELETE FROM build_jobs
    WHERE json_extract(repository_json, '$.fullName') = ?
  `).bind(githubRepo).run();

  await db.prepare(`
    DELETE FROM deployments
    WHERE github_repo = ?
  `).bind(githubRepo).run();

  await db.prepare(`
    DELETE FROM project_domains
    WHERE github_repo = ?
  `).bind(githubRepo).run();

  await db.prepare(`
    DELETE FROM project_secrets
    WHERE github_repo = ?
  `).bind(githubRepo).run();

  await db.prepare(`
    DELETE FROM project_policies
    WHERE github_repo = ?
  `).bind(githubRepo).run();

  await db.prepare(`
    DELETE FROM projects
    WHERE github_repo = ?
  `).bind(githubRepo).run();
}

export async function getProjectDeletionBacklog(
  db: D1Database,
  githubRepo: string
): Promise<ProjectDeletionBacklogRecord | null> {
  const session = db.withSession("first-primary");
  const row = await session.prepare(`
    SELECT
      github_repo,
      project_name,
      requested_at,
      updated_at,
      worker_script_names_json,
      database_ids_json,
      files_bucket_names_json,
      cache_namespace_ids_json,
      artifact_prefixes_json,
      last_error
    FROM project_deletion_backlogs
    WHERE github_repo = ?
  `).bind(githubRepo).first<ProjectDeletionBacklogRow>();

  return row ? toProjectDeletionBacklogRecord(row) : null;
}

export async function listProjectDeletionBacklogs(
  db: D1Database,
  limit = 10
): Promise<ProjectDeletionBacklogRecord[]> {
  const session = db.withSession("first-primary");
  const result = await session.prepare(`
    SELECT
      github_repo,
      project_name,
      requested_at,
      updated_at,
      worker_script_names_json,
      database_ids_json,
      files_bucket_names_json,
      cache_namespace_ids_json,
      artifact_prefixes_json,
      last_error
    FROM project_deletion_backlogs
    ORDER BY updated_at ASC
    LIMIT ?
  `).bind(limit).all<ProjectDeletionBacklogRow>();

  return result.results.map(toProjectDeletionBacklogRecord);
}

export async function putProjectDeletionBacklog(
  db: D1Database,
  backlog: ProjectDeletionBacklogRecord
): Promise<void> {
  await db.prepare(`
    INSERT INTO project_deletion_backlogs (
      github_repo,
      project_name,
      requested_at,
      updated_at,
      worker_script_names_json,
      database_ids_json,
      files_bucket_names_json,
      cache_namespace_ids_json,
      artifact_prefixes_json,
      last_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(github_repo) DO UPDATE SET
      project_name = excluded.project_name,
      updated_at = excluded.updated_at,
      worker_script_names_json = excluded.worker_script_names_json,
      database_ids_json = excluded.database_ids_json,
      files_bucket_names_json = excluded.files_bucket_names_json,
      cache_namespace_ids_json = excluded.cache_namespace_ids_json,
      artifact_prefixes_json = excluded.artifact_prefixes_json,
      last_error = excluded.last_error
  `).bind(
    backlog.githubRepo,
    backlog.projectName,
    backlog.requestedAt,
    backlog.updatedAt,
    JSON.stringify(backlog.workerScriptNames),
    JSON.stringify(backlog.databaseIds),
    JSON.stringify(backlog.filesBucketNames),
    JSON.stringify(backlog.cacheNamespaceIds),
    JSON.stringify(backlog.artifactPrefixes),
    backlog.lastError ?? null
  ).run();
}

export async function deleteProjectDeletionBacklog(
  db: D1Database,
  githubRepo: string
): Promise<void> {
  await db.prepare(`
    DELETE FROM project_deletion_backlogs
    WHERE github_repo = ?
  `).bind(githubRepo).run();
}

export async function getBuildJob(db: D1Database, jobId: string): Promise<BuildJobRecord | null> {
  const session = db.withSession("first-primary");
  const row = await session.prepare(`
    SELECT
      job_id,
      delivery_id,
      event_name,
      installation_id,
      repository_json,
      ref,
      head_sha,
      previous_sha,
      check_run_id,
      status,
      created_at,
      updated_at,
      started_at,
      completed_at,
      project_name,
      deployment_url,
      deployment_id,
      build_log_url,
      error_kind,
      error_message,
      error_detail,
      runner_id
    FROM build_jobs
    WHERE job_id = ?
  `).bind(jobId).first<BuildJobRow>();

  return row ? toBuildJobRecord(row) : null;
}

export async function getBuildJobByDeliveryId(db: D1Database, deliveryId: string): Promise<BuildJobRecord | null> {
  const session = db.withSession("first-primary");
  const row = await session.prepare(`
    SELECT
      job_id,
      delivery_id,
      event_name,
      installation_id,
      repository_json,
      ref,
      head_sha,
      previous_sha,
      check_run_id,
      status,
      created_at,
      updated_at,
      started_at,
      completed_at,
      project_name,
      deployment_url,
      deployment_id,
      build_log_url,
      error_kind,
      error_message,
      error_detail,
      runner_id
    FROM build_jobs
    WHERE delivery_id = ?
  `).bind(deliveryId).first<BuildJobRow>();

  return row ? toBuildJobRecord(row) : null;
}

export async function putBuildJob(db: D1Database, job: BuildJobRecord): Promise<void> {
  await db.prepare(`
    INSERT INTO build_jobs (
      job_id,
      delivery_id,
      event_name,
      installation_id,
      repository_json,
      ref,
      head_sha,
      previous_sha,
      check_run_id,
      status,
      created_at,
      updated_at,
      started_at,
      completed_at,
      project_name,
      deployment_url,
      deployment_id,
      build_log_url,
      error_kind,
      error_message,
      error_detail,
      runner_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET
      delivery_id = excluded.delivery_id,
      installation_id = excluded.installation_id,
      repository_json = excluded.repository_json,
      ref = excluded.ref,
      head_sha = excluded.head_sha,
      previous_sha = excluded.previous_sha,
      check_run_id = excluded.check_run_id,
      status = excluded.status,
      updated_at = excluded.updated_at,
      started_at = excluded.started_at,
      completed_at = excluded.completed_at,
      project_name = excluded.project_name,
      deployment_url = excluded.deployment_url,
      deployment_id = excluded.deployment_id,
      build_log_url = excluded.build_log_url,
      error_kind = excluded.error_kind,
      error_message = excluded.error_message,
      error_detail = excluded.error_detail,
      runner_id = excluded.runner_id
  `).bind(
    job.jobId,
    job.deliveryId ?? null,
    job.eventName,
    job.installationId,
    JSON.stringify(job.repository),
    job.ref,
    job.headSha,
    job.previousSha ?? null,
    job.checkRunId,
    job.status,
    job.createdAt,
    job.updatedAt,
    job.startedAt ?? null,
    job.completedAt ?? null,
    job.projectName ?? null,
    job.deploymentUrl ?? null,
    job.deploymentId ?? null,
    job.buildLogUrl ?? null,
    job.errorKind ?? null,
    job.errorMessage ?? null,
    job.errorDetail ?? null,
    job.runnerId ?? null
  ).run();
}

export async function getLatestBuildJobForProject(
  db: D1Database,
  projectName: string
): Promise<BuildJobRecord | null> {
  const session = db.withSession("first-primary");
  const row = await session.prepare(`
    SELECT
      job_id,
      delivery_id,
      event_name,
      installation_id,
      repository_json,
      ref,
      head_sha,
      previous_sha,
      check_run_id,
      status,
      created_at,
      updated_at,
      started_at,
      completed_at,
      project_name,
      deployment_url,
      deployment_id,
      build_log_url,
      error_kind,
      error_message,
      error_detail,
      runner_id
    FROM build_jobs
    WHERE project_name = ?
      AND event_name = 'push'
    ORDER BY updated_at DESC
    LIMIT 1
  `).bind(projectName).first<BuildJobRow>();

  return row ? toBuildJobRecord(row) : null;
}

export async function claimWebhookDelivery(
  db: D1Database,
  deliveryId: string,
  eventName: string,
  receivedAt: string
): Promise<boolean> {
  const row = await db.prepare(`
    INSERT INTO webhook_deliveries (delivery_id, event_name, received_at)
    VALUES (?, ?, ?)
    ON CONFLICT(delivery_id) DO NOTHING
    RETURNING delivery_id
  `).bind(deliveryId, eventName, receivedAt).first<{ delivery_id: string }>();

  return Boolean(row?.delivery_id);
}

export async function attachWebhookDeliveryJob(
  db: D1Database,
  deliveryId: string,
  jobId: string
): Promise<void> {
  await db.prepare(`
    UPDATE webhook_deliveries
    SET job_id = ?
    WHERE delivery_id = ?
  `).bind(jobId, deliveryId).run();
}

export async function releaseWebhookDelivery(db: D1Database, deliveryId: string): Promise<void> {
  await db.prepare(`
    DELETE FROM webhook_deliveries
    WHERE delivery_id = ?
      AND job_id IS NULL
  `).bind(deliveryId).run();
}

export async function consumeOauthGrant(
  db: D1Database,
  jti: string,
  grantKind: "authorization_code",
  usedAt: string
): Promise<boolean> {
  const row = await db.prepare(`
    INSERT INTO oauth_used_grants (jti, grant_kind, used_at)
    VALUES (?, ?, ?)
    ON CONFLICT(jti) DO NOTHING
    RETURNING jti
  `).bind(jti, grantKind, usedAt).first<OauthUsedGrantRow>();

  return Boolean(row?.jti);
}

export async function consumeOauthRefreshToken(
  db: D1Database,
  jti: string,
  usedAt: string
): Promise<boolean> {
  const row = await db.prepare(`
    INSERT INTO oauth_used_refresh_tokens (jti, used_at)
    VALUES (?, ?)
    ON CONFLICT(jti) DO NOTHING
    RETURNING jti
  `).bind(jti, usedAt).first<OauthUsedGrantRow>();

  return Boolean(row?.jti);
}

function toProjectRecord(row: ProjectRow): ProjectRecord {
  return {
    projectName: row.project_name,
    ownerLogin: row.owner_login,
    githubRepo: row.github_repo,
    description: row.description ?? undefined,
    deploymentUrl: row.deployment_url,
    databaseId: row.database_id ?? undefined,
    filesBucketName: row.files_bucket_name ?? undefined,
    cacheNamespaceId: row.cache_namespace_id ?? undefined,
    runtimeLane: row.runtime_lane ?? "dedicated_worker",
    recommendedRuntimeLane: row.recommended_runtime_lane ?? row.runtime_lane ?? "dedicated_worker",
    hasAssets: row.has_assets === 1,
    latestDeploymentId: row.latest_deployment_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toProjectDomainRecord(row: ProjectDomainRow): ProjectDomainRecord {
  return {
    domainLabel: row.domain_label,
    projectName: row.project_name,
    githubRepo: row.github_repo,
    isPrimary: row.is_primary === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toProjectDeletionBacklogRecord(row: ProjectDeletionBacklogRow): ProjectDeletionBacklogRecord {
  return {
    githubRepo: row.github_repo,
    projectName: row.project_name,
    requestedAt: row.requested_at,
    updatedAt: row.updated_at,
    workerScriptNames: parseJsonArray(row.worker_script_names_json),
    databaseIds: parseJsonArray(row.database_ids_json),
    filesBucketNames: parseJsonArray(row.files_bucket_names_json),
    cacheNamespaceIds: parseJsonArray(row.cache_namespace_ids_json),
    artifactPrefixes: parseJsonArray(row.artifact_prefixes_json),
    lastError: row.last_error ?? undefined
  };
}

function toGitHubUserAuthRecord(row: GitHubUserAuthRow): GitHubUserAuthRecord {
  return {
    accessSubject: row.access_subject,
    accessEmail: row.access_email,
    githubUserId: row.github_user_id,
    githubLogin: row.github_login,
    accessTokenEncrypted: row.access_token_encrypted,
    accessTokenExpiresAt: row.access_token_expires_at ?? undefined,
    refreshTokenEncrypted: row.refresh_token_encrypted ?? undefined,
    refreshTokenExpiresAt: row.refresh_token_expires_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toBuildJobRecord(row: BuildJobRow): BuildJobRecord {
  return {
    jobId: row.job_id,
    deliveryId: row.delivery_id ?? undefined,
    eventName: row.event_name,
    installationId: row.installation_id,
    repository: JSON.parse(row.repository_json) as GitHubRepositoryRecord,
    ref: row.ref,
    headSha: row.head_sha,
    previousSha: row.previous_sha ?? undefined,
    checkRunId: row.check_run_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    projectName: row.project_name ?? undefined,
    deploymentUrl: row.deployment_url ?? undefined,
    deploymentId: row.deployment_id ?? undefined,
    buildLogUrl: row.build_log_url ?? undefined,
    errorKind: row.error_kind ?? undefined,
    errorMessage: row.error_message ?? undefined,
    errorDetail: row.error_detail ?? undefined,
    runnerId: row.runner_id ?? undefined
  };
}

function toProjectPolicyRecord(row: ProjectPolicyRow): ProjectPolicyRecord {
  return {
    githubRepo: row.github_repo,
    projectName: row.project_name ?? undefined,
    aiEnabled: row.ai_enabled === 1,
    vectorizeEnabled: row.vectorize_enabled === 1,
    roomsEnabled: row.rooms_enabled === 1,
    maxValidationsPerDay: row.max_validations_per_day,
    maxDeploymentsPerDay: row.max_deployments_per_day,
    maxConcurrentBuilds: row.max_concurrent_builds,
    maxAssetBytes: row.max_asset_bytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseJsonArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.map((entry) => String(entry));
}

function toProjectSecretRecord(row: ProjectSecretRow): ProjectSecretRecord {
  return {
    githubRepo: row.github_repo,
    projectName: row.project_name,
    secretName: row.secret_name,
    ciphertext: row.ciphertext,
    iv: row.iv,
    githubUserId: row.github_user_id,
    githubLogin: row.github_login,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}


function toDeploymentRecord(row: DeploymentRow): DeploymentRecord {
  return {
    deploymentId: row.deployment_id,
    jobId: row.job_id ?? undefined,
    projectName: row.project_name,
    ownerLogin: row.owner_login,
    githubRepo: row.github_repo,
    headSha: row.head_sha ?? undefined,
    status: row.status,
    deploymentUrl: row.deployment_url,
    artifactPrefix: row.artifact_prefix,
    archiveKind: row.archive_kind,
    manifestKey: row.manifest_key ?? undefined,
    runtimeLane: row.runtime_lane ?? "dedicated_worker",
    recommendedRuntimeLane: row.recommended_runtime_lane ?? row.runtime_lane ?? "dedicated_worker",
    hasAssets: row.has_assets === 1,
    createdAt: row.created_at
  };
}
