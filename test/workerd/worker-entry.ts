import { WorkflowEntrypoint } from "cloudflare:workers";
import { prepareAndSmokeWorker } from "../../src/adapters/cloudflare/worker-bundler";
import { ensureWorkflowInstance } from "../../src/api";
import { artifactSchema } from "../../src/domain/contracts";
import type { ReleaseWorkflowParams, TestWorkflowBinding, WorkerLoaderLike } from "../../src/env";

const artifactBytes =
  '{"schemaVersion":"kale.artifact.v1","runtime":"worker","entrypoint":"src/index.ts","files":{"src/index.ts":"export default { fetch() { return new Response(\\"kale-fixture-v1\\") } }"},"compatibility":{"date":"2026-07-22","flags":[]},"requestedBindings":[]}\n';

const workflowId = "workflow-admission-workerd-gate-v1";
const workflowParams: ReleaseWorkflowParams = {
  projectId: `prj_${"2".repeat(32)}`,
  releaseId: `rel_${"3".repeat(32)}`,
  revisionId: `rev_sha256_${"4".repeat(64)}`,
  requestId: "55555555-5555-4555-8555-555555555555",
  admittedAt: "2026-07-23T00:00:00.000Z",
};

export class AdmissionWorkflow extends WorkflowEntrypoint<unknown, ReleaseWorkflowParams> {
  override async run(): Promise<void> {}
}

export default {
  async fetch(
    _request: Request,
    env: {
      LOADER: WorkerLoaderLike;
      RELEASE_WORKFLOW: Workflow<ReleaseWorkflowParams>;
    },
  ): Promise<Response> {
    const artifact = artifactSchema.parse(JSON.parse(artifactBytes));
    const prepared = await prepareAndSmokeWorker(artifact, env.LOADER);
    const workflowEnv = {
      RELEASE_WORKFLOW: env.RELEASE_WORKFLOW as unknown as TestWorkflowBinding,
    };
    await ensureWorkflowInstance(workflowEnv, workflowId, workflowParams);
    await ensureWorkflowInstance(workflowEnv, workflowId, workflowParams);
    const instance = await env.RELEASE_WORKFLOW.get(workflowId);
    const workflowStatus = await instance.status();
    return Response.json({
      mainModule: prepared.mainModule,
      moduleCount: Object.keys(prepared.modules).length,
      workflowId: instance.id,
      workflowStatus: workflowStatus.status,
    });
  },
};
