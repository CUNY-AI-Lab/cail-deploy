import { describe, expect, test } from "bun:test";
import parsedLock from "../bun.lock";
import {
  verifyCloudflareToolchainReceipt,
  type CloudflareCompatibilityReceipt,
  type CloudflareLockfile,
} from "../scripts/cloudflare-toolchain-receipt";

const root = new URL("../", import.meta.url);
const packageManifest = (await Bun.file(new URL("package.json", root)).json()) as {
  dependencies: Record<string, unknown>;
  devDependencies: Record<string, unknown>;
};
const compatibility = (await Bun.file(
  new URL("cloudflare-compatibility.json", root),
).json()) as CloudflareCompatibilityReceipt;

function driftedReceipt(): CloudflareCompatibilityReceipt {
  return structuredClone(compatibility);
}

function driftedLock(): CloudflareLockfile {
  return structuredClone(parsedLock) as CloudflareLockfile;
}

function mutateRootImporterEntry(
  fixture: CloudflareLockfile,
  packageName: string,
  section: "dependencies" | "devDependencies",
  version: string,
  replacement: string | undefined,
): void {
  const dependencies = fixture.workspaces[""][section];
  if (!dependencies || dependencies[packageName] !== version) {
    throw new Error(`expected one root importer entry for ${packageName}`);
  }
  if (replacement === undefined) {
    delete dependencies[packageName];
  } else {
    dependencies[packageName] = replacement;
  }
}

const importerPins = [
  {
    packageName: "@cloudflare/worker-bundler",
    section: "dependencies",
    version: "0.2.2",
    staleVersion: "0.2.1",
  },
  {
    packageName: "@cloudflare/vitest-pool-workers",
    section: "devDependencies",
    version: "0.19.0",
    staleVersion: "0.18.7",
  },
  {
    packageName: "wrangler",
    section: "devDependencies",
    version: "4.115.0",
    staleVersion: "4.113.0",
  },
] as const;

const packageRecordPins = [
  ["@cloudflare/worker-bundler", "0.2.2", "0.2.1"],
  ["@cloudflare/vitest-pool-workers", "0.19.0", "0.18.7"],
  ["wrangler", "4.115.0", "4.113.0"],
] as const;

describe("Cloudflare toolchain compatibility receipt", () => {
  test("accepts the package and lock authority", () => {
    expect(verifyCloudflareToolchainReceipt(packageManifest, parsedLock, compatibility)).toEqual({
      bundlerVersion: "0.2.2",
      poolVersion: "0.19.0",
      wranglerVersion: "4.115.0",
    });
  });

  test("rejects a stale Wrangler receipt", () => {
    const fixture = driftedReceipt();
    fixture.packages.wrangler = { ...fixture.packages.wrangler, accepted: "4.113.0" };
    expect(() => verifyCloudflareToolchainReceipt(packageManifest, parsedLock, fixture)).toThrow(
      "Cloudflare Wrangler compatibility receipt drifted",
    );
  });

  test("rejects a stale pool receipt", () => {
    const fixture = driftedReceipt();
    fixture.packages["@cloudflare/vitest-pool-workers"] = {
      ...fixture.packages["@cloudflare/vitest-pool-workers"],
      tested: "0.18.7",
    };
    expect(() => verifyCloudflareToolchainReceipt(packageManifest, parsedLock, fixture)).toThrow(
      "Cloudflare vitest pool compatibility receipt drifted",
    );
  });

  test("rejects a stale Worker Bundler receipt", () => {
    const fixture = driftedReceipt();
    fixture.packages["@cloudflare/worker-bundler"] = {
      ...fixture.packages["@cloudflare/worker-bundler"],
      tested: "0.2.1",
    };
    expect(() => verifyCloudflareToolchainReceipt(packageManifest, parsedLock, fixture)).toThrow(
      "Cloudflare Worker Bundler compatibility receipt drifted",
    );
  });

  for (const { packageName, section, version, staleVersion } of importerPins) {
    test(`rejects a stale ${section} root importer entry for ${packageName}`, () => {
      const fixtureLock = driftedLock();
      mutateRootImporterEntry(fixtureLock, packageName, section, version, staleVersion);
      expect(() =>
        verifyCloudflareToolchainReceipt(packageManifest, fixtureLock, compatibility),
      ).toThrow(`Cloudflare ${packageName} root importer authority drifted`);
    });

    test(`rejects a missing ${section} root importer entry for ${packageName}`, () => {
      const fixtureLock = driftedLock();
      mutateRootImporterEntry(fixtureLock, packageName, section, version, undefined);
      expect(() =>
        verifyCloudflareToolchainReceipt(packageManifest, fixtureLock, compatibility),
      ).toThrow(`Cloudflare ${packageName} root importer authority drifted`);
    });
  }

  for (const [packageName, version, staleVersion] of packageRecordPins) {
    test(`rejects a stale ${packageName} package record`, () => {
      const fixture = driftedLock();
      const record = fixture.packages[packageName];
      if (!Array.isArray(record)) {
        throw new Error(`expected package record for ${packageName}`);
      }
      record[0] = `${packageName}@${staleVersion}`;
      expect(() =>
        verifyCloudflareToolchainReceipt(packageManifest, fixture, compatibility),
      ).toThrow(`Cloudflare ${packageName} package/lock authority drifted`);
    });
  }

  for (const field of ["lockfileVersion", "configVersion"] as const) {
    test(`rejects an unsupported bun.lock ${field}`, () => {
      const fixture = driftedLock() as unknown as Record<string, unknown>;
      fixture[field] = 2;
      expect(() =>
        verifyCloudflareToolchainReceipt(packageManifest, fixture, compatibility),
      ).toThrow("Cloudflare bun.lock schema drifted");
    });
  }

  test("rejects stale Worker Bundler conformance text", () => {
    const fixture = driftedReceipt();
    fixture.packages["@cloudflare/worker-bundler"] = {
      ...fixture.packages["@cloudflare/worker-bundler"],
      conformance: "Wrangler 4.113.0 conformance",
    };
    expect(() => verifyCloudflareToolchainReceipt(packageManifest, parsedLock, fixture)).toThrow(
      "Cloudflare Worker Bundler Wrangler conformance receipt drifted",
    );
  });

  test("rejects stale Worker Bundler pool compatibility text", () => {
    const fixture = driftedReceipt();
    fixture.packages["@cloudflare/worker-bundler"] = {
      ...fixture.packages["@cloudflare/worker-bundler"],
      poolCompatibility: "@cloudflare/vitest-pool-workers 0.18.7",
    };
    expect(() => verifyCloudflareToolchainReceipt(packageManifest, parsedLock, fixture)).toThrow(
      "Cloudflare Worker Bundler pool compatibility receipt drifted",
    );
  });

  test("rejects stale pool bundler compatibility text", () => {
    const fixture = driftedReceipt();
    fixture.packages["@cloudflare/vitest-pool-workers"] = {
      ...fixture.packages["@cloudflare/vitest-pool-workers"],
      poolCompatibility: "@cloudflare/worker-bundler 0.2.1",
    };
    expect(() => verifyCloudflareToolchainReceipt(packageManifest, parsedLock, fixture)).toThrow(
      "Cloudflare vitest pool bundler compatibility receipt drifted",
    );
  });
});
