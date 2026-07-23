import { describe, expect, test } from "vitest";
import { prepareAndSmokeWorker } from "../../src/adapters/cloudflare/worker-bundler";
import { artifactSchema } from "../../src/domain/contracts";
import type { WorkerLoaderLike } from "../../src/env";

const artifactBytes =
  '{"schemaVersion":"kale.artifact.v1","runtime":"worker","entrypoint":"src/alternate.ts","files":{"src/index.ts":"export default { fetch() { return new Response(\\"wrong-default-entrypoint\\") } }","src/alternate.ts":"export default { fetch() { return new Response(\\"declared-alternate-entrypoint\\") } }"},"compatibility":{"date":"2026-07-22","flags":[]},"requestedBindings":[]}\n';

describe("worker-bundler 0.2.2 workerd boundary", () => {
  test("bundles the canonical artifact inside workerd and supplies loader-ready modules", async () => {
    const artifact = artifactSchema.parse(JSON.parse(artifactBytes));
    let loaded = false;
    const loader: WorkerLoaderLike = {
      load(options) {
        loaded =
          options.mainModule.length > 0 &&
          Object.keys(options.modules).length > 0 &&
          options.globalOutbound === null;
        return {
          getEntrypoint: () => ({ fetch: async () => new Response("smoke", { status: 200 }) }),
        };
      },
    };
    const prepared = await prepareAndSmokeWorker(artifact, loader);
    expect(loaded).toBe(true);
    expect(prepared.modules[prepared.mainModule]).toBeTruthy();
    expect(
      artifactSchema.safeParse({
        ...artifact,
        entrypoint: "toString",
        files: { "src/index.ts": artifact.files["src/index.ts"] },
      }).success,
    ).toBe(false);
  });
});
