import { readBoundedStream } from "../../bounded-stream";
import { emitDeployDiagnostic, observeDetachedCleanup } from "../../diagnostics";
import { ApiError, apiErrorSnapshot } from "../../domain/errors";
import type { Env } from "../../env";
import type { PreparedWorker } from "./worker-bundler";
import { z } from "zod";

const DEFAULT_PUBLISH_TIMEOUT_MS = 30_000;
const MIN_PUBLISH_TIMEOUT_MS = 1_000;
const MAX_PUBLISH_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function ambiguousResult(cause?: unknown): ApiError {
  return new ApiError(
    502,
    "publication_ambiguous",
    "We could not confirm whether this release published. Check the release status. If it is still publishing, use the reconcile action.",
    cause === undefined ? undefined : { cause },
  );
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  observeDetachedCleanup(() => reader.cancel(), "wfp_response_body_cancel_failed", {});
}

function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.releaseLock();
  } catch {
    emitDeployDiagnostic("wfp_response_body_release_failed", {});
  }
}

function discardResponseBody(response: Response): void {
  let body: ReadableStream<Uint8Array> | null;
  try {
    body = response.body;
  } catch {
    emitDeployDiagnostic("wfp_response_body_cancel_failed", {});
    return;
  }
  if (!body) return;
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = body.getReader();
  } catch {
    emitDeployDiagnostic("wfp_response_body_cancel_failed", {});
    return;
  }
  cancelReader(reader);
  releaseReader(reader);
}

async function readResponseText(response: Response, signal: AbortSignal): Promise<string> {
  return readBoundedStream({
    body: () => response.body,
    signal,
    limit: MAX_RESPONSE_BYTES,
    overflowError: ambiguousResult,
    bodyAccessError: ambiguousResult,
    readError: ambiguousResult,
    missingBodyError: ambiguousResult,
    cancelDiagnostic: "wfp_response_body_cancel_failed",
    releaseDiagnostic: "wfp_response_body_release_failed",
    diagnosticContext: {},
    forwardCancelReason: false,
    cancelOnError: true,
    output: "text",
  });
}

const publicationEnvelopeSchema = z
  .object({
    success: z.literal(true),
    errors: z.array(z.json()),
    messages: z.array(z.json()),
    result: z
      .object({
        startup_time_ms: z.number().finite().nonnegative(),
        id: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

type PublicationEnvelopeInput = z.input<typeof publicationEnvelopeSchema>;

function validPublicationEnvelope(
  value: PublicationEnvelopeInput | null,
  expectedName: string,
): boolean {
  const parsed = publicationEnvelopeSchema.safeParse(value);
  if (!parsed.success) return false;
  return parsed.data.result.id === undefined || parsed.data.result.id === expectedName;
}

export function publicationName(revisionId: string): string {
  return revisionId.slice("rev_sha256_".length);
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
      "Kale Deploy isn't set up correctly right now.",
    );
  }
  const timeout = publicationTimeoutMs(env.WFP_PUBLISH_TIMEOUT_MS);
  const signal = AbortSignal.timeout(timeout);
  const name = publicationName(revisionId);
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
      "We could not confirm whether this release published. Check the release status. If it is still publishing, use the reconcile action.",
      { cause },
    );
  }
  if (!response.ok) {
    discardResponseBody(response);
    const code = response.status >= 500 ? "publication_ambiguous" : "publication_rejected";
    throw new ApiError(502, code, "We could not publish this release.");
  }
  let envelope: PublicationEnvelopeInput | null;
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
