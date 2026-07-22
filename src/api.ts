import { publishWorker } from "./adapters/cloudflare/wfp";
import { authenticate } from "./auth";
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
import { ApiError } from "./domain/errors";
import type { Env } from "./env";
import {
  emitReleaseAdmission,
  emitReleaseTerminal,
  operationalLogSubject,
} from "./operational-events";
import {
  appendTerminalStatus,
  getRevision,
  idempotentResponse,
  requireOwnedProject,
  requireRelease,
  type ReleaseRow,
} from "./storage";
import type { PreparedEnvelope } from "./workflow";

const ARTIFACT_MEDIA_TYPE = "application/vnd.cuny.kale.artifact.v1+json";
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
export const RELEASE_INSERT_SQL = `INSERT INTO releases (release_id, project_id, revision_id, target, approval, status, workflow_instance_id, rollback_of_release_id, operational_subject, request_id, admitted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`;

function requiredIdempotencyKey(request: Request): string {
  const key = request.headers.get("Idempotency-Key");
  if (!key || key.length > 120 || !/^[A-Za-z0-9._:-]+$/u.test(key)) {
    throw new ApiError(
      400,
      "idempotency_key_required",
      "A valid Idempotency-Key header is required.",
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
    throw new ApiError(400, "invalid_request", "The request body does not match the contract.");
  return result.data;
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
      "Content-Digest must contain one SHA-256 digest.",
    );
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARTIFACT_BYTES) {
    throw new ApiError(
      413,
      "artifact_size_invalid",
      "The artifact must be between 1 byte and 2 MiB.",
    );
  }
  const digest = await sha256Hex(bytes);
  if (digest !== bytesToHex(expected)) {
    throw new ApiError(400, "digest_mismatch", "Content-Digest does not match the uploaded bytes.");
  }
  let artifactJson: unknown;
  try {
    artifactJson = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError(400, "artifact_json_invalid", "The artifact must be valid JSON.");
  }
  const artifact = parsedBody(artifactSchema.safeParse(artifactJson));
  if (artifact.requestedBindings.length > 0) {
    throw new ApiError(
      422,
      "binding_not_supported",
      "This isolated release slice does not attach project resources or secrets.",
    );
  }

  const revisionId = `rev_sha256_${digest}`;
  const existing = await getRevision(env, projectId, revisionId);
  if (existing) {
    if (!(await env.ARTIFACTS.head(existing.artifact_key))) {
      throw new ApiError(
        409,
        "artifact_store_inconsistent",
        "The immutable revision record exists but its artifact is missing.",
      );
    }
    return Response.json(
      {
        projectId,
        revisionId,
        artifactDigest: digest,
        artifactBytes: existing.artifact_bytes,
        status: existing.status,
        createdAt: existing.created_at,
      },
      { status: 200 },
    );
  }

  const artifactKey = `revisions/${projectId}/${revisionId}.json`;
  await env.ARTIFACTS.put(artifactKey, bytes, {
    sha256: expected,
    customMetadata: { projectId, revisionId, artifactDigest: digest },
  });
  const createdAt = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO revisions (project_id, revision_id, artifact_digest, artifact_bytes, artifact_key, status, created_at) VALUES (?, ?, ?, ?, ?, 'ready', ?)",
  )
    .bind(projectId, revisionId, digest, bytes.byteLength, artifactKey, createdAt)
    .run();
  return Response.json(
    {
      projectId,
      revisionId,
      artifactDigest: digest,
      artifactBytes: bytes.byteLength,
      status: "ready",
      createdAt,
    },
    { status: 201 },
  );
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
      "The source release is not a retained live release.",
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
      "The isolated stack permits preview releases only.",
    );
  }
  const revision = await getRevision(env, projectId, revisionId);
  if (revision?.status !== "ready")
    throw new ApiError(404, "revision_not_found", "The revision was not found.");

  const key = requiredIdempotencyKey(request);
  const requestShape = { revisionId, target, approval, rollbackOfReleaseId };
  const requestDigest = await sha256Hex(canonicalJson(requestShape));
  const operation = rollbackOfReleaseId ? `rollback:${rollbackOfReleaseId}` : "create_release";
  const replay = await idempotentResponse(env, projectId, operation, key, requestDigest);
  if (replay) return Response.json(replay, { status: 200 });

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
      logSubject,
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
  await env.RELEASE_WORKFLOW.create({
    id: releaseId,
    params: { projectId, releaseId, revisionId, requestId, logSubject, admittedAt: now },
  });
  return Response.json(response, { status: 202 });
}

async function getReleaseResponse(
  env: Env,
  subject: string,
  projectId: string,
  releaseId: string,
): Promise<Response> {
  await requireOwnedProject(env, projectId, subject);
  const release = await requireRelease(env, projectId, releaseId);
  const events = await env.DB.prepare(
    "SELECT sequence, type, occurred_at, actor_subject, detail_json FROM release_events WHERE release_id = ? ORDER BY sequence",
  )
    .bind(releaseId)
    .all<{
      sequence: number;
      type: string;
      occurred_at: string;
      actor_subject: string | null;
      detail_json: string;
    }>();
  return Response.json({
    ...releaseResponse(release),
    events: events.results.map((event) => ({
      sequence: event.sequence,
      type: event.type,
      occurredAt: event.occurred_at,
      actorSubject: event.actor_subject,
      detail: JSON.parse(event.detail_json) as unknown,
    })),
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
  const target = new Request(new URL("/", request.url), { method: "GET", headers });
  return env.DISPATCHER.get(release.publication_name).fetch(target);
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
    throw new ApiError(
      409,
      "release_approval_already_accepted",
      "A release approval was already accepted.",
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
    await env.RELEASE_WORKFLOW.get(release.workflow_instance_id).sendEvent({
      type: "release-approval",
      payload: { decision: "approved", actorSubject: subject, revisionId: release.revision_id },
    });
  } catch {
    throw new ApiError(
      503,
      "approval_delivery_failed",
      "The approval was saved but Workflow delivery must be retried.",
    );
  }
}

async function reconcileRelease(
  env: Env,
  subject: string,
  projectId: string,
  releaseId: string,
): Promise<Response> {
  await requireOwnedProject(env, projectId, subject);
  const release = await requireRelease(env, projectId, releaseId);
  if (release.status !== "reconciling" || !release.prepared_key || !release.prepared_digest) {
    throw new ApiError(
      409,
      "release_not_reconcilable",
      "The release has no ambiguous prepared publication to reconcile.",
    );
  }
  const retained = await env.ARTIFACTS.get(release.prepared_key);
  if (!retained)
    throw new ApiError(
      409,
      "prepared_artifact_missing",
      "The retained prepared artifact is missing.",
    );
  const json = await retained.text();
  if ((await sha256Hex(json)) !== release.prepared_digest) {
    throw new ApiError(
      409,
      "prepared_digest_mismatch",
      "The retained prepared artifact failed verification.",
    );
  }
  const name = await publishWorker(
    env,
    projectId,
    release.revision_id,
    JSON.parse(json) as PreparedEnvelope,
  );
  await env.DB.prepare("UPDATE releases SET publication_name = ? WHERE release_id = ?")
    .bind(name, releaseId)
    .run();
  const terminal = await appendTerminalStatus(env, releaseId, "live", "release.live", {
    publicationName: name,
    reconciled: true,
  });
  if (terminal) {
    emitReleaseTerminal(
      env,
      releaseId,
      release.request_id,
      release.operational_subject ?? undefined,
      release.admitted_at,
      "ok",
      "completed",
    );
  }
  return Response.json({
    ...releaseResponse(await requireRelease(env, projectId, releaseId)),
    status: "live",
  });
}

export async function handleApi(
  request: Request,
  env: Env,
  requestId: string = crypto.randomUUID(),
): Promise<Response> {
  const principal = await authenticate(request, env);
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/v1/projects")
    return createProject(request, env, principal.subject);

  const revisionMatch = url.pathname.match(/^\/v1\/projects\/(prj_[0-9a-f]{32})\/revisions$/u);
  if (request.method === "POST" && revisionMatch?.[1])
    return uploadRevision(request, env, principal.subject, revisionMatch[1]);

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
    return reconcileRelease(env, principal.subject, actionMatch[1], actionMatch[2]);
  }
  if (PROJECT_PATTERN.test(url.pathname) || RELEASE_PATTERN.test(url.pathname)) {
    throw new ApiError(404, "route_not_found", "The route was not found.");
  }
  throw new ApiError(404, "route_not_found", "The route was not found.");
}

export { ARTIFACT_MEDIA_TYPE };
