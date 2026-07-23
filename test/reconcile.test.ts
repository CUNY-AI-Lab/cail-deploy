import { Database } from "bun:sqlite";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { handleApiForPrincipal } from "../src/api";
import type { Principal } from "../src/auth";
import { canonicalJson, sha256Hex } from "../src/domain/digests";
import type { Env } from "../src/env";

const subject = `cail-${"a".repeat(32)}`;
const projectId = `prj_${"b".repeat(32)}`;
const revisionId = `rev_sha256_${"c".repeat(64)}`;
const releaseId = "rel_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa";
const requestId = "11111111-1111-4111-8111-111111111111";
const preparedKey = `prepared/${projectId}/${releaseId}/worker.json`;
const originalFetch = globalThis.fetch;

const principal: Principal = {
  subject,
  authentication: "cail-identity-jwt",
};

class SqliteD1 {
  constructor(readonly sqlite: Database) {}

  prepare(query: string) {
    const sqlite = this.sqlite;
    return {
      bind(...values: unknown[]) {
        return {
          query,
          values,
          async first<T>() {
            return (sqlite.prepare(query).get(...values) as T | null) ?? null;
          },
          async run() {
            const result = sqlite.prepare(query).run(...values);
            return { success: true, meta: { changes: result.changes }, results: [] };
          },
          async all<T>() {
            return {
              success: true,
              meta: { changes: 0 },
              results: sqlite.prepare(query).all(...values) as T[],
            };
          },
        };
      },
    };
  }

  async batch(
    statements: Array<{ query: string; values: unknown[] }>,
  ): Promise<Array<{ success: true; meta: { changes: number }; results: [] }>> {
    return this.sqlite.transaction(() =>
      statements.map(({ query, values }) => {
        const result = this.sqlite.prepare(query).run(...values);
        return { success: true as const, meta: { changes: result.changes }, results: [] as [] };
      }),
    )();
  }
}

async function fixture(status: "publishing" | "reconciling") {
  const sqlite = new Database(":memory:");
  sqlite.exec(await Bun.file(new URL("../schema/0001_control_plane.sql", import.meta.url)).text());
  const now = "2026-07-23T00:00:00.000Z";
  const prepared = canonicalJson({
    schemaVersion: "kale.prepared-worker.v1",
    projectId,
    releaseId,
    revisionId,
    mainModule: "index.js",
    modules: { "index.js": "export default {}" },
    compatibilityDate: "2026-07-22",
    compatibilityFlags: [],
  });
  const preparedDigest = await sha256Hex(prepared);
  sqlite.run("INSERT INTO projects VALUES (?, ?, ?, ?)", [projectId, subject, "test", now]);
  sqlite.run("INSERT INTO revisions VALUES (?, ?, ?, ?, ?, ?, ?)", [
    projectId,
    revisionId,
    "c".repeat(64),
    1,
    "revision-key",
    "ready",
    now,
  ]);
  sqlite.run(
    `INSERT INTO releases
      (release_id, project_id, revision_id, target, approval, status, workflow_instance_id,
       prepared_key, prepared_digest, operational_subject, request_id, admitted_at, created_at,
       updated_at)
     VALUES (?, ?, ?, 'preview', 'required', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      releaseId,
      projectId,
      revisionId,
      status,
      releaseId,
      preparedKey,
      preparedDigest,
      `cail-v1-${"e".repeat(32)}`,
      "22222222-2222-4222-8222-222222222222",
      now,
      now,
      now,
    ],
  );
  const db = new SqliteD1(sqlite);
  const env = {
    DB: db,
    ARTIFACTS: {
      get: async (key: string) => (key === preparedKey ? { text: async () => prepared } : null),
    },
    AUTH_MODE: "test",
    SERVICE_RELEASE: "e332fcc",
    CLOUDFLARE_API_TOKEN: "test-only",
    WFP_ACCOUNT_ID: "account",
    WFP_NAMESPACE: "namespace",
    WFP_PUBLISH_TIMEOUT_MS: "1000",
    RUN_ID: "ki-20260722123456-abcdef12",
  } as unknown as Env;
  return { db, env, preparedDigest };
}

function reconcileRequest(): Request {
  return new Request(
    `https://deploy.test/v1/projects/${projectId}/releases/${releaseId}/reconcile`,
    { method: "POST" },
  );
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("release reconciliation authority", () => {
  for (const status of ["publishing", "reconciling"] as const) {
    test(`recovers retained prepared bytes from ${status} and replays without republishing`, async () => {
      const { db, env } = await fixture(status);
      globalThis.fetch = mock(async () => new Response(null, { status: 200 })) as typeof fetch;

      const first = await handleApiForPrincipal(reconcileRequest(), env, principal, requestId);
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({
        releaseId,
        status: "live",
        publicationName: "kp-ki-20260722123456-abcdef12-bbbbbbbbbbbb",
      });
      const replay = await handleApiForPrincipal(
        reconcileRequest(),
        env,
        principal,
        "33333333-3333-4333-8333-333333333333",
      );
      expect(replay.status).toBe(200);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(
        db.sqlite
          .query("SELECT type, detail_json FROM release_events WHERE release_id = ?")
          .all(releaseId),
      ).toEqual([
        {
          type: "release.live",
          detail_json: JSON.stringify({
            publicationName: "kp-ki-20260722123456-abcdef12-bbbbbbbbbbbb",
            reconciled: true,
            requestId,
          }),
        },
      ]);
    });
  }

  test("permits only one concurrent provider action", async () => {
    const { env } = await fixture("reconciling");
    let unblock: (() => void) | undefined;
    globalThis.fetch = mock(
      async () =>
        new Promise<Response>((resolve) => {
          unblock = () => resolve(new Response(null, { status: 200 }));
        }),
    ) as typeof fetch;

    const first = handleApiForPrincipal(reconcileRequest(), env, principal, requestId);
    for (let attempt = 0; attempt < 100 && !unblock; attempt += 1) {
      await Bun.sleep(1);
    }
    expect(unblock).toBeDefined();
    await expect(
      handleApiForPrincipal(
        reconcileRequest(),
        env,
        principal,
        "33333333-3333-4333-8333-333333333333",
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "release_reconciliation_in_progress",
    });
    unblock();
    expect((await first).status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  test("preserves publication failure cause and permits one later deterministic retry", async () => {
    const { env } = await fixture("publishing");
    const providerFailure = new Error("PRIVATE_PROVIDER_FAILURE");
    globalThis.fetch = mock(async () => {
      throw providerFailure;
    }) as typeof fetch;
    let captured: unknown;
    try {
      await handleApiForPrincipal(reconcileRequest(), env, principal, requestId);
    } catch (error) {
      captured = error;
    }
    expect(captured).toMatchObject({
      status: 502,
      code: "publication_ambiguous",
      cause: providerFailure,
    });

    globalThis.fetch = mock(async () => new Response(null, { status: 200 })) as typeof fetch;
    const retry = await handleApiForPrincipal(
      reconcileRequest(),
      env,
      principal,
      "33333333-3333-4333-8333-333333333333",
    );
    expect(retry.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  test("claim cleanup and a hostile diagnostic sink cannot replace publication failure", async () => {
    const { env } = await fixture("publishing");
    const providerFailure = new Error("PRIVATE_PROVIDER_FAILURE");
    globalThis.fetch = mock(async () => {
      throw providerFailure;
    }) as typeof fetch;
    const db = env.DB as unknown as SqliteD1;
    const originalPrepare = db.prepare.bind(db);
    db.prepare = ((query: string) => {
      const prepared = originalPrepare(query);
      return {
        bind: (...values: unknown[]) => {
          const statement = prepared.bind(...values);
          if (
            query.includes("UPDATE idempotency SET response_json") &&
            values[0] === JSON.stringify({ state: "retryable" })
          ) {
            return {
              ...statement,
              run: async () => {
                throw new Error("PRIVATE_CLAIM_CLEANUP_FAILURE");
              },
            };
          }
          return statement;
        },
      };
    }) as typeof db.prepare;
    const originalConsoleError = console.error;
    console.error = () => {
      throw new Error("PRIVATE_DIAGNOSTIC_SINK_FAILURE");
    };

    let captured: unknown;
    try {
      await handleApiForPrincipal(reconcileRequest(), env, principal, requestId);
    } catch (error) {
      captured = error;
    } finally {
      console.error = originalConsoleError;
    }
    expect(captured).toMatchObject({
      status: 502,
      code: "publication_ambiguous",
      cause: providerFailure,
    });
  });

  test("does not overwrite or fabricate live after a terminal race", async () => {
    const { db, env } = await fixture("reconciling");
    globalThis.fetch = mock(async () => {
      const now = "2026-07-23T00:00:01.000Z";
      db.sqlite.run("INSERT INTO release_events VALUES (?, 1, 'release.failed', ?, NULL, '{}')", [
        releaseId,
        now,
      ]);
      db.sqlite.run("UPDATE releases SET status = 'failed', updated_at = ? WHERE release_id = ?", [
        now,
        releaseId,
      ]);
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    await expect(
      handleApiForPrincipal(reconcileRequest(), env, principal, requestId),
    ).rejects.toMatchObject({
      status: 409,
      code: "release_reconciliation_raced",
    });
    expect(
      db.sqlite
        .query("SELECT status, publication_name FROM releases WHERE release_id = ?")
        .get(releaseId),
    ).toEqual({ status: "failed", publication_name: null });
    expect(
      db.sqlite.query("SELECT type FROM release_events WHERE release_id = ?").all(releaseId),
    ).toEqual([{ type: "release.failed" }]);
  });

  test("rejects incompatible and terminal states before provider action", async () => {
    const { db, env } = await fixture("publishing");
    db.sqlite.run("UPDATE releases SET status = 'live' WHERE release_id = ?", [releaseId]);
    globalThis.fetch = mock(async () => new Response(null, { status: 200 })) as typeof fetch;

    await expect(
      handleApiForPrincipal(reconcileRequest(), env, principal, requestId),
    ).rejects.toMatchObject({
      status: 409,
      code: "release_not_reconcilable",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("conceals a cross-subject reconciliation as not found", async () => {
    const { env } = await fixture("publishing");
    const other: Principal = {
      subject: `cail-${"f".repeat(32)}`,
      authentication: "cail-identity-jwt",
    };
    globalThis.fetch = mock(async () => new Response(null, { status: 200 })) as typeof fetch;

    await expect(
      handleApiForPrincipal(reconcileRequest(), env, other, requestId),
    ).rejects.toMatchObject({
      status: 404,
      code: "project_not_found",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
