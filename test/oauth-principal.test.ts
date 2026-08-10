import { describe, expect, test } from "bun:test";
import { TEST_OPERATIONAL_SUBJECTS, TEST_SUBJECTS } from "@cuny-ai-lab/cail-identity/testing";
import { insufficientScopeResponse, oauthPrincipalFromProps } from "../src/oauth-principal";

describe("OAuth Principal handoff", () => {
  test("accepts only canonical provider props and preserves signed operational attribution", () => {
    expect(
      oauthPrincipalFromProps({
        subject: TEST_SUBJECTS.alice,
        operationalSubject: TEST_OPERATIONAL_SUBJECTS.alice,
        scope: ["cail:deploy"],
      }),
    ).toEqual({
      kind: "ok",
      principal: {
        subject: TEST_SUBJECTS.alice,
        operationalSubject: TEST_OPERATIONAL_SUBJECTS.alice,
        authentication: "oauth-access-token",
      },
    });
    expect(
      oauthPrincipalFromProps({ subject: TEST_SUBJECTS.alice, scope: ["cail:deploy"] }),
    ).toEqual({
      kind: "ok",
      principal: { subject: TEST_SUBJECTS.alice, authentication: "oauth-access-token" },
    });
  });

  test("fails closed for caller-shaped identity and missing or wrong scope", () => {
    expect(
      oauthPrincipalFromProps({
        subject: "caller-selected",
        operationalSubject: TEST_OPERATIONAL_SUBJECTS.alice,
        scope: ["cail:deploy"],
      }),
    ).toEqual({ kind: "invalid" });
    expect(
      oauthPrincipalFromProps({
        subject: TEST_SUBJECTS.alice,
        operationalSubject: "cail-v1-not-valid",
        scope: ["cail:deploy"],
      }),
    ).toEqual({ kind: "invalid" });
    expect(oauthPrincipalFromProps({ subject: TEST_SUBJECTS.alice, scope: [] })).toEqual({
      kind: "insufficient_scope",
    });
    expect(oauthPrincipalFromProps({ subject: TEST_SUBJECTS.alice, scope: ["other"] })).toEqual({
      kind: "insufficient_scope",
    });
    expect(
      oauthPrincipalFromProps({
        subject: TEST_SUBJECTS.alice,
        scope: ["cail:deploy"],
        callerSubject: TEST_SUBJECTS.bob,
      }),
    ).toEqual({ kind: "invalid" });
  });

  test("returns a standard bounded insufficient-scope challenge", async () => {
    const metadata = "https://deploy.example/.well-known/oauth-protected-resource/mcp";
    const requestId = "22222222-2222-4222-8222-222222222222";
    const response = insufficientScopeResponse(metadata, requestId);
    expect(response.status).toBe(403);
    expect(response.headers.get("WWW-Authenticate")).toBe(
      `Bearer realm="OAuth", resource_metadata="${metadata}", error="insufficient_scope", scope="cail:deploy"`,
    );
    expect(response.headers.get("X-CAIL-Request-Id")).toBe(requestId);
    expect(await response.json()).toEqual({
      error: "insufficient_scope",
      error_description: "This app doesn't have permission to deploy.",
    });
  });
});
