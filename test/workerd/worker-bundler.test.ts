import { describe, expect, test } from "vitest";
import { prepareAndSmokeWorker } from "../../src/adapters/cloudflare/worker-bundler";
import { artifactSchema } from "../../src/domain/contracts";
import type { WorkerLoaderLike } from "../../src/env";

const artifactBytes =
  '{"schemaVersion":"kale.artifact.v1","runtime":"worker","entrypoint":"src/index.ts","files":{"src/index.ts":"export default { fetch() { return new Response(\\"kale-fixture-v1\\") } }"},"compatibility":{"date":"2026-07-22","flags":[]},"requestedBindings":[]}\n';

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
  });
});
