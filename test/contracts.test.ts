import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { artifactSchema, REVISION_PATTERN, releaseStatuses } from "../src/domain/contracts";
import { bytesToHex, parseContentDigest, sha256Hex } from "../src/domain/digests";

const fixturePath = new URL("../fixtures/worker-artifact.v1.json", import.meta.url);

describe("immutable artifact contract", () => {
  test("loaded bytes have a valid digest and revision id", async () => {
    const bytes = new Uint8Array(await Bun.file(fixturePath).arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(0);
    const digest = await sha256Hex(bytes);
    expect(`rev_sha256_${digest}`).toMatch(REVISION_PATTERN);
    expect(artifactSchema.parse(JSON.parse(new TextDecoder().decode(bytes))).runtime).toBe(
      "worker",
    );
  });

  test("Content-Digest is the RFC structured SHA-256 form", async () => {
    const bytes = new Uint8Array(await Bun.file(fixturePath).arrayBuffer());
    const digestBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const parsed = parseContentDigest(`sha-256=:${Buffer.from(digestBytes).toString("base64")}:`);
    expect(parsed).not.toBeNull();
    expect(bytesToHex(parsed as Uint8Array)).toBe(await sha256Hex(bytes));
    expect(parseContentDigest("sha256=fb711f")).toBeNull();
  });

  test("unsafe paths and missing entrypoints fail", async () => {
    const base = JSON.parse(await Bun.file(fixturePath).text()) as Record<string, unknown>;
    expect(
      artifactSchema.safeParse({ ...base, entrypoint: "../secret", files: { "../secret": "x" } })
        .success,
    ).toBe(false);
    expect(artifactSchema.safeParse({ ...base, entrypoint: "missing.ts" }).success).toBe(false);
    expect(
      artifactSchema.safeParse({
        ...base,
        entrypoint: "toString",
        files: { "src/index.ts": "export default {}" },
      }).success,
    ).toBe(false);
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
      provider: { version: string };
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
