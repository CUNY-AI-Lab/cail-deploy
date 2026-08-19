import type { PreparedWorker } from "../adapters/cloudflare/worker-bundler";
import { z } from "zod";

export interface PreparedEnvelope extends PreparedWorker {
  schemaVersion: "kale.prepared-worker.v1";
  projectId: string;
  releaseId: string;
  revisionId: string;
}

const preparedEnvelopeSchema = z
  .object({
    schemaVersion: z.literal("kale.prepared-worker.v1"),
    projectId: z.string(),
    releaseId: z.string(),
    revisionId: z.string(),
    mainModule: z.string(),
    modules: z.record(z.string(), z.string()),
    compatibilityDate: z.string(),
    compatibilityFlags: z.array(z.string()),
  })
  .strict();

type PreparedEnvelopeInput = z.input<typeof preparedEnvelopeSchema>;

export function parsePreparedEnvelope(value: PreparedEnvelopeInput | null): PreparedEnvelope {
  return preparedEnvelopeSchema.parse(value);
}
