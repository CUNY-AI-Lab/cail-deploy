import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  publicationName,
  publicationTimeoutMs,
  publishWorker,
} from "../src/adapters/cloudflare/wfp";
import { sendApprovalEvent } from "../src/api";
import type { Env } from "../src/env";
import type { ReleaseRow } from "../src/storage";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Cloudflare volatile boundaries", () => {
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
      await publishWorker(
        {
          CLOUDFLARE_API_TOKEN: "test-only",
          WFP_ACCOUNT_ID: "account",
          WFP_NAMESPACE: "namespace",
          WFP_PUBLISH_TIMEOUT_MS: "1000",
          RUN_ID: "ki-20260722123456-abcdef12",
        } as Env,
        "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        `rev_sha256_${"b".repeat(64)}`,
        {
          mainModule: "index.js",
          modules: { "index.js": "export default {}" },
          compatibilityDate: "2026-07-22",
          compatibilityFlags: [],
        },
      );
    } catch (error) {
      captured = error;
    }

    expect(captured).toMatchObject({
      status: 502,
      code: "publication_ambiguous",
      message: "Workers for Platforms did not return a publication result.",
    });
    expect((captured as Error).cause).toBeInstanceOf(DOMException);
    expect(((captured as Error).cause as DOMException).name).toBe("TimeoutError");
  });

  test("the local WfP service binding receives the same complete Cloudflare request", async () => {
    let captured: Request | undefined;
    const WFP_API = {
      fetch: mock(async (request: Request) => {
        captured = request;
        return Response.json({ success: true, result: { id: "publication" } });
      }),
    };
    const revisionId = `rev_sha256_${"b".repeat(64)}`;
    const result = await publishWorker(
      {
        CLOUDFLARE_API_TOKEN: "test-only",
        WFP_ACCOUNT_ID: "account",
        WFP_NAMESPACE: "namespace",
        RUN_ID: "ki-20260722123456-abcdef12",
        WFP_API,
      } as unknown as Env,
      "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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

    expect(result).toBe("kp-ki-20260722123456-abcdef12-aaaaaaaaaaaa");
    expect(captured?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account/workers/dispatch/namespaces/namespace/scripts/kp-ki-20260722123456-abcdef12-aaaaaaaaaaaa",
    );
    expect(captured?.method).toBe("PUT");
    expect(captured?.headers.get("authorization")).toBe("Bearer test-only");
    const form = await captured?.formData();
    const metadata = form?.get("metadata");
    expect(metadata).toBeInstanceOf(File);
    expect(JSON.parse(await (metadata as File).text())).toEqual({
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

  test("WfP names are run-scoped and 4xx is deterministic rejection", async () => {
    expect(
      publicationName("ki-20260722123456-abcdef12", "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ).toBe("kp-ki-20260722123456-abcdef12-aaaaaaaaaaaa");
    globalThis.fetch = mock(
      async () => new Response("provider-secret-debug-body", { status: 400 }),
    ) as typeof fetch;
    try {
      await publishWorker(
        {
          CLOUDFLARE_API_TOKEN: "test-only",
          WFP_ACCOUNT_ID: "account",
          WFP_NAMESPACE: "namespace",
          RUN_ID: "ki-20260722123456-abcdef12",
        } as Env,
        "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
      expect((error as Error).message).not.toContain("provider-secret-debug-body");
    }
  });

  test("Workflow approval delivery fails closed without provider error leakage", async () => {
    const providerFailure = new Error("provider-internal-detail");
    const sendEvent = mock(async () => {
      throw providerFailure;
    });
    const env = {
      RELEASE_WORKFLOW: { get: async () => ({ sendEvent }) },
    } as unknown as Env;
    const release = {
      workflow_instance_id: "rel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      revision_id: `rev_sha256_${"b".repeat(64)}`,
    } as ReleaseRow;

    await expect(
      sendApprovalEvent(env, release, "cail-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ).rejects.toMatchObject({
      status: 503,
      code: "approval_delivery_failed",
      message: "The approval was saved but Workflow delivery must be retried.",
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
