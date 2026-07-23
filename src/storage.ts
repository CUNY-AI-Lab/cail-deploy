import { ApiError } from "./domain/errors";
import type { Env } from "./env";

export interface ProjectRow {
  project_id: string;
  owner_subject: string;
  name: string;
  created_at: string;
}

export interface RevisionRow {
  project_id: string;
  revision_id: string;
  artifact_digest: string;
  artifact_bytes: number;
  artifact_key: string;
  status: "ready" | "failed";
  created_at: string;
}

export interface ReleaseRow {
  release_id: string;
  project_id: string;
  revision_id: string;
  target: "preview" | "production";
  approval: "required" | "automatic";
  status: string;
  workflow_instance_id: string;
  prepared_key: string | null;
  prepared_digest: string | null;
  publication_name: string | null;
  rollback_of_release_id: string | null;
  approved_by_subject: string | null;
  operational_subject: string | null;
  request_id: string;
  admitted_at: string;
  created_at: string;
  updated_at: string;
}

const RECONCILIATION_KEY = "prepared-publication";

type ReconciliationClaim =
  | { state: "active"; requestId: string }
  | { state: "complete"; publicationName: string }
  | { state: "retryable" };

export type ReconciliationAuthority =
  | {
      state: "acquired";
      token: {
        responseJson: string;
        createdAt: string;
      };
    }
  | { state: "blocked" }
  | { state: "complete"; publicationName: string }
  | { state: "in_progress" };

function reconciliationOperation(releaseId: string): string {
  return `reconcile:${releaseId}`;
}

function parseReconciliationClaim(value: string): ReconciliationClaim {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new ApiError(
      500,
      "reconciliation_record_invalid",
      "The stored reconciliation authority is invalid.",
      { cause },
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new ApiError(
      500,
      "reconciliation_record_invalid",
      "The stored reconciliation authority is invalid.",
    );
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.state === "active" &&
    typeof record.requestId === "string" &&
    Object.keys(record).length === 2
  ) {
    return { state: "active", requestId: record.requestId };
  }
  if (
    record.state === "complete" &&
    typeof record.publicationName === "string" &&
    Object.keys(record).length === 2
  ) {
    return { state: "complete", publicationName: record.publicationName };
  }
  if (record.state === "retryable" && Object.keys(record).length === 1) {
    return { state: "retryable" };
  }
  throw new ApiError(
    500,
    "reconciliation_record_invalid",
    "The stored reconciliation authority is invalid.",
  );
}

async function reconciliationRow(
  env: Env,
  release: ReleaseRow,
  leaseMs: number,
): Promise<{
  request_digest: string;
  response_json: string;
  created_at: string;
  lease_expired: number | null;
} | null> {
  return env.DB.prepare(
    `SELECT request_digest, response_json, created_at,
       CASE
         WHEN julianday(created_at) IS NULL THEN NULL
         WHEN julianday(created_at) <= julianday('now') - (? / 86400000.0) THEN 1
         ELSE 0
       END AS lease_expired
     FROM idempotency
     WHERE project_id = ? AND operation = ? AND idempotency_key = ?`,
  )
    .bind(
      leaseMs,
      release.project_id,
      reconciliationOperation(release.release_id),
      RECONCILIATION_KEY,
    )
    .first<{
      request_digest: string;
      response_json: string;
      created_at: string;
      lease_expired: number | null;
    }>();
}

export async function acquireReconciliationAuthority(
  env: Env,
  release: ReleaseRow,
  requestId: string,
  requestDigest: string,
  leaseMs: number,
): Promise<ReconciliationAuthority> {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw new ApiError(
      503,
      "reconciliation_configuration_error",
      "The reconciliation lease is not configured safely.",
    );
  }
  const activeResponse = JSON.stringify({ state: "active", requestId });
  const operation = reconciliationOperation(release.release_id);
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO idempotency
       (project_id, operation, idempotency_key, request_digest, response_json, created_at)
     SELECT ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE EXISTS (
       SELECT 1 FROM releases
       WHERE release_id = ? AND project_id = ?
         AND status IN ('publishing', 'reconciling')
         AND prepared_key = ? AND prepared_digest = ?
         AND NOT EXISTS (
           SELECT 1 FROM release_events
           WHERE release_id = releases.release_id
             AND type IN ('release.live', 'release.failed', 'release.rejected')
         )
     )
     RETURNING response_json, created_at`,
  )
    .bind(
      release.project_id,
      operation,
      RECONCILIATION_KEY,
      requestDigest,
      activeResponse,
      release.release_id,
      release.project_id,
      release.prepared_key,
      release.prepared_digest,
    )
    .first<{ response_json: string; created_at: string }>();
  if (inserted) {
    return {
      state: "acquired",
      token: { responseJson: inserted.response_json, createdAt: inserted.created_at },
    };
  }

  let row = await reconciliationRow(env, release, leaseMs);
  if (!row) return { state: "blocked" };
  if (row.request_digest !== requestDigest) {
    throw new ApiError(
      500,
      "reconciliation_record_invalid",
      "The stored reconciliation authority does not match the retained artifact.",
    );
  }
  let claim = parseReconciliationClaim(row.response_json);
  if (claim.state === "complete") {
    return { state: "complete", publicationName: claim.publicationName };
  }
  if (row.lease_expired !== 0 && row.lease_expired !== 1) {
    throw new ApiError(
      500,
      "reconciliation_record_invalid",
      "The stored reconciliation authority has an invalid lease timestamp.",
    );
  }
  if (claim.state === "active" && row.lease_expired === 0) {
    return { state: "in_progress" };
  }
  const retryable = claim.state === "retryable";

  const retried = await env.DB.prepare(
    `UPDATE idempotency
     SET response_json = ?, created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE project_id = ? AND operation = ? AND idempotency_key = ?
       AND request_digest = ? AND response_json = ? AND created_at = ?
       AND (? = 1 OR julianday(created_at) <= julianday('now') - (? / 86400000.0))
       AND EXISTS (
         SELECT 1 FROM releases
         WHERE release_id = ? AND project_id = ?
           AND status IN ('publishing', 'reconciling')
           AND prepared_key = ? AND prepared_digest = ?
           AND NOT EXISTS (
             SELECT 1 FROM release_events
             WHERE release_id = releases.release_id
             AND type IN ('release.live', 'release.failed', 'release.rejected')
           )
       )
     RETURNING response_json, created_at`,
  )
    .bind(
      activeResponse,
      release.project_id,
      operation,
      RECONCILIATION_KEY,
      requestDigest,
      row.response_json,
      row.created_at,
      retryable ? 1 : 0,
      leaseMs,
      release.release_id,
      release.project_id,
      release.prepared_key,
      release.prepared_digest,
    )
    .first<{ response_json: string; created_at: string }>();
  if (retried) {
    return {
      state: "acquired",
      token: { responseJson: retried.response_json, createdAt: retried.created_at },
    };
  }

  row = await reconciliationRow(env, release, leaseMs);
  if (!row) return { state: "blocked" };
  if (row.request_digest !== requestDigest) {
    throw new ApiError(
      500,
      "reconciliation_record_invalid",
      "The stored reconciliation authority does not match the retained artifact.",
    );
  }
  claim = parseReconciliationClaim(row.response_json);
  if (claim.state === "complete") {
    return { state: "complete", publicationName: claim.publicationName };
  }
  if (claim.state !== "active") return { state: "blocked" };
  if (row.lease_expired !== 0 && row.lease_expired !== 1) {
    throw new ApiError(
      500,
      "reconciliation_record_invalid",
      "The stored reconciliation authority has an invalid lease timestamp.",
    );
  }
  return row.lease_expired === 0 ? { state: "in_progress" } : { state: "blocked" };
}

export async function releaseReconciliationAuthority(
  env: Env,
  release: ReleaseRow,
  requestDigest: string,
  token: { responseJson: string; createdAt: string },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE idempotency SET response_json = ?
     WHERE project_id = ? AND operation = ? AND idempotency_key = ?
       AND request_digest = ? AND response_json = ? AND created_at = ?`,
  )
    .bind(
      JSON.stringify({ state: "retryable" }),
      release.project_id,
      reconciliationOperation(release.release_id),
      RECONCILIATION_KEY,
      requestDigest,
      token.responseJson,
      token.createdAt,
    )
    .run();
}

export async function completeReconciliation(
  env: Env,
  release: ReleaseRow,
  publicationName: string,
  requestDigest: string,
  token: { responseJson: string; createdAt: string },
  requestId: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const completedResponse = JSON.stringify({ state: "complete", publicationName });
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE releases SET publication_name = ?, updated_at = ?
       WHERE release_id = ? AND project_id = ?
         AND status IN ('publishing', 'reconciling')
         AND prepared_key = ? AND prepared_digest = ?
         AND EXISTS (
           SELECT 1 FROM idempotency
           WHERE project_id = ? AND operation = ? AND idempotency_key = ?
             AND request_digest = ? AND response_json = ? AND created_at = ?
         )
         AND NOT EXISTS (
           SELECT 1 FROM release_events
           WHERE release_id = releases.release_id
             AND type IN ('release.live', 'release.failed', 'release.rejected')
         )`,
    ).bind(
      publicationName,
      now,
      release.release_id,
      release.project_id,
      release.prepared_key,
      release.prepared_digest,
      release.project_id,
      reconciliationOperation(release.release_id),
      RECONCILIATION_KEY,
      requestDigest,
      token.responseJson,
      token.createdAt,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO release_events
         (release_id, sequence, type, occurred_at, detail_json)
       SELECT ?, COALESCE((SELECT MAX(sequence) + 1 FROM release_events WHERE release_id = ?), 1),
         'release.live', ?, ?
       WHERE changes() = 1
         AND EXISTS (
           SELECT 1 FROM idempotency
           WHERE project_id = ? AND operation = ? AND idempotency_key = ?
             AND request_digest = ? AND response_json = ? AND created_at = ?
         )`,
    ).bind(
      release.release_id,
      release.release_id,
      now,
      JSON.stringify({ publicationName, reconciled: true, requestId }),
      release.project_id,
      reconciliationOperation(release.release_id),
      RECONCILIATION_KEY,
      requestDigest,
      token.responseJson,
      token.createdAt,
    ),
    env.DB.prepare(
      `UPDATE releases SET status = 'live', updated_at = ?
       WHERE release_id = ? AND publication_name = ?
         AND EXISTS (
           SELECT 1 FROM release_events
           WHERE release_id = ? AND type = 'release.live'
         )
         AND EXISTS (
           SELECT 1 FROM idempotency
           WHERE project_id = ? AND operation = ? AND idempotency_key = ?
             AND request_digest = ? AND response_json = ? AND created_at = ?
         )`,
    ).bind(
      now,
      release.release_id,
      publicationName,
      release.release_id,
      release.project_id,
      reconciliationOperation(release.release_id),
      RECONCILIATION_KEY,
      requestDigest,
      token.responseJson,
      token.createdAt,
    ),
    env.DB.prepare(
      `UPDATE idempotency SET response_json = ?
       WHERE project_id = ? AND operation = ? AND idempotency_key = ?
         AND request_digest = ? AND response_json = ? AND created_at = ?
         AND EXISTS (
           SELECT 1 FROM releases
           WHERE release_id = ? AND status = 'live' AND publication_name = ?
         )`,
    ).bind(
      completedResponse,
      release.project_id,
      reconciliationOperation(release.release_id),
      RECONCILIATION_KEY,
      requestDigest,
      token.responseJson,
      token.createdAt,
      release.release_id,
      publicationName,
    ),
  ]);
  return (
    (results[0]?.meta.changes ?? 0) === 1 &&
    (results[1]?.meta.changes ?? 0) === 1 &&
    (results[3]?.meta.changes ?? 0) === 1
  );
}

export async function requireOwnedProject(
  env: Env,
  projectId: string,
  subject: string,
): Promise<ProjectRow> {
  const project = await env.DB.prepare("SELECT * FROM projects WHERE project_id = ?")
    .bind(projectId)
    .first<ProjectRow>();
  if (!project || project.owner_subject !== subject) {
    throw new ApiError(404, "project_not_found", "The project was not found.");
  }
  return project;
}

export async function getRevision(
  env: Env,
  projectId: string,
  revisionId: string,
): Promise<RevisionRow | null> {
  return env.DB.prepare("SELECT * FROM revisions WHERE project_id = ? AND revision_id = ?")
    .bind(projectId, revisionId)
    .first<RevisionRow>();
}

export async function requireRelease(
  env: Env,
  projectId: string,
  releaseId: string,
): Promise<ReleaseRow> {
  const release = await env.DB.prepare(
    "SELECT * FROM releases WHERE project_id = ? AND release_id = ?",
  )
    .bind(projectId, releaseId)
    .first<ReleaseRow>();
  if (!release) throw new ApiError(404, "release_not_found", "The release was not found.");
  return release;
}

export async function appendReleaseStatus(
  env: Env,
  releaseId: string,
  status: string,
  type: string,
  detail: Record<string, unknown> = {},
  actorSubject?: string,
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE releases SET status = ?, updated_at = ? WHERE release_id = ?").bind(
      status,
      now,
      releaseId,
    ),
    env.DB.prepare(
      `INSERT INTO release_events (release_id, sequence, type, occurred_at, actor_subject, detail_json)
         VALUES (?, COALESCE((SELECT MAX(sequence) + 1 FROM release_events WHERE release_id = ?), 1), ?, ?, ?, ?)`,
    ).bind(releaseId, releaseId, type, now, actorSubject ?? null, JSON.stringify(detail)),
  ]);
}

export async function appendTerminalStatus(
  env: Env,
  releaseId: string,
  status: "live" | "failed" | "rejected",
  type: "release.live" | "release.failed" | "release.rejected",
  detail: Record<string, unknown> = {},
): Promise<boolean> {
  const now = new Date().toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO release_events (release_id, sequence, type, occurred_at, detail_json)
         VALUES (?, COALESCE((SELECT MAX(sequence) + 1 FROM release_events WHERE release_id = ?), 1), ?, ?, ?)`,
    ).bind(releaseId, releaseId, type, now, JSON.stringify(detail)),
    env.DB.prepare(
      `UPDATE releases SET status = ?, updated_at = ?
       WHERE release_id = ?
         AND EXISTS (
           SELECT 1 FROM release_events
           WHERE release_id = ? AND type = ?
         )`,
    ).bind(status, now, releaseId, releaseId, type),
  ]);
  return (results[0]?.meta.changes ?? 0) === 1;
}

export async function idempotentResponse(
  env: Env,
  projectId: string,
  operation: string,
  key: string,
  requestDigest: string,
): Promise<unknown | null> {
  const row = await env.DB.prepare(
    "SELECT request_digest, response_json FROM idempotency WHERE project_id = ? AND operation = ? AND idempotency_key = ?",
  )
    .bind(projectId, operation, key)
    .first<{ request_digest: string; response_json: string }>();
  if (!row) return null;
  if (row.request_digest !== requestDigest) {
    throw new ApiError(
      409,
      "idempotency_conflict",
      "The idempotency key was already used for different input.",
    );
  }
  return JSON.parse(row.response_json) as unknown;
}
