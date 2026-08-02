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

interface LockEntry {
  key: string;
  valueStart: number;
}

function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (index < source.length && /\s/u.test(source[index] ?? "")) {
    index += 1;
  }
  return index;
}

function stringEnd(source: string, start: number): number {
  if (source[start] !== '"') {
    throw new Error("Cloudflare lockfile string is malformed");
  }
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      return index;
    }
  }
  throw new Error("Cloudflare lockfile string is unterminated");
}

function parseString(source: string, start: number): { value: string; end: number } {
  const end = stringEnd(source, start);
  let value: unknown;
  try {
    value = JSON.parse(source.slice(start, end + 1));
  } catch {
    throw new Error("Cloudflare lockfile string is malformed");
  }
  if (typeof value !== "string") {
    throw new Error("Cloudflare lockfile string is malformed");
  }
  return { value, end: end + 1 };
}

function matchingEnd(source: string, start: number): number {
  const opening = source[start];
  if (opening !== "{" && opening !== "[") {
    throw new Error("Cloudflare lockfile object is malformed");
  }
  const expectedClosings = new Map([
    ["{", "}"],
    ["[", "]"],
  ]);
  const stack = [opening];
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      index = stringEnd(source, index);
    } else if (character === "{" || character === "[") {
      stack.push(character);
    } else if (character === "}" || character === "]") {
      if (expectedClosings.get(stack[stack.length - 1]) !== character) {
        throw new Error("Cloudflare lockfile object is malformed");
      }
      stack.pop();
      if (stack.length === 0) {
        return index;
      }
    }
  }
  throw new Error("Cloudflare lockfile object is unterminated");
}

function valueEnd(source: string, start: number): number {
  const character = source[start];
  if (character === '"') {
    return parseString(source, start).end;
  }
  if (character === "{" || character === "[") {
    return matchingEnd(source, start) + 1;
  }
  let index = start;
  while (index < source.length && !/[\s,}\]]/u.test(source[index] ?? "")) {
    index += 1;
  }
  if (index === start) {
    throw new Error("Cloudflare lockfile value is malformed");
  }
  return index;
}

function objectEntries(source: string, start: number): { end: number; entries: LockEntry[] } {
  if (source[start] !== "{") {
    throw new Error("Cloudflare lockfile object is malformed");
  }
  const end = matchingEnd(source, start);
  const entries: LockEntry[] = [];
  let index = skipWhitespace(source, start + 1);
  while (index < end) {
    const key = parseString(source, index);
    index = skipWhitespace(source, key.end);
    if (source[index] !== ":") {
      throw new Error("Cloudflare lockfile entry is malformed");
    }
    const valueStart = skipWhitespace(source, index + 1);
    index = valueEnd(source, valueStart);
    entries.push({ key: key.value, valueStart });
    index = skipWhitespace(source, index);
    if (index === end) {
      break;
    }
    if (source[index] !== ",") {
      throw new Error("Cloudflare lockfile entry is malformed");
    }
    index = skipWhitespace(source, index + 1);
  }
  return { end, entries };
}

function uniqueObjectEntry(
  source: string,
  entries: LockEntry[],
  key: string,
  label: string,
): LockEntry {
  const matches = entries.filter((entry) => entry.key === key);
  if (matches.length !== 1 || source[matches[0]?.valueStart ?? -1] !== "{") {
    throw new Error(`Cloudflare ${label} lockfile entry is missing or ambiguous`);
  }
  return matches[0] as LockEntry;
}

function hasExactRootImporterEntry(
  lock: string,
  packageName: string,
  section: string,
  version: string,
): boolean {
  try {
    const rootStart = skipWhitespace(lock, 0);
    const root = objectEntries(lock, rootStart);
    if (skipWhitespace(lock, root.end + 1) !== lock.length) {
      return false;
    }
    const workspaces = uniqueObjectEntry(lock, root.entries, "workspaces", "workspaces");
    const workspaceEntries = objectEntries(lock, workspaces.valueStart).entries;
    const importer = uniqueObjectEntry(lock, workspaceEntries, "", "root workspace importer");
    const importerEntries = objectEntries(lock, importer.valueStart).entries;
    const dependencySection = uniqueObjectEntry(lock, importerEntries, section, section);
    const packageMatches = objectEntries(lock, dependencySection.valueStart).entries.filter(
      (entry) => entry.key === packageName,
    );
    if (packageMatches.length !== 1) {
      return false;
    }
    const value = parseString(lock, packageMatches[0]?.valueStart ?? -1).value;
    return value === version;
  } catch {
    return false;
  }
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

  for (const [packageName, section, version] of [
    ["@cloudflare/worker-bundler", "dependencies", bundlerVersion],
    ["@cloudflare/vitest-pool-workers", "devDependencies", poolVersion],
    ["wrangler", "devDependencies", wranglerVersion],
  ] as const) {
    if (!hasExactRootImporterEntry(lock, packageName, section, version)) {
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
