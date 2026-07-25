import { Database } from "bun:sqlite";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { handleApiForPrincipal, reconciliationLeaseMs } from "../src/api";
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

function successfulProviderResponse(): Response {
  return Response.json({
    errors: [],
    messages: [],
    success: true,
    result: {
      id: "kp-ki-20260722123456-abcdef12-bbbbbbbbbbbb",
      startup_time_ms: 1,
    },
  });
}

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

async function seedActiveClaim(
  db: SqliteD1,
  preparedDigest: string,
  createdAt: string,
  activeRequestId = "44444444-4444-4444-8444-444444444444",
): Promise<void> {
  const requestDigest = await sha256Hex(
    canonicalJson({
      releaseId,
      revisionId,
      preparedKey,
      preparedDigest,
    }),
  );
  db.sqlite.run("INSERT INTO idempotency VALUES (?, ?, 'prepared-publication', ?, ?, ?)", [
    projectId,
    `reconcile:${releaseId}`,
    requestDigest,
    JSON.stringify({ state: "active", requestId: activeRequestId }),
    createdAt,
  ]);
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
  test("derives a conservative finite lease from the bounded publisher timeout", () => {
    expect(reconciliationLeaseMs(undefined)).toBe(60_000);
    expect(reconciliationLeaseMs("1000")).toBe(2_000);
    expect(reconciliationLeaseMs("120000")).toBe(240_000);
  });

  for (const status of ["publishing", "reconciling"] as const) {
    test(`recovers retained prepared bytes from ${status} and replays without republishing`, async () => {
      const { db, env } = await fixture(status);
      globalThis.fetch = mock(async () => successfulProviderResponse()) as typeof fetch;

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
          unblock = () => resolve(successfulProviderResponse());
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

  test("takes over an aged active claim and completes from retained authority", async () => {
    const { db, env, preparedDigest } = await fixture("publishing");
    await seedActiveClaim(db, preparedDigest, "2000-01-01T00:00:00.000Z");
    globalThis.fetch = mock(async () => successfulProviderResponse()) as typeof fetch;

    const response = await handleApiForPrincipal(reconcileRequest(), env, principal, requestId);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ releaseId, status: "live" });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  test("excludes takeover while an active claim lease is fresh", async () => {
    const { db, env, preparedDigest } = await fixture("reconciling");
    await seedActiveClaim(db, preparedDigest, new Date().toISOString());
    globalThis.fetch = mock(async () => successfulProviderResponse()) as typeof fetch;

    await expect(
      handleApiForPrincipal(reconcileRequest(), env, principal, requestId),
    ).rejects.toMatchObject({
      status: 409,
      code: "release_reconciliation_in_progress",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("permits only one provider action during concurrent stale takeover", async () => {
    const { db, env, preparedDigest } = await fixture("reconciling");
    await seedActiveClaim(db, preparedDigest, "2000-01-01T00:00:00.000Z");
    let unblock: (() => void) | undefined;
    globalThis.fetch = mock(
      async () =>
        new Promise<Response>((resolve) => {
          unblock = () => resolve(successfulProviderResponse());
        }),
    ) as typeof fetch;

    const winner = handleApiForPrincipal(reconcileRequest(), env, principal, requestId);
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
    expect((await winner).status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  test("fences an expired holder that resumes after a successful takeover", async () => {
    const { db, env } = await fixture("reconciling");
    let resolveExpired: ((response: Response) => void) | undefined;
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      if (calls === 1) {
        return new Promise<Response>((resolve) => {
          resolveExpired = resolve;
        });
      }
      return successfulProviderResponse();
    }) as typeof fetch;

    const expired = handleApiForPrincipal(reconcileRequest(), env, principal, requestId);
    for (let attempt = 0; attempt < 100 && !resolveExpired; attempt += 1) {
      await Bun.sleep(1);
    }
    expect(resolveExpired).toBeDefined();
    db.sqlite.run(
      "UPDATE idempotency SET created_at = '2000-01-01T00:00:00.000Z' WHERE project_id = ? AND operation = ?",
      [projectId, `reconcile:${releaseId}`],
    );
    const takeoverRequestId = "33333333-3333-4333-8333-333333333333";
    const takeover = await handleApiForPrincipal(
      reconcileRequest(),
      env,
      principal,
      takeoverRequestId,
    );
    expect(takeover.status).toBe(200);

    resolveExpired(successfulProviderResponse());
    await expect(expired).rejects.toMatchObject({
      status: 409,
      code: "release_reconciliation_raced",
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
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
          requestId: takeoverRequestId,
        }),
      },
    ]);
  });

  test("same-request takeover fences stale success until the newer holder completes", async () => {
    const { db, env } = await fixture("reconciling");
    const resolvers: Array<(response: Response) => void> = [];
    globalThis.fetch = mock(
      async () =>
        new Promise<Response>((resolve) => {
          resolvers.push(resolve);
        }),
    ) as typeof fetch;

    const stale = handleApiForPrincipal(reconcileRequest(), env, principal, requestId);
    for (let attempt = 0; attempt < 100 && resolvers.length < 1; attempt += 1) {
      await Bun.sleep(1);
    }
    expect(resolvers).toHaveLength(1);
    db.sqlite.run(
      "UPDATE idempotency SET created_at = '2000-01-01T00:00:00.000Z' WHERE project_id = ? AND operation = ?",
      [projectId, `reconcile:${releaseId}`],
    );

    const current = handleApiForPrincipal(reconcileRequest(), env, principal, requestId);
    for (let attempt = 0; attempt < 100 && resolvers.length < 2; attempt += 1) {
      await Bun.sleep(1);
    }
    expect(resolvers).toHaveLength(2);
    const renewed = db.sqlite
      .query("SELECT response_json, created_at FROM idempotency WHERE project_id = ?")
      .get(projectId) as { response_json: string; created_at: string };

    resolvers[0]?.(successfulProviderResponse());
    await expect(stale).rejects.toMatchObject({
      status: 409,
      code: "release_reconciliation_raced",
    });
    expect(
      db.sqlite
        .query("SELECT response_json, created_at FROM idempotency WHERE project_id = ?")
        .get(projectId),
    ).toEqual(renewed);
    expect(
      db.sqlite
        .query("SELECT status, publication_name FROM releases WHERE release_id = ?")
        .get(releaseId),
    ).toEqual({ status: "reconciling", publication_name: null });
    expect(
      db.sqlite
        .query("SELECT COUNT(*) AS count FROM release_events WHERE release_id = ?")
        .get(releaseId),
    ).toEqual({ count: 0 });

    resolvers[1]?.(successfulProviderResponse());
    expect((await current).status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  test("same-request takeover prevents stale failure cleanup from releasing the newer claim", async () => {
    const { db, env } = await fixture("reconciling");
    const resolvers: Array<(response: Response) => void> = [];
    globalThis.fetch = mock(
      async () =>
        new Promise<Response>((resolve) => {
          resolvers.push(resolve);
        }),
    ) as typeof fetch;

    const stale = handleApiForPrincipal(reconcileRequest(), env, principal, requestId);
    for (let attempt = 0; attempt < 100 && resolvers.length < 1; attempt += 1) {
      await Bun.sleep(1);
    }
    expect(resolvers).toHaveLength(1);
    db.sqlite.run(
      "UPDATE idempotency SET created_at = '2000-01-01T00:00:00.000Z' WHERE project_id = ? AND operation = ?",
      [projectId, `reconcile:${releaseId}`],
    );

    const current = handleApiForPrincipal(reconcileRequest(), env, principal, requestId);
    for (let attempt = 0; attempt < 100 && resolvers.length < 2; attempt += 1) {
      await Bun.sleep(1);
    }
    expect(resolvers).toHaveLength(2);
    const renewed = db.sqlite
      .query("SELECT response_json, created_at FROM idempotency WHERE project_id = ?")
      .get(projectId) as { response_json: string; created_at: string };

    resolvers[0]?.(new Response(null, { status: 400 }));
    await expect(stale).rejects.toMatchObject({
      status: 502,
      code: "publication_rejected",
    });
    expect(
      db.sqlite
        .query("SELECT response_json, created_at FROM idempotency WHERE project_id = ?")
        .get(projectId),
    ).toEqual(renewed);

    resolvers[1]?.(successfulProviderResponse());
    expect((await current).status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
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

    globalThis.fetch = mock(async () => successfulProviderResponse()) as typeof fetch;
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
      return successfulProviderResponse();
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
    globalThis.fetch = mock(async () => successfulProviderResponse()) as typeof fetch;

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
    globalThis.fetch = mock(async () => successfulProviderResponse()) as typeof fetch;

    await expect(
      handleApiForPrincipal(reconcileRequest(), env, other, requestId),
    ).rejects.toMatchObject({
      status: 404,
      code: "project_not_found",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
