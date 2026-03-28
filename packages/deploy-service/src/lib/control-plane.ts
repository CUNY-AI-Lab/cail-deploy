import type {
  BuildJobRecord,
  BuildJobStatus,
  DeploymentRecord,
  GitHubRepositoryRecord,
  ProjectRecord
} from "@cuny-ai-lab/build-contract";

type ProjectRow = {
  project_name: string;
  owner_login: string;
  github_repo: string;
  description: string | null;
  deployment_url: string;
  database_id: string | null;
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
      has_assets,
      latest_deployment_id,
      created_at,
      updated_at
    FROM projects
    WHERE project_name = ?
  `).bind(projectName).first<ProjectRow>();

  return row ? toProjectRecord(row) : null;
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
      has_assets,
      latest_deployment_id,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_name) DO UPDATE SET
      owner_login = excluded.owner_login,
      github_repo = excluded.github_repo,
      description = excluded.description,
      deployment_url = excluded.deployment_url,
      database_id = excluded.database_id,
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
      has_assets,
      latest_deployment_id,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_name) DO NOTHING
  `).bind(
    project.projectName,
    project.ownerLogin,
    project.githubRepo,
    project.description ?? null,
    project.deploymentUrl,
    project.databaseId ?? null,
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
      has_assets,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

function toProjectRecord(row: ProjectRow): ProjectRecord {
  return {
    projectName: row.project_name,
    ownerLogin: row.owner_login,
    githubRepo: row.github_repo,
    description: row.description ?? undefined,
    deploymentUrl: row.deployment_url,
    databaseId: row.database_id ?? undefined,
    hasAssets: row.has_assets === 1,
    latestDeploymentId: row.latest_deployment_id ?? undefined,
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
    hasAssets: row.has_assets === 1,
    createdAt: row.created_at
  };
}
