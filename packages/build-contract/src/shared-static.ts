import type { StaticAssetDescriptor, WorkerAssetsConfig } from "./index";

export type SharedStaticManifest = {
  staticAssets?: StaticAssetDescriptor[];
  metadata?: {
    staticAssets?: {
      config?: WorkerAssetsConfig;
    };
    workerUpload?: {
      assets?: {
        config?: WorkerAssetsConfig;
      };
    };
  };
};

export type LoadedSharedStaticManifest = {
  config?: WorkerAssetsConfig;
  assets: Map<string, StaticAssetDescriptor>;
};

export type SharedStaticResolution =
  | { kind: "asset"; assetPath: string; status: number }
  | { kind: "redirect"; locationPath: string; status: number }
  | { kind: "not_found" };

const DEFAULT_SHARED_STATIC_RUNTIME_PROBES = [
  "/api/health",
  "/api",
  "/healthz",
  "/health"
] as const;

export function buildLoadedSharedStaticManifest(manifest: SharedStaticManifest): LoadedSharedStaticManifest {
  const assets = new Map<string, StaticAssetDescriptor>();
  for (const asset of manifest.staticAssets ?? []) {
    const normalizedPath = normalizeSharedStaticPath(asset.path);
    if (!normalizedPath) {
      continue;
    }

    assets.set(normalizedPath, {
      ...asset,
      path: normalizedPath
    });
  }

  return {
    config: manifest.metadata?.staticAssets?.config ?? manifest.metadata?.workerUpload?.assets?.config,
    assets
  };
}

export function resolveSharedStaticRequest(
  manifest: LoadedSharedStaticManifest,
  pathname: string
): SharedStaticResolution {
  const htmlHandling = manifest.config?.html_handling ?? "auto-trailing-slash";
  const exactAsset = manifest.assets.get(pathname);

  if (exactAsset) {
    const canonicalPath = resolveCanonicalHtmlPath(manifest, pathname, htmlHandling);
    if (canonicalPath && canonicalPath !== pathname) {
      return { kind: "redirect", locationPath: canonicalPath, status: 307 };
    }

    return {
      kind: "asset",
      assetPath: pathname,
      status: pathname.endsWith("/404.html") ? 404 : 200
    };
  }

  if (htmlHandling !== "none") {
    const htmlResolution = resolveHtmlHandledStaticRequest(manifest, pathname, htmlHandling);
    if (htmlResolution) {
      return htmlResolution;
    }
  }

  const notFoundAsset = resolveNotFoundAssetPath(manifest, pathname);
  if (notFoundAsset) {
    return {
      kind: "asset",
      assetPath: notFoundAsset,
      status: 404
    };
  }

  return { kind: "not_found" };
}

export function collectSharedStaticValidationPaths(
  manifest: LoadedSharedStaticManifest,
  maxPaths = 12
): string[] {
  const planned = new Set<string>(["/"]);
  const htmlHandling = manifest.config?.html_handling ?? "auto-trailing-slash";

  for (const probePath of DEFAULT_SHARED_STATIC_RUNTIME_PROBES) {
    planned.add(probePath);
  }

  const assetPaths = Array.from(manifest.assets.keys()).sort((left, right) => left.localeCompare(right));
  for (const assetPath of assetPaths) {
    if (planned.size >= maxPaths) {
      break;
    }

    if (assetPath.endsWith("/404.html")) {
      continue;
    }

    const probePath = canonicalProbePath(assetPath, htmlHandling);
    if (probePath) {
      planned.add(probePath);
    }

    const redirectProbe = redirectProbePath(assetPath, htmlHandling);
    if (redirectProbe) {
      planned.add(redirectProbe);
    }
  }

  if (manifest.config?.not_found_handling === "404-page") {
    planned.add("/__kale_missing_page__");
  }

  return Array.from(planned).slice(0, maxPaths);
}

export function normalizeSharedStaticPath(pathname: string): string | undefined {
  const trailingSlash = pathname !== "/" && pathname.endsWith("/");
  const segments = pathname.split("/");
  const normalizedSegments: string[] = [];

  for (const rawSegment of segments) {
    if (!rawSegment) {
      continue;
    }

    let decodedSegment: string;
    try {
      decodedSegment = decodeURIComponent(rawSegment);
    } catch {
      return undefined;
    }

    if (
      decodedSegment === "."
      || decodedSegment === ".."
      || decodedSegment.includes("/")
      || decodedSegment.includes("\\")
      || /[\u0000-\u001f\u007f]/u.test(decodedSegment)
    ) {
      return undefined;
    }

    normalizedSegments.push(decodedSegment);
  }

  const normalizedPath = `/${normalizedSegments.join("/")}`;
  if (normalizedPath === "/") {
    return "/";
  }

  return trailingSlash ? `${normalizedPath}/` : normalizedPath;
}

export function ensureTrailingSlash(pathname: string): string {
  return pathname === "/" || pathname.endsWith("/") ? pathname : `${pathname}/`;
}

export function stripTrailingSlash(pathname: string): string {
  if (pathname === "/") {
    return pathname;
  }

  return pathname.replace(/\/+$/u, "") || "/";
}

export function stripLeadingSlash(pathname: string): string {
  return pathname.replace(/^\/+/u, "");
}

function canonicalProbePath(assetPath: string, htmlHandling: string): string | undefined {
  if (assetPath === "/index.html") {
    return "/";
  }

  if (assetPath.endsWith("/index.html")) {
    const basePath = assetPath.slice(0, -"/index.html".length) || "/";
    return htmlHandling === "drop-trailing-slash" ? stripTrailingSlash(basePath) : ensureTrailingSlash(basePath);
  }

  if (assetPath.endsWith(".html")) {
    const withoutExtension = assetPath.slice(0, -".html".length) || "/";
    return htmlHandling === "force-trailing-slash"
      ? ensureTrailingSlash(withoutExtension)
      : stripTrailingSlash(withoutExtension);
  }

  return assetPath;
}

function redirectProbePath(assetPath: string, htmlHandling: string): string | undefined {
  if (assetPath.endsWith("/index.html") && assetPath !== "/index.html" && htmlHandling !== "drop-trailing-slash") {
    return assetPath.slice(0, -"/index.html".length) || "/";
  }

  if (assetPath.endsWith(".html") && !assetPath.endsWith("/index.html") && htmlHandling === "force-trailing-slash") {
    return stripTrailingSlash(assetPath.slice(0, -".html".length) || "/");
  }

  return undefined;
}

function resolveHtmlHandledStaticRequest(
  manifest: LoadedSharedStaticManifest,
  pathname: string,
  htmlHandling: string
): SharedStaticResolution | undefined {
  const canonicalPath = resolveCanonicalHtmlPath(manifest, pathname, htmlHandling);
  if (canonicalPath && canonicalPath !== pathname) {
    return { kind: "redirect", locationPath: canonicalPath, status: 307 };
  }

  const fileAssetPath = resolveFileHtmlAssetPath(manifest, pathname);
  if (fileAssetPath) {
    if (htmlHandling === "force-trailing-slash") {
      return { kind: "redirect", locationPath: ensureTrailingSlash(pathname), status: 307 };
    }

    return { kind: "asset", assetPath: fileAssetPath, status: 200 };
  }

  const directoryAssetPath = resolveDirectoryHtmlAssetPath(manifest, pathname);
  if (directoryAssetPath) {
    if (htmlHandling === "drop-trailing-slash") {
      return { kind: "asset", assetPath: directoryAssetPath, status: 200 };
    }

    if (pathname === "/" || pathname.endsWith("/")) {
      return { kind: "asset", assetPath: directoryAssetPath, status: 200 };
    }

    return {
      kind: "redirect",
      locationPath: pathname === "/" ? "/" : ensureTrailingSlash(pathname),
      status: 307
    };
  }

  return undefined;
}

function resolveCanonicalHtmlPath(
  manifest: LoadedSharedStaticManifest,
  pathname: string,
  htmlHandling: string
): string | undefined {
  if (pathname === "/") {
    return undefined;
  }

  if (pathname.endsWith("/index.html")) {
    const basePath = pathname.slice(0, -"/index.html".length) || "/";
    return htmlHandling === "drop-trailing-slash" ? stripTrailingSlash(basePath) : ensureTrailingSlash(basePath);
  }

  if (pathname.endsWith("/index")) {
    const basePath = pathname.slice(0, -"/index".length) || "/";
    if (
      manifest.assets.has(`${stripTrailingSlash(basePath)}.html`)
      || manifest.assets.has(`${stripTrailingSlash(basePath)}/index.html`)
    ) {
      return htmlHandling === "drop-trailing-slash" ? stripTrailingSlash(basePath) : ensureTrailingSlash(basePath);
    }
  }

  if (pathname.endsWith(".html")) {
    const withoutExtension = pathname.slice(0, -".html".length) || "/";
    return htmlHandling === "force-trailing-slash"
      ? ensureTrailingSlash(withoutExtension)
      : stripTrailingSlash(withoutExtension);
  }

  if (pathname.endsWith("/")) {
    const withoutSlash = stripTrailingSlash(pathname);
    if (withoutSlash !== "/" && manifest.assets.has(`${withoutSlash}.html`) && htmlHandling !== "force-trailing-slash") {
      return withoutSlash;
    }
  }

  return undefined;
}

function resolveFileHtmlAssetPath(
  manifest: LoadedSharedStaticManifest,
  pathname: string
): string | undefined {
  const basePath = stripTrailingSlash(pathname);
  if (basePath === "/") {
    return undefined;
  }

  const candidate = `${basePath}.html`;
  return manifest.assets.has(candidate) ? candidate : undefined;
}

function resolveDirectoryHtmlAssetPath(
  manifest: LoadedSharedStaticManifest,
  pathname: string
): string | undefined {
  const basePath = pathname === "/" ? "" : stripTrailingSlash(pathname);
  const candidate = `${basePath}/index.html` || "/index.html";
  return manifest.assets.has(candidate) ? candidate : undefined;
}

function resolveNotFoundAssetPath(
  manifest: LoadedSharedStaticManifest,
  pathname: string
): string | undefined {
  if (manifest.config?.not_found_handling !== "404-page") {
    return undefined;
  }

  let currentPath = pathname;
  for (;;) {
    const parentPath = currentPath.endsWith("/")
      ? currentPath.slice(0, -1) || "/"
      : currentPath.slice(0, currentPath.lastIndexOf("/")) || "/";
    const candidate = parentPath === "/" ? "/404.html" : `${parentPath}/404.html`;
    if (manifest.assets.has(candidate)) {
      return candidate;
    }

    if (parentPath === "/") {
      return undefined;
    }

    currentPath = parentPath;
  }
}
