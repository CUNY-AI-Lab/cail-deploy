import { emitDeployDiagnostic, observeDetachedCleanup } from "../../diagnostics";
import { ApiError, apiErrorSnapshot } from "../../domain/errors";
import type { Env } from "../../env";
import type { PreparedWorker } from "./worker-bundler";

const DEFAULT_PUBLISH_TIMEOUT_MS = 30_000;
const MIN_PUBLISH_TIMEOUT_MS = 1_000;
const MAX_PUBLISH_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function ambiguousResult(cause?: unknown): ApiError {
  return new ApiError(
    502,
    "publication_ambiguous",
    "Workers for Platforms returned an indeterminate publication result.",
    cause === undefined ? undefined : { cause },
  );
}

function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      result:
        | { ok: true; value: ReadableStreamReadResult<Uint8Array> }
        | { ok: false; reason: unknown },
    ): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (result.ok) resolve(result.value);
      else reject(result.reason);
    };
    const onAbort = (): void => finish({ ok: false, reason: signal.reason });
    signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(
      (value) => finish({ ok: true, value }),
      (reason) => finish({ ok: false, reason }),
    );
  });
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  observeDetachedCleanup(() => reader.cancel(), "wfp_response_body_cancel_failed", {
    boundary: "wfp_response",
  });
}

function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.releaseLock();
  } catch {
    emitDeployDiagnostic("wfp_response_body_release_failed", { boundary: "wfp_response" });
  }
}

function discardResponseBody(response: Response): void {
  let body: ReadableStream<Uint8Array> | null;
  try {
    body = response.body;
  } catch {
    emitDeployDiagnostic("wfp_response_body_cancel_failed", { boundary: "wfp_response" });
    return;
  }
  if (!body) return;
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = body.getReader();
  } catch {
    emitDeployDiagnostic("wfp_response_body_cancel_failed", { boundary: "wfp_response" });
    return;
  }
  cancelReader(reader);
  releaseReader(reader);
}

async function readResponseText(response: Response, signal: AbortSignal): Promise<string> {
  let body: ReadableStream<Uint8Array> | null;
  try {
    body = response.body;
  } catch (cause) {
    throw ambiguousResult(cause);
  }
  if (!body) throw ambiguousResult();
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = body.getReader();
  } catch (cause) {
    throw ambiguousResult(cause);
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let complete = false;
  let byteLength = 0;
  let text = "";
  try {
    while (true) {
      const result = await readWithSignal(reader, signal);
      if (result.done) {
        complete = true;
        text += decoder.decode();
        return text;
      }
      byteLength += result.value.byteLength;
      if (byteLength > MAX_RESPONSE_BYTES) {
        throw ambiguousResult();
      }
      text += decoder.decode(result.value, { stream: true });
    }
  } catch (cause) {
    if (!complete) cancelReader(reader);
    throw ambiguousResult(cause);
  } finally {
    releaseReader(reader);
  }
}

function validPublicationEnvelope(value: unknown, expectedName: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  const envelope = value as Record<string, unknown>;
  if (
    envelope.success !== true ||
    !Array.isArray(envelope.errors) ||
    !Array.isArray(envelope.messages) ||
    typeof envelope.result !== "object" ||
    envelope.result === null
  ) {
    return false;
  }
  const result = envelope.result as Record<string, unknown>;
  if (
    typeof result.startup_time_ms !== "number" ||
    !Number.isFinite(result.startup_time_ms) ||
    result.startup_time_ms < 0
  ) {
    return false;
  }
  return (
    !Object.hasOwn(result, "id") || (typeof result.id === "string" && result.id === expectedName)
  );
}

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
  const signal = AbortSignal.timeout(timeout);
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
        signal,
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
    discardResponseBody(response);
    const code = response.status >= 500 ? "publication_ambiguous" : "publication_rejected";
    throw new ApiError(502, code, "Workers for Platforms did not accept the prepared publication.");
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(await readResponseText(response, signal));
  } catch (cause) {
    if (apiErrorSnapshot(cause)?.code === "publication_ambiguous") throw cause;
    throw ambiguousResult(cause);
  }
  if (!validPublicationEnvelope(envelope, name)) {
    throw ambiguousResult();
  }
  return name;
}
