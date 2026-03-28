import { Hono } from "hono";
import { baseStyles, faviconLink, logoHtml } from "./ui";

type ProjectRecord = {
  projectName: string;
  ownerLogin: string;
  githubRepo: string;
  description?: string;
  deploymentUrl: string;
  createdAt: string;
  updatedAt: string;
};

type Env = {
  CONTROL_PLANE_DB: D1Database;
  DISPATCHER: DispatchNamespace;
  PLATFORM_BASE_URL: string;
  INSTALL_URL: string;
  PROJECT_HOST_SUFFIX?: string;
  PROJECT_CPU_LIMIT_MS?: string;
  PROJECT_SUBREQUEST_LIMIT?: string;
};

type ProjectRow = {
  project_name: string;
  owner_login: string;
  github_repo: string;
  description: string | null;
  deployment_url: string;
  created_at: string;
  updated_at: string;
};

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => c.json({ ok: true }));

app.get("/", (c) => {
  const deployServiceUrl = c.env.INSTALL_URL.replace(/\/github\/install$/, "");
  return c.redirect(deployServiceUrl, 302);
});

app.all("/:project/*", async (c) => handleProjectRequest(c.req.raw, c.env, c.req.param("project"), "path"));
app.all("/:project", async (c) => handleProjectRequest(c.req.raw, c.env, c.req.param("project"), "path"));

type ProjectRoutingMode = "host" | "path";

async function handleProjectRequest(
  request: Request,
  env: Env,
  projectName: string,
  mode: ProjectRoutingMode
): Promise<Response> {
  const redirect = maybeRedirectProjectRoot(request, projectName, mode);
  if (redirect) {
    return redirect;
  }

  const record = await getProjectRecord(env.CONTROL_PLANE_DB, projectName);
  if (!record) {
    return new Response(renderMissingProjectPage(projectName, env.INSTALL_URL), {
      headers: { "content-type": "text/html; charset=utf-8" },
      status: 404
    });
  }

  try {
    const userWorker = env.DISPATCHER.get(projectName, {}, {
      limits: {
        ...(parseInteger(env.PROJECT_CPU_LIMIT_MS) ? { cpuMs: parseInteger(env.PROJECT_CPU_LIMIT_MS) } : {}),
        ...(parseInteger(env.PROJECT_SUBREQUEST_LIMIT) ? { subRequests: parseInteger(env.PROJECT_SUBREQUEST_LIMIT) } : {})
      }
    });
    const forwardedRequest = rewriteRequestForProject(request, projectName, mode);
    const response = await userWorker.fetch(forwardedRequest);
    return rewriteProjectResponse(response, request, projectName, mode);
  } catch {
    return new Response(renderErrorPage(record), {
      headers: { "content-type": "text/html; charset=utf-8" },
      status: 502
    });
  }
}


async function getProjectRecord(db: D1Database, projectName: string): Promise<ProjectRecord | null> {
  const session = db.withSession("first-primary");
  const row = await session.prepare(`
    SELECT
      project_name,
      owner_login,
      github_repo,
      description,
      deployment_url,
      created_at,
      updated_at
    FROM projects
    WHERE project_name = ?
      AND latest_deployment_id IS NOT NULL
  `).bind(projectName).first<ProjectRow>();

  return row ? toProjectRecord(row) : null;
}

function toProjectRecord(row: ProjectRow): ProjectRecord {
  return {
    projectName: row.project_name,
    ownerLogin: row.owner_login,
    githubRepo: row.github_repo,
    description: row.description ?? undefined,
    deploymentUrl: row.deployment_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rewriteRequestForProject(request: Request, projectName: string, mode: ProjectRoutingMode): Request {
  const incomingUrl = new URL(request.url);
  const prefix = projectPathPrefix(projectName);
  if (mode === "path") {
    const nextPath = incomingUrl.pathname === prefix ? "/" : incomingUrl.pathname.slice(prefix.length) || "/";
    incomingUrl.pathname = nextPath;
  }

  const rewrittenRequest = new Request(incomingUrl.toString(), request);
  const headers = new Headers(rewrittenRequest.headers);
  headers.set("x-cail-project-name", projectName);
  headers.set("x-cail-public-origin", resolvePublicOrigin(request, projectName, mode));
  if (mode === "path") {
    headers.set("x-forwarded-prefix", prefix);
    headers.set("x-cail-base-path", `${prefix}/`);
  } else {
    headers.set("x-cail-base-path", "/");
  }

  return new Request(rewrittenRequest, { headers });
}

function rewriteProjectResponse(
  response: Response,
  request: Request,
  projectName: string,
  mode: ProjectRoutingMode
): Response {
  if (mode === "host") {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("x-cail-base-path", `${projectPathPrefix(projectName)}/`);
  rewriteLocationHeader(headers, request, projectName);
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText
  });
}

function rewriteLocationHeader(headers: Headers, request: Request, projectName: string): void {
  const location = headers.get("location");
  if (!location) {
    return;
  }

  const currentUrl = new URL(request.url);
  const prefix = projectPathPrefix(projectName);
  if (location.startsWith("/") && !location.startsWith("//") && !location.startsWith(prefix)) {
    headers.set("location", `${prefix}${location}`);
    return;
  }

  let locationUrl: URL;
  try {
    locationUrl = new URL(location);
  } catch {
    return;
  }

  if (locationUrl.origin !== currentUrl.origin) {
    return;
  }

  if (locationUrl.pathname.startsWith(prefix)) {
    return;
  }

  locationUrl.pathname = `${prefix}${locationUrl.pathname}`;
  headers.set("location", locationUrl.toString());
}

function maybeRedirectProjectRoot(
  request: Request,
  projectName: string,
  mode: ProjectRoutingMode
): Response | undefined {
  if (mode !== "path") {
    return undefined;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return undefined;
  }

  const incomingUrl = new URL(request.url);
  if (incomingUrl.pathname !== `/${projectName}`) {
    return undefined;
  }

  incomingUrl.pathname = `${incomingUrl.pathname}/`;
  return Response.redirect(incomingUrl.toString(), 308);
}

function projectPathPrefix(projectName: string): string {
  return `/${projectName}`;
}

function resolvePublicOrigin(request: Request, projectName: string, mode: ProjectRoutingMode): string {
  const url = new URL(request.url);
  return mode === "host" ? `${url.protocol}//${url.host}` : `${url.protocol}//${url.host}${projectPathPrefix(projectName)}`;
}

function resolveProjectNameFromHost(request: Request, projectHostSuffix?: string): string | undefined {
  const suffix = projectHostSuffix?.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!suffix) {
    return undefined;
  }

  const hostname = new URL(request.url).hostname.toLowerCase();
  if (hostname === suffix || !hostname.endsWith(`.${suffix}`)) {
    return undefined;
  }

  const candidate = hostname.slice(0, -(suffix.length + 1));
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(candidate) ? candidate : undefined;
}

function parseInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}


function renderMissingProjectPage(projectName: string, installUrl: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Project Not Found — CAIL Deploy</title>
    ${faviconLink()}
    ${baseStyles()}
  </head>
  <body>
    <main>
      <section class="card">
        <div class="logo">${logoHtml("40px")}</div>
        <h1>Project not found</h1>
        <p>The project <strong>${escapeHtml(projectName)}</strong> is not deployed yet.</p>
        <div class="actions">
          <a class="button" href="${escapeHtml(installUrl)}">Install CAIL Deploy</a>
          <a class="button secondary" href="/">Back to directory</a>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

function renderErrorPage(record: ProjectRecord): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Temporarily Unavailable — CAIL Deploy</title>
    ${faviconLink()}
    ${baseStyles()}
  </head>
  <body>
    <main>
      <section class="card">
        <div class="logo">${logoHtml("40px")}</div>
        <h1>Project temporarily unavailable</h1>
        <p><strong>${escapeHtml(record.projectName)}</strong> returned an error. Try again shortly.</p>
      </section>
    </main>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

export default {
  fetch(request: Request, env: Env, executionCtx: ExecutionContext) {
    const normalizedRequest = normalizeWorkerRequest(request, resolveBasePath(env.PLATFORM_BASE_URL));
    const projectName = resolveProjectNameFromHost(normalizedRequest, env.PROJECT_HOST_SUFFIX);
    if (projectName) {
      return handleProjectRequest(normalizedRequest, env, projectName, "host");
    }

    return app.fetch(normalizedRequest, env, executionCtx);
  }
};

function resolveBasePath(baseUrl: string): string {
  const pathname = new URL(baseUrl).pathname.replace(/\/$/, "");
  return pathname === "/" ? "" : pathname;
}

function normalizeWorkerRequest(request: Request, basePath: string): Request {
  if (!basePath) {
    return request;
  }

  const url = new URL(request.url);
  if (url.pathname === basePath) {
    url.pathname = "/";
    return new Request(url.toString(), request);
  }

  if (url.pathname.startsWith(`${basePath}/`)) {
    url.pathname = url.pathname.slice(basePath.length) || "/";
    return new Request(url.toString(), request);
  }

  return request;
}
