import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  publicationName,
  publicationTimeoutMs,
  publishWorker,
} from "../src/adapters/cloudflare/wfp";
import { normalizeWorkerModules } from "../src/adapters/cloudflare/worker-bundler";
import { sendApprovalEvent } from "../src/api";
import type { Env } from "../src/env";
import type { ThrownValue } from "../src/domain/values";
import type { ReleaseRow } from "../src/storage";

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
});

const publicationContext = {
  requestId: "30cc0bc0-6078-49f0-a9c0-ed8e546a9151",
  releaseId: "rel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};
const revisionId = `rev_sha256_${"b".repeat(64)}`;
const expectedPublicationName = "b".repeat(64);
const prepared = {
  mainModule: "index.js",
  modules: { "index.js": "export default {}" },
  compatibilityDate: "2026-07-22",
  compatibilityFlags: [],
};

async function publishWithResponse(response: Response, timeout = "1000"): Promise<string> {
  // SAFETY: this fixture supplies the WfP configuration and local fetch seam
  // consumed by publishWorker; unrelated production bindings are absent.
  return publishWorker(
    {
      CLOUDFLARE_API_TOKEN: "test-only",
      WFP_ACCOUNT_ID: "account",
      WFP_NAMESPACE: "namespace",
      WFP_PUBLISH_TIMEOUT_MS: timeout,
      WFP_API: { fetch: async () => response },
    } as Env,
    publicationContext,
    revisionId,
    prepared,
  );
}

interface ProviderResult {
  startup_time_ms: number;
  etag?: string;
  id?: string;
}

function providerEnvelope(result: ProviderResult, id = true) {
  const providerResult: ProviderResult = { startup_time_ms: 1, ...result };
  if (id) providerResult.id = expectedPublicationName;
  return {
    errors: [],
    messages: [],
    success: true,
    result: providerResult,
  };
}

function responseWithReader(
  status: number,
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Response {
  const response = new Response(null, { status });
  Object.defineProperty(response, "body", {
    value: { getReader: () => reader },
  });
  return response;
}

describe("Cloudflare volatile boundaries", () => {
  test("normalizes bundled and transform-only Worker Loader module representations", () => {
    const json = Object.assign(Object.create(null), { answer: 42 });
    Object.defineProperty(json, "__proto__", {
      value: { keep: true },
      enumerable: true,
    });
    expect(
      normalizeWorkerModules({
        "bundle.js": "export default {};",
        "worker.cjs": { cjs: "module.exports = {};" },
        "notes.txt": { text: "plain text" },
        "config.json": { json },
      }),
    ).toEqual({
      "bundle.js": "export default {};",
      "worker.cjs": "module.exports = {};",
      "notes.txt": "plain text",
      "config.json": '{"answer":42,"__proto__":{"keep":true}}',
    });
    expect(() =>
      normalizeWorkerModules({ "unsupported.bin": { data: new ArrayBuffer(1) } }),
    ).toThrow("Worker Bundler returned an unsupported module type for unsupported.bin.");
  });

  test("WfP publication timeout configuration is bounded", () => {
    expect(publicationTimeoutMs(undefined)).toBe(30_000);
    expect(publicationTimeoutMs("1000")).toBe(1_000);
    expect(() => publicationTimeoutMs("999")).toThrow(
      "WfP publication timeout must be an integer between 1000 and 120000 milliseconds.",
    );
    expect(() => publicationTimeoutMs("120001")).toThrow(
      "WfP publication timeout must be an integer between 1000 and 120000 milliseconds.",
    );
    expect(() => publicationTimeoutMs("not-a-number")).toThrow(
      "WfP publication timeout must be an integer between 1000 and 120000 milliseconds.",
    );
  });

  test("a hanging WfP PUT becomes an ambiguous publication at the configured deadline", async () => {
    // SAFETY: this fetch stub intentionally waits for the publisher's abort
    // signal and is typed to the platform fetch contract.
    globalThis.fetch = mock(
      async (input: RequestInfo | URL) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = input instanceof Request ? input.signal : undefined;
          if (!signal) {
            reject(new Error("missing timeout signal"));
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    ) as typeof fetch;

    let captured: unknown;
    try {
      // SAFETY: this fixture supplies the WfP configuration consumed by the
      // timeout path; no service binding is needed for the fetch stub.
      await publishWorker(
        {
          CLOUDFLARE_API_TOKEN: "test-only",
          WFP_ACCOUNT_ID: "account",
          WFP_NAMESPACE: "namespace",
          WFP_PUBLISH_TIMEOUT_MS: "1000",
        } as Env,
        publicationContext,
        revisionId,
        prepared,
      );
    } catch (error) {
      captured = error;
    }

    expect(captured).toMatchObject({
      status: 502,
      code: "publication_ambiguous",
      message:
        "We could not confirm whether this release published. Check the release status. If it is still publishing, use the reconcile action.",
    });
    // SAFETY: the publisher timeout contract stores the platform DOMException
    // as its cause, established by the preceding error shape assertion.
    expect((captured as Error).cause).toBeInstanceOf(DOMException);
    // SAFETY: the preceding instance check establishes the DOMException cause.
    expect(((captured as Error).cause as DOMException).name).toBe("TimeoutError");
  });

  test("the local WfP service binding receives the same complete Cloudflare request", async () => {
    let captured: Request | undefined;
    const WFP_API = {
      fetch: mock(async (request: Request) => {
        captured = request;
        return Response.json(providerEnvelope({ etag: "publication" }));
      }),
    };
    // SAFETY: the local WfP API binding supplies the exact fetch seam used by
    // this request-shape test.
    const result = await publishWorker(
      {
        CLOUDFLARE_API_TOKEN: "test-only",
        WFP_ACCOUNT_ID: "account",
        WFP_NAMESPACE: "namespace",
        WFP_API,
      } as Env,
      publicationContext,
      revisionId,
      {
        mainModule: "index.js",
        modules: {
          "index.js": "export default {}",
          "support.js": "export const support = true;",
        },
        compatibilityDate: "2026-07-22",
        compatibilityFlags: ["nodejs_compat"],
      },
    );

    expect(result).toBe(expectedPublicationName);
    expect(captured?.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/account/workers/dispatch/namespaces/namespace/scripts/${expectedPublicationName}`,
    );
    expect(captured?.method).toBe("PUT");
    expect(captured?.headers.get("authorization")).toBe("Bearer test-only");
    const form = await captured?.formData();
    const metadata = form?.get("metadata");
    expect(metadata).toBeInstanceOf(File);
    if (!(metadata instanceof File)) throw new Error("publisher metadata part was not a File");
    expect(JSON.parse(await metadata.text())).toEqual({
      main_module: "index.js",
      compatibility_date: "2026-07-22",
      compatibility_flags: ["nodejs_compat"],
      bindings: [
        {
          type: "plain_text",
          name: "KALE_REVISION_ID",
          text: revisionId,
        },
      ],
    });
    expect([...form!.keys()].sort()).toEqual(["index.js", "metadata", "support.js"]);
    expect(globalThis.fetch).toBe(originalFetch);
  });

  test("only a complete successful Cloudflare v4 envelope authorizes publication", async () => {
    await expect(
      publishWithResponse(Response.json(providerEnvelope({ etag: "with-id" }))),
    ).resolves.toBe(expectedPublicationName);
    await expect(
      publishWithResponse(Response.json(providerEnvelope({ etag: "without-id" }, false))),
    ).resolves.toBe(expectedPublicationName);

    const invalidEnvelopes: unknown[] = [
      { errors: [], messages: [], success: false, result: { startup_time_ms: 1 } },
      { errors: [], messages: [], success: true, result: null },
      { errors: [], messages: [], success: true, result: {} },
      { errors: [], messages: [], success: true, result: { startup_time_ms: Number.NaN } },
      {
        errors: [],
        messages: [],
        success: true,
        result: { startup_time_ms: 1, id: "another-script" },
      },
      { success: true, result: { startup_time_ms: 1 } },
    ];
    for (const envelope of invalidEnvelopes) {
      await expect(publishWithResponse(Response.json(envelope))).rejects.toMatchObject({
        status: 502,
        code: "publication_ambiguous",
        message:
          "We could not confirm whether this release published. Check the release status. If it is still publishing, use the reconcile action.",
      });
    }
    await expect(
      publishWithResponse(new Response("{", { headers: { "Content-Type": "application/json" } })),
    ).rejects.toMatchObject({ code: "publication_ambiguous" });
  });

  test("oversized and stalled successful bodies are cancelled, unlocked, and remain ambiguous", async () => {
    let oversizedCancels = 0;
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024 + 1));
      },
      cancel() {
        oversizedCancels += 1;
      },
    });
    const oversizedResponse = new Response(oversized, { status: 200 });
    await expect(publishWithResponse(oversizedResponse)).rejects.toMatchObject({
      code: "publication_ambiguous",
    });
    expect(oversizedCancels).toBe(1);
    expect(oversizedResponse.body?.locked).toBe(false);

    let stalledCancels = 0;
    const stalled = new ReadableStream<Uint8Array>({
      cancel() {
        stalledCancels += 1;
        return new Promise<void>(() => undefined);
      },
    });
    const stalledResponse = new Response(stalled, { status: 200 });
    const startedAt = performance.now();
    await expect(publishWithResponse(stalledResponse)).rejects.toMatchObject({
      code: "publication_ambiguous",
    });
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(stalledCancels).toBe(1);
    expect(stalledResponse.body?.locked).toBe(false);
  });

  test("non-2xx response cleanup is nonblocking and cannot replace provider classification", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: ThrownValue): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      for (const cancel of [
        () => Promise.resolve(),
        () => Promise.reject(new Error("PRIVATE_CANCEL_REJECTION")),
        () => new Promise<void>(() => undefined),
        () => {
          throw new Error("PRIVATE_CANCEL_THROW");
        },
      ]) {
        let cancels = 0;
        let releases = 0;
        console.error = () => {
          throw new Error("PRIVATE_DIAGNOSTIC_FAILURE");
        };
        // SAFETY: this reader fixture implements exactly the cancel/release
        // methods exercised by non-2xx cleanup.
        const reader = {
          cancel: () => {
            cancels += 1;
            return cancel();
          },
          releaseLock: () => {
            releases += 1;
            throw new Error("PRIVATE_RELEASE_FAILURE");
          },
        } as ReadableStreamDefaultReader<Uint8Array>;
        const startedAt = performance.now();
        await expect(publishWithResponse(responseWithReader(503, reader))).rejects.toMatchObject({
          code: "publication_ambiguous",
          message: "We could not publish this release.",
        });
        expect(performance.now() - startedAt).toBeLessThan(100);
        expect(cancels).toBe(1);
        expect(releases).toBe(1);
      }
      await Bun.sleep(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("read failure remains the exact private cause when cleanup and diagnostics fail", async () => {
    const primary = new Error("PRIVATE_READ_FAILURE");
    let cancels = 0;
    let releases = 0;
    console.error = () => {
      throw new Error("PRIVATE_DIAGNOSTIC_FAILURE");
    };
    // SAFETY: this reader fixture injects a primary read rejection while
    // implementing the cleanup methods under test.
    const reader = {
      read: () => Promise.reject(primary),
      cancel: () => {
        cancels += 1;
        return Promise.reject(new Error("PRIVATE_CANCEL_FAILURE"));
      },
      releaseLock: () => {
        releases += 1;
        throw new Error("PRIVATE_RELEASE_FAILURE");
      },
    } as ReadableStreamDefaultReader<Uint8Array>;
    let captured: unknown;
    try {
      await publishWithResponse(responseWithReader(200, reader));
    } catch (error) {
      captured = error;
    }
    await Bun.sleep(0);
    expect(captured).toMatchObject({
      code: "publication_ambiguous",
      message:
        "We could not confirm whether this release published. Check the release status. If it is still publishing, use the reconcile action.",
    });
    // SAFETY: publication failure formatting preserves the injected Error cause.
    expect((captured as Error).cause).toBe(primary);
    expect(cancels).toBe(1);
    expect(releases).toBe(1);
  });

  test("failed provider-body cleanup retains its request and release context", async () => {
    const diagnostics: unknown[] = [];
    console.error = (record) => diagnostics.push(record);
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        throw new Error("PRIVATE_PROVIDER_CLEANUP_DETAIL");
      },
    });
    const response = new Response(body, { status: 503 });
    await expect(publishWithResponse(response)).rejects.toMatchObject({
      code: "publication_ambiguous",
    });
    await Bun.sleep(0);
    expect(response.body?.locked).toBe(false);
    expect(diagnostics).toEqual([
      {
        event: "deploy.wfp.response.body_cancel_failed",
        error: "body_cancel_failed",
        ...publicationContext,
      },
    ]);
  });

  test("WfP names use the full revision digest and 4xx is deterministic rejection", async () => {
    expect(publicationName(revisionId)).toBe(expectedPublicationName);
    // SAFETY: this provider stub returns a deterministic 4xx rejection.
    globalThis.fetch = mock(
      async () => new Response("provider-secret-debug-body", { status: 400 }),
    ) as typeof fetch;
    try {
      // SAFETY: this fixture supplies the WfP configuration consumed by the
      // deterministic rejection path.
      await publishWorker(
        {
          CLOUDFLARE_API_TOKEN: "test-only",
          WFP_ACCOUNT_ID: "account",
          WFP_NAMESPACE: "namespace",
        } as Env,
        publicationContext,
        `rev_sha256_${"b".repeat(64)}`,
        {
          mainModule: "index.js",
          modules: { "index.js": "export default {}" },
          compatibilityDate: "2026-07-22",
          compatibilityFlags: [],
        },
      );
      throw new Error("Expected the publication to fail.");
    } catch (error) {
      expect(error).toMatchObject({ code: "publication_rejected" });
      // SAFETY: the catch branch receives the Error produced by publishWorker.
      expect((error as Error).message).not.toContain("provider-secret-debug-body");
    }
  });

  test("Workflow approval delivery fails closed without provider error leakage", async () => {
    const providerFailure = new Error("provider-internal-detail");
    const sendEvent = mock(async () => {
      throw providerFailure;
    });
    // SAFETY: this fixture supplies only the Workflow sendEvent seam used by
    // approval delivery.
    const env = {
      RELEASE_WORKFLOW: { get: async () => ({ sendEvent }) },
    } as Env;
    // SAFETY: sendApprovalEvent reads only these two ReleaseRow fields.
    const release = {
      workflow_instance_id: "rel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      revision_id: `rev_sha256_${"b".repeat(64)}`,
    } as ReleaseRow;

    await expect(
      sendApprovalEvent(env, release, "cail-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ).rejects.toMatchObject({
      status: 503,
      code: "approval_delivery_failed",
      message:
        "We saved your approval but couldn't finish applying it. Check the release status first, then reuse the same Idempotency-Key if you need to retry.",
      cause: providerFailure,
    });
    expect(sendEvent).toHaveBeenCalledWith({
      type: "release-approval",
      payload: {
        decision: "approved",
        actorSubject: "cail-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        revisionId: `rev_sha256_${"b".repeat(64)}`,
      },
    });
  });
});
