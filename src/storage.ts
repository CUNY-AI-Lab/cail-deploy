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

export type ReleaseStatus =
  | "queued"
  | "validating"
  | "building"
  | "prepared"
  | "awaiting_approval"
  | "publishing"
  | "reconciling"
  | "live"
  | "rejected"
  | "failed";

export type ReleaseTransitionState = "applied" | "fenced" | "already_applied";

export interface ReleaseTransitionResult {
  state: ReleaseTransitionState;
}

const TERMINAL_RELEASE_STATUSES = ["live", "failed", "rejected"] as const;
const NONTERMINAL_RELEASE_STATUSES = [
  "queued",
  "validating",
  "building",
  "prepared",
  "awaiting_approval",
  "publishing",
  "reconciling",
] as const;

const TERMINAL_RELEASE_EVENT_TYPES = [
  "release.live",
  "release.failed",
  "release.rejected",
] as const;

const TERMINAL_EVENT_STATUS: Record<
  (typeof TERMINAL_RELEASE_EVENT_TYPES)[number],
  "live" | "failed" | "rejected"
> = {
  "release.live": "live",
  "release.failed": "failed",
  "release.rejected": "rejected",
};

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
      `UPDATE releases SET status = 'live', updated_at = ?
       WHERE release_id = ? AND publication_name = ?
         AND status IN ('publishing', 'reconciling')
         AND NOT EXISTS (
           SELECT 1 FROM release_events
           WHERE release_id = releases.release_id
             AND type IN ('release.live', 'release.failed', 'release.rejected')
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
    (results[2]?.meta.changes ?? 0) === 1 &&
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

export async function getOwnedRevision(
  env: Env,
  projectId: string,
  revisionId: string,
  subject: string,
): Promise<RevisionRow | null> {
  return env.DB.prepare(
    `SELECT r.*
       FROM revisions AS r
       INNER JOIN projects AS p ON p.project_id = r.project_id
      WHERE r.project_id = ? AND r.revision_id = ? AND p.owner_subject = ?`,
  )
    .bind(projectId, revisionId, subject)
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

/**
 * Return the durable terminal fence for a release. A terminal event remains
 * authoritative even if a legacy writer left the row status nonterminal.
 */
export async function hasTerminalReleaseOutcome(env: Env, releaseId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT (
       EXISTS (
         SELECT 1 FROM releases
         WHERE release_id = ? AND status IN ('live', 'failed', 'rejected')
       )
       OR EXISTS (
         SELECT 1 FROM release_events
         WHERE release_id = ?
           AND type IN ('release.live', 'release.failed', 'release.rejected')
       )
     ) AS terminal_outcome`,
  )
    .bind(releaseId, releaseId)
    .first<{ terminal_outcome: number }>();
  return row?.terminal_outcome === 1;
}

export interface ReleaseTransitionOptions {
  releaseId: string;
  from: readonly ReleaseStatus[];
  to: ReleaseStatus;
  type: string;
  detail?: Record<string, unknown>;
  actorSubject?: string;
  set?: {
    preparedKey?: string;
    preparedDigest?: string;
    publicationName?: string | null;
  };
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

async function transitionStateAfterFence(
  env: Env,
  releaseId: string,
  status: ReleaseStatus,
  type: string,
): Promise<ReleaseTransitionResult> {
  const row = await env.DB.prepare(
    `SELECT status,
       EXISTS (
         SELECT 1 FROM release_events
         WHERE release_id = ? AND type = ?
       ) AS matching_event,
       EXISTS (
         SELECT 1 FROM release_events
         WHERE release_id = ? AND type IN (${TERMINAL_RELEASE_EVENT_TYPES.map(() => "?").join(", ")})
       ) AS terminal_event
     FROM releases WHERE release_id = ?`,
  )
    .bind(releaseId, type, releaseId, ...TERMINAL_RELEASE_EVENT_TYPES, releaseId)
    .first<{
      status: ReleaseStatus;
      matching_event: number;
      terminal_event: number;
    }>();
  if (!row) return { state: "fenced" };
  if (
    row.matching_event === 1 &&
    row.status === status &&
    TERMINAL_RELEASE_EVENT_TYPES.includes(type as (typeof TERMINAL_RELEASE_EVENT_TYPES)[number])
  ) {
    return { state: "already_applied" };
  }
  if (
    row.terminal_event === 1 ||
    TERMINAL_RELEASE_STATUSES.some((terminal) => terminal === row.status)
  ) {
    return { state: "fenced" };
  }
  if (row.matching_event === 1 && row.status === status) {
    return { state: "already_applied" };
  }
  return { state: "fenced" };
}

/**
 * Apply one release state transition and its event as one conditional D1
 * transaction. A terminal event fences every later nonterminal transition;
 * replaying the exact event is an idempotent no-op.
 */
export async function transitionReleaseStatus(
  env: Env,
  options: ReleaseTransitionOptions,
): Promise<ReleaseTransitionResult> {
  if (options.from.length === 0) {
    throw new ApiError(
      500,
      "release_transition_configuration_error",
      "The release transition has no allowed predecessor state.",
    );
  }
  if (options.type.length === 0) {
    throw new ApiError(
      500,
      "release_transition_configuration_error",
      "The release transition has no event type.",
    );
  }
  const terminalStatus = Object.hasOwn(TERMINAL_EVENT_STATUS, options.type)
    ? TERMINAL_EVENT_STATUS[options.type as keyof typeof TERMINAL_EVENT_STATUS]
    : undefined;
  if (terminalStatus !== undefined && terminalStatus !== options.to) {
    throw new ApiError(
      500,
      "release_transition_configuration_error",
      "The release transition event does not match its status.",
    );
  }

  const now = new Date().toISOString();
  const setClauses = ["status = ?", "updated_at = ?"];
  const setValues: unknown[] = [options.to, now];
  if (options.set?.preparedKey !== undefined) {
    setClauses.push("prepared_key = ?");
    setValues.push(options.set.preparedKey);
  }
  if (options.set?.preparedDigest !== undefined) {
    setClauses.push("prepared_digest = ?");
    setValues.push(options.set.preparedDigest);
  }
  if (options.set && Object.hasOwn(options.set, "publicationName")) {
    setClauses.push("publication_name = ?");
    setValues.push(options.set.publicationName ?? null);
  }

  const predecessorSql = placeholders(options.from.length);
  const terminalEventSql = TERMINAL_RELEASE_EVENT_TYPES.map(() => "?").join(", ");
  const updateSql = `UPDATE releases
     SET ${setClauses.join(", ")}
     WHERE release_id = ?
       AND status IN (${predecessorSql})
       AND NOT EXISTS (
         SELECT 1 FROM release_events
         WHERE release_id = releases.release_id
           AND type IN (${terminalEventSql})
       )
       AND NOT EXISTS (
         SELECT 1 FROM release_events
         WHERE release_id = releases.release_id AND type = ?
       )`;
  const updateValues = [
    ...setValues,
    options.releaseId,
    ...options.from,
    ...TERMINAL_RELEASE_EVENT_TYPES,
    options.type,
  ];
  const insertSql = `INSERT INTO release_events
       (release_id, sequence, type, occurred_at, actor_subject, detail_json)
     SELECT ?, COALESCE((SELECT MAX(sequence) + 1 FROM release_events WHERE release_id = ?), 1), ?, ?, ?, ?
     WHERE changes() = 1`;
  const results = await env.DB.batch([
    env.DB.prepare(updateSql).bind(...updateValues),
    env.DB.prepare(insertSql).bind(
      options.releaseId,
      options.releaseId,
      options.type,
      now,
      options.actorSubject ?? null,
      JSON.stringify(options.detail ?? {}),
    ),
  ]);
  const updated = (results[0]?.meta.changes ?? 0) === 1;
  const eventInserted = (results[1]?.meta.changes ?? 0) === 1;
  if (updated && eventInserted) return { state: "applied" };
  if (updated || eventInserted) {
    throw new ApiError(
      500,
      "release_transition_persist_failed",
      "The release transition did not persist its row and event together.",
    );
  }
  return transitionStateAfterFence(env, options.releaseId, options.to, options.type);
}

const NONTERMINAL_PREDECESSORS: Record<
  Exclude<ReleaseStatus, (typeof TERMINAL_RELEASE_STATUSES)[number]>,
  readonly ReleaseStatus[]
> = {
  validating: ["queued"],
  building: ["validating"],
  prepared: ["validating", "building"],
  awaiting_approval: ["prepared"],
  publishing: ["prepared", "awaiting_approval"],
  reconciling: ["publishing"],
  queued: [],
};

export async function appendReleaseStatus(
  env: Env,
  releaseId: string,
  status: Exclude<ReleaseStatus, (typeof TERMINAL_RELEASE_STATUSES)[number]>,
  type: string,
  detail: Record<string, unknown> = {},
  actorSubject?: string,
): Promise<ReleaseTransitionResult> {
  const from = NONTERMINAL_PREDECESSORS[status];
  if (!from || from.length === 0) {
    throw new ApiError(
      500,
      "release_transition_configuration_error",
      `The release transition to ${status} is not configured.`,
    );
  }
  return transitionReleaseStatus(env, {
    releaseId,
    from,
    to: status,
    type,
    detail,
    actorSubject,
  });
}

export async function appendTerminalStatus(
  env: Env,
  releaseId: string,
  status: "live" | "failed" | "rejected",
  type: "release.live" | "release.failed" | "release.rejected",
  detail: Record<string, unknown> = {},
): Promise<boolean> {
  const result = await transitionReleaseStatus(env, {
    releaseId,
    from: NONTERMINAL_RELEASE_STATUSES,
    to: status,
    type,
    detail,
  });
  return result.state === "applied";
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
