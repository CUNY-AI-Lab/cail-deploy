import { renderGitHubInstallPage, renderGitHubSetupPage, type RepositoryLifecycleViewModel } from "./repository-onboarding-ui";

type InstallContext = {
  repositoryFullName: string;
  projectName: string;
};

export async function createGitHubInstallResponse<TEnv>(input: {
  env: TEnv;
  requestUrl: string;
  cookieHeader?: string;
  repositoryFullName?: string;
  repositoryUrl?: string;
  projectName?: string;
  appName: string;
  marketingName: string;
  appSlug?: string;
  readGitHubInstallContext: (cookieHeader: string | undefined, env: TEnv, serviceBaseUrl?: string) => InstallContext | undefined;
  parseOptionalRepositoryContext: (
    body: { repositoryUrl?: string; repositoryFullName?: string; projectName?: string },
    env: TEnv,
    serviceBaseUrl?: string
  ) => InstallContext | undefined;
  parseRepositoryReference: (body: { repositoryFullName?: string; repositoryUrl?: string }) => { owner: string; repo: string };
  buildRepositoryLifecycleState: (
    env: TEnv,
    requestUrl: string,
    repository: { owner: string; repo: string },
    requestedProjectName?: string
  ) => Promise<{ payload: RepositoryLifecycleViewModel }>;
  resolveServiceBaseUrl: (env: TEnv, requestUrl: string) => string;
  resolveMcpOauthBaseUrl: (env: TEnv, requestUrl: string) => string;
  githubAppInstallUrl: (appSlug: string) => string;
  serializeCookie: (
    name: string,
    value: string,
    options: {
      httpOnly?: boolean;
      maxAge?: number;
      path?: string;
      sameSite?: "Lax" | "Strict" | "None";
      secure?: boolean;
    }
  ) => string;
  resolveCookiePath: (serviceBaseUrl: string) => string;
  installContextCookieName: string;
  installContextMaxAgeSeconds: number;
}): Promise<Response> {
  const serviceBaseUrl = input.resolveServiceBaseUrl(input.env, input.requestUrl);
  const installContext = input.readGitHubInstallContext(input.cookieHeader, input.env, serviceBaseUrl);
  const requestedContext = input.parseOptionalRepositoryContext({
    repositoryFullName: input.repositoryFullName,
    repositoryUrl: input.repositoryUrl,
    projectName: input.projectName
  }, input.env, serviceBaseUrl);
  const nextContext = requestedContext ?? installContext;
  let repositoryLifecycle: RepositoryLifecycleViewModel | undefined;

  if (nextContext) {
    const repository = input.parseRepositoryReference({
      repositoryFullName: nextContext.repositoryFullName
    });
    const lifecycle = await input.buildRepositoryLifecycleState(
      input.env,
      input.requestUrl,
      repository,
      nextContext.projectName
    );
    repositoryLifecycle = lifecycle.payload;
  }

  const continueUrl = input.appSlug ? input.githubAppInstallUrl(input.appSlug) : undefined;
  const response = new Response(renderGitHubInstallPage({
    appName: input.appName,
    marketingName: input.marketingName,
    serviceBaseUrl,
    oauthBaseUrl: input.resolveMcpOauthBaseUrl(input.env, input.requestUrl),
    continueUrl,
    lifecycle: repositoryLifecycle
  }), {
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": "no-store"
    }
  });

  if (nextContext) {
    response.headers.set("Set-Cookie", input.serializeCookie(
      input.installContextCookieName,
      JSON.stringify(nextContext),
      {
        httpOnly: true,
        maxAge: input.installContextMaxAgeSeconds,
        path: input.resolveCookiePath(serviceBaseUrl),
        sameSite: "Lax",
        secure: serviceBaseUrl.startsWith("https://")
      }
    ));
  }

  return response;
}

export async function createGitHubSetupResponse<TEnv>(input: {
  env: TEnv;
  requestUrl: string;
  cookieHeader?: string;
  repositoryFullName?: string;
  repositoryUrl?: string;
  projectName?: string;
  installationId?: string;
  setupAction?: string;
  appName: string;
  marketingName: string;
  appSlug?: string;
  readGitHubInstallContext: (cookieHeader: string | undefined, env: TEnv, serviceBaseUrl?: string) => InstallContext | undefined;
  parseOptionalRepositoryContext: (
    body: { repositoryUrl?: string; repositoryFullName?: string; projectName?: string },
    env: TEnv,
    serviceBaseUrl?: string
  ) => InstallContext | undefined;
  parseRepositoryReference: (body: { repositoryFullName?: string; repositoryUrl?: string }) => { owner: string; repo: string };
  buildRepositoryLifecycleState: (
    env: TEnv,
    requestUrl: string,
    repository: { owner: string; repo: string },
    requestedProjectName?: string
  ) => Promise<{ payload: RepositoryLifecycleViewModel }>;
  resolveServiceBaseUrl: (env: TEnv, requestUrl: string) => string;
  resolveMcpOauthBaseUrl: (env: TEnv, requestUrl: string) => string;
  githubAppInstallUrl: (appSlug: string) => string;
  serializeCookie: (
    name: string,
    value: string,
    options: {
      httpOnly?: boolean;
      maxAge?: number;
      path?: string;
      sameSite?: "Lax" | "Strict" | "None";
      secure?: boolean;
    }
  ) => string;
  resolveCookiePath: (serviceBaseUrl: string) => string;
  installContextCookieName: string;
  installContextMaxAgeSeconds: number;
}): Promise<Response> {
  const serviceBaseUrl = input.resolveServiceBaseUrl(input.env, input.requestUrl);
  const installUrl = input.appSlug ? input.githubAppInstallUrl(input.appSlug) : undefined;
  const cookieContext = input.readGitHubInstallContext(input.cookieHeader, input.env, serviceBaseUrl);
  const queryContext = input.parseOptionalRepositoryContext({
    repositoryFullName: input.repositoryFullName,
    repositoryUrl: input.repositoryUrl,
    projectName: input.projectName
  }, input.env, serviceBaseUrl);
  const installContext = queryContext ?? cookieContext;
  let repositoryLifecycle: RepositoryLifecycleViewModel | undefined;

  if (installContext) {
    const repository = input.parseRepositoryReference({
      repositoryFullName: installContext.repositoryFullName
    });
    const lifecycle = await input.buildRepositoryLifecycleState(
      input.env,
      input.requestUrl,
      repository,
      installContext.projectName
    );
    repositoryLifecycle = lifecycle.payload;
  }

  const response = new Response(renderGitHubSetupPage({
    appName: input.appName,
    marketingName: input.marketingName,
    serviceBaseUrl,
    oauthBaseUrl: input.resolveMcpOauthBaseUrl(input.env, input.requestUrl),
    installUrl,
    installationId: input.installationId,
    setupAction: input.setupAction,
    lifecycle: repositoryLifecycle
  }), {
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": "no-store"
    }
  });

  if (installContext) {
    response.headers.set("Set-Cookie", input.serializeCookie(
      input.installContextCookieName,
      JSON.stringify(installContext),
      {
        httpOnly: true,
        maxAge: input.installContextMaxAgeSeconds,
        path: input.resolveCookiePath(serviceBaseUrl),
        sameSite: "Lax",
        secure: serviceBaseUrl.startsWith("https://")
      }
    ));
  }

  return response;
}
