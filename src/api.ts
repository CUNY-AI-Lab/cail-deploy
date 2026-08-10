import { publicationTimeoutMs, publishWorker } from "./adapters/cloudflare/wfp";
import type { Principal } from "./auth";
import { authenticate } from "./auth";
import { emitDeployDiagnostic, observeDetachedCleanup } from "./diagnostics";
import {
  approvalSchema,
  artifactSchema,
  createProjectSchema,
  createReleaseSchema,
  PROJECT_PATTERN,
  RELEASE_PATTERN,
  rollbackSchema,
} from "./domain/contracts";
import {
  bytesToHex,
  canonicalJson,
  opaqueId,
  parseContentDigest,
  sha256Hex,
} from "./domain/digests";
import { ApiError, apiErrorSnapshot } from "./domain/errors";
import type { Env, ReleaseWorkflowParams } from "./env";
import {
  emitReleaseAdmission,
  emitReleaseTerminal,
  operationalLogSubject,
} from "./operational-events";
import {
  acquireReconciliationAuthority,
  completeReconciliation,
  getOwnedRevision,
  getRevision,
  idempotentResponse,
  type ReleaseRow,
  releaseReconciliationAuthority,
  requireOwnedProject,
  requireRelease,
} from "./storage";
import type { RevisionRow } from "./storage";
import type { PreparedEnvelope } from "./workflow";

const ARTIFACT_MEDIA_TYPE = "application/vnd.cuny.kale.artifact.v1+json";
export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
export const MAX_RELEASE_EVENT_COUNT = 256;
export const MAX_RELEASE_EVENT_HISTORY_BYTES = 1024 * 1024;
const DEFAULT_PREVIEW_TIMEOUT_MS = 5_000;
const MIN_PREVIEW_TIMEOUT_MS = 100;
const MAX_PREVIEW_TIMEOUT_MS = 30_000;
const RECONCILIATION_LEASE_MULTIPLIER = 2;
export const RELEASE_INSERT_SQL = `INSERT INTO releases (release_id, project_id, revision_id, target, approval, status, workflow_instance_id, rollback_of_release_id, operational_subject, request_id, admitted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`;

export function previewTimeoutMs(raw: string | undefined): number {
  const value = raw === undefined ? DEFAULT_PREVIEW_TIMEOUT_MS : Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_PREVIEW_TIMEOUT_MS ||
    value > MAX_PREVIEW_TIMEOUT_MS
  ) {
    throw new ApiError(
      503,
      "preview_configuration_error",
      "Kale Deploy isn't set up correctly right now.",
    );
  }
  return value;
}

export function reconciliationLeaseMs(raw: string | undefined): number {
  return publicationTimeoutMs(raw) * RECONCILIATION_LEASE_MULTIPLIER;
}

export async function ensureWorkflowInstance(
  env: Pick<Env, "RELEASE_WORKFLOW">,
  id: string,
  params: ReleaseWorkflowParams,
): Promise<void> {
  try {
    await env.RELEASE_WORKFLOW.create({ id, params });
    return;
  } catch (createCause) {
    try {
      await env.RELEASE_WORKFLOW.get(id);
      return;
    } catch (recoveryCause) {
      throw new ApiError(
        503,
        "workflow_start_failed",
        "We saved your release but couldn't start it. Check back shortly.",
        {
          cause: new AggregateError(
            [createCause, recoveryCause],
            "Workflow creation and recovery both failed.",
          ),
        },
      );
    }
  }
}

function workflowParams(release: ReleaseRow): ReleaseWorkflowParams {
  return {
    projectId: release.project_id,
    releaseId: release.release_id,
    revisionId: release.revision_id,
    requestId: release.request_id,
    ...(release.operational_subject ? { logSubject: release.operational_subject } : {}),
    admittedAt: release.admitted_at,
  };
}

function requiredIdempotencyKey(request: Request): string {
  const key = request.headers.get("Idempotency-Key");
  if (!key || key.length > 120 || !/^[A-Za-z0-9._:-]+$/u.test(key)) {
    throw new ApiError(
      400,
      "idempotency_key_required",
      "The Idempotency-Key header is missing or invalid.",
    );
  }
  return key;
}

async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiError(400, "invalid_json", "The request body must be valid JSON.");
  }
}

function parsedBody<T>(result: { success: true; data: T } | { success: false }): T {
  if (!result.success)
    throw new ApiError(400, "invalid_request", "The request body doesn't match what's expected.");
  return result.data;
}

function cancelRequestBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  requestId: string,
): void {
  observeDetachedCleanup(() => reader.cancel(), "request_body_cancel_failed", { requestId });
}

function requestCancelled(requestId: string, cause: unknown): ApiError {
  return new ApiError(499, "request_cancelled", "The request was cancelled.", {
    cause,
  });
}

async function readArtifactChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  requestId: string,
  cancel: () => void,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    cancel();
    throw requestCancelled(requestId, signal.reason);
  }

  return await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    let settled = false;
    const finish = (continuation: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      continuation();
    };
    const onAbort = () => {
      cancel();
      finish(() => reject(requestCancelled(requestId, signal.reason)));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(
      (result) => finish(() => resolve(result)),
      (cause) => finish(() => reject(cause)),
    );
  });
}

function releaseRequestBodyReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  requestId: string,
): void {
  try {
    reader.releaseLock();
  } catch {
    emitDeployDiagnostic("request_body_release_failed", { requestId });
  }
}

export async function readArtifactBody(request: Request, requestId: string): Promise<Uint8Array> {
  const declaredLength = request.headers.get("Content-Length");
  if (
    declaredLength !== null &&
    /^\d+$/u.test(declaredLength) &&
    Number(declaredLength) > MAX_ARTIFACT_BYTES
  ) {
    if (request.body) {
      const reader = request.body.getReader();
      cancelRequestBody(reader, requestId);
      releaseRequestBodyReader(reader, requestId);
    }
    throw new ApiError(
      413,
      "artifact_size_invalid",
      "Your upload must be between 1 byte and 2 MiB.",
    );
  }

  if (!request.body) {
    throw new ApiError(
      413,
      "artifact_size_invalid",
      "Your upload must be between 1 byte and 2 MiB.",
    );
  }

  const reader = request.body.getReader();
  const signal = request.signal ?? new AbortController().signal;
  const chunks: Uint8Array[] = [];
  let total = 0;
  let cancellationStarted = false;
  const cancel = () => {
    if (cancellationStarted) return;
    cancellationStarted = true;
    cancelRequestBody(reader, requestId);
  };
  try {
    while (true) {
      const { done, value } = await readArtifactChunk(reader, signal, requestId, cancel);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ARTIFACT_BYTES) {
        cancel();
        throw new ApiError(
          413,
          "artifact_size_invalid",
          "Your upload must be between 1 byte and 2 MiB.",
        );
      }
      chunks.push(value);
    }
  } finally {
    releaseRequestBodyReader(reader, requestId);
  }

  if (total === 0) {
    throw new ApiError(
      413,
      "artifact_size_invalid",
      "Your upload must be between 1 byte and 2 MiB.",
    );
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function releaseResponse(release: ReleaseRow) {
  return {
    projectId: release.project_id,
    releaseId: release.release_id,
    revisionId: release.revision_id,
    target: release.target,
    approval: release.approval,
    status: release.status,
    workflowInstanceId: release.workflow_instance_id,
    preparedDigest: release.prepared_digest,
    publicationName: release.publication_name,
    rollbackOfReleaseId: release.rollback_of_release_id,
    createdAt: release.created_at,
    updatedAt: release.updated_at,
  };
}

async function createProject(request: Request, env: Env, subject: string): Promise<Response> {
  const body = parsedBody(createProjectSchema.safeParse(await jsonBody(request)));
  const key = requiredIdempotencyKey(request);
  const requestDigest = await sha256Hex(canonicalJson(body));
  const scope = `subject:${subject}`;
  const replay = await idempotentResponse(env, scope, "create_project", key, requestDigest);
  if (replay) return Response.json(replay, { status: 200 });

  const projectId = opaqueId("prj");
  const createdAt = new Date().toISOString();
  const response = { projectId, name: body.name, createdAt };
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO projects (project_id, owner_subject, name, created_at) VALUES (?, ?, ?, ?)",
    ).bind(projectId, subject, body.name, createdAt),
    env.DB.prepare(
      "INSERT INTO idempotency (project_id, operation, idempotency_key, request_digest, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(scope, "create_project", key, requestDigest, JSON.stringify(response), createdAt),
  ]);
  return Response.json(response, { status: 201 });
}

async function uploadRevision(
  request: Request,
  env: Env,
  subject: string,
  projectId: string,
  requestId: string,
): Promise<Response> {
  await requireOwnedProject(env, projectId, subject);
  if (request.headers.get("Content-Type")?.split(";", 1)[0] !== ARTIFACT_MEDIA_TYPE) {
    throw new ApiError(
      415,
      "unsupported_media_type",
      `Content-Type must be ${ARTIFACT_MEDIA_TYPE}.`,
    );
  }
  const expected = parseContentDigest(request.headers.get("Content-Digest"));
  if (expected?.byteLength !== 32) {
    throw new ApiError(
      400,
      "content_digest_required",
      "The Content-Digest header must contain one SHA-256 digest.",
    );
  }
  const bytes = await readArtifactBody(request, requestId);
  const digest = await sha256Hex(bytes);
  if (digest !== bytesToHex(expected)) {
    throw new ApiError(400, "digest_mismatch", "Content-Digest does not match the uploaded bytes.");
  }
  let artifactJson: unknown;
  try {
    artifactJson = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError(400, "artifact_json_invalid", "Your upload must be valid JSON.");
  }
  const artifact = parsedBody(artifactSchema.safeParse(artifactJson));
  if (artifact.requestedBindings.length > 0) {
    throw new ApiError(
      422,
      "binding_not_supported",
      "This environment doesn't attach project resources or secrets.",
    );
  }

  const revisionId = `rev_sha256_${digest}`;
  const existing = await getRevision(env, projectId, revisionId);
  if (existing) {
    await requireConsistentRevisionArtifact(env, existing);
    return Response.json(revisionResponse(existing), { status: 200 });
  }

  const artifactKey = `revisions/${projectId}/${revisionId}.json`;
  await env.ARTIFACTS.put(artifactKey, bytes, {
    sha256: expected,
    customMetadata: { projectId, revisionId, artifactDigest: digest },
  });
  const createdAt = new Date().toISOString();
  const insert = await env.DB.prepare(
    "INSERT OR IGNORE INTO revisions (project_id, revision_id, artifact_digest, artifact_bytes, artifact_key, status, created_at) VALUES (?, ?, ?, ?, ?, 'ready', ?)",
  )
    .bind(projectId, revisionId, digest, bytes.byteLength, artifactKey, createdAt)
    .run();
  if ((insert.meta.changes ?? 0) !== 1) {
    const winner = await getRevision(env, projectId, revisionId);
    if (!winner) {
      throw new ApiError(
        409,
        "artifact_store_inconsistent",
        "Something went wrong saving your upload. Try again.",
      );
    }
    await requireConsistentRevisionArtifact(env, winner);
    return Response.json(revisionResponse(winner), { status: 200 });
  }
  return Response.json(
    revisionResponse({
      project_id: projectId,
      revision_id: revisionId,
      artifact_digest: digest,
      artifact_bytes: bytes.byteLength,
      artifact_key: artifactKey,
      status: "ready",
      created_at: createdAt,
    }),
    { status: 201 },
  );
}

function revisionResponse(revision: RevisionRow): {
  projectId: string;
  revisionId: string;
  artifactDigest: string;
  artifactBytes: number;
  status: "ready" | "failed";
  createdAt: string;
} {
  return {
    projectId: revision.project_id,
    revisionId: revision.revision_id,
    artifactDigest: revision.artifact_digest,
    artifactBytes: revision.artifact_bytes,
    status: revision.status,
    createdAt: revision.created_at,
  };
}

async function requireConsistentRevisionArtifact(env: Env, revision: RevisionRow): Promise<void> {
  const expectedKey = `revisions/${revision.project_id}/${revision.revision_id}.json`;
  if (
    !/^[0-9a-f]{64}$/u.test(revision.artifact_digest) ||
    revision.revision_id !== `rev_sha256_${revision.artifact_digest}` ||
    revision.status !== "ready" ||
    revision.artifact_key !== expectedKey
  ) {
    throw new ApiError(
      409,
      "artifact_store_inconsistent",
      "Something went wrong saving your upload. Try again.",
    );
  }
  const artifact = await env.ARTIFACTS.head(expectedKey);
  const checksum = artifact?.checksums.sha256;
  if (
    !artifact ||
    artifact.key !== expectedKey ||
    artifact.size !== revision.artifact_bytes ||
    artifact.customMetadata?.projectId !== revision.project_id ||
    artifact.customMetadata?.revisionId !== revision.revision_id ||
    artifact.customMetadata?.artifactDigest !== revision.artifact_digest ||
    !checksum ||
    bytesToHex(new Uint8Array(checksum)) !== revision.artifact_digest
  ) {
    throw new ApiError(
      409,
      "artifact_store_inconsistent",
      "Something went wrong saving your upload. Try again.",
    );
  }
}

async function getRevisionResponse(
  env: Env,
  subject: string,
  projectId: string,
  revisionId: string,
): Promise<Response> {
  const revision = await getOwnedRevision(env, projectId, revisionId, subject);
  if (!revision) {
    throw new ApiError(404, "revision_not_found", "The revision was not found.");
  }
  await requireConsistentRevisionArtifact(env, revision);
  return Response.json(revisionResponse(revision));
}

async function startRelease(
  request: Request,
  env: Env,
  subject: string,
  projectId: string,
  rollbackOfReleaseId: string | null = null,
  requestId: string,
  signedOperationalSubject?: string,
): Promise<Response> {
  await requireOwnedProject(env, projectId, subject);
  const rawBody = await jsonBody(request);
  const rollbackBody = rollbackOfReleaseId ? parsedBody(rollbackSchema.safeParse(rawBody)) : null;
  const releaseBody = rollbackOfReleaseId
    ? null
    : parsedBody(createReleaseSchema.safeParse(rawBody));
  const source = rollbackOfReleaseId
    ? await requireRelease(env, projectId, rollbackOfReleaseId)
    : null;
  if (source && (source.status !== "live" || !source.prepared_key || !source.prepared_digest)) {
    throw new ApiError(
      409,
      "rollback_source_unavailable",
      "You can only roll back to a release that is still live.",
    );
  }
  const revisionId = source?.revision_id ?? releaseBody?.revisionId;
  const target = source?.target ?? releaseBody?.target;
  const approval = rollbackBody?.approval ?? releaseBody?.approval;
  if (!revisionId || !target || !approval)
    throw new ApiError(400, "invalid_request", "The release request is incomplete.");
  if (target === "production" && env.ALLOW_PRODUCTION_TARGET !== "1") {
    throw new ApiError(
      403,
      "production_target_denied",
      "This environment only supports preview releases.",
    );
  }
  const revision = await getRevision(env, projectId, revisionId);
  if (!revision) throw new ApiError(404, "revision_not_found", "The revision was not found.");
  await requireConsistentRevisionArtifact(env, revision);

  const key = requiredIdempotencyKey(request);
  const requestShape = { revisionId, target, approval, rollbackOfReleaseId };
  const requestDigest = await sha256Hex(canonicalJson(requestShape));
  const operation = rollbackOfReleaseId ? `rollback:${rollbackOfReleaseId}` : "create_release";
  const replay = await idempotentResponse(env, projectId, operation, key, requestDigest);
  if (replay) {
    const replayReleaseId =
      typeof replay === "object" &&
      replay !== null &&
      "releaseId" in replay &&
      typeof replay.releaseId === "string" &&
      RELEASE_PATTERN.test(replay.releaseId)
        ? replay.releaseId
        : null;
    if (!replayReleaseId) {
      throw new ApiError(
        500,
        "idempotency_record_invalid",
        "Something went wrong processing this release. Try again.",
      );
    }
    const replayRelease = await requireRelease(env, projectId, replayReleaseId);
    await ensureWorkflowInstance(
      env,
      replayRelease.workflow_instance_id,
      workflowParams(replayRelease),
    );
    return Response.json(replay, { status: 200 });
  }

  const releaseId = opaqueId("rel");
  const now = new Date().toISOString();
  const logSubject = operationalLogSubject(subject, signedOperationalSubject);
  const response = {
    projectId,
    releaseId,
    revisionId,
    target,
    approval,
    status: "queued",
    workflowInstanceId: releaseId,
    rollbackOfReleaseId,
    createdAt: now,
    updatedAt: now,
  };
  await env.DB.batch([
    env.DB.prepare(RELEASE_INSERT_SQL).bind(
      releaseId,
      projectId,
      revisionId,
      target,
      approval,
      releaseId,
      rollbackOfReleaseId,
      logSubject ?? null,
      requestId,
      now,
      now,
      now,
    ),
    env.DB.prepare(
      "INSERT INTO release_events (release_id, sequence, type, occurred_at, actor_subject, detail_json) VALUES (?, 1, 'release.queued', ?, ?, ?)",
    ).bind(releaseId, now, subject, JSON.stringify({ revisionId, target, rollbackOfReleaseId })),
    env.DB.prepare(
      "INSERT INTO idempotency (project_id, operation, idempotency_key, request_digest, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(projectId, operation, key, requestDigest, JSON.stringify(response), now),
  ]);
  emitReleaseAdmission(env, releaseId, requestId, logSubject);
  await ensureWorkflowInstance(env, releaseId, {
    projectId,
    releaseId,
    revisionId,
    requestId,
    ...(logSubject ? { logSubject } : {}),
    admittedAt: now,
  });
  return Response.json(response, { status: 202 });
}

export interface ReleaseEventHistoryEntry {
  sequence: number;
  type: string;
  occurredAt: string;
  actorSubject: string | null;
  detail: unknown;
}

export async function readReleaseEventHistory(
  db: Env["DB"],
  releaseId: string,
): Promise<ReleaseEventHistoryEntry[]> {
  const historySizeSql = `length(CAST(type AS BLOB))
    + length(CAST(occurred_at AS BLOB))
    + COALESCE(length(CAST(actor_subject AS BLOB)), 0)
    + COALESCE(length(CAST(detail_json AS BLOB)), 0)`;
  const summary = await db
    .prepare(
      `SELECT COUNT(*) AS event_count, COALESCE(SUM(${historySizeSql}), 0) AS event_bytes
       FROM release_events WHERE release_id = ?`,
    )
    .bind(releaseId)
    .first<{ event_count: number; event_bytes: number }>();
  if (
    !summary ||
    !Number.isSafeInteger(summary.event_count) ||
    !Number.isSafeInteger(summary.event_bytes) ||
    summary.event_count < 0 ||
    summary.event_bytes < 0 ||
    summary.event_count > MAX_RELEASE_EVENT_COUNT ||
    summary.event_bytes > MAX_RELEASE_EVENT_HISTORY_BYTES
  ) {
    throw new ApiError(
      503,
      "release_history_too_large",
      "This release's history is too long to show.",
    );
  }
  const events = await db
    .prepare(
      `SELECT sequence, type, occurred_at, actor_subject, detail_json,
            ${historySizeSql} AS event_bytes
       FROM release_events WHERE release_id = ? ORDER BY sequence
       LIMIT ?`,
    )
    .bind(releaseId, MAX_RELEASE_EVENT_COUNT + 1)
    .all<{
      sequence: number;
      type: string;
      occurred_at: string;
      actor_subject: string | null;
      detail_json: string | null;
      event_bytes: number;
    }>();
  const observedBytes = events.results.reduce((total, event) => {
    if (!Number.isSafeInteger(event.event_bytes) || event.event_bytes < 0) {
      return Number.NaN;
    }
    return total + event.event_bytes;
  }, 0);
  if (
    events.results.length > MAX_RELEASE_EVENT_COUNT ||
    !Number.isSafeInteger(observedBytes) ||
    observedBytes > MAX_RELEASE_EVENT_HISTORY_BYTES
  ) {
    throw new ApiError(
      503,
      "release_history_too_large",
      "This release's history is too long to show.",
    );
  }
  return events.results.map((event) => ({
    sequence: event.sequence,
    type: event.type,
    occurredAt: event.occurred_at,
    actorSubject: event.actor_subject,
    detail: event.detail_json === null ? null : (JSON.parse(event.detail_json) as unknown),
  }));
}

async function getReleaseResponse(
  env: Env,
  subject: string,
  projectId: string,
  releaseId: string,
): Promise<Response> {
  await requireOwnedProject(env, projectId, subject);
  const release = await requireRelease(env, projectId, releaseId);
  const events = await readReleaseEventHistory(env.DB, releaseId);
  return Response.json({
    ...releaseResponse(release),
    events,
  });
}

async function previewProject(
  request: Request,
  env: Env,
  subject: string,
  projectId: string,
): Promise<Response> {
  await requireOwnedProject(env, projectId, subject);
  const release = await env.DB.prepare(
    "SELECT * FROM releases WHERE project_id = ? AND status = 'live' ORDER BY updated_at DESC LIMIT 1",
  )
    .bind(projectId)
    .first<ReleaseRow>();
  if (!release?.publication_name)
    throw new ApiError(404, "live_release_not_found", "The project has no live release.");
  const headers = new Headers(request.headers);
  headers.delete("Authorization");
  headers.delete("X-CAIL-Identity-JWT");
  const signal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(previewTimeoutMs(env.PREVIEW_TIMEOUT_MS)),
  ]);
  if (signal.aborted) {
    throw new ApiError(503, "preview_unavailable", "The live preview is unavailable.", {
      cause: signal.reason,
    });
  }
  const target = new Request(new URL("/", request.url), {
    method: "GET",
    headers,
    signal,
  });
  try {
    return await env.DISPATCHER.get(release.publication_name).fetch(target);
  } catch (cause) {
    throw new ApiError(503, "preview_unavailable", "The live preview is unavailable.", {
      cause,
    });
  }
}

async function approveRelease(
  request: Request,
  env: Env,
  subject: string,
  projectId: string,
  releaseId: string,
): Promise<Response> {
  await requireOwnedProject(env, projectId, subject);
  parsedBody(approvalSchema.safeParse(await jsonBody(request)));
  const release = await requireRelease(env, projectId, releaseId);
  const key = requiredIdempotencyKey(request);
  const requestDigest = await sha256Hex(
    canonicalJson({ decision: "approved", revisionId: release.revision_id }),
  );
  const replay = await idempotentResponse(
    env,
    projectId,
    `approve:${releaseId}`,
    key,
    requestDigest,
  );
  if (replay) {
    if (release.status === "awaiting_approval" && release.approved_by_subject === subject) {
      await sendApprovalEvent(env, release, subject);
    }
    return Response.json(replay, { status: 200 });
  }
  if (release.status !== "awaiting_approval") {
    throw new ApiError(
      409,
      "release_not_awaiting_approval",
      "The release is not waiting for approval.",
    );
  }
  const now = new Date().toISOString();
  const response = {
    projectId,
    releaseId,
    revisionId: release.revision_id,
    decision: "approved",
    acceptedAt: now,
  };
  const approvalResults = await env.DB.batch([
    env.DB.prepare(
      `UPDATE releases SET approved_by_subject = ?, updated_at = ?
       WHERE release_id = ? AND status = 'awaiting_approval' AND approved_by_subject IS NULL`,
    ).bind(subject, now, releaseId),
    env.DB.prepare(
      `INSERT INTO release_events (release_id, sequence, type, occurred_at, actor_subject, detail_json)
       SELECT ?, COALESCE((SELECT MAX(sequence) + 1 FROM release_events WHERE release_id = ?), 1), 'release.approval_accepted', ?, ?, ?
       WHERE changes() = 1`,
    ).bind(releaseId, releaseId, now, subject, JSON.stringify({ revisionId: release.revision_id })),
    env.DB.prepare(
      `INSERT INTO idempotency (project_id, operation, idempotency_key, request_digest, response_json, created_at)
       SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
    ).bind(projectId, `approve:${releaseId}`, key, requestDigest, JSON.stringify(response), now),
  ]);
  if ((approvalResults[0]?.meta.changes ?? 0) !== 1) {
    // Two callers can both observe an empty idempotency record before either
    // approval transaction commits. The compare-and-set above correctly lets
    // only one caller accept the approval, but the loser must re-read the
    // committed record so a concurrent retry with the same key remains
    // idempotent instead of surfacing a spurious conflict.
    const concurrentReplay = await idempotentResponse(
      env,
      projectId,
      `approve:${releaseId}`,
      key,
      requestDigest,
    );
    if (concurrentReplay) {
      const currentRelease = await requireRelease(env, projectId, releaseId);
      if (
        currentRelease.status === "awaiting_approval" &&
        currentRelease.approved_by_subject === subject
      ) {
        await sendApprovalEvent(env, currentRelease, subject);
      }
      return Response.json(concurrentReplay, { status: 200 });
    }
    throw new ApiError(
      409,
      "release_approval_already_accepted",
      "This release was already approved.",
    );
  }
  await sendApprovalEvent(env, release, subject);
  return Response.json(response, { status: 202 });
}

export async function sendApprovalEvent(
  env: Env,
  release: ReleaseRow,
  subject: string,
): Promise<void> {
  try {
    const instance = await env.RELEASE_WORKFLOW.get(release.workflow_instance_id);
    await instance.sendEvent({
      type: "release-approval",
      payload: { decision: "approved", actorSubject: subject, revisionId: release.revision_id },
    });
  } catch (cause) {
    throw new ApiError(
      503,
      "approval_delivery_failed",
      "We saved your approval but couldn't finish applying it. Try again.",
      { cause },
    );
  }
}

async function reconcileRelease(
  env: Env,
  subject: string,
  projectId: string,
  releaseId: string,
  requestId: string,
): Promise<Response> {
  await requireOwnedProject(env, projectId, subject);
  const release = await requireRelease(env, projectId, releaseId);
  const recoverable = ["publishing", "reconciling"].includes(release.status);
  if (!release.prepared_key || !release.prepared_digest) {
    throw new ApiError(
      409,
      "release_not_reconcilable",
      "There is nothing left to finish on this release.",
    );
  }
  const requestDigest = await sha256Hex(
    canonicalJson({
      releaseId,
      revisionId: release.revision_id,
      preparedKey: release.prepared_key,
      preparedDigest: release.prepared_digest,
    }),
  );
  let authority;
  try {
    authority = await acquireReconciliationAuthority(
      env,
      release,
      requestId,
      requestDigest,
      reconciliationLeaseMs(env.WFP_PUBLISH_TIMEOUT_MS),
    );
  } catch (cause) {
    if (apiErrorSnapshot(cause)) throw cause;
    throw new ApiError(
      503,
      "reconciliation_authority_unavailable",
      "Something went wrong processing this release. Try again.",
      { cause },
    );
  }
  if (authority.state === "complete") {
    const current = await requireRelease(env, projectId, releaseId);
    if (current.status !== "live" || current.publication_name !== authority.publicationName) {
      throw new ApiError(
        409,
        "release_not_reconcilable",
        "There is nothing left to finish on this release.",
      );
    }
    return Response.json(releaseResponse(current));
  }
  if (!recoverable || authority.state === "blocked") {
    throw new ApiError(
      409,
      "release_not_reconcilable",
      "There is nothing left to finish on this release.",
    );
  }
  if (authority.state === "in_progress") {
    throw new ApiError(
      409,
      "release_reconciliation_in_progress",
      "This release is already being processed. Try again in a moment.",
    );
  }

  const retained = await env.ARTIFACTS.get(release.prepared_key);
  if (!retained)
    throw new ApiError(
      409,
      "prepared_artifact_missing",
      "The files saved for this release are missing.",
    );
  const json = await retained.text();
  if ((await sha256Hex(json)) !== release.prepared_digest) {
    throw new ApiError(
      409,
      "prepared_digest_mismatch",
      "The files saved for this release failed their check.",
    );
  }

  try {
    const name = await publishWorker(
      env,
      projectId,
      release.revision_id,
      JSON.parse(json) as PreparedEnvelope,
    );
    let completed: boolean;
    try {
      completed = await completeReconciliation(
        env,
        release,
        name,
        requestDigest,
        authority.token,
        requestId,
      );
    } catch (cause) {
      throw new ApiError(
        503,
        "reconciliation_persist_failed",
        "Something went wrong processing this release. Try again.",
        { cause },
      );
    }
    if (!completed) {
      throw new ApiError(
        409,
        "release_reconciliation_raced",
        "This release is already being processed. Try again in a moment.",
      );
    }
    emitReleaseTerminal(
      env,
      releaseId,
      release.request_id,
      release.operational_subject ?? undefined,
      release.admitted_at,
      "ok",
      "completed",
    );
    const current = await requireRelease(env, projectId, releaseId);
    if (current.status !== "live" || current.publication_name !== name) {
      throw new ApiError(
        409,
        "release_reconciliation_raced",
        "This release is already being processed. Try again in a moment.",
      );
    }
    return Response.json(releaseResponse(current));
  } catch (primary) {
    try {
      await releaseReconciliationAuthority(env, release, requestDigest, authority.token);
    } catch {
      emitDeployDiagnostic("reconcile_claim_release_failed", { releaseId, requestId });
    }
    throw primary;
  }
}

export async function handleApi(
  request: Request,
  env: Env,
  requestId: string = crypto.randomUUID(),
): Promise<Response> {
  const principal = await authenticate(request, env);
  return handleApiForPrincipal(request, env, principal, requestId);
}

export async function handleApiForPrincipal(
  request: Request,
  env: Env,
  principal: Principal,
  requestId: string = crypto.randomUUID(),
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/v1/projects")
    return createProject(request, env, principal.subject);

  const revisionMatch = url.pathname.match(/^\/v1\/projects\/(prj_[0-9a-f]{32})\/revisions$/u);
  if (request.method === "POST" && revisionMatch?.[1])
    return uploadRevision(request, env, principal.subject, revisionMatch[1], requestId);

  const revisionItemMatch = url.pathname.match(
    /^\/v1\/projects\/(prj_[0-9a-f]{32})\/revisions\/(rev_sha256_[0-9a-f]{64})$/u,
  );
  if (request.method === "GET" && revisionItemMatch?.[1] && revisionItemMatch[2])
    return getRevisionResponse(env, principal.subject, revisionItemMatch[1], revisionItemMatch[2]);

  const previewMatch = url.pathname.match(/^\/v1\/projects\/(prj_[0-9a-f]{32})\/preview$/u);
  if (request.method === "GET" && previewMatch?.[1])
    return previewProject(request, env, principal.subject, previewMatch[1]);

  const releasesMatch = url.pathname.match(/^\/v1\/projects\/(prj_[0-9a-f]{32})\/releases$/u);
  if (request.method === "POST" && releasesMatch?.[1])
    return startRelease(
      request,
      env,
      principal.subject,
      releasesMatch[1],
      null,
      requestId,
      principal.operationalSubject,
    );

  const releaseMatch = url.pathname.match(
    /^\/v1\/projects\/(prj_[0-9a-f]{32})\/releases\/(rel_[0-9a-f]{32})$/u,
  );
  if (request.method === "GET" && releaseMatch?.[1] && releaseMatch[2]) {
    return getReleaseResponse(env, principal.subject, releaseMatch[1], releaseMatch[2]);
  }
  const actionMatch = url.pathname.match(
    /^\/v1\/projects\/(prj_[0-9a-f]{32})\/releases\/(rel_[0-9a-f]{32})\/(approve|rollback|reconcile)$/u,
  );
  if (request.method === "POST" && actionMatch?.[1] && actionMatch[2] && actionMatch[3]) {
    if (actionMatch[3] === "approve")
      return approveRelease(request, env, principal.subject, actionMatch[1], actionMatch[2]);
    if (actionMatch[3] === "rollback")
      return startRelease(
        request,
        env,
        principal.subject,
        actionMatch[1],
        actionMatch[2],
        requestId,
        principal.operationalSubject,
      );
    return reconcileRelease(env, principal.subject, actionMatch[1], actionMatch[2], requestId);
  }
  if (PROJECT_PATTERN.test(url.pathname) || RELEASE_PATTERN.test(url.pathname)) {
    throw new ApiError(404, "route_not_found", "The route was not found.");
  }
  throw new ApiError(404, "route_not_found", "The route was not found.");
}

export { ARTIFACT_MEDIA_TYPE };
