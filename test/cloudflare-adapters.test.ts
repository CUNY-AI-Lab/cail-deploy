import { afterEach, describe, expect, mock, test } from "bun:test";
import { publicationName, publishWorker } from "../src/adapters/cloudflare/wfp";
import { sendApprovalEvent } from "../src/api";
import type { Env } from "../src/env";
import type { ReleaseRow } from "../src/storage";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Cloudflare volatile boundaries", () => {
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
    const sendEvent = mock(async () => {
      throw new Error("provider-internal-detail");
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
