import { WorkflowEntrypoint } from "cloudflare:workers";
import { prepareAndSmokeWorker } from "../../src/adapters/cloudflare/worker-bundler";
import { ensureWorkflowInstance, readArtifactBody } from "../../src/api";
import { artifactSchema } from "../../src/domain/contracts";
import { apiErrorSnapshot } from "../../src/domain/errors";
import type { ThrownValue } from "../helpers";
import type { ReleaseWorkflowParams, TestWorkflowBinding, WorkerLoaderLike } from "../../src/env";

const artifactBytes =
  '{"schemaVersion":"kale.artifact.v1","runtime":"worker","entrypoint":"src/alternate.ts","files":{"src/index.ts":"export default { fetch() { return new Response(\\"wrong-default-entrypoint\\") } }","src/alternate.ts":"export default { fetch() { return new Response(\\"declared-alternate-entrypoint\\") } }"},"compatibility":{"date":"2026-07-22","flags":[]},"requestedBindings":[]}\n';

const workflowId = "workflow-admission-workerd-gate-v1";
const workflowParams: ReleaseWorkflowParams = {
  projectId: `prj_${"2".repeat(32)}`,
  releaseId: `rel_${"3".repeat(32)}`,
  revisionId: `rev_sha256_${"4".repeat(64)}`,
  requestId: "55555555-5555-4555-8555-555555555555",
  admittedAt: "2026-07-23T00:00:00.000Z",
};

interface RejectedUploadResult {
  outcome: "rejected";
  status?: number;
  code?: string;
}

export class AdmissionWorkflow extends WorkflowEntrypoint<unknown, ReleaseWorkflowParams> {
  override async run(): Promise<void> {}
}

async function stalledUploadAbortGate(): Promise<{
  outcome: string;
  status?: number;
  code?: string;
  cancellations: number;
  locked: boolean;
}> {
  const controller = new AbortController();
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => undefined);
    },
    cancel() {
      cancellations += 1;
      return new Promise<void>(() => undefined);
    },
  });
  // SAFETY: ReadableStream request bodies require the Workers `duplex` init
  // extension, which is present in the runtime but omitted from RequestInit.
  const request = new Request("https://deploy.invalid/v1/projects/project/revisions", {
    method: "POST",
    body,
    duplex: "half",
    signal: controller.signal,
  } as RequestInit);
  const resultPromise = readArtifactBody(request, "99999999-9999-4999-8999-999999999999").then(
    () => ({ outcome: "resolved" }),
    (error: ThrownValue) => {
      const snapshot = apiErrorSnapshot(error);
      const rejected: RejectedUploadResult = { outcome: "rejected" };
      if (snapshot) {
        rejected.status = snapshot.status;
        rejected.code = snapshot.code;
      }
      return rejected;
    },
  );

  controller.abort(new Error("workerd caller cancelled upload"));
  const result = await Promise.race([
    resultPromise,
    new Promise<{ outcome: string }>((resolve) =>
      setTimeout(() => resolve({ outcome: "timeout" }), 250),
    ),
  ]);
  return {
    ...result,
    cancellations,
    locked: request.body?.locked ?? false,
  };
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
    const inheritedEntrypointRejected = !artifactSchema.safeParse({
      ...artifact,
      entrypoint: "toString",
      files: { "src/index.ts": artifact.files["src/index.ts"] },
    }).success;
    const prepared = await prepareAndSmokeWorker(artifact, env.LOADER);
    const preparedResponse = await env.LOADER.load({ ...prepared, globalOutbound: null })
      .getEntrypoint()
      .fetch(new Request("https://dynamic-worker.invalid/"));
    // SAFETY: the workerd binding implements the TestWorkflowBinding methods
    // used by ensureWorkflowInstance in this integration gate.
    const workflowEnv = {
      RELEASE_WORKFLOW: env.RELEASE_WORKFLOW as TestWorkflowBinding,
    };
    await ensureWorkflowInstance(workflowEnv, workflowId, workflowParams);
    await ensureWorkflowInstance(workflowEnv, workflowId, workflowParams);
    const instance = await env.RELEASE_WORKFLOW.get(workflowId);
    const workflowStatus = await instance.status();
    const stalledUploadAbort = await stalledUploadAbortGate();
    return Response.json({
      mainModule: prepared.mainModule,
      moduleCount: Object.keys(prepared.modules).length,
      workflowId: instance.id,
      workflowStatus: workflowStatus.status,
      preparedResponse: await preparedResponse.text(),
      inheritedEntrypointRejected,
      stalledUploadAbort,
    });
  },
};
