import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const root = join(import.meta.dir, "..");
const logReceipt = {
  packageName: "@cuny-ai-lab/cail-log",
  version: "0.6.0",
  sourceHead: "cb6ffc0cfd4cb544639cbf288ff6eb24c7027e98",
  sourceTree: "618c4bdfae0effadbe23cfd6c4dfb1fcf6440697",
  tarBytes: 50_269,
  tarSha256: "8689422456eb4b7c672538ba91efb7606e9287df473a99a91ee2a60b5f9ba215",
  dependencyPath: "file:vendor/cuny-ai-lab-cail-log-0.6.0.tgz",
} as const;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function tarList(tarPath: string): Uint8Array {
  const result = Bun.spawnSync(["tar", "-tzf", tarPath]);
  expect(result.exitCode).toBe(0);
  return result.stdout;
}

function tarEntry(tarPath: string, entry: string): Uint8Array {
  const result = Bun.spawnSync(["tar", "-xOzf", tarPath, entry]);
  expect(result.exitCode).toBe(0);
  return result.stdout;
}

describe("reviewed primitive package authority", () => {
  test("pins the exact independently accepted clean Log source and tar receipt", async () => {
    const tarPath = join(root, "vendor/cuny-ai-lab-cail-log-0.6.0.tgz");
    const tarBytes = await Bun.file(tarPath).bytes();
    expect(tarBytes.byteLength).toBe(logReceipt.tarBytes);
    expect(sha256(tarBytes)).toBe(logReceipt.tarSha256);

    const packageManifest = await Bun.file(join(root, "package.json")).json();
    expect(packageManifest.dependencies[logReceipt.packageName]).toBe(logReceipt.dependencyPath);
    const lock = await Bun.file(join(root, "bun.lock")).text();
    expect(lock).toContain(`"@cuny-ai-lab/cail-log": "${logReceipt.dependencyPath}"`);

    const provenance = await Bun.file(join(root, "docs/PRIMITIVE_PINS.md")).text();
    for (const authority of [logReceipt.sourceHead, logReceipt.sourceTree, logReceipt.tarSha256]) {
      expect(provenance).toContain(authority);
    }
  });

  test("installs every packaged Log file from the reviewed vendored tar", async () => {
    const tarPath = join(root, "vendor/cuny-ai-lab-cail-log-0.6.0.tgz");
    const installedRoot = join(root, "node_modules/@cuny-ai-lab/cail-log");
    const entries = new TextDecoder().decode(tarList(tarPath)).trim().split("\n");
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      expect(entry.startsWith("package/")).toBe(true);
      const relativePath = entry.slice("package/".length);
      const packaged = tarEntry(tarPath, entry);
      const installed = await Bun.file(join(installedRoot, relativePath)).bytes();
      expect(sha256(installed), relativePath).toBe(sha256(packaged));
    }

    const installedManifest = await Bun.file(join(installedRoot, "package.json")).json();
    expect(installedManifest).toMatchObject({
      name: logReceipt.packageName,
      version: logReceipt.version,
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.js",
          default: "./dist/index.js",
        },
        "./contract/operational-event-v2.json": "./contract/operational-event-v2.json",
      },
    });
  });
});
