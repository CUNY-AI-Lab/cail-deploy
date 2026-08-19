import { describe, expect, test } from "bun:test";
import type { JsonValue } from "../src/domain/json";
import { parseArtifactJsonBytes, readArtifactBody } from "../src/api";

const requestId = "11111111-1111-4111-8111-111111111111";
const maxArtifactBytes = 2 * 1024 * 1024;

function streamingRequest(
  body: ReadableStream<Uint8Array>,
  contentLength?: number,
  signal?: AbortSignal,
): Request {
  // SAFETY: ReadableStream request bodies require the Workers `duplex` init
  // extension, which is present in the runtime but omitted from RequestInit.
  return new Request("https://deploy.test/v1/projects/project/revisions", {
    method: "POST",
    body,
    duplex: "half",
    signal,
    headers: contentLength === undefined ? undefined : { "Content-Length": String(contentLength) },
  } as RequestInit);
}

describe("revision upload body boundary", () => {
  test("rejects malformed UTF-8 instead of changing uploaded JSON text", () => {
    const prefix = new TextEncoder().encode('{"source":"');
    const suffix = new TextEncoder().encode('"}');
    const bytes = new Uint8Array(prefix.byteLength + 1 + suffix.byteLength);
    bytes.set(prefix);
    bytes[prefix.byteLength] = 0x80;
    bytes.set(suffix, prefix.byteLength + 1);

    expect(() => parseArtifactJsonBytes(bytes)).toThrow("valid UTF-8 JSON");
  });

  test("rejects a declared oversized body before reading it", async () => {
    let pulls = 0;
    let cancelled = false;
    const request = streamingRequest(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array([1]));
        },
        cancel() {
          cancelled = true;
        },
      }),
      maxArtifactBytes + 1,
    );

    await expect(readArtifactBody(request, requestId)).rejects.toMatchObject({
      status: 413,
      code: "artifact_size_invalid",
    });
    expect(pulls).toBe(0);
    expect(cancelled).toBe(true);
  });

  test("does not wait for declared oversized body cancellation to settle", async () => {
    let pulls = 0;
    let cancelled = false;
    const request = streamingRequest(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array([1]));
        },
        cancel() {
          cancelled = true;
          return new Promise<void>(() => undefined);
        },
      }),
      maxArtifactBytes + 1,
    );

    await expect(readArtifactBody(request, requestId)).rejects.toMatchObject({
      status: 413,
      code: "artifact_size_invalid",
    });
    expect(pulls).toBe(0);
    expect(cancelled).toBe(true);
  });

  test("preserves the size error when cancellation, release, and diagnostics throw", async () => {
    // SAFETY: this malformed object implements exactly the body reader methods
    // exercised by the oversized-upload cleanup path.
    const request = {
      headers: new Headers({ "Content-Length": String(maxArtifactBytes + 1) }),
      body: {
        getReader: () => ({
          cancel: () => {
            throw new Error("PRIVATE_SYNCHRONOUS_CANCEL_FAILURE");
          },
          releaseLock: () => {
            throw new Error("PRIVATE_RELEASE_FAILURE");
          },
        }),
      },
    } as Request;
    const originalConsoleError = console.error;
    console.error = () => {
      throw new Error("PRIVATE_DIAGNOSTIC_SINK_FAILURE");
    };
    try {
      await expect(readArtifactBody(request, requestId)).rejects.toMatchObject({
        status: 413,
        code: "artifact_size_invalid",
      });
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("cancels a chunked body at the first byte beyond the limit", async () => {
    let cancelled = false;
    let pulls = 0;
    const request = streamingRequest(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls += 1;
            if (pulls === 1) {
              controller.enqueue(new Uint8Array(maxArtifactBytes));
            } else {
              controller.enqueue(new Uint8Array([1]));
            }
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
    );

    await expect(readArtifactBody(request, requestId)).rejects.toMatchObject({
      status: 413,
      code: "artifact_size_invalid",
    });
    expect(pulls).toBe(2);
    expect(cancelled).toBe(true);
  });

  test("preserves the chunked overflow error when cancellation rejects", async () => {
    const diagnostics: JsonValue[] = [];
    const originalConsoleError = console.error;
    console.error = (diagnostic: JsonValue) => {
      diagnostics.push(diagnostic);
    };
    const request = streamingRequest(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(maxArtifactBytes + 1));
        },
        cancel() {
          return Promise.reject(new Error("private cancel failure"));
        },
      }),
    );

    try {
      await expect(readArtifactBody(request, requestId)).rejects.toMatchObject({
        status: 413,
        code: "artifact_size_invalid",
      });
      await Promise.resolve();
      expect(diagnostics).toContainEqual({
        event: "deploy.request.body_cancel_failed",
        error: "body_cancel_failed",
        requestId,
      });
      expect(JSON.stringify(diagnostics)).not.toContain("private cancel failure");
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("preserves a primary read failure when release and diagnostics also fail", async () => {
    const primary = new Error("PRIMARY_ARTIFACT_READ_FAILURE");
    // SAFETY: this fixture implements only the request body reader methods
    // needed to inject a primary read failure and release failure.
    const request = {
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => {
            throw primary;
          },
          releaseLock: () => {
            throw new Error("PRIVATE_RELEASE_FAILURE");
          },
        }),
      },
    } as Request;
    const originalConsoleError = console.error;
    console.error = () => {
      throw new Error("PRIVATE_DIAGNOSTIC_SINK_FAILURE");
    };
    try {
      await expect(readArtifactBody(request, requestId)).rejects.toBe(primary);
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("settles a stalled read on caller cancellation without waiting for cleanup", async () => {
    const controller = new AbortController();
    const cause = new Error("PRIVATE_CALLER_ABORT");
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
    const request = streamingRequest(body, undefined, controller.signal);
    const pending = readArtifactBody(request, requestId);

    controller.abort(cause);

    await expect(pending).rejects.toMatchObject({
      status: 499,
      code: "request_cancelled",
      cause,
    });
    expect(cancellations).toBe(1);
    expect(body.locked).toBe(false);
  });

  test("contains rejecting cancellation and throwing diagnostics on caller abort", async () => {
    const controller = new AbortController();
    const diagnostics: JsonValue[] = [];
    const originalConsoleError = console.error;
    console.error = (diagnostic: JsonValue) => {
      diagnostics.push(diagnostic);
      throw new Error("PRIVATE_DIAGNOSTIC_FAILURE");
    };
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => undefined);
      },
      cancel() {
        return Promise.reject(new Error("PRIVATE_CANCEL_FAILURE"));
      },
    });
    const request = streamingRequest(body, undefined, controller.signal);
    const pending = readArtifactBody(request, requestId);

    try {
      controller.abort(new Error("PRIVATE_ABORT_REASON"));
      await expect(pending).rejects.toMatchObject({
        status: 499,
        code: "request_cancelled",
      });
      await Promise.resolve();
      expect(diagnostics).toHaveLength(1);
      expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_");
      expect(body.locked).toBe(false);
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("accepts an exact-limit streamed body", async () => {
    const expected = new Uint8Array(maxArtifactBytes);
    expected[0] = 17;
    expected[expected.length - 1] = 29;
    const request = streamingRequest(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(expected.subarray(0, 1_000_000));
          controller.enqueue(expected.subarray(1_000_000));
          controller.close();
        },
      }),
      maxArtifactBytes,
    );

    const actual = await readArtifactBody(request, requestId);
    expect(actual.byteLength).toBe(maxArtifactBytes);
    expect(actual[0]).toBe(17);
    expect(actual[actual.length - 1]).toBe(29);
  });

  test("rejects an empty body", async () => {
    const request = streamingRequest(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      0,
    );

    await expect(readArtifactBody(request, requestId)).rejects.toMatchObject({
      status: 413,
      code: "artifact_size_invalid",
    });
  });
});
