import { Hono } from "hono";
import {
  buildLoadedSharedStaticManifest,
  normalizeSharedStaticPath,
  resolveSharedStaticRequest,
  stripLeadingSlash,
  type LoadedSharedStaticManifest,
  type RuntimeLane,
  type SharedStaticManifest
} from "@cuny-ai-lab/build-contract";

import { baseStyles, faviconLink, logoHtml } from "./ui";

type ProjectRecord = {
  projectName: string;
  ownerLogin: string;
  githubRepo: string;
  description?: string;
  deploymentUrl: string;
  runtimeLane: RuntimeLane;
  artifactPrefix?: string;
  archiveKind?: "none" | "manifest" | "full";
  manifestKey?: string;
  createdAt: string;
  updatedAt: string;
};

type Env = {
  CONTROL_PLANE_DB: D1Database;
  DEPLOYMENT_ARCHIVE: R2Bucket;
  DISPATCHER: DispatchNamespace;
  PLATFORM_BASE_URL: string;
  INSTALL_URL: string;
  GATEWAY_PREVIEW_TOKEN?: string;
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
  runtime_lane: RuntimeLane | null;
  artifact_prefix: string | null;
  archive_kind: "none" | "manifest" | "full" | null;
  manifest_key: string | null;
  created_at: string;
  updated_at: string;
};

type ProjectDomainRouteRow = {
  domain_label: string;
  project_name: string;
  is_primary: number;
  primary_domain_label: string | null;
};

type ProjectRouteRecord = {
  project: ProjectRecord;
  requestedLabel: string;
  primaryLabel: string;
  isPrimary: boolean;
};

const SHARED_STATIC_MANIFEST_TTL_MS = 60_000;
const PREVIEW_ROUTE_PREFIX = "/__kale_preview";
const GATEWAY_MISS_HEADER = "x-kale-gateway-miss";
const GATEWAY_MISS_PROJECT_UNKNOWN = "project-unknown";
const sharedStaticManifestCache = new Map<string, {
  manifest: LoadedSharedStaticManifest;
  expiresAt: number;
}>();

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => c.json({ ok: true }));

app.get("/", (c) => {
  const deployServiceUrl = c.env.INSTALL_URL.replace(/\/github\/install$/, "");
  return c.redirect(deployServiceUrl, 302);
});

app.all(`${PREVIEW_ROUTE_PREFIX}/:project/:script/*`, (c) =>
  handlePreviewRequest(c.req.raw, c.env, c.req.param("project"), c.req.param("script"))
);
app.all(`${PREVIEW_ROUTE_PREFIX}/:project/:script`, (c) =>
  handlePreviewRequest(c.req.raw, c.env, c.req.param("project"), c.req.param("script"))
);
app.all("/:project/*", async (c) => handleProjectRequest(c.req.raw, c.env, c.req.param("project"), "path"));
app.all("/:project", async (c) => handleProjectRequest(c.req.raw, c.env, c.req.param("project"), "path"));

type ProjectRoutingMode = "host" | "path";

async function handleProjectRequest(
  request: Request,
  env: Env,
  requestedLabel: string,
  mode: ProjectRoutingMode
): Promise<Response> {
  const visibleMode = resolveVisibleProjectRoutingMode(request, mode);
  const route = await resolveProjectRoute(env.CONTROL_PLANE_DB, requestedLabel);
  const redirect = maybeRedirectProjectRequest(request, env, route, mode, visibleMode);
  if (redirect) {
    return redirect;
  }

  if (!route) {
    return new Response(renderMissingProjectPage(requestedLabel, env.INSTALL_URL), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        [GATEWAY_MISS_HEADER]: GATEWAY_MISS_PROJECT_UNKNOWN
      },
      status: 404
    });
  }

  try {
    if (route.project.runtimeLane === "shared_static") {
      return await serveSharedStaticProject(request, env, route, mode, visibleMode);
    }

    const forwardedRequest = rewriteRequestForProject(
      request,
      route.project.projectName,
      route.requestedLabel,
      mode,
      visibleMode
    );
    const response = await fetchProjectWorker(env, route.project.projectName, forwardedRequest);
    return rewriteProjectResponse(response, request, route.requestedLabel, visibleMode);
  } catch {
    return new Response(renderErrorPage(route.project), {
      headers: { "content-type": "text/html; charset=utf-8" },
      status: 502
    });
  }
}

async function handlePreviewRequest(
  request: Request,
  env: Env,
  projectName: string,
  scriptName: string
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed.", {
      status: 405,
      headers: { allow: "GET, HEAD" }
    });
  }

  const previewToken = env.GATEWAY_PREVIEW_TOKEN?.trim();
  if (!previewToken) {
    return new Response("Not found.", { status: 404 });
  }

  if (readBearerToken(request) !== previewToken) {
    return new Response("Unauthorized.", {
      status: 401,
      headers: { "www-authenticate": "Bearer" }
    });
  }

  const deploymentUrl = request.headers.get("x-kale-preview-deployment-url");
  if (!deploymentUrl) {
    return new Response("Missing preview deployment URL.", { status: 400 });
  }

  const requestedLabel = request.headers.get("x-kale-preview-requested-label") ?? projectName;
  const routingMode = request.headers.get("x-kale-preview-routing-mode") === "path" ? "path" : "host";
  const probePath = resolvePreviewProbePath(request, projectName, scriptName);
  const publicRequest = buildPreviewPublicRequest(request, deploymentUrl, probePath);
  if (!publicRequest) {
    return new Response("Invalid preview deployment URL.", { status: 400 });
  }

  const forwardedRequest = rewriteRequestForProject(
    publicRequest,
    projectName,
    requestedLabel,
    routingMode,
    routingMode
  );

  try {
    const response = await fetchProjectWorker(env, scriptName, forwardedRequest);
    return rewriteProjectResponse(response, publicRequest, requestedLabel, routingMode);
  } catch {
    return new Response(renderErrorPage({
      projectName,
      ownerLogin: "",
      githubRepo: "",
      deploymentUrl,
      runtimeLane: "dedicated_worker",
      createdAt: "",
      updatedAt: ""
    }), {
      headers: { "content-type": "text/html; charset=utf-8" },
      status: 502
    });
  }
}


async function getProjectRecord(db: D1Database, projectName: string): Promise<ProjectRecord | null> {
  const session = db.withSession("first-primary");
  const row = await session.prepare(`
    SELECT
      projects.project_name,
      projects.owner_login,
      projects.github_repo,
      projects.description,
      projects.deployment_url,
      projects.runtime_lane,
      deployments.artifact_prefix,
      deployments.archive_kind,
      deployments.manifest_key,
      projects.created_at,
      projects.updated_at
    FROM projects
    LEFT JOIN deployments
      ON deployments.deployment_id = projects.latest_deployment_id
    WHERE projects.project_name = ?
      AND projects.latest_deployment_id IS NOT NULL
  `).bind(projectName).first<ProjectRow>();

  return row ? toProjectRecord(row) : null;
}

async function resolveProjectRoute(
  db: D1Database,
  requestedLabel: string
): Promise<ProjectRouteRecord | null> {
  const session = db.withSession("first-primary");
  const domain = await session.prepare(`
    SELECT
      domain_label,
      project_name,
      is_primary,
      (
        SELECT primary_domain.domain_label
        FROM project_domains primary_domain
        WHERE primary_domain.project_name = project_domains.project_name
          AND primary_domain.is_primary = 1
        LIMIT 1
      ) AS primary_domain_label
    FROM project_domains
    WHERE domain_label = ?
  `).bind(requestedLabel).first<ProjectDomainRouteRow>();

  const project = await getProjectRecord(db, domain?.project_name ?? requestedLabel);
  if (!project) {
    return null;
  }

  return {
    project,
    requestedLabel,
    primaryLabel: domain?.primary_domain_label ?? project.projectName,
    isPrimary: domain ? domain.is_primary === 1 : requestedLabel === project.projectName
  };
}

function toProjectRecord(row: ProjectRow): ProjectRecord {
  return {
    projectName: row.project_name,
    ownerLogin: row.owner_login,
    githubRepo: row.github_repo,
    description: row.description ?? undefined,
    deploymentUrl: row.deployment_url,
    runtimeLane: row.runtime_lane ?? "dedicated_worker",
    artifactPrefix: row.artifact_prefix ?? undefined,
    archiveKind: row.archive_kind ?? undefined,
    manifestKey: row.manifest_key ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function serveSharedStaticProject(
  request: Request,
  env: Env,
  route: ProjectRouteRecord,
  mode: ProjectRoutingMode,
  visibleMode: ProjectRoutingMode
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed.", {
      status: 405,
      headers: { allow: "GET, HEAD" }
    });
  }

  const manifest = await loadSharedStaticManifest(env.DEPLOYMENT_ARCHIVE, route.project);
  if (!manifest || !route.project.artifactPrefix) {
    return new Response(renderErrorPage(route.project), {
      headers: { "content-type": "text/html; charset=utf-8" },
      status: 502
    });
  }

  const projectPath = resolveProjectRequestPath(request, route.requestedLabel, mode);
  const normalizedPath = normalizeSharedStaticPath(projectPath);
  if (!normalizedPath) {
    return new Response(null, { status: 404 });
  }

  const resolution = resolveSharedStaticRequest(manifest, normalizedPath);
  if (resolution.kind === "redirect") {
    return redirectSharedStaticRequest(request, route.requestedLabel, visibleMode, resolution.locationPath, resolution.status);
  }

  if (resolution.kind === "not_found") {
    return new Response(null, { status: 404 });
  }

  const object = await env.DEPLOYMENT_ARCHIVE.get(
    `${route.project.artifactPrefix}/assets/${stripLeadingSlash(resolution.assetPath)}`
  );
  if (!object) {
    return new Response(null, { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  if (!headers.has("content-type")) {
    const contentType = manifest.assets.get(resolution.assetPath)?.contentType;
    if (contentType) {
      headers.set("content-type", contentType);
    }
  }
  headers.set("etag", object.httpEtag);
  headers.set("content-length", String(object.size));

  return new Response(request.method === "HEAD" ? null : object.body, {
    status: resolution.status,
    headers
  });
}

async function loadSharedStaticManifest(
  bucket: R2Bucket,
  project: ProjectRecord
): Promise<LoadedSharedStaticManifest | null> {
  if (project.runtimeLane !== "shared_static" || project.archiveKind !== "full" || !project.manifestKey) {
    return null;
  }

  const cached = sharedStaticManifestCache.get(project.manifestKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.manifest;
  }

  const object = await bucket.get(project.manifestKey);
  if (!object) {
    return null;
  }

  const raw = await object.text();
  let manifest: SharedStaticManifest;
  try {
    manifest = JSON.parse(raw) as SharedStaticManifest;
  } catch {
    return null;
  }

  const loadedManifest = buildLoadedSharedStaticManifest(manifest);
  sharedStaticManifestCache.set(project.manifestKey, {
    manifest: loadedManifest,
    expiresAt: Date.now() + SHARED_STATIC_MANIFEST_TTL_MS
  });
  return loadedManifest;
}

function redirectSharedStaticRequest(
  request: Request,
  requestedLabel: string,
  visibleMode: ProjectRoutingMode,
  locationPath: string,
  status: number
): Response {
  const targetUrl = new URL(request.url);
  targetUrl.pathname = visibleMode === "host"
    ? locationPath
    : `${projectPathPrefix(requestedLabel)}${locationPath === "/" ? "/" : locationPath}`;
  return Response.redirect(targetUrl.toString(), status);
}

function resolveProjectRequestPath(
  request: Request,
  requestedLabel: string,
  mode: ProjectRoutingMode
): string {
  const incomingUrl = new URL(request.url);
  if (mode !== "path") {
    return incomingUrl.pathname || "/";
  }

  const prefix = projectPathPrefix(requestedLabel);
  return incomingUrl.pathname === prefix ? "/" : incomingUrl.pathname.slice(prefix.length) || "/";
}


function rewriteRequestForProject(
  request: Request,
  projectName: string,
  requestedLabel: string,
  mode: ProjectRoutingMode,
  visibleMode: ProjectRoutingMode
): Request {
  const incomingUrl = new URL(request.url);
  const prefix = projectPathPrefix(requestedLabel);
  if (mode === "path") {
    const nextPath = incomingUrl.pathname === prefix ? "/" : incomingUrl.pathname.slice(prefix.length) || "/";
    incomingUrl.pathname = nextPath;
  }

  const rewrittenRequest = new Request(incomingUrl.toString(), request);
  const headers = new Headers(rewrittenRequest.headers);
  headers.set("x-cail-project-name", projectName);
  headers.set("x-cail-public-origin", resolvePublicOrigin(request, requestedLabel, visibleMode));
  if (visibleMode === "path") {
    headers.set("x-forwarded-prefix", prefix);
    headers.set("x-cail-base-path", `${prefix}/`);
  } else {
    headers.delete("x-forwarded-prefix");
    headers.set("x-cail-base-path", "/");
  }

  return new Request(rewrittenRequest, { headers });
}

function buildPreviewPublicRequest(
  request: Request,
  deploymentUrl: string,
  probePath: string
): Request | null {
  let publicBaseUrl: URL;
  try {
    publicBaseUrl = new URL(deploymentUrl.endsWith("/") ? deploymentUrl : `${deploymentUrl}/`);
  } catch {
    return null;
  }

  const targetUrl = new URL(stripLeadingSlash(probePath), publicBaseUrl);
  targetUrl.search = new URL(request.url).search;

  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("x-kale-preview-deployment-url");
  headers.delete("x-kale-preview-requested-label");
  headers.delete("x-kale-preview-routing-mode");

  return new Request(targetUrl.toString(), {
    method: request.method,
    headers
  });
}

function rewriteProjectResponse(
  response: Response,
  request: Request,
  requestedLabel: string,
  visibleMode: ProjectRoutingMode
): Response {
  if (visibleMode === "host") {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("x-cail-base-path", `${projectPathPrefix(requestedLabel)}/`);
  rewriteLocationHeader(headers, request, requestedLabel);
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText
  });
}

function rewriteLocationHeader(headers: Headers, request: Request, requestedLabel: string): void {
  const location = headers.get("location");
  if (!location) {
    return;
  }

  const currentUrl = new URL(request.url);
  const prefix = projectPathPrefix(requestedLabel);
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

function maybeRedirectProjectRequest(
  request: Request,
  env: Env,
  route: ProjectRouteRecord | null,
  mode: ProjectRoutingMode,
  visibleMode: ProjectRoutingMode
): Response | undefined {
  if (!route) {
    return undefined;
  }

  if (!route.isPrimary) {
    return buildProjectLabelRedirect(request, env, route, mode, visibleMode);
  }

  if (visibleMode !== "path") {
    return undefined;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return undefined;
  }

  const incomingUrl = new URL(request.url);
  if (incomingUrl.pathname !== `/${route.requestedLabel}`) {
    return undefined;
  }

  incomingUrl.pathname = `${incomingUrl.pathname}/`;
  return Response.redirect(incomingUrl.toString(), 308);
}

function projectPathPrefix(projectName: string): string {
  return `/${projectName}`;
}

function resolvePublicOrigin(request: Request, requestedLabel: string, mode: ProjectRoutingMode): string {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");
  if (mode === "host" && forwardedHost && forwardedProto) {
    return `${forwardedProto}://${forwardedHost}`;
  }

  const url = new URL(request.url);
  return mode === "host" ? `${url.protocol}//${url.host}` : `${url.protocol}//${url.host}${projectPathPrefix(requestedLabel)}`;
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

function resolvePreviewProbePath(request: Request, projectName: string, scriptName: string): string {
  const pathname = new URL(request.url).pathname;
  const prefix = `${PREVIEW_ROUTE_PREFIX}/${projectName}/${scriptName}`;
  if (pathname === prefix) {
    return "/";
  }

  return pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length) || "/" : "/";
}

function parseInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function resolveVisibleProjectRoutingMode(
  request: Request,
  mode: ProjectRoutingMode
): ProjectRoutingMode {
  return request.headers.get("x-cail-public-routing-mode") === "host" ? "host" : mode;
}

async function fetchProjectWorker(env: Env, scriptName: string, request: Request): Promise<Response> {
  const userWorker = env.DISPATCHER.get(scriptName, {}, {
    limits: {
      ...(parseInteger(env.PROJECT_CPU_LIMIT_MS) ? { cpuMs: parseInteger(env.PROJECT_CPU_LIMIT_MS) } : {}),
      ...(parseInteger(env.PROJECT_SUBREQUEST_LIMIT) ? { subRequests: parseInteger(env.PROJECT_SUBREQUEST_LIMIT) } : {})
    }
  });
  return await userWorker.fetch(request);
}

function readBearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    return undefined;
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

function buildProjectLabelRedirect(
  request: Request,
  env: Env,
  route: ProjectRouteRecord,
  mode: ProjectRoutingMode,
  visibleMode: ProjectRoutingMode
): Response {
  const incomingUrl = new URL(request.url);

  if (visibleMode === "host") {
    const protocol = request.headers.get("x-forwarded-proto") ?? incomingUrl.protocol.replace(/:$/u, "");
    const suffix = env.PROJECT_HOST_SUFFIX?.trim().replace(/^\.+|\.+$/gu, "");
    const targetUrl = new URL(incomingUrl.toString());
    if (mode === "path") {
      const prefix = projectPathPrefix(route.requestedLabel);
      const nextPath = incomingUrl.pathname === prefix ? "/" : incomingUrl.pathname.slice(prefix.length) || "/";
      targetUrl.pathname = nextPath;
    }
    if (suffix) {
      targetUrl.protocol = `${protocol}:`;
      targetUrl.host = `${route.primaryLabel}.${suffix}`;
    } else {
      targetUrl.pathname = `${projectPathPrefix(route.primaryLabel)}${targetUrl.pathname === "/" ? "" : targetUrl.pathname}`;
    }
    return Response.redirect(targetUrl.toString(), 308);
  }

  if (mode === "path") {
    const prefix = projectPathPrefix(route.requestedLabel);
    const nextPath = incomingUrl.pathname === prefix ? "/" : incomingUrl.pathname.slice(prefix.length) || "/";
    incomingUrl.pathname = nextPath === "/"
      ? `${projectPathPrefix(route.primaryLabel)}/`
      : `${projectPathPrefix(route.primaryLabel)}${nextPath}`;
  } else {
    const suffix = env.PROJECT_HOST_SUFFIX?.trim().replace(/^\.+|\.+$/gu, "");
    if (suffix) {
      incomingUrl.host = `${route.primaryLabel}.${suffix}`;
    }
  }

  return Response.redirect(incomingUrl.toString(), 308);
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
