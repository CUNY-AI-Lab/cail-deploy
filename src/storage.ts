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
    env.DB.prepare("UPDATE releases SET status = ?, updated_at = ? WHERE release_id = ?").bind(
      status,
      now,
      releaseId,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO release_events (release_id, sequence, type, occurred_at, detail_json)
         VALUES (?, COALESCE((SELECT MAX(sequence) + 1 FROM release_events WHERE release_id = ?), 1), ?, ?, ?)`,
    ).bind(releaseId, releaseId, type, now, JSON.stringify(detail)),
  ]);
  return (results[1]?.meta.changes ?? 0) === 1;
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
