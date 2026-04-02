import type { DeploymentRecord, ProjectRecord } from "@cuny-ai-lab/build-contract";

import { CloudflareApiClient } from "./lib/cloudflare";
import {
  deleteRepositoryControlPlaneState,
  listDeploymentsForRepository,
  listProjectDomainsForRepository,
  listProjectsForRepository,
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

type ProjectDeleteEnv = {
  CONTROL_PLANE_DB: D1Database;
  DEPLOYMENT_ARCHIVE: R2Bucket;
  CLOUDFLARE_ACCOUNT_ID: string;
  WFP_NAMESPACE: string;
};

export function assertProjectDeleteConfirmation(projectName: string, confirmation: string | undefined): void {
  const normalized = confirmation?.trim().toLowerCase();
  if (normalized !== projectName) {
    throw new HttpError(400, `Type ${projectName} exactly to confirm permanent deletion.`);
  }
}

export async function deleteProjectFromKale<Env extends ProjectDeleteEnv>(
  env: Env,
  config: ProjectDeleteConfig<Env>,
  authorization: ProjectDeletionAccessContext
): Promise<ProjectDeletePayload> {
  const { project } = authorization;
  const now = new Date().toISOString();
  const [projects, domains, deployments] = await Promise.all([
    listProjectsForRepository(env.CONTROL_PLANE_DB, authorization.repositoryFullName),
    listProjectDomainsForRepository(env.CONTROL_PLANE_DB, authorization.repositoryFullName),
    listDeploymentsForRepository(env.CONTROL_PLANE_DB, authorization.repositoryFullName)
  ]);
  await unpublishProjectsForRepository(env.CONTROL_PLANE_DB, authorization.repositoryFullName, now);

  const artifactPrefixes = uniqueArtifactPrefixes(deployments);
  const workerScriptNames = uniqueWorkerScriptNames(projects, deployments);
  const databaseIds = uniqueValues(projects.map((entry) => entry.databaseId));
  const filesBucketNames = uniqueValues(projects.map((entry) => entry.filesBucketName));
  const cacheNamespaceIds = uniqueValues(projects.map((entry) => entry.cacheNamespaceId));
  const client = new CloudflareApiClient({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: config.resolveRequiredCloudflareApiToken(env)
  });

  try {
    await Promise.all(workerScriptNames.map((scriptName) =>
      client.deleteUserWorker(env.WFP_NAMESPACE, scriptName)
    ));
    await Promise.all(databaseIds.map((databaseId) =>
      client.deleteD1Database(databaseId)
    ));
    await Promise.all(filesBucketNames.map((bucketName) =>
      client.deleteR2Bucket(bucketName)
    ));
    await Promise.all(cacheNamespaceIds.map((namespaceId) =>
      client.deleteKvNamespace(namespaceId)
    ));
    for (const prefix of artifactPrefixes) {
      await deleteArtifactPrefix(env.DEPLOYMENT_ARCHIVE, prefix);
    }
  } catch (error) {
    console.error("Project deletion cleanup failed after Kale unpublished the project.", {
      projectName: project.projectName,
      githubRepo: authorization.repositoryFullName,
      error
    });
    throw new HttpError(
      502,
      `Kale unpublished ${project.projectName}, but could not finish deleting every Cloudflare resource. Retry deletion to finish cleanup.`
    );
  }

  await deleteRepositoryControlPlaneState(env.CONTROL_PLANE_DB, authorization.repositoryFullName);

  return {
    ok: true,
    projectName: project.projectName,
    repositoryFullName: authorization.repositoryFullName,
    connectedGitHubLogin: authorization.githubLogin,
    deletedFromKaleOnly: true,
    githubRepositoryUnaffected: true,
    deleted: {
      deploymentRecords: deployments.length,
      archivedDeployments: artifactPrefixes.length,
      domainLabels: domains.length,
      workerScriptCleanedUp: workerScriptNames.length > 0,
      databaseCleanedUp: databaseIds.length > 0,
      filesBucketCleanedUp: filesBucketNames.length > 0,
      cacheNamespaceCleanedUp: cacheNamespaceIds.length > 0
    },
    summary: `Deleted ${project.projectName} from Kale Deploy. The GitHub repo ${authorization.repositoryFullName} was not changed.`
  };
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
