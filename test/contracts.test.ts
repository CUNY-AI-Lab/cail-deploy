import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { z } from "zod";
import { artifactSchema, createReleaseSchema } from "../src/domain/contracts";
import { bytesToHex, canonicalJson, parseContentDigest, sha256Hex } from "../src/domain/digests";
import type { JsonObject } from "../src/domain/json";
import { NONTERMINAL_RELEASE_STATUSES, TERMINAL_RELEASE_STATUSES } from "../src/storage";

const fixturePath = new URL("../fixtures/worker-artifact.v1.json", import.meta.url);

describe("immutable artifact contract", () => {
  test("loaded bytes have a valid digest and revision id", async () => {
    const bytes = new Uint8Array(await Bun.file(fixturePath).arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(0);
    const digest = await sha256Hex(bytes);
    expect(
      createReleaseSchema.safeParse({
        revisionId: `rev_sha256_${digest}`,
        approval: "automatic",
      }).success,
    ).toBe(true);
    expect(artifactSchema.parse(JSON.parse(new TextDecoder().decode(bytes))).runtime).toBe(
      "worker",
    );
  });

  test("Content-Digest is the RFC structured SHA-256 form", async () => {
    const bytes = new Uint8Array(await Bun.file(fixturePath).arrayBuffer());
    const digestBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const parsed = parseContentDigest(`sha-256=:${Buffer.from(digestBytes).toString("base64")}:`);
    expect(parsed).not.toBeNull();
    if (parsed === null) throw new Error("expected a valid SHA-256 content digest");
    expect(bytesToHex(parsed)).toBe(await sha256Hex(bytes));
    expect(parseContentDigest("sha256=fb711f")).toBeNull();
  });

  test("canonical JSON gives null-prototype records the same digest as ordinary records", async () => {
    const ordinary = {
      nested: { z: "last", a: "first" },
      z: 3,
      a: 1,
    };
    Object.defineProperty(ordinary.nested, "__proto__", {
      value: { keep: true },
      enumerable: true,
    });
    // SAFETY: this fixture deliberately models a JSON object parsed into a
    // null-prototype record; every value remains within the JsonObject contract.
    const nestedNullPrototype = Object.assign(Object.create(null), { a: "first", z: "last" });
    Object.defineProperty(nestedNullPrototype, "__proto__", {
      value: { keep: true },
      enumerable: true,
    });
    const nullPrototype: JsonObject = Object.assign(Object.create(null), {
      z: 3,
      nested: nestedNullPrototype,
      a: 1,
    });
    const ordinaryJson = canonicalJson(ordinary);
    const nullPrototypeJson = canonicalJson(nullPrototype);
    expect(nullPrototypeJson).toContain('"__proto__":{"keep":true}');
    expect(nullPrototypeJson).toBe(ordinaryJson);
    expect(await sha256Hex(nullPrototypeJson)).toBe(await sha256Hex(ordinaryJson));
  });

  test("unsafe paths and missing entrypoints fail", async () => {
    const base = artifactSchema.parse(JSON.parse(await Bun.file(fixturePath).text()));
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

  test("required artifact fields are not filled in by runtime defaults", async () => {
    const base = artifactSchema.parse(JSON.parse(await Bun.file(fixturePath).text()));
    const compatibility = { ...base.compatibility };
    expect(
      artifactSchema.safeParse({
        ...base,
        compatibility: { ...compatibility, flags: undefined },
      }).success,
    ).toBe(false);
    const { flags: _flags, ...withoutFlags } = compatibility;
    expect(artifactSchema.safeParse({ ...base, compatibility: withoutFlags }).success).toBe(false);
    expect(
      artifactSchema.safeParse({
        ...base,
        requestedBindings: undefined,
      }).success,
    ).toBe(false);
    const { requestedBindings: _requestedBindings, ...withoutBindings } = base;
    expect(artifactSchema.safeParse(withoutBindings).success).toBe(false);
  });

  test("machine-readable schemas freeze the artifact fields and release enum", async () => {
    const releaseContract = z
      .object({
        $defs: z.object({ releaseStatus: z.object({ enum: z.array(z.string()) }) }),
      })
      .passthrough()
      .parse(
        JSON.parse(
          await Bun.file(new URL("../contract/release-v1.schema.json", import.meta.url)).text(),
        ),
      );
    expect(releaseContract.$defs.releaseStatus.enum).toEqual([
      ...NONTERMINAL_RELEASE_STATUSES,
      ...TERMINAL_RELEASE_STATUSES,
    ]);
  });
});
