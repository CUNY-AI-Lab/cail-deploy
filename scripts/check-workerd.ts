import { z } from "zod";

const workerdResultSchema = z
  .object({
    mainModule: z.string().optional(),
    moduleCount: z.number().optional(),
    workflowId: z.string().optional(),
    workflowStatus: z.string().optional(),
    preparedResponse: z.string().optional(),
    inheritedEntrypointRejected: z.boolean().optional(),
    stalledUploadAbort: z
      .object({
        outcome: z.string().optional(),
        status: z.number().optional(),
        code: z.string().optional(),
        cancellations: z.number().optional(),
        locked: z.boolean().optional(),
      })
      .optional(),
  })
  .passthrough();

const socket = Bun.listen({
  hostname: "127.0.0.1",
  port: 0,
  socket: { data() {} },
});
const port = socket.port;
socket.stop(true);

const process = Bun.spawn(
  [
    "bunx",
    "wrangler",
    "dev",
    "--local",
    "--config",
    "wrangler.workerd-test.jsonc",
    "--port",
    String(port),
  ],
  { stdout: "ignore", stderr: "ignore" },
);

let lastError: unknown;
try {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (!response.ok) throw new Error(`workerd health check returned status ${response.status}`);
      const result = workerdResultSchema.parse(await response.json());
      if (
        !result.mainModule ||
        !result.moduleCount ||
        result.workflowId !== "workflow-admission-workerd-gate-v1" ||
        !result.workflowStatus ||
        result.workflowStatus === "unknown" ||
        result.preparedResponse !== "declared-alternate-entrypoint" ||
        result.inheritedEntrypointRejected !== true ||
        result.stalledUploadAbort?.outcome !== "rejected" ||
        result.stalledUploadAbort.status !== 499 ||
        result.stalledUploadAbort.code !== "request_cancelled" ||
        result.stalledUploadAbort.cancellations !== 1 ||
        result.stalledUploadAbort.locked !== false
      ) {
        throw new Error(
          "workerd did not honor the declared entrypoint, return one deterministic Workflow, and enforce prompt upload cancellation cleanup.",
        );
      }
      console.log(
        `Workerd gates passed: ${result.mainModule}, ${result.moduleCount} module(s), Workflow ${result.workflowId} ${result.workflowStatus}, stalled upload ${result.stalledUploadAbort.status}/${result.stalledUploadAbort.code}`,
      );
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      if (process.exitCode !== null) break;
      await Bun.sleep(100);
    }
  }
  if (lastError) {
    throw new Error(`Workerd gate failed: ${String(lastError)}`);
  }
} finally {
  process.kill();
  await process.exited;
}
