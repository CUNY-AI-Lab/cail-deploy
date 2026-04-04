import { SignJWT, jwtVerify } from "jose";

import type { ProjectRecord } from "@cuny-ai-lab/build-contract";

import { HttpError, asHttpError } from "./http-error";
import { readProjectControlFlash } from "./project-control-ui";
import {
  renderFeaturedProjectsAdminAuthErrorPage,
  renderFeaturedProjectsAdminPage,
  type FeaturedProjectAdminRecord
} from "./featured-projects-ui";
import type {
  FeaturedProjectDisplayRecord,
  FeaturedProjectRecord
} from "./lib/control-plane";

type FeaturedProjectsAdminIdentity = {
  email: string;
  subject: string;
};

export function buildFeaturedProjectsAdminUrl(
  baseUrl: string,
  options?: { flash?: "success" | "warning" | "error"; message?: string }
): string {
  const url = new URL(`${baseUrl}/featured/control`);
  if (options?.flash) {
    url.searchParams.set("flash", options.flash);
  }
  if (options?.message) {
    url.searchParams.set("message", options.message);
  }
  return url.toString();
}

export async function createFeaturedProjectsAdminPageResponse<TEnv>(input: {
  env: TEnv;
  request: Request;
  requireFeaturedProjectAdminIdentity: (
    request: Request,
    env: TEnv
  ) => Promise<FeaturedProjectsAdminIdentity>;
  resolveServiceBaseUrl: (env: TEnv, requestUrl: string) => string;
  listProjects: (env: TEnv) => Promise<ProjectRecord[]>;
  listFeaturedProjects: (env: TEnv) => Promise<FeaturedProjectDisplayRecord[]>;
  resolveMcpOauthSecret: (env: TEnv) => string;
}): Promise<Response> {
  const serviceBaseUrl = input.resolveServiceBaseUrl(input.env, input.request.url);
  const flash = readProjectControlFlash(input.request.url);

  let identity: FeaturedProjectsAdminIdentity;
  try {
    identity = await input.requireFeaturedProjectAdminIdentity(input.request, input.env);
  } catch (error) {
    const httpError = asHttpError(error);
    return htmlResponse(
      renderFeaturedProjectsAdminAuthErrorPage(httpError.message, serviceBaseUrl),
      httpError.status
    );
  }

  const [projects, featuredProjects, formToken] = await Promise.all([
    input.listProjects(input.env),
    input.listFeaturedProjects(input.env),
    createFeaturedProjectsAdminFormToken({
      secret: input.resolveMcpOauthSecret(input.env),
      issuer: serviceBaseUrl,
      subject: identity.subject
    })
  ]);

  return htmlResponse(renderFeaturedProjectsAdminPage({
    serviceBaseUrl,
    signedInEmail: identity.email,
    formToken,
    flash,
    projects: buildFeaturedProjectsAdminRecords(projects, featuredProjects)
  }));
}

export async function createFeaturedProjectsAdminUpdateResponse<TEnv>(input: {
  env: TEnv;
  request: Request;
  requireFeaturedProjectAdminIdentity: (
    request: Request,
    env: TEnv
  ) => Promise<FeaturedProjectsAdminIdentity>;
  resolveServiceBaseUrl: (env: TEnv, requestUrl: string) => string;
  resolveMcpOauthSecret: (env: TEnv) => string;
  getProject: (env: TEnv, projectName: string) => Promise<ProjectRecord | null>;
  getFeaturedProject: (env: TEnv, githubRepo: string) => Promise<FeaturedProjectRecord | null>;
  putFeaturedProject: (env: TEnv, feature: FeaturedProjectRecord) => Promise<void>;
  deleteFeaturedProject: (env: TEnv, githubRepo: string) => Promise<void>;
}): Promise<Response> {
  const serviceBaseUrl = input.resolveServiceBaseUrl(input.env, input.request.url);

  let identity: FeaturedProjectsAdminIdentity;
  try {
    identity = await input.requireFeaturedProjectAdminIdentity(input.request, input.env);
  } catch (error) {
    const httpError = asHttpError(error);
    return htmlResponse(
      renderFeaturedProjectsAdminAuthErrorPage(httpError.message, serviceBaseUrl),
      httpError.status
    );
  }

  try {
    const form = await input.request.formData();
    await verifyFeaturedProjectsAdminFormToken({
      secret: input.resolveMcpOauthSecret(input.env),
      issuer: serviceBaseUrl,
      token: getRequiredFeaturedProjectsAdminFormField(form, "formToken"),
      subject: identity.subject
    });

    const projectName = getRequiredFeaturedProjectsAdminFormField(form, "projectName");
    const enabled = form.get("featureProject") === "1";
    if (!enabled) {
      const project = await clearFeaturedProjectForLiveProject({
        env: input.env,
        projectName,
        getProject: input.getProject,
        deleteFeaturedProject: input.deleteFeaturedProject
      });
      return Response.redirect(buildFeaturedProjectsAdminUrl(serviceBaseUrl, {
        flash: "success",
        message: `${project.projectName} is no longer featured.`
      }), 302);
    }

    const { project } = await setFeaturedProjectForLiveProject({
      env: input.env,
      projectName,
      getProject: input.getProject,
      getFeaturedProject: input.getFeaturedProject,
      putFeaturedProject: input.putFeaturedProject,
      headline: readOptionalFeaturedProjectsAdminFormField(form, "featureHeadline"),
      sortOrder: parseFeaturedProjectSortOrder(
        readOptionalFeaturedProjectsAdminFormField(form, "featureSortOrder")
      )
    });

    return Response.redirect(buildFeaturedProjectsAdminUrl(serviceBaseUrl, {
      flash: "success",
      message: `${project.projectName} is now featured.`
    }), 302);
  } catch (error) {
    const httpError = asHttpError(error);
    return Response.redirect(buildFeaturedProjectsAdminUrl(serviceBaseUrl, {
      flash: "error",
      message: httpError.message
    }), 302);
  }
}

export async function setFeaturedProjectForLiveProject<TEnv>(input: {
  env: TEnv;
  projectName: string;
  getProject: (env: TEnv, projectName: string) => Promise<ProjectRecord | null>;
  getFeaturedProject: (env: TEnv, githubRepo: string) => Promise<FeaturedProjectRecord | null>;
  putFeaturedProject: (env: TEnv, feature: FeaturedProjectRecord) => Promise<void>;
  headline?: string;
  sortOrder: number;
}): Promise<{ project: ProjectRecord; feature: FeaturedProjectRecord }> {
  const project = await requireLiveFeaturedProject(input.env, input.projectName, input.getProject);
  const now = new Date().toISOString();
  const existing = await input.getFeaturedProject(input.env, project.githubRepo);
  const feature = {
    githubRepo: project.githubRepo,
    projectName: project.projectName,
    headline: input.headline,
    sortOrder: input.sortOrder,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  } satisfies FeaturedProjectRecord;
  await input.putFeaturedProject(input.env, feature);
  return { project, feature };
}

export async function clearFeaturedProjectForLiveProject<TEnv>(input: {
  env: TEnv;
  projectName: string;
  getProject: (env: TEnv, projectName: string) => Promise<ProjectRecord | null>;
  deleteFeaturedProject: (env: TEnv, githubRepo: string) => Promise<void>;
}): Promise<ProjectRecord> {
  const project = await requireLiveFeaturedProject(input.env, input.projectName, input.getProject);
  await input.deleteFeaturedProject(input.env, project.githubRepo);
  return project;
}

export function buildFeaturedProjectsAdminRecords(
  projects: ProjectRecord[],
  featuredProjects: FeaturedProjectDisplayRecord[]
): FeaturedProjectAdminRecord[] {
  const featuredByRepo = new Map(
    featuredProjects.map((project) => [project.githubRepo, project] as const)
  );
  const latestProjectByRepo = new Map<string, ProjectRecord>();

  for (const project of projects) {
    const existing = latestProjectByRepo.get(project.githubRepo);
    if (!existing || project.updatedAt.localeCompare(existing.updatedAt) > 0) {
      latestProjectByRepo.set(project.githubRepo, project);
    }
  }

  return Array.from(latestProjectByRepo.values())
    .map((project) => {
      const featured = featuredByRepo.get(project.githubRepo);
      return {
        projectName: project.projectName,
        ownerLogin: project.ownerLogin,
        githubRepo: project.githubRepo,
        deploymentUrl: project.deploymentUrl,
        description: project.description,
        runtimeLane: project.runtimeLane,
        updatedAt: project.updatedAt,
        featured: {
          enabled: Boolean(featured),
          headline: featured?.headline,
          sortOrder: featured?.sortOrder ?? 100
        }
      };
    })
    .sort((left, right) => {
      if (left.featured.enabled !== right.featured.enabled) {
        return left.featured.enabled ? -1 : 1;
      }
      if (left.featured.enabled && right.featured.enabled) {
        const orderDiff = left.featured.sortOrder - right.featured.sortOrder;
        if (orderDiff !== 0) {
          return orderDiff;
        }
      }
      return right.updatedAt.localeCompare(left.updatedAt);
    });
}

async function requireLiveFeaturedProject<TEnv>(
  env: TEnv,
  projectName: string,
  getProject: (env: TEnv, projectName: string) => Promise<ProjectRecord | null>
): Promise<ProjectRecord> {
  const project = await getProject(env, projectName);
  if (!project || !project.latestDeploymentId) {
    throw new HttpError(404, "Only live Kale projects can be featured.");
  }

  return project;
}

async function createFeaturedProjectsAdminFormToken(input: {
  secret: string;
  issuer: string;
  subject: string;
}): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(input.issuer)
    .setAudience("featured-projects-control-form")
    .setSubject(input.subject)
    .setIssuedAt()
    .setExpirationTime("30m")
    .sign(new TextEncoder().encode(input.secret));
}

async function verifyFeaturedProjectsAdminFormToken(input: {
  secret: string;
  issuer: string;
  token: string;
  subject: string;
}): Promise<void> {
  await jwtVerify(input.token, new TextEncoder().encode(input.secret), {
    issuer: input.issuer,
    audience: "featured-projects-control-form",
    subject: input.subject
  });
}

function getRequiredFeaturedProjectsAdminFormField(form: FormData, field: string): string {
  const value = form.get(field);
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `Missing required form field '${field}'.`);
  }

  return value.trim();
}

function readOptionalFeaturedProjectsAdminFormField(form: FormData, field: string): string | undefined {
  const value = form.get(field);
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseFeaturedProjectSortOrder(value?: string): number {
  if (!value) {
    return 100;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new HttpError(400, "Featured project order must be a non-negative number.");
  }

  return parsed;
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=UTF-8"
    }
  });
}
