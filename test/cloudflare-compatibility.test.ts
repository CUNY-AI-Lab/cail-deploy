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
});
