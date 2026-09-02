import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { handleApiForPrincipal } from "../src/api";
import type { Principal } from "../src/auth";
import { sha256Hex } from "../src/domain/digests";
import type { Env } from "../src/env";

const ownerSubject = `cail-${"a".repeat(32)}`;
const otherSubject = `cail-${"b".repeat(32)}`;
const projectId = `prj_${"c".repeat(32)}`;
const digest = "d".repeat(64);
const revisionId = `rev_sha256_${digest}`;
const artifactKey = `revisions/${projectId}/${revisionId}.json`;
const createdAt = "2026-08-02T00:00:00.000Z";

const owner: Principal = {
  subject: ownerSubject,
  authentication: "cail-identity-jwt",
};
const other: Principal = {
  subject: otherSubject,
  authentication: "cail-identity-jwt",
};

class SqliteD1 {
  constructor(readonly sqlite: Database) {}

  prepare(query: string) {
    const sqlite = this.sqlite;
    return {
      bind(...values: unknown[]) {
        return {
          async first<T>() {
            // SAFETY: SQLite returns the row shape requested by each test
            // query; the generic caller owns that row contract.
            return (sqlite.prepare(query).get(...values) as T | null) ?? null;
          },
          async run() {
            const result = sqlite.prepare(query).run(...values);
            return { success: true, meta: { changes: result.changes }, results: [] };
          },
        };
      },
    };
  }
}

interface RevisionHeadOverrides {
  key?: string;
  size?: number;
  checksums?: { sha256?: ArrayBuffer };
  customMetadata?: Record<string, string>;
}

function checksumBytes(hex: string): ArrayBuffer {
  const bytes = Uint8Array.from(hex.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
  return bytes.buffer;
}

function revisionHead(overrides: RevisionHeadOverrides = {}): R2Object {
  // SAFETY: the fixture supplies the R2 metadata accessed by revision lookup;
  // methods not used by this boundary are intentionally absent.
  return {
    key: artifactKey,
    size: 321,
    checksums: { sha256: checksumBytes(digest) },
    customMetadata: { projectId, revisionId, artifactDigest: digest },
    ...overrides,
  } as R2Object;
}

async function fixture(
  input: {
    head?: R2Object | null;
    status?: "ready" | "failed";
    artifactKey?: string;
    artifactDigest?: string;
  } = {},
): Promise<{ env: Env; sqlite: Database; headCalls: string[] }> {
  const sqlite = new Database(":memory:");
  sqlite.exec(await Bun.file(new URL("../schema/0001_control_plane.sql", import.meta.url)).text());
  sqlite.run("INSERT INTO projects VALUES (?, ?, ?, ?)", [
    projectId,
    ownerSubject,
    "Owned project",
    createdAt,
  ]);
  sqlite.run("INSERT INTO revisions VALUES (?, ?, ?, ?, ?, ?, ?)", [
    projectId,
    revisionId,
    input.artifactDigest ?? digest,
    321,
    input.artifactKey ?? artifactKey,
    input.status ?? "ready",
    createdAt,
  ]);
  const headCalls: string[] = [];
  // SAFETY: this fixture implements the DB and R2 seams consumed by lookup.
  const env = {
    DB: new SqliteD1(sqlite),
    ARTIFACTS: {
      async head(key: string) {
        headCalls.push(key);
        return input.head === undefined ? revisionHead() : input.head;
      },
    },
  } as Env;
  return { env, sqlite, headCalls };
}

function lookupRequest(): Request {
  return new Request(`https://deploy.test/v1/projects/${projectId}/revisions/${revisionId}`);
}

describe("immutable revision lookup", () => {
  test("returns only owner-scoped ready revision metadata after exact R2 verification", async () => {
    const { env, headCalls } = await fixture();

    const response = await handleApiForPrincipal(lookupRequest(), env, owner);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      projectId,
      revisionId,
      artifactDigest: digest,
      artifactBytes: 321,
      status: "ready",
      createdAt,
    });
    expect(headCalls).toEqual([artifactKey]);
  });

  test("conceals both absent and cross-owner revisions behind the same generic 404", async () => {
    const { env, sqlite, headCalls } = await fixture();

    await expect(handleApiForPrincipal(lookupRequest(), env, other)).rejects.toMatchObject({
      status: 404,
      code: "revision_not_found",
      message: "The revision was not found.",
    });
    sqlite.run("DELETE FROM revisions");
    await expect(handleApiForPrincipal(lookupRequest(), env, owner)).rejects.toMatchObject({
      status: 404,
      code: "revision_not_found",
      message: "The revision was not found.",
    });
    expect(headCalls).toEqual([]);
  });

  const inconsistencies: Array<[string, Parameters<typeof fixture>[0]]> = [
    ["missing artifact", { head: null }],
    ["non-ready row", { status: "failed" }],
    [
      "wrong SHA-256 checksum",
      { head: revisionHead({ checksums: { sha256: checksumBytes("e".repeat(64)) } }) },
    ],
  ];

  for (const [name, input] of inconsistencies) {
    test(`returns an indeterminate 409 for ${name}`, async () => {
      const { env } = await fixture(input);

      await expect(handleApiForPrincipal(lookupRequest(), env, owner)).rejects.toMatchObject({
        status: 409,
        code: "artifact_store_inconsistent",
      });
    });
  }

  test("concurrent exact uploads converge on one row and truthful 201/200 responses", async () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(
      await Bun.file(new URL("../schema/0001_control_plane.sql", import.meta.url)).text(),
    );
    sqlite.run("INSERT INTO projects VALUES (?, ?, ?, ?)", [
      projectId,
      ownerSubject,
      "Owned project",
      createdAt,
    ]);
    const bytes = new Uint8Array(
      await Bun.file(new URL("../fixtures/worker-artifact.v1.json", import.meta.url)).arrayBuffer(),
    );
    const uploadDigest = await sha256Hex(bytes);
    const uploadRevisionId = `rev_sha256_${uploadDigest}`;
    const uploadKey = `revisions/${projectId}/${uploadRevisionId}.json`;
    const checksum = checksumBytes(uploadDigest);
    let putCalls = 0;
    let releasePuts: (() => void) | undefined;
    const bothPutsStarted = new Promise<void>((resolve) => {
      releasePuts = resolve;
    });
    let storedHead: R2Object | null = null;
    // SAFETY: this fixture implements the DB and concurrent R2 put/head seams
    // used by the upload idempotency test.
    const env = {
      DB: new SqliteD1(sqlite),
      ARTIFACTS: {
        async put(key: string, value: ArrayBuffer | ArrayBufferView, options: R2PutOptions) {
          putCalls += 1;
          if (putCalls === 2) releasePuts?.();
          await bothPutsStarted;
          storedHead = revisionHead({
            key,
            size: value.byteLength,
            checksums: { sha256: checksum },
            customMetadata: options.customMetadata,
          });
          return storedHead;
        },
        async head(key: string) {
          return storedHead?.key === key ? storedHead : null;
        },
      },
    } as Env;
    const digestHeader = `sha-256=:${btoa(String.fromCharCode(...new Uint8Array(checksum)))}:`;
    const uploadRequest = () =>
      new Request(`https://deploy.test/v1/projects/${projectId}/revisions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.cuny.kale.artifact.v1+json",
          "Content-Digest": digestHeader,
        },
        body: bytes.slice(),
      });

    const responses = await Promise.all([
      handleApiForPrincipal(uploadRequest(), env, owner),
      handleApiForPrincipal(uploadRequest(), env, owner),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    for (const response of responses) {
      expect(await response.json()).toMatchObject({
        projectId,
        revisionId: uploadRevisionId,
        artifactDigest: uploadDigest,
        artifactBytes: bytes.byteLength,
        status: "ready",
      });
    }
    expect(putCalls).toBe(2);
    expect(
      sqlite
        .query("SELECT COUNT(*) AS count FROM revisions WHERE project_id = ? AND revision_id = ?")
        .get(projectId, uploadRevisionId),
    ).toEqual({ count: 1 });
    expect(storedHead?.key).toBe(uploadKey);
  });
});
