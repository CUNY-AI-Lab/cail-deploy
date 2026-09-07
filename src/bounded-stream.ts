import {
  type DeployDiagnostic,
  type DiagnosticContext,
  emitDeployDiagnostic,
  observeDetachedCleanup,
} from "./diagnostics";

type FailureMapper = <T>(cause: T) => Error;

interface ReadBoundedStreamOptions {
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly signal: AbortSignal;
  readonly limit: number;
  readonly overflowError: () => Error;
  readonly abortError?: FailureMapper;
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

export function readBoundedStream(options: ReadBoundedBytesOptions): Promise<Uint8Array>;
export function readBoundedStream(options: ReadBoundedTextOptions): Promise<string>;
export async function readBoundedStream(
  options: ReadBoundedBytesOptions | ReadBoundedTextOptions,
): Promise<Uint8Array | string> {
  const reader = options.reader;
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
      cancel();
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
    throw error;
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
