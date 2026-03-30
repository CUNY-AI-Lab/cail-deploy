type Env = {
  INTERNAL_GATEWAY_BASE_URL: string;
  INTERNAL_DEPLOY_SERVICE_URL: string;
  DEPLOY_SERVICE_PATH_PREFIX: string;
  PROJECT_HOST_SUFFIX: string;
  RUNTIME_MANIFEST_HOST?: string;
  RUNTIME_MANIFEST_URL: string;
};

const INTERNAL_HEADER_NAMES = [
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "x-forwarded-host",
  "x-forwarded-proto"
] as const;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (isRuntimeManifestRequest(request, env.PROJECT_HOST_SUFFIX, env.RUNTIME_MANIFEST_HOST)) {
      return proxyRuntimeManifest(env.RUNTIME_MANIFEST_URL);
    }

    if (isDeployServiceRequest(request, env)) {
      return proxyToDeployService(request, env);
    }

    const projectName = resolveProjectName(request, env.PROJECT_HOST_SUFFIX, env.RUNTIME_MANIFEST_HOST);
    if (!projectName) {
      // Fall through to the origin (e.g. Cloudflare Tunnel or other service on this hostname)
      return fetch(request);
    }

    const upstreamRequest = rewriteRequestForInternalGateway(request, env, projectName);
    const upstreamResponse = await fetch(upstreamRequest);

    // If the gateway doesn't know this project, fall through to the origin
    // so other services on this subdomain (e.g. Cloudflare Tunnel) can handle it.
    if (upstreamResponse.status === 404) {
      return fetch(request);
    }

    return rewriteResponseForProjectHost(upstreamResponse, request, env, projectName);
  }
};

function isDeployServiceRequest(request: Request, env: Env): boolean {
  const url = new URL(request.url);
  const hostname = url.hostname.toLowerCase();
  const suffix = env.PROJECT_HOST_SUFFIX.trim().toLowerCase();
  const prefix = env.DEPLOY_SERVICE_PATH_PREFIX;

  return hostname === suffix && (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`));
}

async function proxyToDeployService(request: Request, env: Env): Promise<Response> {
  const requestUrl = new URL(request.url);
  const prefix = env.DEPLOY_SERVICE_PATH_PREFIX;

  // Strip the prefix to get the path the deploy service expects
  const strippedPath = requestUrl.pathname.slice(prefix.length) || "/";
  const upstreamUrl = new URL(env.INTERNAL_DEPLOY_SERVICE_URL);
  upstreamUrl.pathname = strippedPath;
  upstreamUrl.search = requestUrl.search;

  const headers = new Headers(request.headers);
  for (const headerName of INTERNAL_HEADER_NAMES) {
    headers.delete(headerName);
  }
  headers.set("x-forwarded-host", requestUrl.host);
  headers.set("x-forwarded-proto", requestUrl.protocol.replace(/:$/, ""));
  headers.set("x-forwarded-prefix", prefix);

  const upstreamRequest = new Request(upstreamUrl.toString(), {
    body: request.body,
    cf: request.cf,
    headers,
    method: request.method,
    redirect: "manual"
  });

  const response = await fetch(upstreamRequest);
  const responseHeaders = new Headers(response.headers);

  // Rewrite Location headers to use the public /kale prefix
  const location = responseHeaders.get("location");
  if (location) {
    const internalOrigin = new URL(env.INTERNAL_DEPLOY_SERVICE_URL).origin;

    if (location.startsWith("/")) {
      // Relative path — add the prefix
      responseHeaders.set("location", `${prefix}${location}`);
    } else if (looksLikeAbsoluteUrl(location)) {
      const locationUrl = new URL(location);
      if (locationUrl.origin === internalOrigin) {
        const publicUrl = new URL(requestUrl.toString());
        publicUrl.pathname = `${prefix}${locationUrl.pathname}`;
        publicUrl.search = locationUrl.search;
        publicUrl.hash = locationUrl.hash;
        responseHeaders.set("location", publicUrl.toString());
      }
    }
  }

  return new Response(response.body, {
    headers: responseHeaders,
    status: response.status,
    statusText: response.statusText
  });
}

async function proxyRuntimeManifest(runtimeManifestUrl: string): Promise<Response> {
  if (!runtimeManifestUrl) {
    return new Response("Runtime manifest URL is not configured.", { status: 500 });
  }

  const response = await fetch(runtimeManifestUrl, {
    headers: {
      accept: "application/json"
    }
  });

  const headers = new Headers(response.headers);
  headers.set("cache-control", "public, max-age=300");
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText
  });
}

function isRuntimeManifestRequest(
  request: Request,
  projectHostSuffix: string,
  runtimeManifestHost?: string
): boolean {
  const url = new URL(request.url);
  const hostname = url.hostname.toLowerCase();
  const normalizedSuffix = projectHostSuffix.trim().toLowerCase();
  const normalizedRuntimeHost = runtimeManifestHost?.trim().toLowerCase();

  return url.pathname === "/.well-known/cail-runtime.json"
    && (hostname === normalizedSuffix || hostname === normalizedRuntimeHost);
}

function resolveProjectName(request: Request, projectHostSuffix: string, runtimeManifestHost?: string): string | undefined {
  const suffix = projectHostSuffix.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!suffix) {
    return undefined;
  }

  const hostname = new URL(request.url).hostname.toLowerCase();
  if (!hostname.endsWith(`.${suffix}`)) {
    return undefined;
  }

  const candidate = hostname.slice(0, -(suffix.length + 1));
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(candidate)) {
    return undefined;
  }

  if (resolveReservedProjectLabels(projectHostSuffix, runtimeManifestHost).has(candidate)) {
    return undefined;
  }

  return candidate;
}

function resolveReservedProjectLabels(projectHostSuffix: string, runtimeManifestHost?: string): Set<string> {
  const reserved = new Set<string>();
  const suffix = projectHostSuffix.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  const normalizedRuntimeHost = runtimeManifestHost?.trim().toLowerCase();
  if (!suffix || !normalizedRuntimeHost || !normalizedRuntimeHost.endsWith(`.${suffix}`)) {
    return reserved;
  }

  const candidate = normalizedRuntimeHost.slice(0, -(suffix.length + 1));
  if (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(candidate)) {
    reserved.add(candidate);
  }

  return reserved;
}

function rewriteRequestForInternalGateway(request: Request, env: Env, projectName: string): Request {
  const requestUrl = new URL(request.url);
  const internalBaseUrl = new URL(env.INTERNAL_GATEWAY_BASE_URL);
  internalBaseUrl.pathname = buildInternalGatewayPath(projectName, requestUrl.pathname);
  internalBaseUrl.search = requestUrl.search;

  const headers = new Headers(request.headers);
  for (const headerName of INTERNAL_HEADER_NAMES) {
    headers.delete(headerName);
  }
  headers.set("x-forwarded-host", requestUrl.host);
  headers.set("x-forwarded-proto", requestUrl.protocol.replace(/:$/, ""));
  headers.set("x-cail-public-routing-mode", "host");

  return new Request(internalBaseUrl.toString(), {
    body: request.body,
    cf: request.cf,
    headers,
    method: request.method,
    redirect: "manual"
  });
}

function buildInternalGatewayPath(projectName: string, pathname: string): string {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `/${projectName}${normalizedPath}`;
}

function rewriteResponseForProjectHost(
  response: Response,
  request: Request,
  env: Env,
  projectName: string
): Response {
  const headers = new Headers(response.headers);
  headers.delete("x-cail-base-path");
  rewriteLocationHeader(headers, request, env, projectName);

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText
  });
}

function rewriteLocationHeader(headers: Headers, request: Request, env: Env, projectName: string): void {
  const location = headers.get("location");
  if (!location) {
    return;
  }

  const publicUrl = new URL(request.url);
  const internalBaseUrl = new URL(env.INTERNAL_GATEWAY_BASE_URL);
  const projectPrefix = `/${projectName}`;

  if (location.startsWith(projectPrefix)) {
    const trimmedPath = location.slice(projectPrefix.length) || "/";
    headers.set("location", trimmedPath.startsWith("/") ? trimmedPath : `/${trimmedPath}`);
    return;
  }

  if (location.startsWith("/") || !looksLikeAbsoluteUrl(location)) {
    return;
  }

  const locationUrl = new URL(location);
  if (locationUrl.origin !== internalBaseUrl.origin) {
    return;
  }

  const trimmedPath = locationUrl.pathname.startsWith(projectPrefix)
    ? locationUrl.pathname.slice(projectPrefix.length) || "/"
    : locationUrl.pathname;
  const rewrittenUrl = new URL(publicUrl.toString());
  rewrittenUrl.pathname = trimmedPath.startsWith("/") ? trimmedPath : `/${trimmedPath}`;
  rewrittenUrl.search = locationUrl.search;
  rewrittenUrl.hash = locationUrl.hash;
  headers.set("location", rewrittenUrl.toString());
}

function looksLikeAbsoluteUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}
