import { afterEach, describe, expect, mock, test } from "bun:test";
import { publicationName, publishWorker } from "../src/adapters/cloudflare/wfp";
import type { Env } from "../src/env";

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
});
