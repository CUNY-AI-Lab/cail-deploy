export interface CloudflarePackageReceipt {
  accepted?: unknown;
  boundary?: unknown;
  tested?: unknown;
  conformance?: unknown;
  legacyClientPin?: unknown;
  npmIntegritySha512?: unknown;
  poolCompatibility?: unknown;
  peerPins?: Record<string, string>;
}

export interface CloudflareCompatibilityReceipt {
  packages: Record<string, CloudflarePackageReceipt | undefined>;
}

export interface CloudflareLockfile {
  lockfileVersion: number;
  configVersion: number;
  workspaces: Record<string, CloudflareLockfileImporter>;
  packages: Record<string, unknown>;
}

export interface CloudflareLockfileImporter {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

interface PackageManifest {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

export interface CloudflareToolchainPins {
  bundlerVersion: string;
  poolVersion: string;
  wranglerVersion: string;
}

function pinnedVersion(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("npm:")) {
    throw new Error(`Cloudflare ${label} package pin is missing or not exact`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLockfile(lock: unknown): CloudflareLockfile {
  if (!isRecord(lock) || lock.lockfileVersion !== 1 || lock.configVersion !== 1) {
    throw new Error("Cloudflare bun.lock schema drifted");
  }
  if (!isRecord(lock.workspaces)) {
    throw new Error("Cloudflare bun.lock root importer drifted");
  }
  const rootImporter = lock.workspaces[""];
  if (!isRecord(rootImporter)) {
    throw new Error("Cloudflare bun.lock root importer drifted");
  }
  for (const section of ["dependencies", "devDependencies"] as const) {
    const value = rootImporter[section];
    if (value !== undefined && !isRecord(value)) {
      throw new Error(`Cloudflare bun.lock ${section} importer drifted`);
    }
  }
  if (!isRecord(lock.packages)) {
    throw new Error("Cloudflare bun.lock package records drifted");
  }
  return lock as unknown as CloudflareLockfile;
}

function hasExactLockRecord(
  lock: CloudflareLockfile,
  packageName: string,
  version: string,
): boolean {
  const record = lock.packages[packageName];
  return Array.isArray(record) && record[0] === `${packageName}@${version}`;
}

function hasExactRootImporterEntry(
  lock: CloudflareLockfile,
  packageName: string,
  section: keyof CloudflareLockfileImporter,
  version: string,
): boolean {
  const dependencies = lock.workspaces[""][section];
  return isRecord(dependencies) && dependencies[packageName] === version;
}

export function verifyCloudflareToolchainReceipt(
  packageManifest: PackageManifest,
  lock: unknown,
  compatibility: CloudflareCompatibilityReceipt,
): CloudflareToolchainPins {
  const parsedLock = parseLockfile(lock);
  const bundlerVersion = pinnedVersion(
    packageManifest.dependencies?.["@cloudflare/worker-bundler"],
    "worker-bundler",
  );
  const poolVersion = pinnedVersion(
    packageManifest.devDependencies?.["@cloudflare/vitest-pool-workers"],
    "vitest pool",
  );
  const wranglerVersion = pinnedVersion(packageManifest.devDependencies?.wrangler, "Wrangler");

  for (const [packageName, version] of [
    ["@cloudflare/worker-bundler", bundlerVersion],
    ["@cloudflare/vitest-pool-workers", poolVersion],
    ["wrangler", wranglerVersion],
  ] as const) {
    if (!hasExactLockRecord(parsedLock, packageName, version)) {
      throw new Error(`Cloudflare ${packageName} package/lock authority drifted`);
    }
  }

  for (const [packageName, section, version] of [
    ["@cloudflare/worker-bundler", "dependencies", bundlerVersion],
    ["@cloudflare/vitest-pool-workers", "devDependencies", poolVersion],
    ["wrangler", "devDependencies", wranglerVersion],
  ] as const) {
    if (!hasExactRootImporterEntry(parsedLock, packageName, section, version)) {
      throw new Error(`Cloudflare ${packageName} root importer authority drifted`);
    }
  }

  const workerBundlerReceipt = compatibility.packages?.["@cloudflare/worker-bundler"];
  const poolReceipt = compatibility.packages?.["@cloudflare/vitest-pool-workers"];
  const wranglerReceipt = compatibility.packages?.wrangler;
  if (workerBundlerReceipt?.tested !== bundlerVersion) {
    throw new Error("Cloudflare Worker Bundler compatibility receipt drifted");
  }
  if (poolReceipt?.tested !== poolVersion) {
    throw new Error("Cloudflare vitest pool compatibility receipt drifted");
  }
  if (wranglerReceipt?.accepted !== wranglerVersion) {
    throw new Error("Cloudflare Wrangler compatibility receipt drifted");
  }
  if (
    typeof workerBundlerReceipt?.conformance !== "string" ||
    !workerBundlerReceipt.conformance.includes(`Wrangler ${wranglerVersion}`)
  ) {
    throw new Error("Cloudflare Worker Bundler Wrangler conformance receipt drifted");
  }
  if (
    typeof workerBundlerReceipt.poolCompatibility !== "string" ||
    !workerBundlerReceipt.poolCompatibility.includes(
      `@cloudflare/vitest-pool-workers ${poolVersion}`,
    )
  ) {
    throw new Error("Cloudflare Worker Bundler pool compatibility receipt drifted");
  }
  if (
    typeof poolReceipt?.poolCompatibility !== "string" ||
    !poolReceipt.poolCompatibility.includes(`@cloudflare/worker-bundler ${bundlerVersion}`)
  ) {
    throw new Error("Cloudflare vitest pool bundler compatibility receipt drifted");
  }

  return { bundlerVersion, poolVersion, wranglerVersion };
}
