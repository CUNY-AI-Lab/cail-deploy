import assert from "node:assert/strict";
import { createHash, randomFillSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createTestIdentityIssuer, TEST_SUBJECTS } from "@cuny-ai-lab/cail-identity/testing";
import { createTestHarness } from "wrangler";
import { z } from "zod";

const DEPLOY_WORKER = "kale-release-control-plane-release-workerd-test";
const PROVIDER_WORKER = "kale-release-control-plane-wfp-api-test";
const PROVIDER_CONTROL = {
  "X-Kale-WfP-Test-Control": "local-e2e-control",
};
const INITIAL_REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const TEST_TIMEOUT_MS = 60_000;
const root = new URL("../..", import.meta.url).pathname.replace(/\/$/u, "");

const preparedEnvelopeSchema = z
  .object({
    schemaVersion: z.literal("kale.prepared-worker.v1"),
    projectId: z.string().regex(/^prj_[0-9a-f]{32}$/u),
    releaseId: z.string().regex(/^rel_[0-9a-f]{32}$/u),
    revisionId: z.string().regex(/^rev_sha256_[0-9a-f]{64}$/u),
    mainModule: z.string().min(1),
    modules: z.record(z.string(), z.string()).refine((modules) => Object.keys(modules).length > 0),
    compatibilityDate: z.iso.date(),
    compatibilityFlags: z.array(z.string()),
  })
  .strict();

function isText(value) {
  return z.string().safeParse(value).success;
}

function identityHeaders(jwt) {
  return { "X-CAIL-Identity-JWT": jwt };
}

async function discardResponseBody(response) {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {
    // The harness closes the Worker after a failed assertion; cleanup is best effort.
  }
}

async function assertStatusAndDiscard(response, expected, message) {
  try {
    assert.equal(response.status, expected, message);
  } finally {
    await discardResponseBody(response);
  }
}

async function responseErrorCode(response) {
  const body = await response.json();
  return body?.error?.code;
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function releaseActionId(releaseId) {
  const hex = releaseId.slice(4);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function readPreparedObject(env, preparedKey, preparedDigest) {
  assert.equal(isText(preparedKey), true);
  assert.match(preparedKey, /^prepared\/prj_[0-9a-f]{32}\/rel_[0-9a-f]{32}\/[0-9a-f]{64}\.json$/u);
  assert.equal(isText(preparedDigest), true);
  assert.match(preparedDigest, /^[0-9a-f]{64}$/u);
  const object = await env.ARTIFACTS.get(preparedKey);
  assert.ok(object, `prepared object ${preparedKey} was not retained in R2`);
  const bytes = new Uint8Array(await object.arrayBuffer());
  const observedDigest = sha256Hex(bytes);
  assert.equal(observedDigest, preparedDigest, "prepared bytes failed their D1 digest");
  const envelope = preparedEnvelopeSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  assert.equal(isText(envelope.modules[envelope.mainModule]), true);
  return { bytes, digest: observedDigest, envelope };
}

function moduleSha256(envelope) {
  return Object.fromEntries(
    Object.entries(envelope.modules).map(([name, source]) => {
      assert.equal(isText(source), true, `prepared module ${name} was not text`);
      return [name, sha256Hex(source)];
    }),
  );
}

function parseFlattenedLogMessage(message) {
  if (!isText(message) || !message.trimStart().startsWith("{")) return null;
  const fields = {};
  for (const line of message.split("\n")) {
    const match = line.trim().match(/^(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_.-]*)): (.*?)(?:,)?$/u);
    if (!match) continue;
    const key = match[1] ?? match[2];
    const raw = match[3];
    if (raw.startsWith("'") && raw.endsWith("'")) {
      fields[key] = raw.slice(1, -1);
    } else if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(raw)) {
      fields[key] = Number(raw);
    } else {
      fields[key] = raw;
    }
  }
  return Object.hasOwn(fields, "event.name") ? fields : null;
}

function assertReleaseLogEvents(logs, releaseId) {
  assert.ok(logs.length > 0, "the local build harness emitted no runtime logs");
  const events = logs
    .map((log) => parseFlattenedLogMessage(log.message))
    .filter((event) => event?.["cail.request.id"] === INITIAL_REQUEST_ID);
  assert.equal(
    events.length,
    2,
    "the initial release did not emit exactly two correlated action events",
  );
  assert.deepEqual(
    events.map((event) => event["event.name"]),
    ["cail.action.admitted", "cail.action.terminal"],
  );

  const common = {
    "cail.action.id": releaseActionId(releaseId),
    "cail.product.id": "kale-deploy",
    "cail.request.id": INITIAL_REQUEST_ID,
    "cail.principal.type": "anonymous",
    "cail.schema.version": 2,
    "cail.source.class": "platform",
    "deployment.environment.name": "test",
    "event.name": "cail.action.admitted",
    "http.request.method": "POST",
    "service.name": "kale-release-control-plane",
    "service.namespace": "cuny-ai-lab",
    "service.version": "uncommitted",
    severity_number: 9,
    severity_text: "INFO",
    body: "Action admitted.",
    timestamp: events[0].timestamp,
    "url.template": "/v1/projects/{projectId}/releases",
  };
  const admitted = events[0];
  const terminal = events[1];
  assert.deepEqual(Object.keys(admitted).sort(), Object.keys(common).sort());
  assert.deepEqual(admitted, common);
  assert.match(admitted.timestamp, /^\d{4}-\d{2}-\d{2}T[^ ]+Z$/u);
  assert.ok(Number.isFinite(Date.parse(admitted.timestamp)));

  const terminalExpected = {
    ...common,
    "cail.operation.duration_ms": terminal["cail.operation.duration_ms"],
    "cail.outcome": "ok",
    "cail.outcome.reason": "completed",
    "event.name": "cail.action.terminal",
    body: "Action reached a terminal state.",
    timestamp: terminal.timestamp,
  };
  assert.deepEqual(Object.keys(terminal).sort(), Object.keys(terminalExpected).sort());
  assert.deepEqual(terminal, terminalExpected);
  assert.match(terminal.timestamp, /^\d{4}-\d{2}-\d{2}T[^ ]+Z$/u);
  assert.ok(Number.isFinite(Date.parse(terminal.timestamp)));
  assert.ok(Date.parse(terminal.timestamp) >= Date.parse(admitted.timestamp));
  assert.ok(Number.isSafeInteger(terminal["cail.operation.duration_ms"]));
  assert.ok(terminal["cail.operation.duration_ms"] >= 0);
  assert.ok(terminal["cail.operation.duration_ms"] < TEST_TIMEOUT_MS);
}

async function waitForRelease(worker, projectId, releaseId, jwt, expectedStatus) {
  let observed;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await worker.fetch(`/v1/projects/${projectId}/releases/${releaseId}`, {
      headers: identityHeaders(jwt),
    });
    observed = await response.json();
    assert.equal(response.status, 200, `release read returned ${response.status}`);
    if (observed.status === expectedStatus) return observed;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(
    `release ${releaseId} did not reach ${expectedStatus}; observed ${String(observed?.status)}`,
  );
}

async function waitForProviderObservation(provider, expectedCount) {
  let observed;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await provider.fetch("/__control/state", {
      headers: PROVIDER_CONTROL,
    });
    observed = await response.json();
    assert.equal(response.status, 200, "provider state read failed");
    if (observed.observations.length >= expectedCount) return observed;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(
    `provider did not record observation ${expectedCount}; observed ${String(observed?.observations?.length)}`,
  );
}

async function createAutomaticRelease(worker, projectId, revisionId, jwt, idempotencyKey) {
  const response = await worker.fetch(`/v1/projects/${projectId}/releases`, {
    method: "POST",
    headers: {
      ...identityHeaders(jwt),
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      revisionId,
      approval: "automatic",
    }),
  });
  const release = await response.json();
  assert.equal(response.status, 202, `automatic release returned ${response.status}`);
  assert.match(release.releaseId, /^rel_[0-9a-f]{32}$/u);
  return release.releaseId;
}

test("actual Deploy local integration preserves identity, artifact, Workflow, provider, and reset boundaries", {
  timeout: TEST_TIMEOUT_MS,
}, async (context) => {
  const issuer = await createTestIdentityIssuer();
  const ownerJwt = await issuer.mintIdentityJwt({
    audience: "cail:deploy",
    subject: TEST_SUBJECTS.alice,
  });
  const otherOwnerJwt = await issuer.mintIdentityJwt({
    audience: "cail:deploy",
    subject: TEST_SUBJECTS.bob,
  });
  const wrongAudienceJwt = await issuer.mintIdentityJwt({
    audience: "cail:not-deploy",
    subject: TEST_SUBJECTS.alice,
  });

  const harness = createTestHarness({
    root,
    workers: [
      {
        configPath: "wrangler.release-workerd-test.jsonc",
        vars: {
          SERVICE_AUDIENCE: "cail:deploy",
          PUBLIC_BASE_URL: "http://127.0.0.1:8787",
          OAUTH_AUTHORIZE_URL: "http://127.0.0.1:8787/api/oauth/authorize",
          CAIL_IDENTITY_ISSUER: issuer.issuer,
          CAIL_IDENTITY_JWKS: issuer.jwksJson,
          CAIL_TRUSTED_IDENTITY_ISSUER: issuer.issuer,
          WFP_ACCOUNT_ID: "integration-account",
          WFP_NAMESPACE: "integration-namespace",
          WFP_PUBLISH_TIMEOUT_MS: "1000",
        },
        secrets: {
          CLOUDFLARE_API_TOKEN: "local-contract-token",
        },
        bindingOverrides: {
          WFP_API: PROVIDER_WORKER,
        },
      },
      { configPath: "wrangler.wfp-api-test.jsonc" },
    ],
  });
  context.after(async () => {
    if (context.signal.aborted) harness.debug();
    await harness.close();
  });

  const { url: harnessUrl } = await harness.listen();
  let deploy = harness.getWorker(DEPLOY_WORKER);
  let provider = harness.getWorker(PROVIDER_WORKER);
  await deploy.applyD1Migrations("DB");

  const providerReset = await provider.fetch("/__control/reset", {
    method: "POST",
    headers: {
      ...PROVIDER_CONTROL,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      responseModes: [
        "http-503",
        "stalled",
        "valid",
        "valid",
        "valid",
        "http-503",
        "success-false",
        "malformed-json",
        "invalid-utf8",
        "oversized",
        "stalled",
        "identity-mismatch",
        "valid-without-id",
      ],
    }),
  });
  await assertStatusAndDiscard(providerReset, 200, "provider fixture reset failed");

  const health = await deploy.fetch("/health");
  await assertStatusAndDiscard(health, 200, "identity-backed readiness failed");

  const unauthenticated = await deploy.fetch("/v1/projects", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "harness-unauthenticated",
    },
    body: JSON.stringify({ name: "must not exist" }),
  });
  const unauthenticatedCode = await responseErrorCode(unauthenticated);
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticatedCode, "authentication_required");

  const wrongAudience = await deploy.fetch("/v1/projects", {
    method: "POST",
    headers: {
      ...identityHeaders(wrongAudienceJwt),
      "Content-Type": "application/json",
      "Idempotency-Key": "harness-wrong-audience",
    },
    body: JSON.stringify({ name: "must not exist either" }),
  });
  const wrongAudienceCode = await responseErrorCode(wrongAudience);
  assert.equal(wrongAudience.status, 401);
  assert.equal(wrongAudienceCode, "invalid_credential");

  const createProjectRequest = () =>
    deploy.fetch("/v1/projects", {
      method: "POST",
      headers: {
        ...identityHeaders(ownerJwt),
        "Content-Type": "application/json",
        "Idempotency-Key": "harness-project",
      },
      body: JSON.stringify({ name: "createTestHarness release fixture" }),
    });
  const projectResponses = await Promise.all([createProjectRequest(), createProjectRequest()]);
  const projects = await Promise.all(projectResponses.map((response) => response.json()));
  assert.deepEqual(
    projectResponses.map(({ status }) => status).sort(),
    [200, 201],
    "concurrent project idempotency did not produce one creation and one replay",
  );
  assert.equal(projects[0].projectId, projects[1].projectId);
  const project = projects[0];
  assert.match(project.projectId, /^prj_[0-9a-f]{32}$/u);

  const artifact = await readFile(
    new URL("../../fixtures/worker-artifact.v1.json", import.meta.url),
  );
  const artifactDigest = createHash("sha256").update(artifact).digest("hex");
  const contentDigest = `sha-256=:${createHash("sha256").update(artifact).digest("base64")}:`;
  const revisionPath = `/v1/projects/${project.projectId}/revisions`;

  const badDigestUpload = await deploy.fetch(revisionPath, {
    method: "POST",
    headers: {
      ...identityHeaders(ownerJwt),
      "Content-Type": "application/vnd.cuny.kale.artifact.v1+json",
      "Content-Digest": `sha-256=:${Buffer.alloc(32).toString("base64")}:`,
    },
    body: artifact,
  });
  const badDigestCode = await responseErrorCode(badDigestUpload);
  assert.equal(badDigestUpload.status, 400);
  assert.equal(badDigestCode, "digest_mismatch");

  const crossOwnerUpload = await deploy.fetch(revisionPath, {
    method: "POST",
    headers: {
      ...identityHeaders(otherOwnerJwt),
      "Content-Type": "application/vnd.cuny.kale.artifact.v1+json",
      "Content-Digest": contentDigest,
    },
    body: artifact,
  });
  const crossOwnerCode = await responseErrorCode(crossOwnerUpload);
  assert.equal(crossOwnerUpload.status, 404);
  assert.equal(crossOwnerCode, "project_not_found");

  const revisionResponse = await deploy.fetch(revisionPath, {
    method: "POST",
    headers: {
      ...identityHeaders(ownerJwt),
      "Content-Type": "application/vnd.cuny.kale.artifact.v1+json",
      "Content-Digest": contentDigest,
    },
    body: artifact,
  });
  const revision = await revisionResponse.json();
  assert.equal(revisionResponse.status, 201, "revision upload failed");
  assert.equal(revision.revisionId, `rev_sha256_${artifactDigest}`);

  const createReleaseRequest = () =>
    deploy.fetch(`/v1/projects/${project.projectId}/releases`, {
      method: "POST",
      headers: {
        ...identityHeaders(ownerJwt),
        "Content-Type": "application/json",
        "Idempotency-Key": "harness-release",
        "X-CAIL-Request-Id": INITIAL_REQUEST_ID,
      },
      body: JSON.stringify({
        revisionId: revision.revisionId,
        approval: "required",
      }),
    });
  const releaseResponses = await Promise.all([createReleaseRequest(), createReleaseRequest()]);
  const releases = await Promise.all(releaseResponses.map((response) => response.json()));
  assert.deepEqual(
    releaseResponses.map(({ status }) => status).sort(),
    [200, 202],
    "concurrent release idempotency did not produce one admission and one replay",
  );
  assert.equal(releases[0].releaseId, releases[1].releaseId);
  const release = releases[0];
  const awaitingApproval = await waitForRelease(
    deploy,
    project.projectId,
    release.releaseId,
    ownerJwt,
    "awaiting_approval",
  );
  const awaitingApprovalEvents = awaitingApproval.events.map(({ type }) => type);
  assert.deepEqual(awaitingApprovalEvents, [
    "release.queued",
    "release.validating",
    "release.building",
    "release.prepared",
    "release.awaiting_approval",
  ]);
  assert.equal(awaitingApproval.events[0].actorSubject, TEST_SUBJECTS.alice);

  const env = await deploy.getEnv();
  const durableRelease = await env.DB.prepare(
    "SELECT release_id, project_id, revision_id, rollback_of_release_id, operational_subject, status, prepared_key, prepared_digest FROM releases WHERE release_id = ?",
  )
    .bind(release.releaseId)
    .first();
  assert.equal(durableRelease.release_id, release.releaseId);
  assert.equal(durableRelease.project_id, project.projectId);
  assert.equal(durableRelease.revision_id, revision.revisionId);
  assert.equal(durableRelease.rollback_of_release_id, null);
  assert.equal(durableRelease.operational_subject, null);
  assert.equal(durableRelease.status, "awaiting_approval");
  assert.equal(isText(durableRelease.prepared_key), true);
  assert.equal(isText(durableRelease.prepared_digest), true);
  const preparedAtApproval = await readPreparedObject(
    env,
    durableRelease.prepared_key,
    durableRelease.prepared_digest,
  );
  assert.equal(preparedAtApproval.envelope.projectId, project.projectId);
  assert.equal(preparedAtApproval.envelope.releaseId, release.releaseId);
  assert.equal(preparedAtApproval.envelope.revisionId, revision.revisionId);

  const durableEvents = await env.DB.prepare(
    "SELECT sequence, type FROM release_events WHERE release_id = ? ORDER BY sequence",
  )
    .bind(release.releaseId)
    .all();
  assert.deepEqual(
    durableEvents.results.map(({ type }) => type),
    awaitingApprovalEvents,
    "public release events drifted from authoritative D1",
  );

  const durableCounts = await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM projects) AS projects, (SELECT COUNT(*) FROM revisions) AS revisions, (SELECT COUNT(*) FROM releases) AS releases",
  ).first();
  assert.deepEqual(durableCounts, { projects: 1, revisions: 1, releases: 1 });

  const storedRevision = await env.ARTIFACTS.get(
    `revisions/${project.projectId}/${revision.revisionId}.json`,
  );
  assert.ok(storedRevision, "immutable revision bytes were not retained in R2");
  assert.deepEqual(
    new Uint8Array(await storedRevision.arrayBuffer()),
    new Uint8Array(artifact),
    "retained revision bytes drifted",
  );

  await env.DB.prepare(`
    CREATE TRIGGER fail_reconciling_transition
    BEFORE UPDATE OF status ON releases
    WHEN OLD.release_id = '${release.releaseId}'
      AND OLD.status = 'publishing'
      AND NEW.status = 'reconciling'
    BEGIN
      SELECT RAISE(ABORT, 'injected reconciling failure');
    END
  `).run();

  const approvalResponse = await deploy.fetch(
    `/v1/projects/${project.projectId}/releases/${release.releaseId}/approve`,
    {
      method: "POST",
      headers: {
        ...identityHeaders(ownerJwt),
        "Content-Type": "application/json",
        "Idempotency-Key": "harness-approval",
      },
      body: JSON.stringify({ decision: "approved" }),
    },
  );
  await assertStatusAndDiscard(approvalResponse, 202, "release approval failed");
  await waitForProviderObservation(provider, 1);
  const publishingAfterTransitionFailure = await waitForRelease(
    deploy,
    project.projectId,
    release.releaseId,
    ownerJwt,
    "publishing",
  );
  assert.deepEqual(
    publishingAfterTransitionFailure.events.map(({ type }) => type),
    [
      "release.queued",
      "release.validating",
      "release.building",
      "release.prepared",
      "release.awaiting_approval",
      "release.approval_accepted",
      "release.publishing",
    ],
    "a failed reconciling transition changed the durable release outcome",
  );
  const reconciliationPath = `/v1/projects/${project.projectId}/releases/${release.releaseId}/reconcile`;
  const reconciliationResponses = await Promise.all([
    fetch(new URL(reconciliationPath, harnessUrl), {
      method: "POST",
      headers: identityHeaders(ownerJwt),
    }),
    fetch(new URL(reconciliationPath, harnessUrl), {
      method: "POST",
      headers: identityHeaders(ownerJwt),
    }),
  ]);
  const reconciliationStatuses = reconciliationResponses
    .map(({ status }) => status)
    .sort((left, right) => left - right);
  await Promise.all(reconciliationResponses.map(discardResponseBody));
  assert.deepEqual(
    reconciliationStatuses,
    [409, 502],
    "concurrent reconciliation did not fence the in-flight authority request",
  );
  const reconciliationResponse = await deploy.fetch(reconciliationPath, {
    method: "POST",
    headers: identityHeaders(ownerJwt),
  });
  await assertStatusAndDiscard(reconciliationResponse, 200, "reconciliation retry failed");
  await waitForRelease(deploy, project.projectId, release.releaseId, ownerJwt, "live");
  await env.DB.prepare("DROP TRIGGER fail_reconciling_transition").run();

  const secondArtifact = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: "kale.artifact.v1",
      runtime: "worker",
      entrypoint: "src/index.ts",
      files: {
        "src/index.ts": "export default { fetch() { return new Response('kale-fixture-v2') } }",
      },
      compatibility: { date: "2026-07-22", flags: [] },
      requestedBindings: [],
    }),
  );
  const secondArtifactDigest = createHash("sha256").update(secondArtifact).digest("hex");
  const secondContentDigest = `sha-256=:${createHash("sha256").update(secondArtifact).digest("base64")}:`;
  const secondRevisionResponse = await deploy.fetch(revisionPath, {
    method: "POST",
    headers: {
      ...identityHeaders(ownerJwt),
      "Content-Type": "application/vnd.cuny.kale.artifact.v1+json",
      "Content-Digest": secondContentDigest,
    },
    body: secondArtifact,
  });
  const secondRevision = await secondRevisionResponse.json();
  assert.equal(secondRevisionResponse.status, 201, "second revision upload failed");
  assert.equal(secondRevision.revisionId, `rev_sha256_${secondArtifactDigest}`);

  const secondReleaseId = await createAutomaticRelease(
    deploy,
    project.projectId,
    secondRevision.revisionId,
    ownerJwt,
    "harness-release-v2",
  );
  await waitForRelease(deploy, project.projectId, secondReleaseId, ownerJwt, "live");

  const sourceBeforeRollback = await env.DB.prepare(
    "SELECT release_id, project_id, revision_id, status, prepared_key, prepared_digest, rollback_of_release_id FROM releases WHERE release_id = ?",
  )
    .bind(release.releaseId)
    .first();
  assert.equal(sourceBeforeRollback.release_id, release.releaseId);
  assert.equal(sourceBeforeRollback.project_id, project.projectId);
  assert.equal(sourceBeforeRollback.revision_id, revision.revisionId);
  assert.equal(sourceBeforeRollback.status, "live");
  assert.equal(sourceBeforeRollback.rollback_of_release_id, null);
  assert.equal(sourceBeforeRollback.prepared_key, durableRelease.prepared_key);
  assert.equal(sourceBeforeRollback.prepared_digest, durableRelease.prepared_digest);
  const sourcePreparedBeforeRollback = await readPreparedObject(
    env,
    sourceBeforeRollback.prepared_key,
    sourceBeforeRollback.prepared_digest,
  );
  assert.deepEqual(sourcePreparedBeforeRollback.bytes, preparedAtApproval.bytes);
  assert.deepEqual(sourcePreparedBeforeRollback.envelope, preparedAtApproval.envelope);

  const rollbackResponse = await deploy.fetch(
    `/v1/projects/${project.projectId}/releases/${release.releaseId}/rollback`,
    {
      method: "POST",
      headers: {
        ...identityHeaders(ownerJwt),
        "Content-Type": "application/json",
        "Idempotency-Key": "harness-rollback-v1",
      },
      body: JSON.stringify({ approval: "automatic" }),
    },
  );
  const rollbackRelease = await rollbackResponse.json();
  assert.equal(rollbackResponse.status, 202, "rollback admission failed");
  assert.equal(rollbackRelease.rollbackOfReleaseId, release.releaseId);
  await waitForRelease(deploy, project.projectId, rollbackRelease.releaseId, ownerJwt, "live");

  const sourceAfterRollback = await env.DB.prepare(
    "SELECT release_id, project_id, revision_id, status, prepared_key, prepared_digest, rollback_of_release_id FROM releases WHERE release_id = ?",
  )
    .bind(release.releaseId)
    .first();
  const rollbackRow = await env.DB.prepare(
    "SELECT release_id, project_id, revision_id, status, prepared_key, prepared_digest, rollback_of_release_id FROM releases WHERE release_id = ?",
  )
    .bind(rollbackRelease.releaseId)
    .first();
  assert.equal(sourceAfterRollback.release_id, sourceBeforeRollback.release_id);
  assert.equal(sourceAfterRollback.project_id, sourceBeforeRollback.project_id);
  assert.equal(sourceAfterRollback.revision_id, sourceBeforeRollback.revision_id);
  assert.equal(sourceAfterRollback.status, "live");
  assert.equal(sourceAfterRollback.rollback_of_release_id, null);
  assert.equal(sourceAfterRollback.prepared_key, sourceBeforeRollback.prepared_key);
  assert.equal(sourceAfterRollback.prepared_digest, sourceBeforeRollback.prepared_digest);
  assert.equal(rollbackRow.release_id, rollbackRelease.releaseId);
  assert.equal(rollbackRow.project_id, project.projectId);
  assert.equal(rollbackRow.revision_id, sourceBeforeRollback.revision_id);
  assert.equal(rollbackRow.status, "live");
  assert.equal(rollbackRow.rollback_of_release_id, sourceBeforeRollback.release_id);
  assert.equal(rollbackRow.prepared_key, sourceBeforeRollback.prepared_key);
  assert.equal(rollbackRow.prepared_digest, sourceBeforeRollback.prepared_digest);
  const liveAfterRollback = await env.DB.prepare(
    "SELECT release_id FROM releases WHERE project_id = ? AND status = 'live' ORDER BY release_sequence DESC LIMIT 1",
  )
    .bind(project.projectId)
    .first();
  assert.equal(
    liveAfterRollback.release_id,
    rollbackRelease.releaseId,
    "rollback did not become the newest admitted live authority",
  );
  const rollbackPrepared = await readPreparedObject(
    env,
    rollbackRow.prepared_key,
    rollbackRow.prepared_digest,
  );
  assert.deepEqual(rollbackPrepared.bytes, sourcePreparedBeforeRollback.bytes);
  assert.deepEqual(rollbackPrepared.envelope, sourcePreparedBeforeRollback.envelope);
  const rollbackModuleSha256 = moduleSha256(sourcePreparedBeforeRollback.envelope);

  const largePayload = Buffer.allocUnsafe(1_350_000);
  randomFillSync(largePayload);
  const largeArtifact = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: "kale.artifact.v1",
      runtime: "worker",
      entrypoint: "src/index.ts",
      files: {
        "src/index.ts":
          `const payload = "${largePayload.toString("base64")}";` +
          "export default { fetch() { return new Response(String(payload.length)) } }",
      },
      compatibility: { date: "2026-07-22", flags: [] },
      requestedBindings: [],
    }),
  );
  assert.ok(largeArtifact.byteLength > 1_750_000, "large artifact was not near the 2 MiB limit");
  assert.ok(largeArtifact.byteLength < 2 * 1024 * 1024, "large artifact exceeded 2 MiB");
  const largeArtifactDigest = createHash("sha256").update(largeArtifact).digest("hex");
  const largeContentDigest = `sha-256=:${createHash("sha256").update(largeArtifact).digest("base64")}:`;
  const largeRevisionResponse = await deploy.fetch(revisionPath, {
    method: "POST",
    headers: {
      ...identityHeaders(ownerJwt),
      "Content-Type": "application/vnd.cuny.kale.artifact.v1+json",
      "Content-Digest": largeContentDigest,
    },
    body: largeArtifact,
  });
  const largeRevision = await largeRevisionResponse.json();
  assert.equal(largeRevisionResponse.status, 201, "near-2MiB revision upload failed");
  assert.equal(largeRevision.revisionId, `rev_sha256_${largeArtifactDigest}`);
  const largeReleaseId = await createAutomaticRelease(
    deploy,
    project.projectId,
    largeRevision.revisionId,
    ownerJwt,
    "harness-large-release",
  );
  await waitForRelease(deploy, project.projectId, largeReleaseId, ownerJwt, "reconciling");
  const largeReleaseRow = await env.DB.prepare(
    "SELECT prepared_key, prepared_digest FROM releases WHERE release_id = ?",
  )
    .bind(largeReleaseId)
    .first();
  const largePrepared = await readPreparedObject(
    env,
    largeReleaseRow.prepared_key,
    largeReleaseRow.prepared_digest,
  );
  assert.ok(
    largePrepared.bytes.byteLength > 1024 * 1024,
    "near-2MiB prepared bytes did not cross the Workflow step-result limit",
  );
  assert.equal(largePrepared.envelope.releaseId, largeReleaseId);
  assert.equal(largePrepared.envelope.revisionId, largeRevision.revisionId);

  const responseBoundaryReleases = [];
  for (const mode of [
    "success-false",
    "malformed-json",
    "invalid-utf8",
    "oversized",
    "stalled",
    "identity-mismatch",
  ]) {
    const releaseId = await createAutomaticRelease(
      deploy,
      project.projectId,
      revision.revisionId,
      ownerJwt,
      `harness-provider-${mode}`,
    );
    await waitForRelease(deploy, project.projectId, releaseId, ownerJwt, "reconciling");
    responseBoundaryReleases.push({ mode, releaseId, status: "reconciling" });
  }
  const noIdentityReleaseId = await createAutomaticRelease(
    deploy,
    project.projectId,
    revision.revisionId,
    ownerJwt,
    "harness-provider-valid-without-id",
  );
  await waitForRelease(deploy, project.projectId, noIdentityReleaseId, ownerJwt, "live");
  responseBoundaryReleases.push({
    mode: "valid-without-id",
    releaseId: noIdentityReleaseId,
    status: "live",
  });

  const lateLargeReconciliation = await deploy.fetch(
    `/v1/projects/${project.projectId}/releases/${largeReleaseId}/reconcile`,
    { method: "POST", headers: identityHeaders(ownerJwt) },
  );
  await assertStatusAndDiscard(
    lateLargeReconciliation,
    200,
    "late reconciliation of the older release failed",
  );
  await waitForRelease(deploy, project.projectId, largeReleaseId, ownerJwt, "live");
  const liveAfterLateReconciliation = await env.DB.prepare(
    "SELECT release_id FROM releases WHERE project_id = ? AND status = 'live' ORDER BY release_sequence DESC LIMIT 1",
  )
    .bind(project.projectId)
    .first();
  assert.equal(
    liveAfterLateReconciliation.release_id,
    noIdentityReleaseId,
    "late reconciliation superseded a newer admitted live release",
  );

  const providerStateResponse = await provider.fetch("/__control/state", {
    headers: PROVIDER_CONTROL,
  });
  const providerState = await providerStateResponse.json();
  assert.equal(providerStateResponse.status, 200);
  assert.equal(providerState.errors.length, 0);
  assert.equal(providerState.observations.length, 14);
  assert.ok(
    providerState.observations.every(
      ({
        accountId,
        namespace,
        authorizationAccepted,
        mainModule,
        moduleNames,
        scriptName,
        revisionId,
      }) =>
        accountId === "integration-account" &&
        namespace === "integration-namespace" &&
        authorizationAccepted &&
        scriptName === revisionId.slice("rev_sha256_".length) &&
        moduleNames.includes(mainModule),
    ),
  );
  assert.deepEqual(
    providerState.observations.slice(0, 5).map(({ responseStatus, revisionId }) => ({
      responseStatus,
      revisionId,
    })),
    [
      { responseStatus: 503, revisionId: revision.revisionId },
      { responseStatus: 200, revisionId: revision.revisionId },
      { responseStatus: 200, revisionId: revision.revisionId },
      { responseStatus: 200, revisionId: secondRevision.revisionId },
      { responseStatus: 200, revisionId: revision.revisionId },
    ],
    "provider publication sequence did not preserve reconciliation, v2, and rollback",
  );
  const rollbackObservation = providerState.observations[4];
  assert.equal(rollbackObservation.revisionId, rollbackRow.revision_id);
  assert.equal(rollbackObservation.mainModule, sourcePreparedBeforeRollback.envelope.mainModule);
  assert.deepEqual(
    rollbackObservation.moduleNames,
    Object.keys(sourcePreparedBeforeRollback.envelope.modules).sort(),
  );
  assert.deepEqual(
    rollbackObservation.moduleSha256,
    rollbackModuleSha256,
    "rollback publication did not use the exact retained prepared module bytes",
  );
  const largeObservation = providerState.observations[5];
  assert.equal(largeObservation.responseMode, "http-503");
  assert.equal(largeObservation.revisionId, largeRevision.revisionId);
  assert.deepEqual(largeObservation.moduleSha256, moduleSha256(largePrepared.envelope));
  assert.deepEqual(
    providerState.observations.slice(6, 13).map(({ responseMode }) => responseMode),
    [
      "success-false",
      "malformed-json",
      "invalid-utf8",
      "oversized",
      "stalled",
      "identity-mismatch",
      "valid-without-id",
    ],
  );
  assert.deepEqual(
    responseBoundaryReleases.map(({ mode, status }) => `${mode}:${status}`),
    [
      "success-false:reconciling",
      "malformed-json:reconciling",
      "invalid-utf8:reconciling",
      "oversized:reconciling",
      "stalled:reconciling",
      "identity-mismatch:reconciling",
      "valid-without-id:live",
    ],
    "provider response boundaries admitted a false live release",
  );
  assert.deepEqual(
    providerState.observations[0].moduleSha256,
    providerState.observations[2].moduleSha256,
  );
  assert.deepEqual(
    providerState.observations[0].moduleSha256,
    providerState.observations[4].moduleSha256,
    "rollback did not republish retained v1 module bytes",
  );
  assert.notDeepEqual(
    providerState.observations[0].moduleSha256,
    providerState.observations[3].moduleSha256,
  );
  assert.equal(providerState.observations[13].revisionId, largeRevision.revisionId);
  assert.equal(providerState.observations[13].responseMode, "valid");

  const finalCounts = await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM projects) AS projects, (SELECT COUNT(*) FROM revisions) AS revisions, (SELECT COUNT(*) FROM releases) AS releases, (SELECT COUNT(*) FROM releases WHERE status = 'live') AS liveReleases, (SELECT COUNT(*) FROM releases WHERE status = 'reconciling') AS reconcilingReleases",
  ).first();
  assert.deepEqual(finalCounts, {
    projects: 1,
    revisions: 3,
    releases: 11,
    liveReleases: 5,
    reconcilingReleases: 6,
  });

  const logs = harness.getLogs();
  const runtimeLogs = JSON.stringify(logs);
  assertReleaseLogEvents(logs, release.releaseId);
  assert.equal(runtimeLogs.includes(ownerJwt), false, "runtime logs captured the identity JWT");
  assert.equal(
    runtimeLogs.includes(TEST_SUBJECTS.alice),
    false,
    "runtime logs captured the stable ownership subject",
  );

  await harness.reset();
  deploy = harness.getWorker(DEPLOY_WORKER);
  provider = harness.getWorker(PROVIDER_WORKER);
  await deploy.applyD1Migrations("DB");

  const resetEnv = await deploy.getEnv();
  const resetCounts = await resetEnv.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM projects) AS projects, (SELECT COUNT(*) FROM revisions) AS revisions, (SELECT COUNT(*) FROM releases) AS releases",
  ).first();
  assert.deepEqual(resetCounts, { projects: 0, revisions: 0, releases: 0 });
  assert.equal((await resetEnv.ARTIFACTS.list()).objects.length, 0);

  const resetProviderState = await provider.fetch("/__control/state", {
    headers: PROVIDER_CONTROL,
  });
  const resetState = await resetProviderState.json();
  assert.equal(resetProviderState.status, 200);
  assert.deepEqual(resetState, {
    errors: [],
    observations: [],
    responseModes: [],
  });
});
