import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

describe("CI acceptance authority", () => {
  test("pins the current official checkout and Bun setup actions", () => {
    expect(workflow).toContain(
      "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2",
    );
    expect(workflow).toContain(
      "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0",
    );
    expect(workflow).toContain("bun-version: 1.3.5");
    expect(workflow).toContain("bun install --frozen-lockfile");
  });

  test("runs the complete self-contained gate and Worker build", () => {
    expect(workflow).toContain("run: bun run check");
    expect(workflow).toContain("run: bun run build");
    expect(workflow).not.toContain("bun test test/*.test.ts");
    expect(workflow).not.toContain("bun run typecheck");
  });
});
