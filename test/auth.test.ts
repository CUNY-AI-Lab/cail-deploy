import { describe, expect, test } from "bun:test";
import {
  createTestIdentityIssuer,
  TEST_OPERATIONAL_SUBJECTS,
  TEST_SUBJECTS,
} from "@cuny-ai-lab/cail-identity/testing";
import { authenticate } from "../src/auth";
import type { Env } from "../src/env";
import { operationalLogSubject } from "../src/operational-events";

const audience = "https://deploy.integration.invalid";

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

  test("accepts one offline RS256 token at the exact issuer and audience", async () => {
    const issuer = await createTestIdentityIssuer({
      issuer: "https://identity.integration.invalid",
    });
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
    const issuer = await createTestIdentityIssuer({
      issuer: "https://identity.integration.invalid",
    });
    const token = await issuer.mintIdentityJwt({ audience, subject: TEST_SUBJECTS.alice });
    const principal = await authenticate(
      new Request("https://deploy.invalid", { headers: { "X-CAIL-Identity-JWT": token } }),
      env({ CAIL_IDENTITY_JWKS: issuer.jwksJson, CAIL_IDENTITY_ISSUER: issuer.issuer }),
    );
    expect(principal.operationalSubject).toBeUndefined();
  });

  test("rejects a malformed signed operational subject and ignores caller headers", async () => {
    const issuer = await createTestIdentityIssuer({
      issuer: "https://identity.integration.invalid",
    });
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
    const issuer = await createTestIdentityIssuer({
      issuer: "https://identity.integration.invalid",
    });
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
});
