import { describe, expect, test } from "bun:test";
import {
  verifyCloudflareToolchainReceipt,
  type CloudflareCompatibilityReceipt,
} from "../scripts/cloudflare-toolchain-receipt";

const root = new URL("../", import.meta.url);
const packageManifest = (await Bun.file(new URL("package.json", root)).json()) as {
  dependencies: Record<string, unknown>;
  devDependencies: Record<string, unknown>;
};
const lock = await Bun.file(new URL("bun.lock", root)).text();
const compatibility = (await Bun.file(
  new URL("cloudflare-compatibility.json", root),
).json()) as CloudflareCompatibilityReceipt;

function driftedReceipt(): CloudflareCompatibilityReceipt {
  return JSON.parse(JSON.stringify(compatibility)) as CloudflareCompatibilityReceipt;
}

function replaceRootImporterEntry(
  packageName: string,
  version: string,
  replacement: string,
): string {
  const line = `        "${packageName}": "${version}",`;
  const matches = lock.match(
    new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "gmu"),
  );
  if (matches?.length !== 1) {
    throw new Error(`expected one root importer entry for ${packageName}`);
  }
  return lock.replace(`${line}\n`, replacement.length > 0 ? `${replacement}\n` : "");
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

describe("Cloudflare toolchain compatibility receipt", () => {
  test("accepts the package and lock authority", () => {
    expect(verifyCloudflareToolchainReceipt(packageManifest, lock, compatibility)).toEqual({
      bundlerVersion: "0.2.2",
      poolVersion: "0.19.0",
      wranglerVersion: "4.115.0",
    });
  });

  test("rejects a stale Wrangler receipt", () => {
    const fixture = driftedReceipt();
    fixture.packages.wrangler = { ...fixture.packages.wrangler, accepted: "4.113.0" };
    expect(() => verifyCloudflareToolchainReceipt(packageManifest, lock, fixture)).toThrow(
      "Cloudflare Wrangler compatibility receipt drifted",
    );
  });

  test("rejects a stale pool receipt", () => {
    const fixture = driftedReceipt();
    fixture.packages["@cloudflare/vitest-pool-workers"] = {
      ...fixture.packages["@cloudflare/vitest-pool-workers"],
      tested: "0.18.7",
    };
    expect(() => verifyCloudflareToolchainReceipt(packageManifest, lock, fixture)).toThrow(
      "Cloudflare vitest pool compatibility receipt drifted",
    );
  });

  test("rejects a stale Worker Bundler receipt", () => {
    const fixture = driftedReceipt();
    fixture.packages["@cloudflare/worker-bundler"] = {
      ...fixture.packages["@cloudflare/worker-bundler"],
      tested: "0.2.1",
    };
    expect(() => verifyCloudflareToolchainReceipt(packageManifest, lock, fixture)).toThrow(
      "Cloudflare Worker Bundler compatibility receipt drifted",
    );
  });

  for (const { packageName, section, version, staleVersion } of importerPins) {
    test(`rejects a stale ${section} root importer entry for ${packageName}`, () => {
      const fixtureLock = replaceRootImporterEntry(
        packageName,
        version,
        `        "${packageName}": "${staleVersion}",`,
      );
      expect(() =>
        verifyCloudflareToolchainReceipt(packageManifest, fixtureLock, compatibility),
      ).toThrow(`Cloudflare ${packageName} root importer authority drifted`);
    });

    test(`rejects a missing ${section} root importer entry for ${packageName}`, () => {
      const fixtureLock = replaceRootImporterEntry(packageName, version, "");
      expect(() =>
        verifyCloudflareToolchainReceipt(packageManifest, fixtureLock, compatibility),
      ).toThrow(`Cloudflare ${packageName} root importer authority drifted`);
    });
  }
});
