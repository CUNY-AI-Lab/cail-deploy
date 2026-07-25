import { describe, expect, test } from "bun:test";
import {
  CAIL_CANONICAL_ISSUER,
  CAIL_STAGING_ISSUER,
  parseIdentityConfig,
} from "@cuny-ai-lab/cail-identity";
import { trustedIdentityIssuers } from "../src/identity-issuers";

// Deploy is pinned to the reviewed historical Identity 4.6.0, whose config
// boundary is the synchronous `parseIdentityConfig`. The allowlist semantics
// exercised here are the same ones the Identity 5 consumers rely on.
const RUN_ISSUER = "https://ki-20260722223510-ecade68e.identity.invalid/cail-sso";
const DEFAULTS = [CAIL_CANONICAL_ISSUER, CAIL_STAGING_ISSUER];
const JWKS = JSON.stringify({ keys: [] });

describe("trustedIdentityIssuers", () => {
  test("locks a deployment to the canonical issuers when nothing is declared", () => {
    expect(trustedIdentityIssuers({})).toEqual(DEFAULTS);
    expect(trustedIdentityIssuers({ CAIL_TRUSTED_IDENTITY_ISSUERS: "   " })).toEqual(DEFAULTS);
  });

  // The point of the environment-scoped list: a practice deployment trusts its
  // own issuer INSTEAD OF production, not in addition to it.
  test("replaces the defaults rather than extending them", () => {
    const trusted = trustedIdentityIssuers({
      CAIL_TRUSTED_IDENTITY_ISSUERS: RUN_ISSUER,
    });
    expect(trusted).toEqual([RUN_ISSUER]);
    expect(trusted).not.toContain(CAIL_CANONICAL_ISSUER);
    expect(trusted).not.toContain(CAIL_STAGING_ISSUER);
  });

  test("accepts several issuers and tolerates surrounding whitespace", () => {
    expect(
      trustedIdentityIssuers({
        CAIL_TRUSTED_IDENTITY_ISSUERS: ` ${CAIL_CANONICAL_ISSUER} , ${RUN_ISSUER} `,
      }),
    ).toEqual([CAIL_CANONICAL_ISSUER, RUN_ISSUER]);
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
      "https://run.identity.invalid/cail-sso/",
      "not-a-url",
      `${RUN_ISSUER},`,
      `${RUN_ISSUER},not-a-url`,
    ];
    for (const value of malformed) {
      expect(trustedIdentityIssuers({ CAIL_TRUSTED_IDENTITY_ISSUERS: value })).toEqual([]);
    }
  });

  test("fails closed on a repeated issuer", () => {
    expect(
      trustedIdentityIssuers({
        CAIL_TRUSTED_IDENTITY_ISSUERS: `${RUN_ISSUER},${RUN_ISSUER}`,
      }),
    ).toEqual([]);
  });
});

describe("the primitive honours the list this produces", () => {
  const load = (trusted: readonly string[], issuer: string) =>
    parseIdentityConfig({ jwks: JWKS, issuer, supportedIssuers: trusted });

  test("parses when the configured issuer is declared trusted", () => {
    const declared = trustedIdentityIssuers({
      CAIL_TRUSTED_IDENTITY_ISSUERS: RUN_ISSUER,
    });
    expect(load(declared, RUN_ISSUER).ok).toBe(true);
  });

  test("refuses the canonical issuer on a deployment scoped to the run", () => {
    const declared = trustedIdentityIssuers({
      CAIL_TRUSTED_IDENTITY_ISSUERS: RUN_ISSUER,
    });
    expect(load(declared, CAIL_CANONICAL_ISSUER)).toMatchObject({
      ok: false,
      reason: "issuer_unsupported",
    });
  });

  test("refuses the run issuer when nothing is declared", () => {
    expect(load(trustedIdentityIssuers({}), RUN_ISSUER)).toMatchObject({
      ok: false,
      reason: "issuer_unsupported",
    });
  });

  test("refuses everything when the declaration is malformed", () => {
    const declared = trustedIdentityIssuers({
      CAIL_TRUSTED_IDENTITY_ISSUERS: "not-a-url",
    });
    expect(declared).toEqual([]);
    expect(load(declared, RUN_ISSUER)).toMatchObject({
      ok: false,
      reason: "issuer_unsupported",
    });
  });
});
