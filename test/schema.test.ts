import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  MAX_RELEASE_EVENT_COUNT,
  MAX_RELEASE_EVENT_HISTORY_BYTES,
  LATEST_LIVE_RELEASE_SQL,
  RELEASE_INSERT_SQL,
  readReleaseEventHistory,
} from "../src/api";
import { apiErrorSnapshot } from "../src/domain/errors";
import { CONSUME_CONSENT_NONCE_SQL } from "../src/oauth-consent";
import {
  appendReleaseStatus,
  appendTerminalStatus,
  hasTerminalReleaseOutcome,
} from "../src/storage";

class SqliteD1 {
  constructor(private readonly db: Database) {}

  prepare(query: string) {
    const db = this.db;
    return {
      bind: (...values: unknown[]) => ({
        query,
        values,
        async first<T>() {
          return (db.prepare(query).get(...values) as T | null) ?? null;
        },
        async all<T>() {
          return { results: db.prepare(query).all(...values) as T[] };
        },
      }),
    };
  }

  async batch(
    statements: Array<{ query: string; values: unknown[] }>,
  ): Promise<Array<{ meta: { changes: number } }>> {
    return this.db.transaction(() =>
      statements.map(({ query, values }) => {
        const result = this.db.prepare(query).run(...values);
        return { meta: { changes: result.changes } };
      }),
    )();
  }
}

describe("durable release invariants", () => {
  test("bounds release event history by count and encoded bytes without truncation", async () => {
    const db = new Database(":memory:");
    db.exec(await Bun.file(new URL("../schema/0001_control_plane.sql", import.meta.url)).text());
    const releaseId = "rel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const projectId = "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const revisionId = `rev_sha256_${"b".repeat(64)}`;
    const now = "2026-08-01T00:00:00.000Z";
    db.run("INSERT INTO projects VALUES (?, ?, ?, ?)", [
      projectId,
      "cail-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "test",
      now,
    ]);
    db.run("INSERT INTO revisions VALUES (?, ?, ?, ?, ?, ?, ?)", [
      projectId,
      revisionId,
      "b".repeat(64),
      1,
      "key",
      "ready",
      now,
    ]);
    db.run(
      "INSERT INTO releases (release_id, project_id, revision_id, approval, status, workflow_instance_id, request_id, admitted_at, created_at, updated_at) VALUES (?, ?, ?, 'required', 'queued', ?, ?, ?, ?, ?)",
      [
        releaseId,
        projectId,
        revisionId,
        releaseId,
        "11111111-1111-4111-8111-111111111111",
        now,
        now,
        now,
      ],
    );
    const insert = db.prepare(
      "INSERT INTO release_events (release_id, sequence, type, occurred_at, actor_subject, detail_json) VALUES (?, ?, ?, ?, NULL, ?)",
    );
    db.transaction(() => {
      for (let sequence = 1; sequence <= MAX_RELEASE_EVENT_COUNT; sequence += 1) {
        insert.run(releaseId, sequence, "release.progress", now, "{}");
      }
    })();
    const d1 = new SqliteD1(db) as unknown as Parameters<typeof readReleaseEventHistory>[0];
    const exact = await readReleaseEventHistory(d1, releaseId);
    expect(exact).toHaveLength(MAX_RELEASE_EVENT_COUNT);
    expect(exact[0]?.sequence).toBe(1);
    expect(exact.at(-1)?.sequence).toBe(MAX_RELEASE_EVENT_COUNT);

    insert.run(releaseId, MAX_RELEASE_EVENT_COUNT + 1, "release.progress", now, "{}");
    const countError = await readReleaseEventHistory(d1, releaseId).catch(
      (error: unknown) => error,
    );
    expect(apiErrorSnapshot(countError)?.code).toBe("release_history_too_large");

    db.run("DELETE FROM release_events WHERE release_id = ?", [releaseId]);
    insert.run(
      releaseId,
      1,
      "release.progress",
      now,
      JSON.stringify({ payload: "x".repeat(MAX_RELEASE_EVENT_HISTORY_BYTES) }),
    );
    const byteError = await readReleaseEventHistory(d1, releaseId).catch((error: unknown) => error);
    expect(apiErrorSnapshot(byteError)?.code).toBe("release_history_too_large");
  });

  test("accepts nullable detail_json and counts multibyte detail bytes at the exact boundary", async () => {
    const db = new Database(":memory:");
    db.exec(await Bun.file(new URL("../schema/0001_control_plane.sql", import.meta.url)).text());
    const releaseId = "rel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const projectId = "prj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const revisionId = `rev_sha256_${"c".repeat(64)}`;
    const now = "2026-08-01T00:00:00.000Z";
    db.run("INSERT INTO projects VALUES (?, ?, ?, ?)", [
      projectId,
      "cail-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "test",
      now,
    ]);
    db.run("INSERT INTO revisions VALUES (?, ?, ?, ?, ?, ?, ?)", [
      projectId,
      revisionId,
      "c".repeat(64),
      1,
      "key-b",
      "ready",
      now,
    ]);
    db.run(
      "INSERT INTO releases (release_id, project_id, revision_id, approval, status, workflow_instance_id, request_id, admitted_at, created_at, updated_at) VALUES (?, ?, ?, 'required', 'queued', ?, ?, ?, ?, ?)",
      [
        releaseId,
        projectId,
        revisionId,
        releaseId,
        "22222222-2222-4222-8222-222222222222",
        now,
        now,
        now,
      ],
    );
    const insert = db.prepare(
      "INSERT INTO release_events (release_id, sequence, type, occurred_at, actor_subject, detail_json) VALUES (?, ?, ?, ?, NULL, ?)",
    );
    insert.run(releaseId, 1, "release.progress", now, null);
    const d1 = new SqliteD1(db) as unknown as Parameters<typeof readReleaseEventHistory>[0];
    expect(await readReleaseEventHistory(d1, releaseId)).toEqual([
      {
        sequence: 1,
        type: "release.progress",
        occurredAt: now,
        actorSubject: null,
        detail: null,
      },
    ]);

    const encoder = new TextEncoder();
    const typeBytes = encoder.encode("release.progress").byteLength;
    const occurredBytes = encoder.encode(now).byteLength;
    const detailFor = (length: number) => JSON.stringify({ payload: "é".repeat(length) });
    let low = 0;
    let high = MAX_RELEASE_EVENT_HISTORY_BYTES;
    while (low < high) {
      const candidate = Math.ceil((low + high) / 2);
      const bytes = typeBytes + occurredBytes + encoder.encode(detailFor(candidate)).byteLength;
      if (bytes <= MAX_RELEASE_EVENT_HISTORY_BYTES) low = candidate;
      else high = candidate - 1;
    }
    const exactDetail = detailFor(low);
    db.run("DELETE FROM release_events WHERE release_id = ?", [releaseId]);
    insert.run(releaseId, 1, "release.progress", now, exactDetail);
    const exact = await readReleaseEventHistory(d1, releaseId);
    expect(exact[0]?.detail).toEqual({ payload: "é".repeat(low) });
    expect(typeBytes + occurredBytes + encoder.encode(exactDetail).byteLength).toBe(
      MAX_RELEASE_EVENT_HISTORY_BYTES,
    );

    insert.run(releaseId, 2, "release.progress", now, "{}");
    const overflow = await readReleaseEventHistory(d1, releaseId).catch((error: unknown) => error);
    expect(apiErrorSnapshot(overflow)?.code).toBe("release_history_too_large");
  });

  test("production release insert matches the durable schema", async () => {
    const db = new Database(":memory:");
    db.exec(await Bun.file(new URL("../schema/0001_control_plane.sql", import.meta.url)).text());
    const now = new Date().toISOString();
    const projectId = "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const revisionId = `rev_sha256_${"b".repeat(64)}`;
    const releaseId = "rel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    db.run("INSERT INTO projects VALUES (?, ?, ?, ?)", [
      projectId,
      "cail-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "test",
      now,
    ]);
    db.run("INSERT INTO revisions VALUES (?, ?, ?, ?, ?, ?, ?)", [
      projectId,
      revisionId,
      "b".repeat(64),
      1,
      "key",
      "ready",
      now,
    ]);

    db.run(RELEASE_INSERT_SQL, [
      releaseId,
      projectId,
      revisionId,
      "required",
      releaseId,
      null,
      "cail-v1-11111111111111111111111111111111",
      "019f8bdc-342a-76e1-ba71-005d69808f86",
      now,
      now,
      now,
    ]);

    expect(db.query("SELECT status FROM releases WHERE release_id = ?").get(releaseId)).toEqual({
      status: "queued",
    });
    expect(() =>
      db.run("UPDATE releases SET status = 'unknown' WHERE release_id = ?", [releaseId]),
    ).toThrow();
  });

  test("preview keeps newest-admitted live authority across late reconciliation and rollback", async () => {
    const db = new Database(":memory:");
    db.exec(await Bun.file(new URL("../schema/0001_control_plane.sql", import.meta.url)).text());
    const now = new Date().toISOString();
    const projectId = "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const revisionId = `rev_sha256_${"b".repeat(64)}`;
    db.run("INSERT INTO projects VALUES (?, ?, ?, ?)", [
      projectId,
      "cail-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "test",
      now,
    ]);
    db.run("INSERT INTO revisions VALUES (?, ?, ?, ?, ?, ?, ?)", [
      projectId,
      revisionId,
      "b".repeat(64),
      1,
      "key",
      "ready",
      now,
    ]);
    const insert = db.prepare(
      "INSERT INTO releases (release_id, project_id, revision_id, approval, status, workflow_instance_id, rollback_of_release_id, request_id, admitted_at, created_at, updated_at) VALUES (?, ?, ?, 'automatic', ?, ?, ?, ?, ?, ?, ?)",
    );
    const first = "rel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const second = "rel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const rollback = "rel_cccccccccccccccccccccccccccccccc";
    insert.run(
      first,
      projectId,
      revisionId,
      "reconciling",
      first,
      null,
      "request-1",
      now,
      now,
      now,
    );
    insert.run(second, projectId, revisionId, "live", second, null, "request-2", now, now, now);
    db.run("UPDATE releases SET status = 'live', updated_at = ? WHERE release_id = ?", [
      "2026-08-02T00:00:00.000Z",
      first,
    ]);
    expect(db.query(LATEST_LIVE_RELEASE_SQL).get(projectId)).toMatchObject({
      release_id: second,
    });

    insert.run(
      rollback,
      projectId,
      revisionId,
      "live",
      rollback,
      second,
      "request-3",
      now,
      now,
      now,
    );
    expect(db.query(LATEST_LIVE_RELEASE_SQL).get(projectId)).toMatchObject({
      release_id: rollback,
      rollback_of_release_id: second,
    });
  });

  test("workflow terminal replay keeps the release row and terminal event in agreement", async () => {
    const db = new Database(":memory:");
    db.exec(await Bun.file(new URL("../schema/0001_control_plane.sql", import.meta.url)).text());
    const now = new Date().toISOString();
    db.run("INSERT INTO projects VALUES (?, ?, ?, ?)", [
      "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "cail-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "test",
      now,
    ]);
    db.run("INSERT INTO revisions VALUES (?, ?, ?, ?, ?, ?, ?)", [
      "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      `rev_sha256_${"b".repeat(64)}`,
      "b".repeat(64),
      1,
      "key",
      "ready",
      now,
    ]);
    db.run(
      "INSERT INTO releases (release_id, project_id, revision_id, approval, status, workflow_instance_id, operational_subject, request_id, admitted_at, created_at, updated_at) VALUES (?, ?, ?, 'required', 'publishing', ?, ?, ?, ?, ?, ?)",
      [
        "rel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        `rev_sha256_${"b".repeat(64)}`,
        "rel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "cail-v1-11111111111111111111111111111111",
        "019f8bdc-342a-76e1-ba71-005d69808f86",
        now,
        now,
        now,
      ],
    );
    const env = {
      DB: new SqliteD1(db),
    } as unknown as Parameters<typeof appendTerminalStatus>[0];
    const releaseId = "rel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    expect(await appendTerminalStatus(env, releaseId, "live", "release.live")).toBe(true);
    expect(await appendTerminalStatus(env, releaseId, "live", "release.live")).toBe(false);
    expect(await appendTerminalStatus(env, releaseId, "failed", "release.failed")).toBe(false);

    expect(db.query("SELECT status FROM releases WHERE release_id = ?").get(releaseId)).toEqual({
      status: "live",
    });
    expect(
      db
        .query("SELECT type FROM release_events WHERE release_id = ? ORDER BY sequence")
        .all(releaseId),
    ).toEqual([{ type: "release.live" }]);
  });

  test("terminal outcomes fence every later nonterminal transition", async () => {
    for (const [status, type] of [
      ["live", "release.live"],
      ["failed", "release.failed"],
    ] as const) {
      const db = new Database(":memory:");
      db.exec(await Bun.file(new URL("../schema/0001_control_plane.sql", import.meta.url)).text());
      const now = new Date().toISOString();
      const projectId = "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const revisionId = `rev_sha256_${"b".repeat(64)}`;
      const releaseId = "rel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      db.run("INSERT INTO projects VALUES (?, ?, ?, ?)", [
        projectId,
        "cail-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "test",
        now,
      ]);
      db.run("INSERT INTO revisions VALUES (?, ?, ?, ?, ?, ?, ?)", [
        projectId,
        revisionId,
        "b".repeat(64),
        1,
        "key",
        "ready",
        now,
      ]);
      db.run(
        "INSERT INTO releases (release_id, project_id, revision_id, approval, status, workflow_instance_id, request_id, admitted_at, created_at, updated_at) VALUES (?, ?, ?, 'automatic', 'publishing', ?, ?, ?, ?, ?)",
        [releaseId, projectId, revisionId, releaseId, "request", now, now, now],
      );
      const env = {
        DB: new SqliteD1(db),
      } as unknown as Parameters<typeof appendTerminalStatus>[0];

      expect(await appendTerminalStatus(env, releaseId, status, type)).toBe(true);
      expect(
        await appendReleaseStatus(env, releaseId, "reconciling", "release.reconciling"),
      ).toEqual({ state: "fenced" });
      expect(db.query("SELECT status FROM releases WHERE release_id = ?").get(releaseId)).toEqual({
        status,
      });
      expect(
        db
          .query("SELECT type FROM release_events WHERE release_id = ? ORDER BY sequence")
          .all(releaseId),
      ).toEqual([{ type }]);
    }
  });

  test("the terminal fence is enforced for direct SQL writers by its migration trigger", async () => {
    const db = new Database(":memory:");
    db.exec(await Bun.file(new URL("../schema/0001_control_plane.sql", import.meta.url)).text());
    const now = new Date().toISOString();
    const projectId = "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const revisionId = `rev_sha256_${"b".repeat(64)}`;
    const releaseId = "rel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    db.run("INSERT INTO projects VALUES (?, ?, ?, ?)", [
      projectId,
      "cail-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "test",
      now,
    ]);
    db.run("INSERT INTO revisions VALUES (?, ?, ?, ?, ?, ?, ?)", [
      projectId,
      revisionId,
      "b".repeat(64),
      1,
      "key",
      "ready",
      now,
    ]);
    db.run(
      "INSERT INTO releases (release_id, project_id, revision_id, approval, status, workflow_instance_id, request_id, admitted_at, created_at, updated_at) VALUES (?, ?, ?, 'automatic', 'live', ?, ?, ?, ?, ?)",
      [releaseId, projectId, revisionId, releaseId, "request", now, now, now],
    );
    const env = {
      DB: new SqliteD1(db),
    } as unknown as Parameters<typeof appendTerminalStatus>[0];

    expect(() =>
      db.run("UPDATE releases SET status = 'reconciling' WHERE release_id = ?", [releaseId]),
    ).toThrow("terminal release status cannot regress");
    expect(() =>
      db.run("UPDATE releases SET status = 'failed' WHERE release_id = ?", [releaseId]),
    ).toThrow("terminal release status cannot regress");
    expect(db.query("SELECT status FROM releases WHERE release_id = ?").get(releaseId)).toEqual({
      status: "live",
    });

    const eventOnlyReleaseId = "rel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    db.run(
      "INSERT INTO releases (release_id, project_id, revision_id, approval, status, workflow_instance_id, request_id, admitted_at, created_at, updated_at) VALUES (?, ?, ?, 'automatic', 'reconciling', ?, ?, ?, ?, ?)",
      [
        eventOnlyReleaseId,
        projectId,
        revisionId,
        eventOnlyReleaseId,
        "request-event-only",
        now,
        now,
        now,
      ],
    );
    db.run(
      "INSERT INTO release_events (release_id, sequence, type, occurred_at) VALUES (?, 1, 'release.live', ?)",
      [eventOnlyReleaseId, now],
    );
    expect(await hasTerminalReleaseOutcome(env, eventOnlyReleaseId)).toBe(true);
    expect(
      await appendReleaseStatus(env, eventOnlyReleaseId, "validating", "release.validating"),
    ).toEqual({ state: "fenced" });
    expect(() =>
      db.run("UPDATE releases SET status = 'publishing' WHERE release_id = ?", [
        eventOnlyReleaseId,
      ]),
    ).toThrow("terminal release status cannot regress");
    expect(
      db.query("SELECT status FROM releases WHERE release_id = ?").get(eventOnlyReleaseId),
    ).toEqual({ status: "reconciling" });
  });

  test("forward transitions are idempotent and terminal completion wins the reverse ordering", async () => {
    const db = new Database(":memory:");
    db.exec(await Bun.file(new URL("../schema/0001_control_plane.sql", import.meta.url)).text());
    const now = new Date().toISOString();
    const projectId = "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const revisionId = `rev_sha256_${"b".repeat(64)}`;
    const releaseId = "rel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    db.run("INSERT INTO projects VALUES (?, ?, ?, ?)", [
      projectId,
      "cail-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "test",
      now,
    ]);
    db.run("INSERT INTO revisions VALUES (?, ?, ?, ?, ?, ?, ?)", [
      projectId,
      revisionId,
      "b".repeat(64),
      1,
      "key",
      "ready",
      now,
    ]);
    db.run(
      "INSERT INTO releases (release_id, project_id, revision_id, approval, status, workflow_instance_id, request_id, admitted_at, created_at, updated_at) VALUES (?, ?, ?, 'automatic', 'queued', ?, ?, ?, ?, ?)",
      [releaseId, projectId, revisionId, releaseId, "request", now, now, now],
    );
    const env = {
      DB: new SqliteD1(db),
    } as unknown as Parameters<typeof appendTerminalStatus>[0];

    expect(await appendReleaseStatus(env, releaseId, "validating", "release.validating")).toEqual({
      state: "applied",
    });
    expect(await appendReleaseStatus(env, releaseId, "validating", "release.validating")).toEqual({
      state: "already_applied",
    });
    expect(await appendTerminalStatus(env, releaseId, "live", "release.live")).toBe(true);
    expect(await appendReleaseStatus(env, releaseId, "reconciling", "release.reconciling")).toEqual(
      { state: "fenced" },
    );
    expect(db.query("SELECT status FROM releases WHERE release_id = ?").get(releaseId)).toEqual({
      status: "live",
    });
    expect(
      db
        .query("SELECT type FROM release_events WHERE release_id = ? ORDER BY sequence")
        .all(releaseId),
    ).toEqual([{ type: "release.validating" }, { type: "release.live" }]);
  });

  test("publishing accepts an approved release from awaiting approval", async () => {
    const db = new Database(":memory:");
    db.exec(await Bun.file(new URL("../schema/0001_control_plane.sql", import.meta.url)).text());
    const now = new Date().toISOString();
    const projectId = "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const revisionId = `rev_sha256_${"b".repeat(64)}`;
    const releaseId = "rel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    db.run("INSERT INTO projects VALUES (?, ?, ?, ?)", [
      projectId,
      "cail-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "test",
      now,
    ]);
    db.run("INSERT INTO revisions VALUES (?, ?, ?, ?, ?, ?, ?)", [
      projectId,
      revisionId,
      "b".repeat(64),
      1,
      "key",
      "ready",
      now,
    ]);
    db.run(
      "INSERT INTO releases (release_id, project_id, revision_id, approval, status, workflow_instance_id, request_id, admitted_at, created_at, updated_at) VALUES (?, ?, ?, 'required', 'awaiting_approval', ?, ?, ?, ?, ?)",
      [releaseId, projectId, revisionId, releaseId, "request", now, now, now],
    );
    db.run(
      "INSERT INTO release_events (release_id, sequence, type, occurred_at) VALUES (?, 1, 'release.awaiting_approval', ?)",
      [releaseId, now],
    );
    const env = {
      DB: new SqliteD1(db),
    } as unknown as Parameters<typeof appendReleaseStatus>[0];

    expect(await appendReleaseStatus(env, releaseId, "publishing", "release.publishing")).toEqual({
      state: "applied",
    });
    expect(db.query("SELECT status FROM releases WHERE release_id = ?").get(releaseId)).toEqual({
      status: "publishing",
    });
    expect(
      db
        .query("SELECT type FROM release_events WHERE release_id = ? ORDER BY sequence")
        .all(releaseId),
    ).toEqual([{ type: "release.awaiting_approval" }, { type: "release.publishing" }]);
  });

  test("interleaved D1 transition batches keep one authoritative row/event pair", async () => {
    const db = new Database(":memory:");
    db.exec(await Bun.file(new URL("../schema/0001_control_plane.sql", import.meta.url)).text());
    const now = new Date().toISOString();
    const projectId = "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const revisionId = `rev_sha256_${"b".repeat(64)}`;
    const releaseId = "rel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    db.run("INSERT INTO projects VALUES (?, ?, ?, ?)", [
      projectId,
      "cail-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "test",
      now,
    ]);
    db.run("INSERT INTO revisions VALUES (?, ?, ?, ?, ?, ?, ?)", [
      projectId,
      revisionId,
      "b".repeat(64),
      1,
      "key",
      "ready",
      now,
    ]);
    db.run(
      "INSERT INTO releases (release_id, project_id, revision_id, approval, status, workflow_instance_id, request_id, admitted_at, created_at, updated_at) VALUES (?, ?, ?, 'automatic', 'queued', ?, ?, ?, ?, ?)",
      [releaseId, projectId, revisionId, releaseId, "request", now, now, now],
    );

    let releaseFirstBatch: (() => void) | undefined;
    const firstBatchGate = new Promise<void>((resolve) => {
      releaseFirstBatch = resolve;
    });
    let firstBatchStarted: (() => void) | undefined;
    const firstBatchBarrier = new Promise<void>((resolve) => {
      firstBatchStarted = resolve;
    });
    class BarrierD1 extends SqliteD1 {
      private batches = 0;

      override async batch(
        statements: Array<{ query: string; values: unknown[] }>,
      ): Promise<Array<{ meta: { changes: number } }>> {
        this.batches += 1;
        if (this.batches === 1) {
          firstBatchStarted?.();
          await firstBatchGate;
        }
        return super.batch(statements);
      }
    }
    const env = {
      DB: new BarrierD1(db),
    } as unknown as Parameters<typeof appendReleaseStatus>[0];

    const first = appendReleaseStatus(env, releaseId, "validating", "release.validating");
    await firstBatchBarrier;
    const second = appendReleaseStatus(env, releaseId, "validating", "release.validating");
    releaseFirstBatch?.();
    const results = await Promise.all([first, second]);
    expect(results.map(({ state }) => state).sort()).toEqual(["already_applied", "applied"]);
    expect(db.query("SELECT status FROM releases WHERE release_id = ?").get(releaseId)).toEqual({
      status: "validating",
    });
    expect(
      db
        .query("SELECT sequence, type FROM release_events WHERE release_id = ? ORDER BY sequence")
        .all(releaseId),
    ).toEqual([{ sequence: 1, type: "release.validating" }]);
  });

  test("approval compare-and-set accepts only one idempotency contender", async () => {
    const db = new Database(":memory:");
    db.exec(await Bun.file(new URL("../schema/0001_control_plane.sql", import.meta.url)).text());
    const now = new Date().toISOString();
    const projectId = "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const revisionId = `rev_sha256_${"b".repeat(64)}`;
    const releaseId = "rel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    db.run("INSERT INTO projects VALUES (?, ?, ?, ?)", [
      projectId,
      "cail-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "test",
      now,
    ]);
    db.run("INSERT INTO revisions VALUES (?, ?, ?, ?, ?, ?, ?)", [
      projectId,
      revisionId,
      "b".repeat(64),
      1,
      "key",
      "ready",
      now,
    ]);
    db.run(
      "INSERT INTO releases (release_id, project_id, revision_id, approval, status, workflow_instance_id, operational_subject, request_id, admitted_at, created_at, updated_at) VALUES (?, ?, ?, 'required', 'awaiting_approval', ?, ?, ?, ?, ?, ?)",
      [
        releaseId,
        projectId,
        revisionId,
        releaseId,
        "cail-v1-11111111111111111111111111111111",
        "019f8bdc-342a-76e1-ba71-005d69808f86",
        now,
        now,
        now,
      ],
    );
    const approve = db.prepare(
      "UPDATE releases SET approved_by_subject = ?, updated_at = ? WHERE release_id = ? AND status = 'awaiting_approval' AND approved_by_subject IS NULL",
    );
    const first = approve.run("cail-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", now, releaseId);
    const second = approve.run("cail-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", now, releaseId);
    expect(first.changes).toBe(1);
    expect(second.changes).toBe(0);
  });
});

describe("OAuth consent nonce invariants", () => {
  test("one subject/client/request-bound nonce is consumed once before expiry", async () => {
    const db = new Database(":memory:");
    db.exec(await Bun.file(new URL("../schema/0001_control_plane.sql", import.meta.url)).text());
    const nonce = `ocn_${"a".repeat(32)}`;
    const subject = "cail-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const clientId = "client-a";
    const digest = "request-a";
    db.run(
      "INSERT INTO oauth_consent_nonces (nonce, owner_subject, client_id, request_digest, expires_at) VALUES (?, ?, ?, ?, ?)",
      [nonce, subject, clientId, digest, "2099-01-01T00:00:00.000Z"],
    );
    const consume = db.prepare(CONSUME_CONSENT_NONCE_SQL);
    const parameters = [nonce, subject, clientId, digest, "2026-07-22T00:00:00.000Z"];
    expect(consume.run(...parameters).changes).toBe(1);
    expect(consume.run(...parameters).changes).toBe(0);
  });

  test("changed subject, client, request, and expired nonce do not consume", async () => {
    const variants = [
      [
        "cail-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "client-a",
        "request-a",
        "2026-07-22T00:00:00.000Z",
      ],
      [
        "cail-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "client-b",
        "request-a",
        "2026-07-22T00:00:00.000Z",
      ],
      [
        "cail-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "client-a",
        "request-b",
        "2026-07-22T00:00:00.000Z",
      ],
      [
        "cail-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "client-a",
        "request-a",
        "2100-01-01T00:00:00.000Z",
      ],
    ];
    for (const [subject, clientId, digest, now] of variants) {
      const db = new Database(":memory:");
      db.exec(await Bun.file(new URL("../schema/0001_control_plane.sql", import.meta.url)).text());
      db.run(
        "INSERT INTO oauth_consent_nonces (nonce, owner_subject, client_id, request_digest, expires_at) VALUES (?, ?, ?, ?, ?)",
        [
          `ocn_${"a".repeat(32)}`,
          "cail-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "client-a",
          "request-a",
          "2099-01-01T00:00:00.000Z",
        ],
      );
      expect(
        db
          .prepare(CONSUME_CONSENT_NONCE_SQL)
          .run(
            `ocn_${"a".repeat(32)}`,
            subject as string,
            clientId as string,
            digest as string,
            now as string,
          ).changes,
      ).toBe(0);
    }
  });
});
