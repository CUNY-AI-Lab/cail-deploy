import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createTestIdentityIssuer, TEST_SUBJECTS } from "@cuny-ai-lab/cail-identity/testing";
import { createTestHarness } from "wrangler";

const DEPLOY_WORKER = "kale-release-control-plane-release-workerd-test";
const PROVIDER_WORKER = "kale-release-control-plane-wfp-api-test";
const PROVIDER_CONTROL = {
  "X-Kale-WfP-Test-Control": "local-e2e-control",
};
const root = new URL("../..", import.meta.url).pathname.replace(/\/$/u, "");

function identityHeaders(jwt) {
  return { "X-CAIL-Identity-JWT": jwt };
}

async function discardResponseBody(response) {
  if (response.body) await response.body.cancel();
}

async function responseErrorCode(response) {
  const body = await response.json();
  return body?.error?.code;
}

async function waitForRelease(worker, projectId, releaseId, jwt, expectedStatus) {
  let observed;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await worker.fetch(`/v1/projects/${projectId}/releases/${releaseId}`, {
      headers: identityHeaders(jwt),
    });
    assert.equal(response.status, 200, `release read returned ${response.status}`);
    observed = await response.json();
    if (observed.status === expectedStatus) return observed;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(
    `release ${releaseId} did not reach ${expectedStatus}; observed ${String(observed?.status)}`,
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
      target: "preview",
      approval: "automatic",
    }),
  });
  assert.equal(response.status, 202, `automatic release returned ${response.status}`);
  const release = await response.json();
  assert.match(release.releaseId, /^rel_[0-9a-f]{32}$/u);
  return release.releaseId;
}

test("actual Deploy production build preserves identity, artifact, Workflow, provider, and reset boundaries", {
  timeout: 60_000,
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
          AUTH_MODE: "cail-jwt",
          SERVICE_AUDIENCE: "cail:deploy",
          PUBLIC_BASE_URL: "http://127.0.0.1:8787",
          CAIL_IDENTITY_ISSUER: issuer.issuer,
          CAIL_IDENTITY_JWKS: issuer.jwksJson,
          CAIL_TRUSTED_IDENTITY_ISSUERS: issuer.issuer,
          RUN_ID: "integration-local-e2e",
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
  assert.equal(providerReset.status, 200, "provider fixture reset failed");
  await discardResponseBody(providerReset);

  const health = await deploy.fetch("/health");
  assert.equal(health.status, 200, "identity-backed readiness failed");
  await discardResponseBody(health);

  const unauthenticated = await deploy.fetch("/v1/projects", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "harness-unauthenticated",
    },
    body: JSON.stringify({ name: "must not exist" }),
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal(await responseErrorCode(unauthenticated), "authentication_required");

  const wrongAudience = await deploy.fetch("/v1/projects", {
    method: "POST",
    headers: {
      ...identityHeaders(wrongAudienceJwt),
      "Content-Type": "application/json",
      "Idempotency-Key": "harness-wrong-audience",
    },
    body: JSON.stringify({ name: "must not exist either" }),
  });
  assert.equal(wrongAudience.status, 401);
  assert.equal(await responseErrorCode(wrongAudience), "invalid_credential");

  const projectResponse = await deploy.fetch("/v1/projects", {
    method: "POST",
    headers: {
      ...identityHeaders(ownerJwt),
      "Content-Type": "application/json",
      "Idempotency-Key": "harness-project",
    },
    body: JSON.stringify({ name: "createTestHarness release fixture" }),
  });
  assert.equal(projectResponse.status, 201, "project creation failed");
  const project = await projectResponse.json();
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
  assert.equal(badDigestUpload.status, 400);
  assert.equal(await responseErrorCode(badDigestUpload), "digest_mismatch");

  const crossOwnerUpload = await deploy.fetch(revisionPath, {
    method: "POST",
    headers: {
      ...identityHeaders(otherOwnerJwt),
      "Content-Type": "application/vnd.cuny.kale.artifact.v1+json",
      "Content-Digest": contentDigest,
    },
    body: artifact,
  });
  assert.equal(crossOwnerUpload.status, 404);
  assert.equal(await responseErrorCode(crossOwnerUpload), "project_not_found");

  const revisionResponse = await deploy.fetch(revisionPath, {
    method: "POST",
    headers: {
      ...identityHeaders(ownerJwt),
      "Content-Type": "application/vnd.cuny.kale.artifact.v1+json",
      "Content-Digest": contentDigest,
    },
    body: artifact,
  });
  assert.equal(revisionResponse.status, 201, "revision upload failed");
  const revision = await revisionResponse.json();
  assert.equal(revision.revisionId, `rev_sha256_${artifactDigest}`);

  const releaseResponse = await deploy.fetch(`/v1/projects/${project.projectId}/releases`, {
    method: "POST",
    headers: {
      ...identityHeaders(ownerJwt),
      "Content-Type": "application/json",
      "Idempotency-Key": "harness-release",
    },
    body: JSON.stringify({
      revisionId: revision.revisionId,
      target: "preview",
      approval: "required",
    }),
  });
  assert.equal(releaseResponse.status, 202, "release admission failed");
  const release = await releaseResponse.json();
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
    "SELECT operational_subject, status, prepared_digest FROM releases WHERE release_id = ?",
  )
    .bind(release.releaseId)
    .first();
  assert.equal(durableRelease.operational_subject, null);
  assert.equal(durableRelease.status, "awaiting_approval");
  assert.equal(typeof durableRelease.prepared_digest, "string");

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
  assert.equal(approvalResponse.status, 202, "release approval failed");
  await discardResponseBody(approvalResponse);
  await waitForRelease(deploy, project.projectId, release.releaseId, ownerJwt, "reconciling");

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
  assert.deepEqual(
    reconciliationStatuses,
    [409, 502],
    "concurrent reconciliation did not fence the in-flight authority request",
  );
  await Promise.all(reconciliationResponses.map(discardResponseBody));
  const reconciliationResponse = await deploy.fetch(reconciliationPath, {
    method: "POST",
    headers: identityHeaders(ownerJwt),
  });
  assert.equal(reconciliationResponse.status, 200, "reconciliation retry failed");
  await discardResponseBody(reconciliationResponse);
  await waitForRelease(deploy, project.projectId, release.releaseId, ownerJwt, "live");

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
  assert.equal(secondRevisionResponse.status, 201, "second revision upload failed");
  const secondRevision = await secondRevisionResponse.json();
  assert.equal(secondRevision.revisionId, `rev_sha256_${secondArtifactDigest}`);

  const secondReleaseId = await createAutomaticRelease(
    deploy,
    project.projectId,
    secondRevision.revisionId,
    ownerJwt,
    "harness-release-v2",
  );
  await waitForRelease(deploy, project.projectId, secondReleaseId, ownerJwt, "live");

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
  assert.equal(rollbackResponse.status, 202, "rollback admission failed");
  const rollbackRelease = await rollbackResponse.json();
  assert.equal(rollbackRelease.rollbackOfReleaseId, release.releaseId);
  await waitForRelease(deploy, project.projectId, rollbackRelease.releaseId, ownerJwt, "live");

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

  const providerStateResponse = await provider.fetch("/__control/state", {
    headers: PROVIDER_CONTROL,
  });
  assert.equal(providerStateResponse.status, 200);
  const providerState = await providerStateResponse.json();
  assert.equal(providerState.errors.length, 0);
  assert.equal(providerState.observations.length, 12);
  assert.ok(
    providerState.observations.every(
      ({ accountId, namespace, authorizationAccepted, mainModule, moduleNames }) =>
        accountId === "integration-account" &&
        namespace === "integration-namespace" &&
        authorizationAccepted &&
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
  assert.deepEqual(
    providerState.observations.slice(5).map(({ responseMode }) => responseMode),
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

  const finalCounts = await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM projects) AS projects, (SELECT COUNT(*) FROM revisions) AS revisions, (SELECT COUNT(*) FROM releases) AS releases, (SELECT COUNT(*) FROM releases WHERE status = 'live') AS liveReleases, (SELECT COUNT(*) FROM releases WHERE status = 'reconciling') AS reconcilingReleases",
  ).first();
  assert.deepEqual(finalCounts, {
    projects: 1,
    revisions: 2,
    releases: 10,
    liveReleases: 4,
    reconcilingReleases: 6,
  });

  const runtimeLogs = JSON.stringify(harness.getLogs());
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
  assert.equal(resetProviderState.status, 200);
  assert.deepEqual(await resetProviderState.json(), {
    errors: [],
    observations: [],
    responseModes: [],
  });
});
