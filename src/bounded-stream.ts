import {
  type DeployDiagnostic,
  type DiagnosticContext,
  emitDeployDiagnostic,
  observeDetachedCleanup,
} from "./diagnostics";

type FailureMapper = <T>(cause: T) => Error;

interface ReadBoundedStreamOptions {
  readonly body: () => ReadableStream<Uint8Array> | null;
  readonly signal: AbortSignal;
  readonly limit: number;
  readonly overflowError: () => Error;
  readonly abortError?: FailureMapper;
  readonly bodyAccessError?: FailureMapper;
  readonly readError?: FailureMapper;
  readonly missingBodyError?: () => Error;
  readonly cancelDiagnostic: DeployDiagnostic;
  readonly releaseDiagnostic: DeployDiagnostic;
  readonly diagnosticContext: DiagnosticContext;
  readonly forwardCancelReason: boolean;
  readonly cancelOnError: boolean;
  readonly declaredTooLarge?: boolean;
}

interface ReadBoundedBytesOptions extends ReadBoundedStreamOptions {
  readonly output: "bytes";
}

interface ReadBoundedTextOptions extends ReadBoundedStreamOptions {
  readonly output: "text";
}

function accessBody(
  body: () => ReadableStream<Uint8Array> | null,
  bodyAccessError: FailureMapper | undefined,
): ReadableStream<Uint8Array> | null {
  try {
    return body();
  } catch (cause) {
    if (bodyAccessError) throw bodyAccessError(cause);
    throw cause;
  }
}

function accessReader(
  body: ReadableStream<Uint8Array>,
  bodyAccessError: FailureMapper | undefined,
): ReadableStreamDefaultReader<Uint8Array> {
  try {
    return body.getReader();
  } catch (cause) {
    if (bodyAccessError) throw bodyAccessError(cause);
    throw cause;
  }
}

export function readBoundedStream(options: ReadBoundedBytesOptions): Promise<Uint8Array>;
export function readBoundedStream(options: ReadBoundedTextOptions): Promise<string>;
export async function readBoundedStream(
  options: ReadBoundedBytesOptions | ReadBoundedTextOptions,
): Promise<Uint8Array | string> {
  const body = accessBody(options.body, options.bodyAccessError);
  if (!body) {
    if (options.missingBodyError) throw options.missingBodyError();
    return options.output === "bytes" ? new Uint8Array() : "";
  }

  const reader = accessReader(body, options.bodyAccessError);
  let cancellationStarted = false;
  const cancel = <T>(reason?: T): void => {
    if (cancellationStarted) return;
    cancellationStarted = true;
    observeDetachedCleanup(
      () => (options.forwardCancelReason ? reader.cancel(reason) : reader.cancel()),
      options.cancelDiagnostic,
      options.diagnosticContext,
    );
  };
  const release = (): void => {
    try {
      reader.releaseLock();
    } catch {
      emitDeployDiagnostic(options.releaseDiagnostic, options.diagnosticContext);
    }
  };
  const readChunk = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    if (options.signal.aborted) {
      cancel(options.signal.reason);
      throw options.abortError ? options.abortError(options.signal.reason) : options.signal.reason;
    }
    return await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
      let settled = false;
      const finish = (continuation: () => void): void => {
        if (settled) return;
        settled = true;
        options.signal.removeEventListener("abort", onAbort);
        continuation();
      };
      const onAbort = (): void => {
        cancel(options.signal.reason);
        const error = options.abortError
          ? options.abortError(options.signal.reason)
          : options.signal.reason;
        finish(() => reject(error));
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
      void reader.read().then(
        (result) => finish(() => resolve(result)),
        (cause) => finish(() => reject(cause)),
      );
    });
  };

  const chunks: Uint8Array[] = [];
  const decoder = options.output === "text" ? new TextDecoder("utf-8", { fatal: true }) : null;
  let total = 0;
  let text = "";
  let complete = false;
  try {
    if (options.declaredTooLarge) {
      const error = options.overflowError();
      cancel(error);
      throw error;
    }
    while (true) {
      const { done, value } = await readChunk();
      if (done) {
        complete = true;
        if (decoder) return text + decoder.decode();
        break;
      }
      total += value.byteLength;
      if (total > options.limit) {
        const error = options.overflowError();
        cancel(error);
        throw error;
      }
      if (decoder) text += decoder.decode(value, { stream: true });
      else chunks.push(value);
    }
  } catch (error) {
    if (options.cancelOnError && !complete) cancel(error);
    throw options.readError ? options.readError(error) : error;
  } finally {
    release();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
