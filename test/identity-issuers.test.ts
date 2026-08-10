import { beforeAll, describe, expect, test } from "bun:test";
import { CAIL_CANONICAL_ISSUER, loadIdentityVerifierConfig } from "@cuny-ai-lab/cail-identity";
import { createTestIdentityIssuer } from "@cuny-ai-lab/cail-identity/testing";
import { trustedIdentityIssuers } from "../src/identity-issuers";

// The allowlist is the authority passed to Identity 5.2.2's verifier-config
// loader.
const RUN_ISSUER = "https://run.identity.invalid/cail-sso";
const DEFAULTS = [CAIL_CANONICAL_ISSUER];
const AUDIENCE = "cail:deploy";
let jwks: string;

beforeAll(async () => {
  jwks = (await createTestIdentityIssuer({ issuer: RUN_ISSUER })).jwksJson;
});

describe("trustedIdentityIssuers", () => {
  test("locks a deployment to the canonical issuer when nothing is declared", () => {
    expect(trustedIdentityIssuers({})).toEqual(DEFAULTS);
  });

  // The point of the environment-scoped list: a practice deployment trusts its
  // own issuer INSTEAD OF production, not in addition to it.
  test("replaces the defaults rather than extending them", () => {
    const trusted = trustedIdentityIssuers({
      CAIL_TRUSTED_IDENTITY_ISSUER: RUN_ISSUER,
    });
    expect(trusted).toEqual([RUN_ISSUER]);
    expect(trusted).not.toContain(CAIL_CANONICAL_ISSUER);
  });

  test("rejects an issuer union", () => {
    expect(
      trustedIdentityIssuers({
        CAIL_TRUSTED_IDENTITY_ISSUER: `${CAIL_CANONICAL_ISSUER},${RUN_ISSUER}`,
      }),
    ).toEqual([]);
  });

  // Empty is not "unrestricted": the primitive rejects an empty list, so a
  // configuration mistake takes the service out of rotation instead of quietly
  // reverting to a different trust boundary than the operator wrote.
  test("fails closed on a malformed entry instead of falling back", () => {
    const malformed = [
      "http://run.identity.invalid/cail-sso",
      "https://user:pass@run.identity.invalid/cail-sso",
      "https://run.identity.invalid/cail-sso?tenant=other",
      "https://run.identity.invalid/cail-sso#fragment",
      "not-a-url",
      `${RUN_ISSUER},`,
      `${RUN_ISSUER},not-a-url`,
    ];
    for (const value of malformed) {
      expect(trustedIdentityIssuers({ CAIL_TRUSTED_IDENTITY_ISSUER: value })).toEqual([]);
    }
  });

  test("withdraws all trust when the declaration is present but empty", () => {
    // Absence and emptiness are different statements. A template that renders a
    // missing value as "" must not silently restore the production issuers, and
    // an operator clearing the variable is withdrawing trust, not defaulting.
    for (const value of ["", "   "]) {
      expect(trustedIdentityIssuers({ CAIL_TRUSTED_IDENTITY_ISSUER: value })).toEqual([]);
    }
  });

  test("accepts exactly what the verifier primitive accepts", () => {
    // The primitive's rule is `parsed.href === value`. Inventing a stricter one
    // rejected a path-bearing issuer OIDC permits, and accepted an origin the
    // primitive refuses — a gate disagreeing with the thing it guards.
    expect(
      trustedIdentityIssuers({
        CAIL_TRUSTED_IDENTITY_ISSUER: "https://issuer.example/tenant/",
      }),
    ).toEqual(["https://issuer.example/tenant/"]);
    expect(
      trustedIdentityIssuers({
        CAIL_TRUSTED_IDENTITY_ISSUER: "https://issuer.example",
      }),
    ).toEqual([]);
  });

});

describe("the primitive honours the list this produces", () => {
  const load = (trusted: readonly string[], issuer: string) =>
    loadIdentityVerifierConfig({
      jwks,
      issuer,
      expectedAudience: AUDIENCE,
      supportedIssuers: trusted,
    });

  test("loads when the configured issuer is declared trusted", async () => {
    const declared = trustedIdentityIssuers({
      CAIL_TRUSTED_IDENTITY_ISSUER: RUN_ISSUER,
    });
    expect((await load(declared, RUN_ISSUER)).ok).toBe(true);
  });

  test("refuses the canonical issuer on a deployment scoped to the run", async () => {
    const declared = trustedIdentityIssuers({
      CAIL_TRUSTED_IDENTITY_ISSUER: RUN_ISSUER,
    });
    await expect(load(declared, CAIL_CANONICAL_ISSUER)).resolves.toMatchObject({
      ok: false,
      reason: "issuer_unsupported",
    });
  });

  test("refuses the run issuer when nothing is declared", async () => {
    await expect(load(trustedIdentityIssuers({}), RUN_ISSUER)).resolves.toMatchObject({
      ok: false,
      reason: "issuer_unsupported",
    });
  });

  test("refuses everything when the declaration is malformed", async () => {
    const declared = trustedIdentityIssuers({
      CAIL_TRUSTED_IDENTITY_ISSUER: "not-a-url",
    });
    expect(declared).toEqual([]);
    await expect(load(declared, RUN_ISSUER)).resolves.toMatchObject({
      ok: false,
      reason: "issuer_unsupported",
    });
  });
});
