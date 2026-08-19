import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";
import { handleApiForPrincipal } from "../src/api";
import type { Principal } from "../src/auth";
import type { Env } from "../src/env";

const subject = `cail-${"a".repeat(32)}`;
const projectId = `prj_${"b".repeat(32)}`;
const revisionId = `rev_sha256_${"c".repeat(64)}`;
const releaseId = `rel_${"d".repeat(32)}`;
const now = "2026-08-07T00:00:00.000Z";
const principal: Principal = { subject, authentication: "isolated-test-bearer" };

class BarrierD1 {
  private idempotencyReads = 0;
  private readonly bothReads: Promise<void>;
  private releaseBothReads!: () => void;

  constructor(readonly sqlite: Database) {
    this.bothReads = new Promise<void>((resolve) => {
      this.releaseBothReads = resolve;
    });
  }

  async waitForBothPreflightReads(): Promise<void> {
    await this.bothReads;
  }

  openPreflightReads(): void {
    this.releaseBothReads();
  }

  prepare(query: string) {
    const sqlite = this.sqlite;
    const waitForPreflight = async () => {
      if (!query.includes("FROM idempotency") || this.idempotencyReads >= 2) return;
      this.idempotencyReads += 1;
      if (this.idempotencyReads === 2) this.releaseBothReads();
      await this.bothReads;
    };
    return {
      bind(...values: unknown[]) {
        return {
          query,
          values,
          async first<T>() {
            await waitForPreflight();
            // SAFETY: SQLite returns the row shape requested by each test
            // query; the generic caller owns that row contract.
            return (sqlite.prepare(query).get(...values) as T | null) ?? null;
          },
          async run() {
            const result = sqlite.prepare(query).run(...values);
            return { meta: { changes: result.changes } };
          },
        };
      },
    };
  }

  async batch(statements: Array<{ query: string; values: unknown[] }>) {
    return this.sqlite.transaction(() =>
      statements.map(({ query, values }) => {
        const result = this.sqlite.prepare(query).run(...values);
        return { meta: { changes: result.changes } };
      }),
    )();
  }
}

function approvalRequest(): Request {
  return new Request(`https://deploy.test/v1/projects/${projectId}/releases/${releaseId}/approve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "concurrent-approval",
    },
    body: JSON.stringify({ decision: "approved" }),
  });
}

async function fixture(): Promise<{
  d1: BarrierD1;
  env: Env;
  sendEvent: ReturnType<typeof mock>;
}> {
  const sqlite = new Database(":memory:");
  sqlite.exec(await Bun.file(new URL("../schema/0001_control_plane.sql", import.meta.url)).text());
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
      (release_id, project_id, revision_id, approval, status, workflow_instance_id,
       request_id, admitted_at, created_at, updated_at)
     VALUES (?, ?, ?, 'required', 'awaiting_approval', ?, ?, ?, ?, ?)`,
    [releaseId, projectId, revisionId, releaseId, "request-id", now, now, now],
  );
  sqlite.run(
    `INSERT INTO release_events (release_id, sequence, type, occurred_at)
     VALUES (?, 1, 'release.awaiting_approval', ?)`,
    [releaseId, now],
  );
  const d1 = new BarrierD1(sqlite);
  const sendEvent = mock(async () => {});
  // SAFETY: this fixture supplies the D1 and Workflow methods used by the
  // approval handler; unrelated production bindings are intentionally absent.
  const env = {
    DB: d1,
    RELEASE_WORKFLOW: { get: async () => ({ sendEvent }) },
  } as Env;
  return { d1, env, sendEvent };
}

describe("release approval idempotency", () => {
  test("concurrent requests with one key replay the committed approval", async () => {
    const { d1, env, sendEvent } = await fixture();
    const first = handleApiForPrincipal(approvalRequest(), env, principal);
    const second = handleApiForPrincipal(approvalRequest(), env, principal);

    await d1.waitForBothPreflightReads();
    d1.openPreflightReads();

    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 202]);
    expect(await responses[0]?.json()).toMatchObject({
      projectId,
      releaseId,
      revisionId,
      decision: "approved",
    });
    expect(await responses[1]?.json()).toMatchObject({
      projectId,
      releaseId,
      revisionId,
      decision: "approved",
    });
    expect(sendEvent).toHaveBeenCalledTimes(2);
  });
});
