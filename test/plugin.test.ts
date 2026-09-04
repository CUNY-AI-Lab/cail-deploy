import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareArtifact } from "../plugins/kale-deploy/scripts/prepare-artifact.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("Kale Deploy plugin", () => {
  test("prepares exact bounded UTF-8 artifact bytes and upload arguments", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kale-plugin-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "src", "lib"), { recursive: true });
    await writeFile(path.join(root, "src", "index.ts"), "import './lib/value';\n");
    await writeFile(path.join(root, "src", "lib", "value.ts"), "export const value = 1;\n");

    const prepared = await prepareArtifact({
      root,
      source: "src",
      entrypoint: "src/index.ts",
      compatibilityDate: "2026-07-22",
    });

    expect(prepared.artifact).toEqual({
      schemaVersion: "kale.artifact.v1",
      runtime: "worker",
      entrypoint: "src/index.ts",
      files: {
        "src/index.ts": "import './lib/value';\n",
        "src/lib/value.ts": "export const value = 1;\n",
      },
      compatibility: { date: "2026-07-22", flags: [] },
      requestedBindings: [],
    });
    expect(Buffer.from(prepared.uploadArguments.artifactBase64, "base64")).toEqual(prepared.bytes);
    expect(prepared.uploadArguments.contentDigest).toMatch(/^sha-256=:[A-Za-z0-9+/]{43}=:$/u);
    expect(prepared.artifactDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("rejects entrypoints outside the source tree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kale-plugin-invalid-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "outside.ts"), "export default {};\n");
    await writeFile(path.join(root, "src", "index.ts"), "export default {};\n");

    await expect(
      prepareArtifact({
        root,
        source: "src",
        entrypoint: "outside.ts",
        compatibilityDate: "2026-07-22",
      }),
    ).rejects.toThrow("Entrypoint is not present under the source directory: outside.ts");
  });

  test("rejects a symbolic link inside the source tree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kale-plugin-link-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "outside.ts"), "export default {};\n");
    await symlink(path.join(root, "outside.ts"), path.join(root, "src", "index.ts"));
    await expect(
      prepareArtifact({
        root,
        source: "src",
        entrypoint: "src/index.ts",
        compatibilityDate: "2026-07-22",
      }),
    ).rejects.toThrow("Symbolic links are not allowed:");
  });

  test("rejects a NUL-containing binary source file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kale-plugin-binary-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "index.ts"), new Uint8Array([0x00]));
    await expect(
      prepareArtifact({
        root,
        source: "src",
        entrypoint: "src/index.ts",
        compatibilityDate: "2026-07-22",
      }),
    ).rejects.toThrow("Binary source is not allowed: src/index.ts");
  });

  test("rejects an impossible compatibility date", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kale-plugin-date-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "index.ts"), "export default {};\n");

    await expect(
      prepareArtifact({
        root,
        source: "src",
        entrypoint: "src/index.ts",
        compatibilityDate: "2026-02-30",
      }),
    ).rejects.toThrow("real calendar date");
  });
});
