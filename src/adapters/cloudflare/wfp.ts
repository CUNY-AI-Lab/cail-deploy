import type { PreparedWorker } from "./worker-bundler";
import { ApiError } from "../../domain/errors";
import type { Env } from "../../env";

const DEFAULT_PUBLISH_TIMEOUT_MS = 30_000;
const MIN_PUBLISH_TIMEOUT_MS = 1_000;
const MAX_PUBLISH_TIMEOUT_MS = 120_000;

export function publicationName(runId: string, projectId: string): string {
  return `kp-${runId}-${projectId.slice(4, 16)}`;
}

export function publicationTimeoutMs(raw: string | undefined): number {
  const value = raw === undefined ? DEFAULT_PUBLISH_TIMEOUT_MS : Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_PUBLISH_TIMEOUT_MS ||
    value > MAX_PUBLISH_TIMEOUT_MS
  ) {
    throw new ApiError(
      503,
      "publisher_configuration_error",
      `WfP publication timeout must be an integer between ${MIN_PUBLISH_TIMEOUT_MS} and ${MAX_PUBLISH_TIMEOUT_MS} milliseconds.`,
    );
  }
  return value;
}

export async function publishWorker(
  env: Env,
  projectId: string,
  revisionId: string,
  prepared: PreparedWorker,
): Promise<string> {
  if (!env.CLOUDFLARE_API_TOKEN) {
    throw new ApiError(
      503,
      "publisher_not_configured",
      "The isolated publisher credential is not configured.",
    );
  }
  const timeout = publicationTimeoutMs(env.WFP_PUBLISH_TIMEOUT_MS);
  const name = publicationName(env.RUN_ID, projectId);
  const metadata = {
    main_module: prepared.mainModule,
    compatibility_date: prepared.compatibilityDate,
    compatibility_flags: prepared.compatibilityFlags,
    bindings: [{ type: "plain_text", name: "KALE_REVISION_ID", text: revisionId }],
  };
  const form = new FormData();
  form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  for (const [path, source] of Object.entries(prepared.modules)) {
    form.set(path, new Blob([source], { type: "application/javascript+module" }), path);
  }
  let response: Response;
  try {
    const request = new Request(
      `https://api.cloudflare.com/client/v4/accounts/${env.WFP_ACCOUNT_ID}/workers/dispatch/namespaces/${env.WFP_NAMESPACE}/scripts/${name}`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
        body: form,
        signal: AbortSignal.timeout(timeout),
      },
    );
    response = env.WFP_API ? await env.WFP_API.fetch(request) : await fetch(request);
  } catch (cause) {
    throw new ApiError(
      502,
      "publication_ambiguous",
      "Workers for Platforms did not return a publication result.",
      { cause },
    );
  }
  if (!response.ok) {
    const code = response.status >= 500 ? "publication_ambiguous" : "publication_rejected";
    throw new ApiError(502, code, "Workers for Platforms did not accept the prepared publication.");
  }
  return name;
}
