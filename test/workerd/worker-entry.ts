import { prepareAndSmokeWorker } from "../../src/adapters/cloudflare/worker-bundler";
import { artifactSchema } from "../../src/domain/contracts";
import type { WorkerLoaderLike } from "../../src/env";

const artifactBytes =
  '{"schemaVersion":"kale.artifact.v1","runtime":"worker","entrypoint":"src/index.ts","files":{"src/index.ts":"export default { fetch() { return new Response(\\"kale-fixture-v1\\") } }"},"compatibility":{"date":"2026-07-22","flags":[]},"requestedBindings":[]}\n';

export default {
  async fetch(_request: Request, env: { LOADER: WorkerLoaderLike }): Promise<Response> {
    const artifact = artifactSchema.parse(JSON.parse(artifactBytes));
    const prepared = await prepareAndSmokeWorker(artifact, env.LOADER);
    return Response.json({
      mainModule: prepared.mainModule,
      moduleCount: Object.keys(prepared.modules).length,
    });
  },
};
