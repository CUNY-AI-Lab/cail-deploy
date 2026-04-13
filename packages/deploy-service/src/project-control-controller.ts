import { SignJWT, jwtVerify } from "jose";

import { HttpError, asHttpError } from "./http-error";
import {
  buildGitHubUserSecretsConnectUrl,
  type AuthenticatedAgentRequestIdentity,
  type ProjectSecretsAuthorization,
} from "./project-admin-auth";
import {
  buildProjectAdminEntryUrl,
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
import {
  assertProjectDeleteConfirmation,
  type ProjectDeletePayload
} from "./project-delete";

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
  const flash = readProjectControlFlash(input.request.url);

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
      signedInEmail: identity.email,
      flash
    }));
  } catch (error) {
    const httpError = asHttpError(error);
    const status = httpError.status === 400 || httpError.status === 409 ? 400 : httpError.status;
    return htmlResponse(renderProjectAdminEntryPage({
      controlBaseUrl: serviceBaseUrl,
      serviceBaseUrl,
      signedInEmail: identity.email,
      errorMessage: httpError.message,
      flash
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

    const [statusResult, secretsPayload, formToken] = await Promise.all([
      input.buildProjectStatusResponse(input.env, input.projectName, { includeSensitive: true }),
      input.buildProjectSecretsListPayload(input.env, authorization.project, authorization.githubLogin),
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
      runtimeLane:
        typeof statusResult.body.runtime_lane === "string"
          ? statusResult.body.runtime_lane
          : authorization.project.runtimeLane,
      recommendedRuntimeLane:
        typeof statusResult.body.recommended_runtime_lane === "string"
          ? statusResult.body.recommended_runtime_lane
          : authorization.project.recommendedRuntimeLane,
      runtimeEvidenceFramework:
        typeof statusResult.body.runtime_evidence_framework === "string"
          ? statusResult.body.runtime_evidence_framework
          : undefined,
      runtimeEvidenceClassification:
        typeof statusResult.body.runtime_evidence_classification === "string"
          ? statusResult.body.runtime_evidence_classification
          : undefined,
      runtimeEvidenceConfidence:
        typeof statusResult.body.runtime_evidence_confidence === "string"
          ? statusResult.body.runtime_evidence_confidence
          : undefined,
      runtimeEvidenceBasis:
        Array.isArray(statusResult.body.runtime_evidence_basis)
          ? statusResult.body.runtime_evidence_basis.filter((entry): entry is string => typeof entry === "string")
          : undefined,
      runtimeEvidenceSummary:
        typeof statusResult.body.runtime_evidence_summary === "string"
          ? statusResult.body.runtime_evidence_summary
          : undefined,
      buildLogUrl: typeof statusResult.body.build_log_url === "string" ? statusResult.body.build_log_url : undefined,
      errorMessage: typeof statusResult.body.error_message === "string" ? statusResult.body.error_message : undefined,
      errorHint: typeof statusResult.body.error_hint === "string" ? statusResult.body.error_hint : undefined,
      errorDetail: typeof statusResult.body.error_detail === "string" ? statusResult.body.error_detail : undefined,
      errorKind: typeof statusResult.body.error_kind === "string" ? statusResult.body.error_kind : undefined,
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

export async function createProjectControlProjectDeleteResponse<TEnv>(input: {
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
  deleteProject: (
    env: TEnv,
    authorization: Extract<ProjectSecretsAuthorization, { ok: true }>
  ) => Promise<ProjectDeletePayload>;
}): Promise<Response> {
  return createProjectControlMutationResponse({
    ...input,
    mutate: async ({ env, authorization, form }) => {
      assertProjectDeleteConfirmation(
        input.projectName,
        getRequiredProjectControlFormField(form, "confirmProjectName")
      );
      return input.deleteProject(env, authorization);
    },
    buildSuccessRedirectUrl: (serviceBaseUrl, _projectName, result) =>
      buildProjectAdminEntryUrl(serviceBaseUrl, {
        flash: "success",
        message: result.summary
      })
  });
}

type ProjectControlMutationResult = {
  summary: string;
  warning?: string;
  nextAction?: string;
};

async function createProjectControlMutationResponse<TEnv, TResult extends ProjectControlMutationResult>(input: {
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
  }) => Promise<TResult>;
  buildSuccessRedirectUrl?: (serviceBaseUrl: string, projectName: string, result: TResult) => string;
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

    const redirectUrl = input.buildSuccessRedirectUrl
      ? input.buildSuccessRedirectUrl(serviceBaseUrl, input.projectName, result)
      : buildProjectControlPanelUrl(serviceBaseUrl, input.projectName, {
          flash: result.nextAction === "redeploy_to_apply_secret" ? "warning" : "success",
          message: result.warning ?? result.summary
        });

    return Response.redirect(redirectUrl, 302);
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
