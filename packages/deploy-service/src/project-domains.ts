import type { ProjectRecord } from "@cuny-ai-lab/build-contract";

import { HttpError } from "./http-error";
import {
  deleteProjectDomain,
  getPrimaryProjectDomainForProject,
  getProjectDomain,
  listProjectDomainsForProject,
  putProjectDomain,
  updateProjectDeploymentUrl
} from "./lib/control-plane";

export type ProjectDomainListItem = {
  domainLabel: string;
  url: string;
  updatedAt: string;
};

export type ProjectDomainsPayload = {
  primaryDomainLabel: string;
  primaryUrl: string;
  redirects: ProjectDomainListItem[];
};

export type ProjectDomainMutationPayload = {
  summary: string;
};

type ProjectDomainsEnv = {
  CONTROL_PLANE_DB: D1Database;
  PROJECT_BASE_URL: string;
  PROJECT_HOST_SUFFIX?: string;
};

export async function ensurePrimaryProjectDomainLabel(
  env: ProjectDomainsEnv,
  projectName: string,
  githubRepo: string,
  now: string
): Promise<string> {
  const primary = await getPrimaryProjectDomainForProject(env.CONTROL_PLANE_DB, projectName);
  if (primary) {
    return primary.domainLabel;
  }

  const existing = await getProjectDomain(env.CONTROL_PLANE_DB, projectName);
  if (existing && existing.projectName !== projectName) {
    throw new HttpError(409, `The URL label '${projectName}' is already in use by another Kale project.`);
  }

  await putProjectDomain(env.CONTROL_PLANE_DB, {
    domainLabel: projectName,
    projectName,
    githubRepo,
    isPrimary: true,
    createdAt: now,
    updatedAt: now
  });
  return projectName;
}

export async function buildProjectDomainsPayload(
  env: ProjectDomainsEnv,
  project: ProjectRecord
): Promise<ProjectDomainsPayload> {
  const domains = await listProjectDomainsForProject(env.CONTROL_PLANE_DB, project.projectName);
  const primary = domains.find((domain) => domain.isPrimary) ?? {
    domainLabel: project.projectName,
    projectName: project.projectName,
    githubRepo: project.githubRepo,
    isPrimary: true,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt
  };

  return {
    primaryDomainLabel: primary.domainLabel,
    primaryUrl: buildProjectDeploymentUrl(env, primary.domainLabel),
    redirects: domains
      .filter((domain) => !domain.isPrimary)
      .map((domain) => ({
        domainLabel: domain.domainLabel,
        url: buildProjectDeploymentUrl(env, domain.domainLabel),
        updatedAt: domain.updatedAt
      }))
  };
}

export async function setProjectPrimaryDomainLabel(
  env: ProjectDomainsEnv,
  project: ProjectRecord,
  domainLabel: string
): Promise<ProjectDomainMutationPayload> {
  const now = new Date().toISOString();
  const domains = await listProjectDomainsForProject(env.CONTROL_PLANE_DB, project.projectName);
  const currentPrimary = domains.find((domain) => domain.isPrimary);
  const currentPrimaryLabel = currentPrimary?.domainLabel ?? project.projectName;
  const existing = await getProjectDomain(env.CONTROL_PLANE_DB, domainLabel);

  if (existing && existing.projectName !== project.projectName) {
    throw new HttpError(409, `The URL label '${domainLabel}' is already in use by another Kale project.`);
  }

  if (currentPrimary && currentPrimary.domainLabel !== domainLabel) {
    await putProjectDomain(env.CONTROL_PLANE_DB, {
      ...currentPrimary,
      isPrimary: false,
      updatedAt: now
    });
  } else if (!currentPrimary && currentPrimaryLabel !== domainLabel) {
    await putProjectDomain(env.CONTROL_PLANE_DB, {
      domainLabel: currentPrimaryLabel,
      projectName: project.projectName,
      githubRepo: project.githubRepo,
      isPrimary: false,
      createdAt: project.createdAt,
      updatedAt: now
    });
  }

  await putProjectDomain(env.CONTROL_PLANE_DB, {
    domainLabel,
    projectName: project.projectName,
    githubRepo: project.githubRepo,
    isPrimary: true,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  });

  const primaryUrl = buildProjectDeploymentUrl(env, domainLabel);
  await updateProjectDeploymentUrl(env.CONTROL_PLANE_DB, project.projectName, primaryUrl, now);

  if (currentPrimaryLabel === domainLabel) {
    return {
      summary: `Primary Kale URL is already ${primaryUrl}.`
    };
  }

  return {
    summary: `Primary Kale URL changed to ${primaryUrl}. ${buildProjectDeploymentUrl(env, currentPrimaryLabel)} now redirects there.`
  };
}

export async function addProjectRedirectDomainLabel(
  env: ProjectDomainsEnv,
  project: ProjectRecord,
  domainLabel: string
): Promise<ProjectDomainMutationPayload> {
  const now = new Date().toISOString();
  const primaryDomainLabel = await ensurePrimaryProjectDomainLabel(
    env,
    project.projectName,
    project.githubRepo,
    now
  );
  if (domainLabel === primaryDomainLabel) {
    throw new HttpError(400, `The label '${domainLabel}' is already the primary Kale URL for this project.`);
  }

  const existing = await getProjectDomain(env.CONTROL_PLANE_DB, domainLabel);
  if (existing && existing.projectName !== project.projectName) {
    throw new HttpError(409, `The URL label '${domainLabel}' is already in use by another Kale project.`);
  }

  if (existing?.projectName === project.projectName && !existing.isPrimary) {
    return {
      summary: `${buildProjectDeploymentUrl(env, domainLabel)} already redirects to ${buildProjectDeploymentUrl(env, primaryDomainLabel)}.`
    };
  }

  await putProjectDomain(env.CONTROL_PLANE_DB, {
    domainLabel,
    projectName: project.projectName,
    githubRepo: project.githubRepo,
    isPrimary: false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  });

  return {
    summary: `Added a redirect from ${buildProjectDeploymentUrl(env, domainLabel)} to ${buildProjectDeploymentUrl(env, primaryDomainLabel)}.`
  };
}

export async function removeProjectRedirectDomainLabel(
  env: ProjectDomainsEnv,
  project: ProjectRecord,
  domainLabel: string
): Promise<ProjectDomainMutationPayload> {
  const existing = await getProjectDomain(env.CONTROL_PLANE_DB, domainLabel);
  if (!existing || existing.projectName !== project.projectName) {
    throw new HttpError(404, "That redirect does not exist for this Kale project.");
  }
  if (existing.isPrimary) {
    throw new HttpError(400, "Use the primary URL form to change the main Kale URL for this project.");
  }

  await deleteProjectDomain(env.CONTROL_PLANE_DB, domainLabel);
  return {
    summary: `Removed the redirect from ${buildProjectDeploymentUrl(env, domainLabel)}.`
  };
}

function buildProjectDeploymentUrl(env: Pick<ProjectDomainsEnv, "PROJECT_BASE_URL" | "PROJECT_HOST_SUFFIX">, domainLabel: string): string {
  const projectHostSuffix = env.PROJECT_HOST_SUFFIX?.trim().replace(/^\.+|\.+$/g, "");
  if (projectHostSuffix) {
    return `https://${domainLabel}.${projectHostSuffix}`;
  }

  return `${env.PROJECT_BASE_URL.replace(/\/$/, "")}/${domainLabel}`;
}
