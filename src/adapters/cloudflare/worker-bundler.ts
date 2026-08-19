import { createWorker, type Modules } from "@cloudflare/worker-bundler";
import { z } from "zod";
import type { Artifact } from "../../domain/contracts";
import { jsonValueSchema, type JsonValue } from "../../domain/json";
import type { WorkerLoaderLike } from "../../env";

interface WorkerModuleRecord {
  js?: string;
  cjs?: string;
  text?: string;
  json?: JsonValue;
}

const workerModuleContract = z
  .object({
    js: z.string().optional(),
    cjs: z.string().optional(),
    text: z.string().optional(),
    json: jsonValueSchema.optional(),
  })
  .passthrough();
const workerModuleSchema = z.custom<WorkerModuleRecord>(
  (value) => workerModuleContract.safeParse(value).success,
);

export interface PreparedWorker {
  mainModule: string;
  modules: Record<string, string>;
  compatibilityDate: string;
  compatibilityFlags: string[];
}

export function normalizeWorkerModules(bundledModules: Modules): Record<string, string> {
  return Object.fromEntries(
    Object.entries(bundledModules).map(([path, source]) => {
      const text = z.string().safeParse(source);
      if (text.success) return [path, text.data];
      const module = workerModuleSchema.safeParse(source);
      if (!module.success) {
        throw new Error(`Worker Bundler returned an unsupported module type for ${path}.`);
      }
      if (module.data.js !== undefined) return [path, module.data.js];
      if (module.data.cjs !== undefined) return [path, module.data.cjs];
      if (module.data.text !== undefined) return [path, module.data.text];
      if (module.data.json !== undefined) return [path, JSON.stringify(module.data.json)];
      throw new Error(`Worker Bundler returned an unsupported module type for ${path}.`);
    }),
  );
}

export async function prepareAndSmokeWorker(
  artifact: Artifact,
  loader: WorkerLoaderLike,
): Promise<PreparedWorker> {
  const bundled = await createWorker({
    files: artifact.files,
    entryPoint: artifact.entrypoint,
  });
  const modules = normalizeWorkerModules(bundled.modules);
  const prepared = {
    mainModule: bundled.mainModule,
    modules,
    compatibilityDate: artifact.compatibility.date,
    compatibilityFlags: artifact.compatibility.flags,
  };
  const dynamicWorker = loader.load({ ...prepared, globalOutbound: null });
  const response = await dynamicWorker
    .getEntrypoint()
    .fetch(new Request("https://dynamic-worker.invalid/__kale_smoke"));
  if (response.status >= 500) throw new Error(`Dynamic Worker smoke returned ${response.status}.`);
  return prepared;
}
