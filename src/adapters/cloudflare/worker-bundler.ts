import { createWorker } from "@cloudflare/worker-bundler";
import type { Artifact } from "../../domain/contracts";
import type { WorkerLoaderLike } from "../../env";

export interface PreparedWorker {
  mainModule: string;
  modules: Record<string, string>;
  compatibilityDate: string;
  compatibilityFlags: string[];
}

export async function prepareAndSmokeWorker(
  artifact: Artifact,
  loader: WorkerLoaderLike,
): Promise<PreparedWorker> {
  const bundled = await createWorker({
    files: artifact.files,
    entryPoint: artifact.entrypoint,
  });
  const modules = Object.fromEntries(
    Object.entries(bundled.modules).map(([path, source]) => {
      if (typeof source === "string") return [path, source];
      if (source.js !== undefined) return [path, source.js];
      if (source.cjs !== undefined) return [path, source.cjs];
      if (source.text !== undefined) return [path, source.text];
      if (source.json !== undefined) return [path, JSON.stringify(source.json)];
      throw new Error(`Worker Bundler returned an unsupported module type for ${path}.`);
    }),
  );
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
