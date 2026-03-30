import { SignJWT, jwtVerify } from "jose";

import { HttpError, asHttpError } from "./http-error";
import {
  buildGitHubUserSecretsConnectUrl,
  type AuthenticatedAgentRequestIdentity,
  type ProjectSecretsAuthorization,
} from "./project-admin-auth";
import {
  buildProjectControlPanelUrl,
  readProjectControlFlash,
  renderProjectAdminEntryPage,
  renderProjectControlPanelAuthErrorPage,
  renderProjectControlPanelGatePage,
  renderProjectControlPanelPage,
} from "./project-control-ui";
import { buildGuidedSetupUrl } from "./repository-onboarding-ui";
import type { ProjectDomainMutationPayload, ProjectDomainsPayload } from "./project-domains";
import type {
  ProjectSecretMutationPayload,
  ProjectSecretsAccessContext,
  ProjectSecretsListPayload
} from "./project-secrets";

type ProjectContext = {
  repositoryFullName: string;
  projectName: string;
};

type ProjectStatusResponse = {
  status: number;
  body: Record<string, unknown>;
};

export async function createProjectAdminEntryResponse<TEnv>(input: {
  env: TEnv;
  request: Request;
  requireCloudflareAccessIdentity: (request: Request, env: TEnv) => Promise<AuthenticatedAgentRequestIdentity>;
  resolveServiceBaseUrl: (env: TEnv, requestUrl: string) => string;
  normalizeRequestedProjectName: (projectName: string, reservedProjectNames?: Iterable<string>) => string;
  resolveReservedProjectNames: (env: TEnv, serviceBaseUrl?: string) => Set<string>;
  parseOptionalRepositoryContext: (
    body: { repositoryFullName?: string; repositoryUrl?: string; projectName?: string },
    env: TEnv,
    serviceBaseUrl?: string
  ) => ProjectContext | undefined;
}): Promise<Response> {
  const serviceBaseUrl = input.resolveServiceBaseUrl(input.env, input.request.url);
  const requestUrl = new URL(input.request.url);

  let identity: AuthenticatedAgentRequestIdentity;
  try {
    identity = await input.requireCloudflareAccessIdentity(input.request, input.env);
  } catch (error) {
    const httpError = asHttpError(error);
    return htmlResponse(renderProjectControlPanelAuthErrorPage(httpError.message, serviceBaseUrl), httpError.status);
  }

  try {
    const projectNameInput = requestUrl.searchParams.get("projectName") ?? undefined;
    const repositoryFullName = requestUrl.searchParams.get("repositoryFullName") ?? undefined;
    const repositoryUrl = requestUrl.searchParams.get("repositoryUrl") ?? undefined;

    if (projectNameInput?.trim()) {
      const projectName = input.normalizeRequestedProjectName(
        projectNameInput,
        input.resolveReservedProjectNames(input.env, serviceBaseUrl)
      );
      return Response.redirect(buildProjectControlPanelUrl(serviceBaseUrl, projectName), 302);
    }

    if (repositoryFullName?.trim() || repositoryUrl?.trim()) {
      const repositoryContext = input.parseOptionalRepositoryContext(
        { repositoryFullName, repositoryUrl },
        input.env,
        serviceBaseUrl
      );
      if (!repositoryContext) {
        throw new HttpError(400, "Enter a GitHub repository in owner/repo form.");
      }
      return Response.redirect(
        buildGuidedSetupUrl(serviceBaseUrl, repositoryContext.repositoryFullName, repositoryContext.projectName),
        302
      );
    }

    return htmlResponse(renderProjectAdminEntryPage({
      controlBaseUrl: serviceBaseUrl,
      serviceBaseUrl,
      signedInEmail: identity.email
    }));
  } catch (error) {
    const httpError = asHttpError(error);
    const status = httpError.status === 400 || httpError.status === 409 ? 400 : httpError.status;
    return htmlResponse(renderProjectAdminEntryPage({
      controlBaseUrl: serviceBaseUrl,
      serviceBaseUrl,
      signedInEmail: identity.email,
      errorMessage: httpError.message
    }), status);
  }
}

export async function createProjectControlPanelResponse<TEnv>(input: {
  env: TEnv;
  request: Request;
  projectName: string;
  requireCloudflareAccessIdentity: (request: Request, env: TEnv) => Promise<AuthenticatedAgentRequestIdentity>;
  resolveServiceBaseUrl: (env: TEnv, requestUrl: string) => string;
  authorizeProjectSecretsAccess: (
    env: TEnv,
    requestUrl: string,
    identity: AuthenticatedAgentRequestIdentity,
    projectName: string
  ) => Promise<ProjectSecretsAuthorization>;
  buildProjectStatusResponse: (
    env: TEnv,
    projectName: string,
    options?: { includeSensitive?: boolean }
  ) => Promise<ProjectStatusResponse>;
  buildProjectSecretsListPayload: (
    env: TEnv,
    project: ProjectSecretsAccessContext["project"],
    githubLogin: string
  ) => Promise<ProjectSecretsListPayload>;
  buildProjectDomainsPayload: (
    env: TEnv,
    project: ProjectSecretsAccessContext["project"]
  ) => Promise<ProjectDomainsPayload>;
  resolveMcpOauthSecret: (env: TEnv) => string;
}): Promise<Response> {
  const serviceBaseUrl = input.resolveServiceBaseUrl(input.env, input.request.url);

  let identity: AuthenticatedAgentRequestIdentity;
  try {
    identity = await input.requireCloudflareAccessIdentity(input.request, input.env);
  } catch (error) {
    const httpError = asHttpError(error);
    return htmlResponse(renderProjectControlPanelAuthErrorPage(httpError.message, serviceBaseUrl), httpError.status);
  }

  try {
    const authorization = await input.authorizeProjectSecretsAccess(
      input.env,
      input.request.url,
      identity,
      input.projectName
    );
    const flash = readProjectControlFlash(input.request.url);

    if (!authorization.ok) {
      const connectUrl = authorization.body.nextAction === "connect_github_user"
        ? buildGitHubUserSecretsConnectUrl(serviceBaseUrl, input.projectName, {
            returnTo: buildProjectControlPanelUrl(serviceBaseUrl, input.projectName)
          })
        : authorization.body.connectGitHubUserUrl;
      return htmlResponse(renderProjectControlPanelGatePage({
        serviceBaseUrl,
        summary: authorization.body.summary,
        connectUrl,
        flash
      }), 403);
    }

    const [statusResult, secretsPayload, domainsPayload, formToken] = await Promise.all([
      input.buildProjectStatusResponse(input.env, input.projectName, { includeSensitive: true }),
      input.buildProjectSecretsListPayload(input.env, authorization.project, authorization.githubLogin),
      input.buildProjectDomainsPayload(input.env, authorization.project),
      createProjectControlFormToken({
        secret: input.resolveMcpOauthSecret(input.env),
        issuer: serviceBaseUrl,
        subject: identity.subject,
        projectName: input.projectName
      })
    ]);

    return htmlResponse(renderProjectControlPanelPage({
      controlBaseUrl: serviceBaseUrl,
      signedInEmail: identity.email,
      projectName: authorization.project.projectName,
      repositoryFullName: authorization.project.githubRepo,
      statusSlug: typeof statusResult.body.status === "string" ? statusResult.body.status : "unknown",
      deploymentUrl: typeof statusResult.body.deployment_url === "string" ? statusResult.body.deployment_url : authorization.project.deploymentUrl,
      buildLogUrl: typeof statusResult.body.build_log_url === "string" ? statusResult.body.build_log_url : undefined,
      errorMessage: typeof statusResult.body.error_message === "string" ? statusResult.body.error_message : undefined,
      updatedAt: typeof statusResult.body.updated_at === "string" ? statusResult.body.updated_at : authorization.project.updatedAt,
      repoUrl: `https://github.com/${authorization.project.githubRepo}`,
      setupUrl: buildGuidedSetupUrl(
        input.resolveServiceBaseUrl(input.env, input.request.url),
        authorization.project.githubRepo,
        authorization.project.projectName
      ),
      domains: domainsPayload,
      secrets: {
        count: secretsPayload.count,
        secrets: secretsPayload.secrets
      },
      formToken,
      flash
    }));
  } catch (error) {
    const httpError = asHttpError(error);
    if (httpError.status === 404) {
      const connectUrl = buildGitHubUserSecretsConnectUrl(serviceBaseUrl, input.projectName, {
        returnTo: buildProjectControlPanelUrl(serviceBaseUrl, input.projectName)
      });
      return htmlResponse(renderProjectControlPanelGatePage({
        serviceBaseUrl,
        summary: "Project settings are only visible to people who can manage this Kale project.",
        connectUrl
      }), 403);
    }

    return htmlResponse(renderProjectControlPanelAuthErrorPage(httpError.message, serviceBaseUrl), httpError.status);
  }
}

export async function createProjectControlSecretSetResponse<TEnv>(input: {
  env: TEnv;
  request: Request;
  projectName: string;
  requireCloudflareAccessIdentity: (request: Request, env: TEnv) => Promise<AuthenticatedAgentRequestIdentity>;
  resolveServiceBaseUrl: (env: TEnv, requestUrl: string) => string;
  resolveMcpOauthSecret: (env: TEnv) => string;
  authorizeProjectSecretsAccess: (
    env: TEnv,
    requestUrl: string,
    identity: AuthenticatedAgentRequestIdentity,
    projectName: string
  ) => Promise<ProjectSecretsAuthorization>;
  setProjectSecretValue: (
    env: TEnv,
    authorization: Extract<ProjectSecretsAuthorization, { ok: true }>,
    secretName: string,
    value: string
  ) => Promise<ProjectSecretMutationPayload>;
}): Promise<Response> {
  return createProjectControlMutationResponse({
    ...input,
    mutate: async ({ env, authorization, form, request }) =>
      input.setProjectSecretValue(
        env,
        authorization,
        getRequiredProjectControlFormField(form, "secretName"),
        getRequiredProjectControlFormField(form, "secretValue")
      )
  });
}

export async function createProjectControlSecretDeleteResponse<TEnv>(input: {
  env: TEnv;
  request: Request;
  projectName: string;
  secretName: string;
  requireCloudflareAccessIdentity: (request: Request, env: TEnv) => Promise<AuthenticatedAgentRequestIdentity>;
  resolveServiceBaseUrl: (env: TEnv, requestUrl: string) => string;
  resolveMcpOauthSecret: (env: TEnv) => string;
  authorizeProjectSecretsAccess: (
    env: TEnv,
    requestUrl: string,
    identity: AuthenticatedAgentRequestIdentity,
    projectName: string
  ) => Promise<ProjectSecretsAuthorization>;
  removeProjectSecretValue: (
    env: TEnv,
    authorization: Extract<ProjectSecretsAuthorization, { ok: true }>,
    secretName: string
  ) => Promise<ProjectSecretMutationPayload>;
}): Promise<Response> {
  return createProjectControlMutationResponse({
    ...input,
    mutate: async ({ env, authorization }) =>
      input.removeProjectSecretValue(env, authorization, input.secretName)
  });
}

export async function createProjectControlPrimaryDomainSetResponse<TEnv>(input: {
  env: TEnv;
  request: Request;
  projectName: string;
  requireCloudflareAccessIdentity: (request: Request, env: TEnv) => Promise<AuthenticatedAgentRequestIdentity>;
  resolveServiceBaseUrl: (env: TEnv, requestUrl: string) => string;
  resolveMcpOauthSecret: (env: TEnv) => string;
  authorizeProjectSecretsAccess: (
    env: TEnv,
    requestUrl: string,
    identity: AuthenticatedAgentRequestIdentity,
    projectName: string
  ) => Promise<ProjectSecretsAuthorization>;
  normalizeDomainLabel: (value: string) => string;
  setPrimaryProjectDomainLabel: (
    env: TEnv,
    authorization: Extract<ProjectSecretsAuthorization, { ok: true }>,
    domainLabel: string
  ) => Promise<ProjectDomainMutationPayload>;
}): Promise<Response> {
  return createProjectControlMutationResponse({
    ...input,
    mutate: async ({ env, authorization, form }) =>
      input.setPrimaryProjectDomainLabel(
        env,
        authorization,
        input.normalizeDomainLabel(getRequiredProjectControlFormField(form, "domainLabel"))
      )
  });
}

export async function createProjectControlRedirectAddResponse<TEnv>(input: {
  env: TEnv;
  request: Request;
  projectName: string;
  requireCloudflareAccessIdentity: (request: Request, env: TEnv) => Promise<AuthenticatedAgentRequestIdentity>;
  resolveServiceBaseUrl: (env: TEnv, requestUrl: string) => string;
  resolveMcpOauthSecret: (env: TEnv) => string;
  authorizeProjectSecretsAccess: (
    env: TEnv,
    requestUrl: string,
    identity: AuthenticatedAgentRequestIdentity,
    projectName: string
  ) => Promise<ProjectSecretsAuthorization>;
  normalizeDomainLabel: (value: string) => string;
  addProjectRedirectDomainLabel: (
    env: TEnv,
    authorization: Extract<ProjectSecretsAuthorization, { ok: true }>,
    domainLabel: string
  ) => Promise<ProjectDomainMutationPayload>;
}): Promise<Response> {
  return createProjectControlMutationResponse({
    ...input,
    mutate: async ({ env, authorization, form }) =>
      input.addProjectRedirectDomainLabel(
        env,
        authorization,
        input.normalizeDomainLabel(getRequiredProjectControlFormField(form, "domainLabel"))
      )
  });
}

export async function createProjectControlRedirectDeleteResponse<TEnv>(input: {
  env: TEnv;
  request: Request;
  projectName: string;
  domainLabel: string;
  requireCloudflareAccessIdentity: (request: Request, env: TEnv) => Promise<AuthenticatedAgentRequestIdentity>;
  resolveServiceBaseUrl: (env: TEnv, requestUrl: string) => string;
  resolveMcpOauthSecret: (env: TEnv) => string;
  authorizeProjectSecretsAccess: (
    env: TEnv,
    requestUrl: string,
    identity: AuthenticatedAgentRequestIdentity,
    projectName: string
  ) => Promise<ProjectSecretsAuthorization>;
  normalizeDomainLabel: (value: string) => string;
  removeProjectRedirectDomainLabel: (
    env: TEnv,
    authorization: Extract<ProjectSecretsAuthorization, { ok: true }>,
    domainLabel: string
  ) => Promise<ProjectDomainMutationPayload>;
}): Promise<Response> {
  return createProjectControlMutationResponse({
    ...input,
    mutate: async ({ env, authorization }) =>
      input.removeProjectRedirectDomainLabel(
        env,
        authorization,
        input.normalizeDomainLabel(input.domainLabel)
      )
  });
}

async function createProjectControlMutationResponse<TEnv>(input: {
  env: TEnv;
  request: Request;
  projectName: string;
  requireCloudflareAccessIdentity: (request: Request, env: TEnv) => Promise<AuthenticatedAgentRequestIdentity>;
  resolveServiceBaseUrl: (env: TEnv, requestUrl: string) => string;
  resolveMcpOauthSecret: (env: TEnv) => string;
  authorizeProjectSecretsAccess: (
    env: TEnv,
    requestUrl: string,
    identity: AuthenticatedAgentRequestIdentity,
    projectName: string
  ) => Promise<ProjectSecretsAuthorization>;
  mutate: (input: {
    env: TEnv;
    request: Request;
    authorization: Extract<ProjectSecretsAuthorization, { ok: true }>;
    form: FormData;
  }) => Promise<ProjectSecretMutationPayload | ProjectDomainMutationPayload>;
}): Promise<Response> {
  const serviceBaseUrl = input.resolveServiceBaseUrl(input.env, input.request.url);
  let identity: AuthenticatedAgentRequestIdentity;

  try {
    identity = await input.requireCloudflareAccessIdentity(input.request, input.env);
  } catch (error) {
    const httpError = asHttpError(error);
    return htmlResponse(renderProjectControlPanelAuthErrorPage(httpError.message, serviceBaseUrl), httpError.status);
  }

  try {
    const form = await input.request.formData();
    await verifyProjectControlFormToken({
      secret: input.resolveMcpOauthSecret(input.env),
      issuer: serviceBaseUrl,
      token: getRequiredProjectControlFormField(form, "formToken"),
      subject: identity.subject,
      projectName: input.projectName
    });

    const authorization = await input.authorizeProjectSecretsAccess(
      input.env,
      input.request.url,
      identity,
      input.projectName
    );
    if (!authorization.ok) {
      return Response.redirect(buildProjectControlPanelUrl(serviceBaseUrl, input.projectName, {
        flash: "error",
        message: authorization.body.summary
      }), 302);
    }

    const result = await input.mutate({
      env: input.env,
      request: input.request,
      authorization,
      form
    });

    return Response.redirect(buildProjectControlPanelUrl(serviceBaseUrl, input.projectName, {
      flash: "nextAction" in result && result.nextAction === "redeploy_to_apply_secret" ? "warning" : "success",
      message: "warning" in result ? (result.warning ?? result.summary) : result.summary
    }), 302);
  } catch (error) {
    const httpError = asHttpError(error);
    return Response.redirect(buildProjectControlPanelUrl(serviceBaseUrl, input.projectName, {
      flash: "error",
      message: httpError.message
    }), 302);
  }
}

async function createProjectControlFormToken(input: {
  secret: string;
  issuer: string;
  subject: string;
  projectName: string;
}): Promise<string> {
  return new SignJWT({
    project_name: input.projectName
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(input.issuer)
    .setAudience("project-control-form")
    .setSubject(input.subject)
    .setIssuedAt()
    .setExpirationTime("30m")
    .sign(new TextEncoder().encode(input.secret));
}

async function verifyProjectControlFormToken(input: {
  secret: string;
  issuer: string;
  token: string;
  subject: string;
  projectName: string;
}): Promise<void> {
  const { payload } = await jwtVerify(input.token, new TextEncoder().encode(input.secret), {
    issuer: input.issuer,
    audience: "project-control-form",
    subject: input.subject
  });

  if (payload.project_name !== input.projectName) {
    throw new HttpError(403, "This form token does not belong to the current Kale project.");
  }
}

function getRequiredProjectControlFormField(form: FormData, field: string): string {
  const value = form.get(field);
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `Missing required form field '${field}'.`);
  }

  return value.trim();
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=UTF-8"
    }
  });
}
