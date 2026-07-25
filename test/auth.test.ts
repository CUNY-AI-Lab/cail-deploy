import { describe, expect, test } from "bun:test";
import {
  createTestIdentityIssuer,
  TEST_OPERATIONAL_SUBJECTS,
  TEST_SUBJECTS,
} from "@cuny-ai-lab/cail-identity/testing";
import { authenticate } from "../src/auth";
import type { Env } from "../src/env";
import { workerHandler } from "../src/handler";
import { operationalLogSubject } from "../src/operational-events";

// The real fleet audience. It is pinned in code, so a placeholder here would
// be refused at config load and every case below would read 503 instead of
// exercising token validation.
const audience = "cail:deploy";

function env(overrides: Partial<Env>): Env {
  return { AUTH_MODE: "cail-jwt", SERVICE_AUDIENCE: audience, ...overrides } as Env;
}

describe("CAIL identity boundary", () => {
  test("never maps an ownership subject into an operational subject", () => {
    expect(operationalLogSubject(TEST_SUBJECTS.alice)).toBeUndefined();
    expect(operationalLogSubject(TEST_SUBJECTS.alice, TEST_OPERATIONAL_SUBJECTS.alice)).toBe(
      TEST_OPERATIONAL_SUBJECTS.alice,
    );
    expect(() =>
      operationalLogSubject(TEST_SUBJECTS.alice, TEST_SUBJECTS.alice.replace(/^cail-/, "cail-v1-")),
    ).toThrow("distinct operational pseudonym");
  });

  test("refuses an issuer outside the allowlist as an operator error", async () => {
    // The configured issuer must belong to a code-owned allowlist. Deriving the
    // allowlist from the configured value made the check a tautology, so a bad
    // config push could point issuer and JWKS at an attacker pair and Deploy
    // would verify tokens minted by it.
    const rogue = await createTestIdentityIssuer({
      issuer: "https://attacker.example/sso",
    });
    const token = await rogue.mintIdentityJwt({
      audience,
      subject: TEST_SUBJECTS.alice,
    });
    await expect(
      authenticate(
        new Request("https://deploy.invalid", {
          headers: { "X-CAIL-Identity-JWT": token },
        }),
        env({ CAIL_IDENTITY_JWKS: rogue.jwksJson, CAIL_IDENTITY_ISSUER: rogue.issuer }),
      ),
    ).rejects.toMatchObject({ status: 503, code: "identity_not_configured" });
  });

  test("reports an unusable key set as unavailable rather than a bad credential", async () => {
    // 4.6.0 treats an empty or duplicate-`kid` key set as a token concern, so
    // every user saw 401 during a bad JWKS rotation while peer services
    // correctly reported 503. A caller cannot fix an operator error.
    const issuer = await createTestIdentityIssuer();
    const token = await issuer.mintIdentityJwt({
      audience,
      subject: TEST_SUBJECTS.alice,
    });
    for (const jwksJson of [
      JSON.stringify({ keys: [] }),
      JSON.stringify({
        keys: [
          ...(JSON.parse(issuer.jwksJson) as { keys: unknown[] }).keys,
          ...(JSON.parse(issuer.jwksJson) as { keys: unknown[] }).keys,
        ],
      }),
    ]) {
      await expect(
        authenticate(
          new Request("https://deploy.invalid", {
            headers: { "X-CAIL-Identity-JWT": token },
          }),
          env({ CAIL_IDENTITY_JWKS: jwksJson, CAIL_IDENTITY_ISSUER: issuer.issuer }),
        ),
      ).rejects.toMatchObject({ status: 503, code: "identity_not_configured" });
    }
  });

  test("reports a missing service audience as unavailable rather than a bad credential", async () => {
    const issuer = await createTestIdentityIssuer();
    const token = await issuer.mintIdentityJwt({
      audience,
      subject: TEST_SUBJECTS.alice,
    });
    await expect(
      authenticate(
        new Request("https://deploy.invalid", {
          headers: { "X-CAIL-Identity-JWT": token },
        }),
        env({
          CAIL_IDENTITY_JWKS: issuer.jwksJson,
          CAIL_IDENTITY_ISSUER: issuer.issuer,
          SERVICE_AUDIENCE: "",
        }),
      ),
    ).rejects.toMatchObject({ status: 503, code: "identity_not_configured" });
  });

  test("accepts one offline RS256 token at the exact issuer and audience", async () => {
    const issuer = await createTestIdentityIssuer();
    const token = await issuer.mintIdentityJwt({
      audience,
      subject: TEST_SUBJECTS.alice,
      operationalSubject: TEST_OPERATIONAL_SUBJECTS.alice,
    });
    const principal = await authenticate(
      new Request("https://deploy.invalid", { headers: { "X-CAIL-Identity-JWT": token } }),
      env({ CAIL_IDENTITY_JWKS: issuer.jwksJson, CAIL_IDENTITY_ISSUER: issuer.issuer }),
    );
    expect(principal).toEqual({
      subject: TEST_SUBJECTS.alice,
      operationalSubject: TEST_OPERATIONAL_SUBJECTS.alice,
      authentication: "cail-identity-jwt",
    });
  });

  test("does not invent an operational subject when the signed claim is absent", async () => {
    const issuer = await createTestIdentityIssuer();
    const token = await issuer.mintIdentityJwt({ audience, subject: TEST_SUBJECTS.alice });
    const principal = await authenticate(
      new Request("https://deploy.invalid", { headers: { "X-CAIL-Identity-JWT": token } }),
      env({ CAIL_IDENTITY_JWKS: issuer.jwksJson, CAIL_IDENTITY_ISSUER: issuer.issuer }),
    );
    expect(principal.operationalSubject).toBeUndefined();
  });

  test("rejects a malformed signed operational subject and ignores caller headers", async () => {
    const issuer = await createTestIdentityIssuer();
    const malformed = await issuer.mintIdentityJwt({
      audience,
      subject: TEST_SUBJECTS.alice,
      operationalSubject: "cail-v1-not-valid",
    });
    await expect(
      authenticate(
        new Request("https://deploy.invalid", {
          headers: { "X-CAIL-Identity-JWT": malformed },
        }),
        env({ CAIL_IDENTITY_JWKS: issuer.jwksJson, CAIL_IDENTITY_ISSUER: issuer.issuer }),
      ),
    ).rejects.toMatchObject({ code: "invalid_credential" });

    const token = await issuer.mintIdentityJwt({ audience, subject: TEST_SUBJECTS.alice });
    const principal = await authenticate(
      new Request("https://deploy.invalid", {
        headers: {
          "X-CAIL-Identity-JWT": token,
          "X-CAIL-Operational-Subject": TEST_OPERATIONAL_SUBJECTS.alice,
        },
      }),
      env({ CAIL_IDENTITY_JWKS: issuer.jwksJson, CAIL_IDENTITY_ISSUER: issuer.issuer }),
    );
    expect(principal.operationalSubject).toBeUndefined();
  });

  test("rejects wrong audience and credential ambiguity", async () => {
    const issuer = await createTestIdentityIssuer();
    const wrongAudience = await issuer.mintIdentityJwt({ audience: "https://other.invalid" });
    await expect(
      authenticate(
        new Request("https://deploy.invalid", {
          headers: { "X-CAIL-Identity-JWT": wrongAudience },
        }),
        env({ CAIL_IDENTITY_JWKS: issuer.jwksJson, CAIL_IDENTITY_ISSUER: issuer.issuer }),
      ),
    ).rejects.toMatchObject({ code: "invalid_credential" });
    const valid = await issuer.mintIdentityJwt({ audience });
    await expect(
      authenticate(
        new Request("https://deploy.invalid", {
          headers: { "X-CAIL-Identity-JWT": valid, Authorization: "Bearer key" },
        }),
        env({ CAIL_IDENTITY_JWKS: issuer.jwksJson, CAIL_IDENTITY_ISSUER: issuer.issuer }),
      ),
    ).rejects.toMatchObject({ code: "credential_ambiguity" });
  });

  test("serializes an async authentication rejection at the Worker boundary", async () => {
    const issuer = await createTestIdentityIssuer();
    const wrongAudience = await issuer.mintIdentityJwt({ audience: "https://other.invalid" });
    const requestId = "019f8bdc-342a-76e1-ba71-005d69808f86";
    const response = await workerHandler.fetch(
      new Request("https://deploy.invalid/v1/projects", {
        method: "POST",
        headers: {
          "X-CAIL-Identity-JWT": wrongAudience,
          "X-CAIL-Request-Id": requestId,
        },
      }),
      env({ CAIL_IDENTITY_JWKS: issuer.jwksJson, CAIL_IDENTITY_ISSUER: issuer.issuer }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_credential",
        message: "The CAIL identity JWT is invalid.",
        requestId,
      },
    });
  });
});
