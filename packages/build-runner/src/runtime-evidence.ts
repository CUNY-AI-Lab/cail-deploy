import path from "node:path";
import { readFile } from "node:fs/promises";

import type {
  RuntimeEvidence,
  RuntimeEvidenceBasis,
  RuntimeEvidenceClassification,
  RuntimeEvidenceConfidence,
  RuntimeEvidenceFramework,
  StaticAssetUpload,
  WorkerAssetsConfig,
  WorkerBinding
} from "@cuny-ai-lab/build-contract";

type ProjectPackageJson = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type KaleProjectConfig = {
  projectShape?: "static_site" | "worker_app";
  staticOutputDir?: string;
  requestTimeLogic?: "none" | "allowed";
};

type DetectRuntimeEvidenceOptions = {
  projectRoot: string;
  packageJson?: ProjectPackageJson;
  requestedBindings: WorkerBinding[];
  staticAssets?: StaticAssetUpload;
  assetsConfig?: WorkerAssetsConfig;
  assetsDirectory?: string;
};

export async function detectRuntimeEvidence(
  options: DetectRuntimeEvidenceOptions
): Promise<RuntimeEvidence> {
  const framework = detectFramework(options.packageJson);
  const assetsConfig = options.assetsConfig ?? options.staticAssets?.config;

  if (options.requestedBindings.length > 0) {
    return buildRuntimeEvidence(
      framework,
      "dedicated_required",
      "high",
      ["bindings_present"],
      `Build output requests ${options.requestedBindings.length} Worker binding${options.requestedBindings.length === 1 ? "" : "s"}, so it must stay on a dedicated Worker.`
    );
  }

  if (runsWorkerFirst(assetsConfig)) {
    return buildRuntimeEvidence(
      framework,
      "dedicated_required",
      "high",
      ["run_worker_first"],
      "Wrangler is configured to run the Worker before asset serving, so this deployment must stay on a dedicated Worker."
    );
  }

  if (!options.staticAssets?.files.length) {
    return buildRuntimeEvidence(
      framework,
      "dedicated_required",
      "high",
      ["no_static_assets"],
      "The build did not produce a static asset bundle, so shared static hosting is not available."
    );
  }

  const unsupportedStaticControlFiles = detectUnsupportedStaticControlFiles(options.staticAssets);
  if (unsupportedStaticControlFiles) {
    return buildRuntimeEvidence(
      framework,
      "dedicated_required",
      "high",
      unsupportedStaticControlFiles.basis,
      unsupportedStaticControlFiles.summary
    );
  }

  const frameworkEvidence = await detectFrameworkRuntimeEvidence(options.projectRoot, framework, options.packageJson);
  if (frameworkEvidence) {
    return frameworkEvidence;
  }

  const kaleProjectConfig = await readKaleProjectConfig(options.projectRoot);
  const kaleStaticEvidence = detectKaleStaticRuntimeEvidence({
    projectRoot: options.projectRoot,
    framework,
    packageJson: options.packageJson,
    assetsDirectory: options.assetsDirectory,
    projectConfig: kaleProjectConfig
  });
  if (kaleStaticEvidence) {
    return kaleStaticEvidence;
  }

  return buildRuntimeEvidence(
    framework,
    "unknown",
    "medium",
    ["generic_assets_only"],
    "The build produced static assets, but the runner did not find explicit framework evidence that the Worker runtime is disposable."
  );
}

function detectFramework(packageJson: ProjectPackageJson | undefined): RuntimeEvidenceFramework {
  const dependencies = {
    ...packageJson?.dependencies,
    ...packageJson?.devDependencies
  };

  if (dependencies.next) {
    return "next";
  }

  if (dependencies.astro) {
    return "astro";
  }

  if (dependencies["@sveltejs/kit"]) {
    return "sveltekit";
  }

  if (dependencies.nuxt) {
    return "nuxt";
  }

  if (dependencies.vite) {
    return "vite";
  }

  return "unknown";
}

async function detectFrameworkRuntimeEvidence(
  projectRoot: string,
  framework: RuntimeEvidenceFramework,
  packageJson: ProjectPackageJson | undefined
): Promise<RuntimeEvidence | undefined> {
  switch (framework) {
    case "next":
      return await detectNextRuntimeEvidence(projectRoot);
    case "astro":
      return await detectAstroRuntimeEvidence(projectRoot);
    case "sveltekit":
      return await detectSvelteKitRuntimeEvidence(projectRoot);
    case "nuxt":
      return detectNuxtRuntimeEvidence(packageJson);
    default:
      return undefined;
  }
}

async function detectNextRuntimeEvidence(projectRoot: string): Promise<RuntimeEvidence | undefined> {
  const config = await readFirstExistingFile(projectRoot, [
    "next.config.js",
    "next.config.mjs",
    "next.config.ts",
    "next.config.mts",
    "next.config.cjs"
  ]);
  if (!config) {
    return undefined;
  }

  if (hasConfigValue(config, "output", ["export"])) {
    return buildRuntimeEvidence(
      "next",
      "shared_static_eligible",
      "high",
      ["next_output_export"],
      "Next.js explicitly sets output to 'export', so the built site is eligible for shared static hosting."
    );
  }

  return undefined;
}

async function detectAstroRuntimeEvidence(projectRoot: string): Promise<RuntimeEvidence | undefined> {
  const config = await readFirstExistingFile(projectRoot, [
    "astro.config.mjs",
    "astro.config.js",
    "astro.config.ts",
    "astro.config.mts",
    "astro.config.cjs"
  ]);
  if (!config) {
    return undefined;
  }

  if (hasConfigValue(config, "output", ["server", "hybrid"])) {
    return buildRuntimeEvidence(
      "astro",
      "dedicated_required",
      "high",
      ["astro_server_output"],
      "Astro is configured for server or hybrid output, so request-time runtime behavior must stay on a dedicated Worker."
    );
  }

  if (hasConfigValue(config, "output", ["static"])) {
    return buildRuntimeEvidence(
      "astro",
      "shared_static_eligible",
      "high",
      ["astro_static_output"],
      "Astro explicitly sets output to 'static', so the built site is eligible for shared static hosting."
    );
  }

  return undefined;
}

async function detectSvelteKitRuntimeEvidence(projectRoot: string): Promise<RuntimeEvidence | undefined> {
  const config = await readFirstExistingFile(projectRoot, [
    "svelte.config.js",
    "svelte.config.mjs",
    "svelte.config.ts",
    "svelte.config.cjs"
  ]);
  if (!config) {
    return undefined;
  }

  if (/@sveltejs\/adapter-static|adapter-static/u.test(config)) {
    return buildRuntimeEvidence(
      "sveltekit",
      "shared_static_eligible",
      "high",
      ["sveltekit_adapter_static"],
      "SvelteKit is configured with adapter-static, so the built site is eligible for shared static hosting."
    );
  }

  return undefined;
}

function detectNuxtRuntimeEvidence(packageJson: ProjectPackageJson | undefined): RuntimeEvidence | undefined {
  const buildScript = packageJson?.scripts?.build;
  if (!buildScript) {
    return undefined;
  }

  if (/\b(?:nuxt|nuxi)\s+generate\b/u.test(buildScript) || /\b(?:nuxt|nuxi)\s+build\b[^\n]*--prerender\b/u.test(buildScript)) {
    return buildRuntimeEvidence(
      "nuxt",
      "shared_static_eligible",
      "high",
      ["nuxt_generate"],
      "The Nuxt build script explicitly generates prerendered output, so the built site is eligible for shared static hosting."
    );
  }

  return undefined;
}

function detectKaleStaticRuntimeEvidence(input: {
  projectRoot: string;
  framework: RuntimeEvidenceFramework;
  packageJson: ProjectPackageJson | undefined;
  assetsDirectory: string | undefined;
  projectConfig: KaleProjectConfig | undefined;
}): RuntimeEvidence | undefined {
  if (input.projectConfig?.projectShape !== "static_site") {
    return undefined;
  }

  if (input.projectConfig.requestTimeLogic !== "none") {
    return buildRuntimeEvidence(
      input.framework,
      "unknown",
      "medium",
      ["kale_static_project_manifest", "kale_static_project_contract_incomplete"],
      "kale.project.json declares a static_site project, but it does not explicitly promise requestTimeLogic: 'none', so the runner cannot certify it for shared static hosting."
    );
  }

  const declaredOutputDir = normalizeProjectDirectory(input.projectConfig.staticOutputDir);
  const assetsDirectory = normalizeProjectDirectory(
    input.assetsDirectory
      ? path.isAbsolute(input.assetsDirectory)
        ? path.relative(input.projectRoot, input.assetsDirectory)
        : input.assetsDirectory
      : undefined
  );
  if (!declaredOutputDir || !assetsDirectory) {
    return buildRuntimeEvidence(
      input.framework,
      "unknown",
      "medium",
      ["kale_static_project_manifest", "kale_static_project_contract_incomplete"],
      "kale.project.json declares a static_site project, but the static output directory is not fully declared in both kale.project.json and wrangler.jsonc."
    );
  }

  if (declaredOutputDir && assetsDirectory && declaredOutputDir !== assetsDirectory) {
    return buildRuntimeEvidence(
      input.framework,
      "unknown",
      "medium",
      ["kale_static_project_manifest_mismatch"],
      `kale.project.json declares '${input.projectConfig.staticOutputDir}' as the static output directory, but Wrangler serves assets from '${input.assetsDirectory}'.`
    );
  }

  const basis: RuntimeEvidenceBasis[] = ["kale_static_project_manifest"];
  if (input.framework === "vite" && hasViteBuildScript(input.packageJson)) {
    basis.push("vite_build_script");
  }

  if (input.framework === "vite" && hasViteBuildScript(input.packageJson)) {
    return buildRuntimeEvidence(
      "vite",
      "shared_static_eligible",
      "high",
      basis,
      "kale.project.json declares a static_site project and the repository builds its asset bundle with vite build, so the deployment is eligible for shared static hosting."
    );
  }

  return buildRuntimeEvidence(
    input.framework,
    "shared_static_eligible",
    "high",
    basis,
    "kale.project.json declares a static_site project and the build produced a static asset bundle without request-time Worker requirements, so the deployment is eligible for shared static hosting."
  );
}

function runsWorkerFirst(config?: WorkerAssetsConfig): boolean {
  const value = config?.run_worker_first;

  if (value === undefined) {
    return false;
  }

  if (typeof value === "boolean") {
    return value;
  }

  return value.length > 0;
}

function hasConfigValue(configText: string, property: string, values: string[]): boolean {
  return values.some((value) => new RegExp(`\\b${property}\\s*:\\s*["']${escapeRegExp(value)}["']`, "u").test(configText));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasViteBuildScript(packageJson: ProjectPackageJson | undefined): boolean {
  const buildScript = packageJson?.scripts?.build;
  return typeof buildScript === "string" && /\bvite\s+build\b/u.test(buildScript);
}

function detectUnsupportedStaticControlFiles(
  staticAssets: StaticAssetUpload | undefined
): { basis: RuntimeEvidenceBasis[]; summary: string } | undefined {
  if (!staticAssets?.files.length) {
    return undefined;
  }

  const assetPaths = new Set(staticAssets.files.map((descriptor) => descriptor.path));
  const basis: RuntimeEvidenceBasis[] = [];
  const controlFiles: string[] = [];

  if (assetPaths.has("/_headers")) {
    basis.push("static_asset_headers_file");
    controlFiles.push("_headers");
  }

  if (assetPaths.has("/_redirects")) {
    basis.push("static_asset_redirects_file");
    controlFiles.push("_redirects");
  }

  if (basis.length === 0) {
    return undefined;
  }

  const listedFiles = controlFiles.map((name) => `'${name}'`).join(" and ");
  return {
    basis,
    summary: `The asset bundle includes ${listedFiles}, and the current shared static lane does not yet emulate those Cloudflare static asset control files, so this deployment must stay on a dedicated Worker.`
  };
}

function normalizeProjectDirectory(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return value
    .replace(/\\/g, "/")
    .replace(/^\.\//u, "")
    .replace(/\/+$/u, "");
}

async function readKaleProjectConfig(projectRoot: string): Promise<KaleProjectConfig | undefined> {
  const raw = await readFirstExistingFile(projectRoot, ["kale.project.json"]);
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const projectShape = parsed.projectShape;
    const staticOutputDir = parsed.staticOutputDir;
    const requestTimeLogic = parsed.requestTimeLogic;

    return {
      projectShape: projectShape === "static_site" || projectShape === "worker_app" ? projectShape : undefined,
      staticOutputDir: typeof staticOutputDir === "string" ? staticOutputDir : undefined,
      requestTimeLogic: requestTimeLogic === "none" || requestTimeLogic === "allowed"
        ? requestTimeLogic
        : undefined
    };
  } catch {
    return undefined;
  }
}

async function readFirstExistingFile(projectRoot: string, relativePaths: string[]): Promise<string | undefined> {
  for (const relativePath of relativePaths) {
    try {
      return await readFile(path.join(projectRoot, relativePath), "utf8");
    } catch {
      continue;
    }
  }

  return undefined;
}

function buildRuntimeEvidence(
  framework: RuntimeEvidenceFramework,
  classification: RuntimeEvidenceClassification,
  confidence: RuntimeEvidenceConfidence,
  basis: RuntimeEvidenceBasis[],
  summary: string
): RuntimeEvidence {
  return {
    source: "build_runner",
    framework,
    classification,
    confidence,
    basis,
    summary
  };
}
