import { describe, expect, test } from "bun:test";
import { artifactSchema, REVISION_PATTERN, releaseStatuses } from "../src/domain/contracts";
import { bytesToHex, parseContentDigest, sha256Hex } from "../src/domain/digests";

const fixturePath = new URL("../fixtures/worker-artifact.v1.json", import.meta.url);

describe("immutable artifact contract", () => {
  test("golden bytes have the frozen digest and revision id", async () => {
    const bytes = await Bun.file(fixturePath).arrayBuffer();
    expect(bytes.byteLength).toBe(253);
    const digest = await sha256Hex(bytes);
    expect(digest).toBe("fb711fd92301a9ef5aae345cc3da06408e7d291b8e0cdff1d4434c216e459e82");
    expect(`rev_sha256_${digest}`).toMatch(REVISION_PATTERN);
    expect(artifactSchema.parse(JSON.parse(new TextDecoder().decode(bytes))).runtime).toBe(
      "worker",
    );
  });

  test("Content-Digest is the RFC structured SHA-256 form", () => {
    const parsed = parseContentDigest("sha-256=:+3Ef2SMBqe9arjRcw9oGQI59KRuODN/x1ENMIW5FnoI=:");
    expect(parsed).not.toBeNull();
    expect(bytesToHex(parsed as Uint8Array)).toBe(
      "fb711fd92301a9ef5aae345cc3da06408e7d291b8e0cdff1d4434c216e459e82",
    );
    expect(parseContentDigest("sha256=fb711f")).toBeNull();
  });

  test("unsafe paths and missing entrypoints fail", async () => {
    const base = JSON.parse(await Bun.file(fixturePath).text()) as Record<string, unknown>;
    expect(
      artifactSchema.safeParse({ ...base, entrypoint: "../secret", files: { "../secret": "x" } })
        .success,
    ).toBe(false);
    expect(artifactSchema.safeParse({ ...base, entrypoint: "missing.ts" }).success).toBe(false);
  });

  test("release progress freezes prepared before approval", () => {
    expect(releaseStatuses).toEqual([
      "queued",
      "validating",
      "building",
      "prepared",
      "awaiting_approval",
      "publishing",
      "reconciling",
      "live",
      "rejected",
      "failed",
    ]);
  });

  test("machine-readable schemas freeze the artifact fields and release enum", async () => {
    const artifactContract = JSON.parse(
      await Bun.file(new URL("../contract/artifact-v1.schema.json", import.meta.url)).text(),
    ) as { required: string[] };
    expect(artifactContract.required).toEqual([
      "schemaVersion",
      "runtime",
      "entrypoint",
      "files",
      "compatibility",
      "requestedBindings",
    ]);
    const releaseContract = JSON.parse(
      await Bun.file(new URL("../contract/release-v1.schema.json", import.meta.url)).text(),
    ) as { $defs: { releaseStatus: { enum: string[] } } };
    expect(releaseContract.$defs.releaseStatus.enum).toEqual([...releaseStatuses]);
  });

  test("machine-readable OAuth MCP contract freezes the public surface", async () => {
    const contract = JSON.parse(
      await Bun.file(new URL("../contract/oauth-mcp-v1.json", import.meta.url)).text(),
    ) as {
      provider: { version: string; sourceRevision: string; npmTarballSha256: string };
      routes: Record<string, string>;
      authorization: {
        scope: string;
        pkceMethods: string[];
        accessTokenTtlSeconds: number;
        implicitFlow: boolean;
        tokenExchangeGrant: boolean;
        clientIdMetadataDocument: boolean;
      };
      identity: { audience: string; principalProps: string[] };
    };
    expect(contract.provider).toEqual({
      package: "@cloudflare/workers-oauth-provider",
      version: "0.5.0",
      sourceRevision: "b4bc502c3421f2bc8a61760fb84790f09d0fa529",
      npmTarballSha256: "097c5955e8eb6092575a008d9e3b960fc945b48c8fb26ae252bedd9482bdce11",
    });
    expect(contract.routes).toEqual({
      protectedResourceMetadata: "/.well-known/oauth-protected-resource/mcp",
      authorizationServerMetadata: "/.well-known/oauth-authorization-server",
      register: "/oauth/register",
      authorize: "/api/oauth/authorize",
      token: "/oauth/token",
      resource: "/mcp",
    });
    expect(contract.authorization).toMatchObject({
      scope: "cail:deploy",
      pkceMethods: ["S256"],
      accessTokenTtlSeconds: 3600,
      implicitFlow: false,
      tokenExchangeGrant: false,
      clientIdMetadataDocument: false,
    });
    expect(contract.identity).toEqual({
      authorizationCredential: "X-CAIL-Identity-JWT",
      audience: "cail:deploy",
      principalProps: ["subject", "operationalSubject", "scope"],
      ownershipField: "subject",
      optionalOperationalField: "operationalSubject",
    });
  });
});
