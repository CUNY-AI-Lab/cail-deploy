import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";

import { parse as parseJsonc } from "jsonc-parser";

import type {
  DeploymentMetadata,
  StaticAssetUpload,
  WorkerAssetsConfig,
  WorkerBinding
} from "@cuny-ai-lab/build-contract";

import { detectRuntimeEvidence } from "./runtime-evidence";
import { canAutoPromoteToSharedStatic, recommendRuntimeLane } from "../../deploy-service/src/runtime-lanes";

type FixtureExpectation = {
  classification: string;
  confidence: string;
  recommendedRuntimeLane: string;
  autoPromote: boolean;
};

type FixtureWranglerConfig = {
  main?: string;
  compatibility_date?: string;
  d1_databases?: Array<{ binding?: string; database_id?: string }>;
  kv_namespaces?: Array<{ binding?: string; id?: string }>;
  r2_buckets?: Array<{ binding?: string; bucket_name?: string }>;
  assets?: {
    directory?: string;
    html_handling?: string;
    not_found_handling?: string;
    run_worker_first?: boolean | string[];
  };
};

const FIXTURES_ROOT = path.join(import.meta.dirname, "..", "fixtures", "runtime-lanes");

const EXPECTATIONS = new Map<string, FixtureExpectation>([
  ["hono-worker", {
    classification: "dedicated_required",
    confidence: "high",
    recommendedRuntimeLane: "dedicated_worker",
    autoPromote: false
  }],
  ["hono-with-assets", {
    classification: "unknown",
    confidence: "medium",
    recommendedRuntimeLane: "dedicated_worker",
    autoPromote: false
  }],
  ["vite-static", {
    classification: "unknown",
    confidence: "medium",
    recommendedRuntimeLane: "dedicated_worker",
    autoPromote: false
  }],
  ["vite-static-kale", {
    classification: "shared_static_eligible",
    confidence: "high",
    recommendedRuntimeLane: "shared_static",
    autoPromote: true
  }],
  ["next-export", {
    classification: "shared_static_eligible",
    confidence: "high",
    recommendedRuntimeLane: "shared_static",
    autoPromote: true
  }],
  ["plain-static", {
    classification: "shared_static_eligible",
    confidence: "high",
    recommendedRuntimeLane: "shared_static",
    autoPromote: true
  }],
  ["static-with-control-files", {
    classification: "dedicated_required",
    confidence: "high",
    recommendedRuntimeLane: "dedicated_worker",
    autoPromote: false
  }],
  ["astro-static", {
    classification: "shared_static_eligible",
    confidence: "high",
    recommendedRuntimeLane: "shared_static",
    autoPromote: true
  }],
  ["astro-server", {
    classification: "dedicated_required",
    confidence: "high",
    recommendedRuntimeLane: "dedicated_worker",
    autoPromote: false
  }],
  ["sveltekit-static", {
    classification: "shared_static_eligible",
    confidence: "high",
    recommendedRuntimeLane: "shared_static",
    autoPromote: true
  }],
  ["nuxt-generate", {
    classification: "shared_static_eligible",
    confidence: "high",
    recommendedRuntimeLane: "shared_static",
    autoPromote: true
  }],
  ["worker-first-static", {
    classification: "dedicated_required",
    confidence: "high",
    recommendedRuntimeLane: "dedicated_worker",
    autoPromote: false
  }],
  ["static-with-db", {
    classification: "dedicated_required",
    confidence: "high",
    recommendedRuntimeLane: "dedicated_worker",
    autoPromote: false
  }]
]);

test("fixture apps map to the current runtime-lane outcomes", async (t) => {
  const fixtureNames = (await readdir(FIXTURES_ROOT)).sort();

  for (const fixtureName of fixtureNames) {
    await t.test(fixtureName, async () => {
      const expectation = EXPECTATIONS.get(fixtureName);
      assert.ok(expectation, `Missing expectation for fixture '${fixtureName}'.`);

      const fixtureRoot = path.join(FIXTURES_ROOT, fixtureName);
      const packageJson = await readOptionalJson(path.join(fixtureRoot, "package.json"));
      const wranglerConfig = await readOptionalJsonc<FixtureWranglerConfig>(path.join(fixtureRoot, "wrangler.jsonc")) ?? {};
      const staticAssets = await collectFixtureStaticAssets(fixtureRoot, wranglerConfig);
      const requestedBindings = extractRequestedBindings(wranglerConfig);
      const runtimeEvidence = await detectRuntimeEvidence({
        projectRoot: fixtureRoot,
        packageJson: packageJson ?? undefined,
        requestedBindings,
        staticAssets,
        assetsConfig: staticAssets?.config,
        assetsDirectory: wranglerConfig.assets?.directory
      });

      const metadata: DeploymentMetadata = {
        projectName: fixtureName,
        ownerLogin: "fixtures",
        githubRepo: `fixtures/${fixtureName}`,
        runtimeEvidence,
        workerUpload: {
          main_module: wranglerConfig.main ?? "src/index.ts",
          compatibility_date: wranglerConfig.compatibility_date ?? "2026-04-01",
          bindings: requestedBindings
        },
        ...(staticAssets ? { staticAssets } : {})
      };

      assert.equal(runtimeEvidence.classification, expectation.classification);
      assert.equal(runtimeEvidence.confidence, expectation.confidence);
      assert.equal(recommendRuntimeLane(metadata), expectation.recommendedRuntimeLane);
      assert.equal(canAutoPromoteToSharedStatic(metadata), expectation.autoPromote);
    });
  }
});

async function collectFixtureStaticAssets(
  fixtureRoot: string,
  wranglerConfig: FixtureWranglerConfig
): Promise<StaticAssetUpload | undefined> {
  const relativeDirectory = wranglerConfig.assets?.directory;
  if (!relativeDirectory) {
    return undefined;
  }

  const assetsDirectory = path.join(fixtureRoot, relativeDirectory);
  const files = await listFilesRecursive(assetsDirectory);
  if (files.length === 0) {
    return undefined;
  }

  return {
    ...(buildAssetsConfig(wranglerConfig.assets) ? { config: buildAssetsConfig(wranglerConfig.assets)! } : {}),
    isolationKey: path.basename(fixtureRoot),
    files: files.map((relativePath, index) => ({
      path: `/${relativePath}`,
      partName: `asset-${index}`
    }))
  };
}

function buildAssetsConfig(
  assets: FixtureWranglerConfig["assets"]
): WorkerAssetsConfig | undefined {
  if (!assets) {
    return undefined;
  }

  const config: WorkerAssetsConfig = {};
  if (assets.html_handling) {
    config.html_handling = assets.html_handling;
  }
  if (assets.not_found_handling) {
    config.not_found_handling = assets.not_found_handling;
  }
  if (assets.run_worker_first !== undefined) {
    config.run_worker_first = assets.run_worker_first;
  }

  return Object.keys(config).length > 0 ? config : undefined;
}

function extractRequestedBindings(config: FixtureWranglerConfig): WorkerBinding[] {
  const bindings: WorkerBinding[] = [];

  for (const database of config.d1_databases ?? []) {
    if (!database.binding) {
      continue;
    }

    bindings.push({
      type: "d1",
      name: database.binding,
      id: database.database_id ?? ""
    });
  }

  for (const namespace of config.kv_namespaces ?? []) {
    if (!namespace.binding) {
      continue;
    }

    bindings.push({
      type: "kv_namespace",
      name: namespace.binding,
      namespace_id: namespace.id ?? ""
    });
  }

  for (const bucket of config.r2_buckets ?? []) {
    if (!bucket.binding) {
      continue;
    }

    bindings.push({
      type: "r2_bucket",
      name: bucket.binding,
      bucket_name: bucket.bucket_name ?? ""
    });
  }

  return bindings;
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(currentPath: string): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }

      if (entry.isFile()) {
        results.push(path.relative(root, absolutePath).replaceAll(path.sep, "/"));
      }
    }
  }

  await walk(root);
  return results;
}

async function readOptionalJson(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readOptionalJsonc<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    return parseJsonc(raw) as T;
  } catch {
    return null;
  }
}
