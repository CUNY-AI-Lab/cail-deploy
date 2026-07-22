import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { RELEASE_INSERT_SQL } from "../src/api";

describe("durable release invariants", () => {
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
      "preview",
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
  });

  test("workflow terminal replay records one terminal event", async () => {
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
      "INSERT INTO releases (release_id, project_id, revision_id, target, approval, status, workflow_instance_id, operational_subject, request_id, admitted_at, created_at, updated_at) VALUES (?, ?, ?, 'preview', 'required', 'publishing', ?, ?, ?, ?, ?, ?)",
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
    const insert =
      "INSERT OR IGNORE INTO release_events (release_id, sequence, type, occurred_at, detail_json) VALUES (?, COALESCE((SELECT MAX(sequence) + 1 FROM release_events WHERE release_id = ?), 1), 'release.failed', ?, '{}')";
    db.run(insert, [
      "rel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "rel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      now,
    ]);
    db.run(insert, [
      "rel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "rel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      now,
    ]);
    const count = db
      .query("SELECT COUNT(*) AS count FROM release_events WHERE type = 'release.failed'")
      .get() as { count: number };
    expect(count.count).toBe(1);
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
      "INSERT INTO releases (release_id, project_id, revision_id, target, approval, status, workflow_instance_id, operational_subject, request_id, admitted_at, created_at, updated_at) VALUES (?, ?, ?, 'preview', 'required', 'awaiting_approval', ?, ?, ?, ?, ?, ?)",
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
