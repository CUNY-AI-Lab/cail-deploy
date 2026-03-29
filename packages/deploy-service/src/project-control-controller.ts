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
  resolveMcpOauthBaseUrl: (env: TEnv, requestUrl: string) => string;
  resolveServiceBaseUrl: (env: TEnv, requestUrl: string) => string;
  normalizeRequestedProjectName: (projectName: string, reservedProjectNames?: Iterable<string>) => string;
  resolveReservedProjectNames: (env: TEnv, serviceBaseUrl?: string) => Set<string>;
  parseOptionalRepositoryContext: (
    body: { repositoryFullName?: string; repositoryUrl?: string; projectName?: string },
    env: TEnv,
    serviceBaseUrl?: string
  ) => ProjectContext | undefined;
}): Promise<Response> {
  const oauthBaseUrl = input.resolveMcpOauthBaseUrl(input.env, input.request.url);
  const serviceBaseUrl = input.resolveServiceBaseUrl(input.env, input.request.url);
  const requestUrl = new URL(input.request.url);

  if (requestUrl.origin !== new URL(oauthBaseUrl).origin) {
    const redirectUrl = new URL(`${oauthBaseUrl}/projects/control`);
    for (const [key, value] of requestUrl.searchParams.entries()) {
      redirectUrl.searchParams.append(key, value);
    }
    return Response.redirect(redirectUrl.toString(), 302);
  }

  let identity: AuthenticatedAgentRequestIdentity;
  try {
    identity = await input.requireCloudflareAccessIdentity(input.request, input.env);
  } catch (error) {
    const httpError = asHttpError(error);
    return htmlResponse(renderProjectControlPanelAuthErrorPage(httpError.message, oauthBaseUrl), httpError.status);
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
      return Response.redirect(buildProjectControlPanelUrl(oauthBaseUrl, projectName), 302);
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
      oauthBaseUrl,
      serviceBaseUrl,
      signedInEmail: identity.email
    }));
  } catch (error) {
    const httpError = asHttpError(error);
    const status = httpError.status === 400 || httpError.status === 409 ? 400 : httpError.status;
    return htmlResponse(renderProjectAdminEntryPage({
      oauthBaseUrl,
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
  resolveMcpOauthBaseUrl: (env: TEnv, requestUrl: string) => string;
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
  resolveMcpOauthSecret: (env: TEnv) => string;
}): Promise<Response> {
  const oauthBaseUrl = input.resolveMcpOauthBaseUrl(input.env, input.request.url);
  const requestUrl = new URL(input.request.url);
  if (requestUrl.origin !== new URL(oauthBaseUrl).origin) {
    const redirectUrl = new URL(`${oauthBaseUrl}/projects/${encodeURIComponent(input.projectName)}/control`);
    const flash = requestUrl.searchParams.get("flash");
    const message = requestUrl.searchParams.get("message");
    if (flash) {
      redirectUrl.searchParams.set("flash", flash);
    }
    if (message) {
      redirectUrl.searchParams.set("message", message);
    }
    return Response.redirect(redirectUrl.toString(), 302);
  }

  let identity: AuthenticatedAgentRequestIdentity;
  try {
    identity = await input.requireCloudflareAccessIdentity(input.request, input.env);
  } catch (error) {
    const httpError = asHttpError(error);
    return htmlResponse(renderProjectControlPanelAuthErrorPage(httpError.message, oauthBaseUrl), httpError.status);
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
        ? buildGitHubUserSecretsConnectUrl(oauthBaseUrl, input.projectName, {
            returnTo: buildProjectControlPanelUrl(oauthBaseUrl, input.projectName)
          })
        : authorization.body.connectGitHubUserUrl;
      return htmlResponse(renderProjectControlPanelGatePage({
        oauthBaseUrl,
        summary: authorization.body.summary,
        connectUrl,
        flash
      }), 403);
    }

    const [statusResult, secretsPayload, formToken] = await Promise.all([
      input.buildProjectStatusResponse(input.env, input.projectName, { includeSensitive: true }),
      input.buildProjectSecretsListPayload(input.env, authorization.project, authorization.githubLogin),
      createProjectControlFormToken({
        secret: input.resolveMcpOauthSecret(input.env),
        issuer: oauthBaseUrl,
        subject: identity.subject,
        projectName: input.projectName
      })
    ]);

    return htmlResponse(renderProjectControlPanelPage({
      oauthBaseUrl,
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
      const connectUrl = buildGitHubUserSecretsConnectUrl(oauthBaseUrl, input.projectName, {
        returnTo: buildProjectControlPanelUrl(oauthBaseUrl, input.projectName)
      });
      return htmlResponse(renderProjectControlPanelGatePage({
        oauthBaseUrl,
        summary: "Project settings are only visible to people who can manage this Kale project.",
        connectUrl
      }), 403);
    }

    return htmlResponse(renderProjectControlPanelAuthErrorPage(httpError.message, oauthBaseUrl), httpError.status);
  }
}

export async function createProjectControlSecretSetResponse<TEnv>(input: {
  env: TEnv;
  request: Request;
  projectName: string;
  requireCloudflareAccessIdentity: (request: Request, env: TEnv) => Promise<AuthenticatedAgentRequestIdentity>;
  resolveMcpOauthBaseUrl: (env: TEnv, requestUrl: string) => string;
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
  return createProjectControlSecretMutationResponse({
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
  resolveMcpOauthBaseUrl: (env: TEnv, requestUrl: string) => string;
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
  return createProjectControlSecretMutationResponse({
    ...input,
    mutate: async ({ env, authorization }) =>
      input.removeProjectSecretValue(env, authorization, input.secretName)
  });
}

async function createProjectControlSecretMutationResponse<TEnv>(input: {
  env: TEnv;
  request: Request;
  projectName: string;
  requireCloudflareAccessIdentity: (request: Request, env: TEnv) => Promise<AuthenticatedAgentRequestIdentity>;
  resolveMcpOauthBaseUrl: (env: TEnv, requestUrl: string) => string;
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
  }) => Promise<ProjectSecretMutationPayload>;
}): Promise<Response> {
  const oauthBaseUrl = input.resolveMcpOauthBaseUrl(input.env, input.request.url);
  let identity: AuthenticatedAgentRequestIdentity;

  try {
    identity = await input.requireCloudflareAccessIdentity(input.request, input.env);
  } catch (error) {
    const httpError = asHttpError(error);
    return htmlResponse(renderProjectControlPanelAuthErrorPage(httpError.message, oauthBaseUrl), httpError.status);
  }

  try {
    const form = await input.request.formData();
    await verifyProjectControlFormToken({
      secret: input.resolveMcpOauthSecret(input.env),
      issuer: oauthBaseUrl,
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
      return Response.redirect(buildProjectControlPanelUrl(oauthBaseUrl, input.projectName, {
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

    return Response.redirect(buildProjectControlPanelUrl(oauthBaseUrl, input.projectName, {
      flash: result.nextAction === "redeploy_to_apply_secret" ? "warning" : "success",
      message: result.warning ?? result.summary
    }), 302);
  } catch (error) {
    const httpError = asHttpError(error);
    return Response.redirect(buildProjectControlPanelUrl(oauthBaseUrl, input.projectName, {
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
