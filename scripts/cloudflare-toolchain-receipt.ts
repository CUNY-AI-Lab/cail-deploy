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

function hasExactLockRecord(lock: string, packageName: string, version: string): boolean {
  return lock.includes(`"${packageName}": ["${packageName}@${version}"`);
}

export function verifyCloudflareToolchainReceipt(
  packageManifest: PackageManifest,
  lock: string,
  compatibility: CloudflareCompatibilityReceipt,
): CloudflareToolchainPins {
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
    if (!hasExactLockRecord(lock, packageName, version)) {
      throw new Error(`Cloudflare ${packageName} package/lock authority drifted`);
    }
  }

  const workerBundlerReceipt = compatibility.packages?.["@cloudflare/worker-bundler"];
  const poolReceipt = compatibility.packages?.["@cloudflare/vitest-pool-workers"];
  const wranglerReceipt = compatibility.packages?.wrangler;
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
