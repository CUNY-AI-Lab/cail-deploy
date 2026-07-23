import { describe, expect, test } from "bun:test";
import { readArtifactBody } from "../src/api";

const requestId = "11111111-1111-4111-8111-111111111111";
const maxArtifactBytes = 2 * 1024 * 1024;

function streamingRequest(body: ReadableStream<Uint8Array>, contentLength?: number): Request {
  return new Request("https://deploy.test/v1/projects/project/revisions", {
    method: "POST",
    body,
    duplex: "half",
    headers: contentLength === undefined ? undefined : { "Content-Length": String(contentLength) },
  } as RequestInit);
}

describe("revision upload body boundary", () => {
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

  test("cancels a chunked body at the first byte beyond the limit", async () => {
    let cancelled = false;
    let pulls = 0;
    const request = streamingRequest(
      new ReadableStream<Uint8Array>({
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
      }),
    );

    await expect(readArtifactBody(request, requestId)).rejects.toMatchObject({
      status: 413,
      code: "artifact_size_invalid",
    });
    expect(pulls).toBe(2);
    expect(cancelled).toBe(true);
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
