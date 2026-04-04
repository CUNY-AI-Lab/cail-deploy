import type { DeploymentRecord, ProjectRecord } from "@cuny-ai-lab/build-contract";

import { CloudflareApiClient } from "./lib/cloudflare";
import {
  deleteProjectDeletionBacklog,
  deleteRepositoryControlPlaneState,
  getProjectDeletionBacklog,
  listProjectDeletionBacklogs,
  listDeploymentsForRepository,
  listProjectDomainsForRepository,
  listProjectsForRepository,
  putProjectDeletionBacklog,
  type ProjectDeletionBacklogRecord,
  unpublishProjectsForRepository
} from "./lib/control-plane";
import { HttpError } from "./http-error";

export type ProjectDeletePayload = {
  ok: true;
  projectName: string;
  repositoryFullName: string;
  connectedGitHubLogin: string;
  deletedFromKaleOnly: true;
  githubRepositoryUnaffected: true;
  deleted: {
    deploymentRecords: number;
    archivedDeployments: number;
    domainLabels: number;
    workerScriptCleanedUp: boolean;
    databaseCleanedUp: boolean;
    filesBucketCleanedUp: boolean;
    cacheNamespaceCleanedUp: boolean;
  };
  cleanupPending?: {
    workerScripts: number;
    databases: number;
    filesBuckets: number;
    cacheNamespaces: number;
    artifactPrefixes: number;
    summary: string;
  };
  summary: string;
};

export type ProjectDeletionAccessContext = {
  project: ProjectRecord;
  repositoryFullName: string;
  githubLogin: string;
  githubUserId: number;
};

export type ProjectDeleteConfig<Env> = {
  resolveRequiredCloudflareApiToken(env: Env): string;
};

export type ProjectDeleteOptions = {
  scheduleBackgroundCleanup?: (task: Promise<void>) => void;
};

type ProjectDeleteEnv = {
  CONTROL_PLANE_DB: D1Database;
  DEPLOYMENT_ARCHIVE: R2Bucket;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_R2_ACCESS_KEY_ID?: string;
  CLOUDFLARE_R2_SECRET_ACCESS_KEY?: string;
  WFP_NAMESPACE: string;
};

type ProjectDeletionCleanupTargets = {
  workerScriptNames: string[];
  databaseIds: string[];
  filesBucketNames: string[];
  cacheNamespaceIds: string[];
  artifactPrefixes: string[];
};

type ProjectDeletionCleanupResult = {
  remaining: ProjectDeletionCleanupTargets;
  lastError?: string;
};

const BACKGROUND_DELETE_RETRY_ATTEMPTS = 4;
const BACKGROUND_DELETE_RETRY_MS = 1_500;

export function assertProjectDeleteConfirmation(projectName: string, confirmation: string | undefined): void {
  const normalized = confirmation?.trim().toLowerCase();
  if (normalized !== projectName) {
    throw new HttpError(400, `Type ${projectName} exactly to confirm permanent deletion.`);
  }
}

export async function deleteProjectFromKale<Env extends ProjectDeleteEnv>(
  env: Env,
  config: ProjectDeleteConfig<Env>,
  authorization: ProjectDeletionAccessContext,
  options: ProjectDeleteOptions = {}
): Promise<ProjectDeletePayload> {
  const { project } = authorization;
  const now = new Date().toISOString();
  const [projects, domains, deployments, existingBacklog] = await Promise.all([
    listProjectsForRepository(env.CONTROL_PLANE_DB, authorization.repositoryFullName),
    listProjectDomainsForRepository(env.CONTROL_PLANE_DB, authorization.repositoryFullName),
    listDeploymentsForRepository(env.CONTROL_PLANE_DB, authorization.repositoryFullName),
    getProjectDeletionBacklog(env.CONTROL_PLANE_DB, authorization.repositoryFullName)
  ]);
  const cleanupTargets = mergeCleanupTargets(
    existingBacklog,
    buildCleanupTargets(projects, deployments),
    authorization.repositoryFullName,
    project.projectName,
    now
  );

  if (hasCleanupTargets(cleanupTargets)) {
    await putProjectDeletionBacklog(env.CONTROL_PLANE_DB, cleanupTargets);
  }

  await unpublishProjectsForRepository(env.CONTROL_PLANE_DB, authorization.repositoryFullName, now);
  const cleanupResult = await runProjectDeletionCleanup(env, config, cleanupTargets);
  const cleanupPending = hasCleanupTargets(cleanupResult.remaining);
  const finalBacklog = toBacklogRecord(cleanupTargets, cleanupResult, now);

  if (cleanupPending) {
    await putProjectDeletionBacklog(env.CONTROL_PLANE_DB, finalBacklog);
    options.scheduleBackgroundCleanup?.(
      retryPendingProjectDeletionBacklog(env, config, authorization.repositoryFullName)
    );
  } else {
    await deleteProjectDeletionBacklog(env.CONTROL_PLANE_DB, authorization.repositoryFullName);
    await deleteRepositoryControlPlaneState(env.CONTROL_PLANE_DB, authorization.repositoryFullName);
  }

  return {
    ok: true,
    projectName: project.projectName,
    repositoryFullName: authorization.repositoryFullName,
    connectedGitHubLogin: authorization.githubLogin,
    deletedFromKaleOnly: true,
    githubRepositoryUnaffected: true,
    deleted: {
      deploymentRecords: deployments.length,
      archivedDeployments: cleanupTargets.artifactPrefixes.length,
      domainLabels: domains.length,
      workerScriptCleanedUp: cleanupTargets.workerScriptNames.length > 0 && cleanupResult.remaining.workerScriptNames.length === 0,
      databaseCleanedUp: cleanupTargets.databaseIds.length > 0 && cleanupResult.remaining.databaseIds.length === 0,
      filesBucketCleanedUp: cleanupTargets.filesBucketNames.length > 0 && cleanupResult.remaining.filesBucketNames.length === 0,
      cacheNamespaceCleanedUp: cleanupTargets.cacheNamespaceIds.length > 0 && cleanupResult.remaining.cacheNamespaceIds.length === 0
    },
    ...(cleanupPending
      ? {
          cleanupPending: {
            workerScripts: cleanupResult.remaining.workerScriptNames.length,
            databases: cleanupResult.remaining.databaseIds.length,
            filesBuckets: cleanupResult.remaining.filesBucketNames.length,
            cacheNamespaces: cleanupResult.remaining.cacheNamespaceIds.length,
            artifactPrefixes: cleanupResult.remaining.artifactPrefixes.length,
            summary: `Deleted ${project.projectName} from Kale Deploy and unpublished its live site. Kale will keep retrying the remaining Cloudflare cleanup automatically.`
          }
        }
      : {}),
    summary: cleanupPending
      ? `Deleted ${project.projectName} from Kale Deploy and unpublished its live site. Kale will keep retrying the remaining Cloudflare cleanup automatically. The GitHub repo ${authorization.repositoryFullName} was not changed.`
      : `Deleted ${project.projectName} from Kale Deploy. The GitHub repo ${authorization.repositoryFullName} was not changed.`
  };
}

export async function resumePendingProjectDeletionBacklogs<Env extends ProjectDeleteEnv>(
  env: Env,
  config: ProjectDeleteConfig<Env>,
  options: { limit?: number } = {}
): Promise<void> {
  const pendingBacklogs = await listProjectDeletionBacklogs(env.CONTROL_PLANE_DB, options.limit ?? 1);

  for (const backlog of pendingBacklogs) {
    await continuePendingProjectDeletionBacklog(env, config, backlog);
  }
}

function uniqueArtifactPrefixes(deployments: DeploymentRecord[]): string[] {
  const prefixes = new Set<string>();
  for (const deployment of deployments) {
    if (deployment.artifactPrefix) {
      prefixes.add(deployment.artifactPrefix);
    }
  }
  return [...prefixes];
}

function uniqueWorkerScriptNames(projects: ProjectRecord[], deployments: DeploymentRecord[]): string[] {
  const names = new Set<string>();

  for (const project of projects) {
    names.add(project.projectName);
  }
  for (const deployment of deployments) {
    names.add(deployment.projectName);
  }

  return [...names];
}

function uniqueValues(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value?.trim())))];
}

function buildCleanupTargets(
  projects: ProjectRecord[],
  deployments: DeploymentRecord[]
): ProjectDeletionCleanupTargets {
  return {
    workerScriptNames: uniqueWorkerScriptNames(projects, deployments),
    databaseIds: uniqueValues(projects.map((entry) => entry.databaseId)),
    filesBucketNames: uniqueValues(projects.map((entry) => entry.filesBucketName)),
    cacheNamespaceIds: uniqueValues(projects.map((entry) => entry.cacheNamespaceId)),
    artifactPrefixes: uniqueArtifactPrefixes(deployments)
  };
}

function mergeCleanupTargets(
  existingBacklog: ProjectDeletionBacklogRecord | null,
  currentTargets: ProjectDeletionCleanupTargets,
  githubRepo: string,
  projectName: string,
  now: string
): ProjectDeletionBacklogRecord {
  return {
    githubRepo,
    projectName: existingBacklog?.projectName ?? projectName,
    requestedAt: existingBacklog?.requestedAt ?? now,
    updatedAt: now,
    workerScriptNames: uniqueStrings(existingBacklog?.workerScriptNames, currentTargets.workerScriptNames),
    databaseIds: uniqueStrings(existingBacklog?.databaseIds, currentTargets.databaseIds),
    filesBucketNames: uniqueStrings(existingBacklog?.filesBucketNames, currentTargets.filesBucketNames),
    cacheNamespaceIds: uniqueStrings(existingBacklog?.cacheNamespaceIds, currentTargets.cacheNamespaceIds),
    artifactPrefixes: uniqueStrings(existingBacklog?.artifactPrefixes, currentTargets.artifactPrefixes),
    lastError: existingBacklog?.lastError
  };
}

function toBacklogRecord(
  source: ProjectDeletionBacklogRecord,
  cleanupResult: ProjectDeletionCleanupResult,
  now: string
): ProjectDeletionBacklogRecord {
  return {
    ...source,
    updatedAt: now,
    workerScriptNames: cleanupResult.remaining.workerScriptNames,
    databaseIds: cleanupResult.remaining.databaseIds,
    filesBucketNames: cleanupResult.remaining.filesBucketNames,
    cacheNamespaceIds: cleanupResult.remaining.cacheNamespaceIds,
    artifactPrefixes: cleanupResult.remaining.artifactPrefixes,
    lastError: cleanupResult.lastError
  };
}

async function retryPendingProjectDeletionBacklog<Env extends ProjectDeleteEnv>(
  env: Env,
  config: ProjectDeleteConfig<Env>,
  githubRepo: string
): Promise<void> {
  for (let attempt = 0; attempt < BACKGROUND_DELETE_RETRY_ATTEMPTS; attempt += 1) {
    const finished = await continuePendingProjectDeletionBacklog(env, config, githubRepo);
    if (finished) {
      return;
    }
    if (attempt < BACKGROUND_DELETE_RETRY_ATTEMPTS - 1) {
      await sleep(BACKGROUND_DELETE_RETRY_MS * (attempt + 1));
    }
  }
}

async function continuePendingProjectDeletionBacklog<Env extends ProjectDeleteEnv>(
  env: Env,
  config: ProjectDeleteConfig<Env>,
  backlogOrRepo: ProjectDeletionBacklogRecord | string
): Promise<boolean> {
  const backlog = typeof backlogOrRepo === "string"
    ? await getProjectDeletionBacklog(env.CONTROL_PLANE_DB, backlogOrRepo)
    : backlogOrRepo;
  if (!backlog) {
    return true;
  }

  const cleanupResult = await runProjectDeletionCleanup(env, config, backlog);
  if (hasCleanupTargets(cleanupResult.remaining)) {
    await putProjectDeletionBacklog(
      env.CONTROL_PLANE_DB,
      toBacklogRecord(backlog, cleanupResult, new Date().toISOString())
    );
    return false;
  }

  await deleteProjectDeletionBacklog(env.CONTROL_PLANE_DB, backlog.githubRepo);
  await deleteRepositoryControlPlaneState(env.CONTROL_PLANE_DB, backlog.githubRepo);
  return true;
}

async function runProjectDeletionCleanup<Env extends ProjectDeleteEnv>(
  env: Env,
  config: ProjectDeleteConfig<Env>,
  targets: ProjectDeletionCleanupTargets
): Promise<ProjectDeletionCleanupResult> {
  const client = new CloudflareApiClient({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: config.resolveRequiredCloudflareApiToken(env),
    r2AccessKeyId: env.CLOUDFLARE_R2_ACCESS_KEY_ID,
    r2SecretAccessKey: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY
  });
  const remaining: ProjectDeletionCleanupTargets = {
    workerScriptNames: [],
    databaseIds: [],
    filesBucketNames: [],
    cacheNamespaceIds: [],
    artifactPrefixes: []
  };
  let lastError: string | undefined;

  const recordFailure = (
    resourceType: string,
    resourceName: string,
    error: unknown
  ): void => {
    lastError = `${resourceType} ${resourceName}: ${formatCleanupError(error)}`;
    console.error("Project deletion cleanup step failed.", {
      resourceType,
      resourceName,
      error
    });
  };

  await cleanupCollection(targets.workerScriptNames, remaining.workerScriptNames, async (scriptName) => {
    await client.deleteUserWorker(env.WFP_NAMESPACE, scriptName);
  }, (scriptName, error) => recordFailure("worker_script", scriptName, error));
  await cleanupCollection(targets.databaseIds, remaining.databaseIds, async (databaseId) => {
    await client.deleteD1Database(databaseId);
  }, (databaseId, error) => recordFailure("database", databaseId, error));
  await cleanupCollection(targets.filesBucketNames, remaining.filesBucketNames, async (bucketName) => {
    await client.emptyAndDeleteR2Bucket(bucketName);
  }, (bucketName, error) => recordFailure("files_bucket", bucketName, error));
  await cleanupCollection(targets.cacheNamespaceIds, remaining.cacheNamespaceIds, async (namespaceId) => {
    await client.deleteKvNamespace(namespaceId);
  }, (namespaceId, error) => recordFailure("cache_namespace", namespaceId, error));
  await cleanupCollection(targets.artifactPrefixes, remaining.artifactPrefixes, async (prefix) => {
    await deleteArtifactPrefix(env.DEPLOYMENT_ARCHIVE, prefix);
  }, (prefix, error) => recordFailure("artifact_prefix", prefix, error));

  return { remaining, lastError };
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

async function cleanupCollection(
  values: string[],
  remaining: string[],
  action: (value: string) => Promise<void>,
  onFailure: (value: string, error: unknown) => void
): Promise<void> {
  for (const value of values) {
    try {
      await action(value);
    } catch (error) {
      remaining.push(value);
      onFailure(value, error);
    }
  }
}

function hasCleanupTargets(targets: ProjectDeletionCleanupTargets): boolean {
  return targets.workerScriptNames.length > 0
    || targets.databaseIds.length > 0
    || targets.filesBucketNames.length > 0
    || targets.cacheNamespaceIds.length > 0
    || targets.artifactPrefixes.length > 0;
}

function uniqueStrings(...collections: Array<string[] | undefined>): string[] {
  return [...new Set(collections.flatMap((entries) => entries ?? []))];
}

function formatCleanupError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
