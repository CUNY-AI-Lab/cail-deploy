import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestIdentityIssuer, TEST_SUBJECTS } from "@cuny-ai-lab/cail-identity/testing";

const config = "wrangler.release-workerd-test.jsonc";
const providerConfig = "wrangler.wfp-api-test.jsonc";
const database = "kale-release-control-plane-release-workerd-test";
const requestId = "33333333-3333-4333-8333-333333333333";
const providerControl = { "X-Kale-WfP-Test-Control": "local-e2e-control" };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function run(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed (${exitCode})\n${stdout}\n${stderr}`);
  }
  return stdout.trim();
}

async function d1Rows<T>(cwd: string, persistTo: string, sql: string): Promise<T[]> {
  const output = await run(
    [
      "bunx",
      "wrangler",
      "d1",
      "execute",
      database,
      "--local",
      "--persist-to",
      persistTo,
      "--config",
      config,
      "--command",
      sql,
      "--json",
    ],
    cwd,
  );
  const result = JSON.parse(output) as Array<{ results?: T[]; success?: boolean }>;
  assert(result.length === 1 && result[0]?.success === true, "D1 query did not succeed");
  return result[0].results ?? [];
}

async function errorCode(response: Response): Promise<string | undefined> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code;
}

async function availablePort(): Promise<number> {
  const socket = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const port = socket.port;
  socket.stop(true);
  return port;
}

function identityHeaders(jwt: string): Record<string, string> {
  return { "X-CAIL-Identity-JWT": jwt };
}

async function waitForRelease(
  baseUrl: string,
  projectId: string,
  releaseId: string,
  jwt: string,
  expectedStatus: string,
): Promise<{
  status?: string;
  events?: Array<{ type?: string; actorSubject?: string | null }>;
}> {
  let observed:
    | {
        status?: string;
        events?: Array<{ type?: string; actorSubject?: string | null }>;
      }
    | undefined;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(`${baseUrl}/v1/projects/${projectId}/releases/${releaseId}`, {
      headers: identityHeaders(jwt),
    });
    assert(response.status === 200, `release read returned ${response.status}`);
    observed = (await response.json()) as typeof observed;
    if (observed?.status === expectedStatus) return observed;
    await Bun.sleep(100);
  }
  throw new Error(
    `release ${releaseId} did not reach ${expectedStatus}; observed ${String(observed?.status)}`,
  );
}

const cwd = new URL("..", import.meta.url).pathname.replace(/\/$/u, "");
const persistTo = await mkdtemp(join(tmpdir(), "kale-release-workerd-"));
const providerPersistTo = await mkdtemp(join(tmpdir(), "kale-wfp-api-workerd-"));
const port = await availablePort();
const providerPort = await availablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const providerBaseUrl = `http://127.0.0.1:${providerPort}`;
// Defaults to CAIL_CANONICAL_ISSUER. The issuer allowlist is a code constant,
// not a reflection of CAIL_IDENTITY_ISSUER, so a `.invalid` test issuer is
// refused at config load and every probe reads 503 — which would mask the
// wrong-audience and cross-owner assertions below rather than exercise them.
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

const providerWorker = Bun.spawn(
  [
    "bunx",
    "wrangler",
    "dev",
    "--local",
    "--config",
    providerConfig,
    "--port",
    String(providerPort),
    "--persist-to",
    providerPersistTo,
  ],
  { cwd, stdout: "pipe", stderr: "pipe" },
);
const providerStdoutPromise = new Response(providerWorker.stdout).text();
const providerStderrPromise = new Response(providerWorker.stderr).text();
let providerReady = false;
for (let attempt = 0; attempt < 150; attempt += 1) {
  try {
    const response = await fetch(`${providerBaseUrl}/__control/state`, {
      headers: providerControl,
    });
    if (response.ok) {
      providerReady = true;
      break;
    }
  } catch {
    // Local provider contract Worker is still starting.
  }
  if (providerWorker.exitCode !== null) break;
  await Bun.sleep(100);
}
if (!providerReady) {
  providerWorker.kill();
  const [stdout, stderr] = await Promise.all([providerStdoutPromise, providerStderrPromise]);
  throw new Error(`WfP provider contract Worker did not start.\n${stdout}\n${stderr}`);
}
const resetProvider = await fetch(`${providerBaseUrl}/__control/reset`, {
  method: "POST",
  headers: {
    ...providerControl,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ ambiguousCalls: [1] }),
});
assert(resetProvider.status === 200, "WfP provider contract reset failed");

await run(
  [
    "bunx",
    "wrangler",
    "d1",
    "migrations",
    "apply",
    database,
    "--local",
    "--persist-to",
    persistTo,
    "--config",
    config,
  ],
  cwd,
);

const worker = Bun.spawn(
  [
    "bunx",
    "wrangler",
    "dev",
    "--local",
    "--config",
    config,
    "--port",
    String(port),
    "--persist-to",
    persistTo,
    "--var",
    `PUBLIC_BASE_URL:${baseUrl}`,
    "--var",
    "AUTH_MODE:cail-jwt",
    "--var",
    "SERVICE_AUDIENCE:cail:deploy",
    "--var",
    `CAIL_IDENTITY_ISSUER:${issuer.issuer}`,
    "--var",
    `CAIL_IDENTITY_JWKS:${issuer.jwksJson}`,
    "--var",
    "RUN_ID:integration-local-e2e",
    "--var",
    "WFP_ACCOUNT_ID:integration-account",
    "--var",
    "WFP_NAMESPACE:integration-namespace",
    "--var",
    "CLOUDFLARE_API_TOKEN:local-contract-token",
  ],
  { cwd, stdout: "pipe", stderr: "pipe" },
);
const stdoutPromise = new Response(worker.stdout).text();
const stderrPromise = new Response(worker.stderr).text();

let evidence:
  | {
      projectId: string;
      revisionId: string;
      releaseId: string;
      secondRevisionId: string;
      secondReleaseId: string;
      rollbackReleaseId: string;
      eventTypes: string[];
      artifactDigest: string;
      providerCalls: Array<{
        call: number;
        revisionId: string;
        moduleSha256: Record<string, string>;
        responseStatus: number;
      }>;
    }
  | undefined;
let primaryError: unknown;

try {
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // Local workerd is still starting.
    }
    if (worker.exitCode !== null) break;
    await Bun.sleep(100);
  }
  assert(ready, "release workerd did not start");

  const unauthenticatedProject = await fetch(`${baseUrl}/v1/projects`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "release-workerd-unauthenticated",
    },
    body: JSON.stringify({ name: "must not exist" }),
  });
  assert(
    unauthenticatedProject.status === 401 &&
      (await errorCode(unauthenticatedProject)) === "authentication_required",
    "missing identity did not fail closed",
  );

  const wrongAudienceProject = await fetch(`${baseUrl}/v1/projects`, {
    method: "POST",
    headers: {
      ...identityHeaders(wrongAudienceJwt),
      "Content-Type": "application/json",
      "Idempotency-Key": "release-workerd-wrong-audience",
    },
    body: JSON.stringify({ name: "must not exist either" }),
  });
  assert(
    wrongAudienceProject.status === 401 &&
      (await errorCode(wrongAudienceProject)) === "invalid_credential",
    "wrong-audience identity did not fail closed",
  );

  const projectResponse = await fetch(`${baseUrl}/v1/projects`, {
    method: "POST",
    headers: {
      ...identityHeaders(ownerJwt),
      "Content-Type": "application/json",
      "Idempotency-Key": "release-workerd-project",
    },
    body: JSON.stringify({ name: "Release workerd fixture" }),
  });
  assert(projectResponse.status === 201, `project creation returned ${projectResponse.status}`);
  const project = (await projectResponse.json()) as { projectId?: string };
  assert(
    typeof project.projectId === "string" && /^prj_[0-9a-f]{32}$/u.test(project.projectId),
    "project response did not contain a project id",
  );

  const artifact = new Uint8Array(
    await Bun.file(new URL("../fixtures/worker-artifact.v1.json", import.meta.url)).arrayBuffer(),
  );
  const artifactDigest = createHash("sha256").update(artifact).digest("hex");
  const contentDigest = `sha-256=:${createHash("sha256").update(artifact).digest("base64")}:`;
  const revisionUrl = `${baseUrl}/v1/projects/${project.projectId}/revisions`;

  const badDigestResponse = await fetch(revisionUrl, {
    method: "POST",
    headers: {
      ...identityHeaders(ownerJwt),
      "Content-Type": "application/vnd.cuny.kale.artifact.v1+json",
      "Content-Digest": `sha-256=:${Buffer.alloc(32).toString("base64")}:`,
    },
    body: artifact,
  });
  assert(
    badDigestResponse.status === 400 && (await errorCode(badDigestResponse)) === "digest_mismatch",
    "wrong artifact digest reached durable revision state",
  );

  const crossOwnerUpload = await fetch(revisionUrl, {
    method: "POST",
    headers: {
      ...identityHeaders(otherOwnerJwt),
      "Content-Type": "application/vnd.cuny.kale.artifact.v1+json",
      "Content-Digest": contentDigest,
    },
    body: artifact,
  });
  assert(
    crossOwnerUpload.status === 404 && (await errorCode(crossOwnerUpload)) === "project_not_found",
    "a different signed subject crossed the project boundary",
  );

  const revisionResponse = await fetch(revisionUrl, {
    method: "POST",
    headers: {
      ...identityHeaders(ownerJwt),
      "Content-Type": "application/vnd.cuny.kale.artifact.v1+json",
      "Content-Digest": contentDigest,
    },
    body: artifact,
  });
  assert(revisionResponse.status === 201, `revision upload returned ${revisionResponse.status}`);
  const revision = (await revisionResponse.json()) as { revisionId?: string };
  assert(
    revision.revisionId === `rev_sha256_${artifactDigest}`,
    "revision id did not preserve the exact artifact digest",
  );

  const releaseResponse = await fetch(`${baseUrl}/v1/projects/${project.projectId}/releases`, {
    method: "POST",
    headers: {
      ...identityHeaders(ownerJwt),
      "Content-Type": "application/json",
      "Idempotency-Key": "release-workerd-release",
      "X-CAIL-Request-Id": requestId,
    },
    body: JSON.stringify({
      revisionId: revision.revisionId,
      target: "preview",
      approval: "required",
    }),
  });
  assert(releaseResponse.status === 202, `release creation returned ${releaseResponse.status}`);
  const release = (await releaseResponse.json()) as { releaseId?: string; status?: string };
  assert(
    typeof release.releaseId === "string" &&
      /^rel_[0-9a-f]{32}$/u.test(release.releaseId) &&
      release.status === "queued",
    "release admission response drifted",
  );

  const observed = await waitForRelease(
    baseUrl,
    project.projectId,
    release.releaseId,
    ownerJwt,
    "awaiting_approval",
  );
  const eventTypes = observed.events?.map((event) => event.type ?? "") ?? [];
  assert(
    eventTypes.join(",") ===
      "release.queued,release.validating,release.building,release.prepared,release.awaiting_approval",
    `release events drifted: ${eventTypes.join(",")}`,
  );
  assert(
    observed.events?.[0]?.actorSubject === TEST_SUBJECTS.alice,
    "queued event lost the authenticated ownership subject",
  );

  const releaseRows = await d1Rows<{
    release_id: string;
    operational_subject: string | null;
    request_id: string;
    status: string;
    prepared_digest: string | null;
  }>(
    cwd,
    persistTo,
    `SELECT release_id, operational_subject, request_id, status, prepared_digest FROM releases WHERE release_id = '${release.releaseId}'`,
  );
  assert(releaseRows.length === 1, "durable release row was not found");
  assert(
    releaseRows[0]?.operational_subject === null,
    "missing signed operational subject was not persisted as SQL NULL",
  );
  assert(
    releaseRows[0]?.status === "awaiting_approval" &&
      releaseRows[0].request_id === requestId &&
      typeof releaseRows[0].prepared_digest === "string",
    "durable release state did not match the public response",
  );

  const durableEvents = await d1Rows<{ sequence: number; type: string }>(
    cwd,
    persistTo,
    `SELECT sequence, type FROM release_events WHERE release_id = '${release.releaseId}' ORDER BY sequence`,
  );
  assert(
    durableEvents.map((event) => event.type).join(",") === eventTypes.join(","),
    "public release events did not match durable D1 events",
  );
  const durableCounts = await d1Rows<{
    projects: number;
    revisions: number;
    releases: number;
  }>(
    cwd,
    persistTo,
    "SELECT (SELECT COUNT(*) FROM projects) AS projects, (SELECT COUNT(*) FROM revisions) AS revisions, (SELECT COUNT(*) FROM releases) AS releases",
  );
  assert(
    durableCounts[0]?.projects === 1 &&
      durableCounts[0].revisions === 1 &&
      durableCounts[0].releases === 1,
    "negative controls created unexpected durable state",
  );

  const approvalResponse = await fetch(
    `${baseUrl}/v1/projects/${project.projectId}/releases/${release.releaseId}/approve`,
    {
      method: "POST",
      headers: {
        ...identityHeaders(ownerJwt),
        "Content-Type": "application/json",
        "Idempotency-Key": "release-workerd-approval",
      },
      body: JSON.stringify({ decision: "approved" }),
    },
  );
  assert(approvalResponse.status === 202, `release approval returned ${approvalResponse.status}`);
  try {
    await waitForRelease(baseUrl, project.projectId, release.releaseId, ownerJwt, "reconciling");
  } catch (error) {
    const providerFailure = await fetch(`${providerBaseUrl}/__control/state`, {
      headers: providerControl,
    });
    throw new Error(`${String(error)}; provider state=${await providerFailure.text()}`);
  }

  const reconciliationUrl = `${baseUrl}/v1/projects/${project.projectId}/releases/${release.releaseId}/reconcile`;
  const reconciliationResponses = await Promise.all([
    fetch(reconciliationUrl, {
      method: "POST",
      headers: {
        ...identityHeaders(ownerJwt),
        "X-CAIL-Request-Id": requestId,
      },
    }),
    fetch(reconciliationUrl, {
      method: "POST",
      headers: {
        ...identityHeaders(ownerJwt),
        "X-CAIL-Request-Id": requestId,
      },
    }),
  ]);
  const reconciliationStatuses = reconciliationResponses
    .map((response) => response.status)
    .sort((left, right) => left - right);
  assert(
    reconciliationStatuses[0] === 200 && reconciliationStatuses[1] === 409,
    `concurrent reconciliation did not produce one authority winner: ${reconciliationStatuses.join(",")}`,
  );
  await waitForRelease(baseUrl, project.projectId, release.releaseId, ownerJwt, "live");

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
  const secondContentDigest = `sha-256=:${createHash("sha256")
    .update(secondArtifact)
    .digest("base64")}:`;
  const secondRevisionResponse = await fetch(revisionUrl, {
    method: "POST",
    headers: {
      ...identityHeaders(ownerJwt),
      "Content-Type": "application/vnd.cuny.kale.artifact.v1+json",
      "Content-Digest": secondContentDigest,
    },
    body: secondArtifact,
  });
  assert(
    secondRevisionResponse.status === 201,
    `second revision upload returned ${secondRevisionResponse.status}`,
  );
  const secondRevision = (await secondRevisionResponse.json()) as {
    revisionId?: string;
  };
  assert(
    secondRevision.revisionId === `rev_sha256_${secondArtifactDigest}`,
    "second revision id did not preserve exact artifact bytes",
  );

  const secondReleaseResponse = await fetch(
    `${baseUrl}/v1/projects/${project.projectId}/releases`,
    {
      method: "POST",
      headers: {
        ...identityHeaders(ownerJwt),
        "Content-Type": "application/json",
        "Idempotency-Key": "release-workerd-release-v2",
      },
      body: JSON.stringify({
        revisionId: secondRevision.revisionId,
        target: "preview",
        approval: "automatic",
      }),
    },
  );
  assert(
    secondReleaseResponse.status === 202,
    `second release returned ${secondReleaseResponse.status}`,
  );
  const secondRelease = (await secondReleaseResponse.json()) as {
    releaseId?: string;
  };
  assert(typeof secondRelease.releaseId === "string", "second release response omitted its id");
  await waitForRelease(baseUrl, project.projectId, secondRelease.releaseId, ownerJwt, "live");

  const rollbackResponse = await fetch(
    `${baseUrl}/v1/projects/${project.projectId}/releases/${release.releaseId}/rollback`,
    {
      method: "POST",
      headers: {
        ...identityHeaders(ownerJwt),
        "Content-Type": "application/json",
        "Idempotency-Key": "release-workerd-rollback-v1",
      },
      body: JSON.stringify({ approval: "automatic" }),
    },
  );
  assert(rollbackResponse.status === 202, `rollback release returned ${rollbackResponse.status}`);
  const rollbackRelease = (await rollbackResponse.json()) as {
    releaseId?: string;
    rollbackOfReleaseId?: string;
  };
  assert(
    typeof rollbackRelease.releaseId === "string" &&
      rollbackRelease.rollbackOfReleaseId === release.releaseId,
    "rollback admission did not retain its exact source release",
  );
  await waitForRelease(baseUrl, project.projectId, rollbackRelease.releaseId, ownerJwt, "live");

  const providerResponse = await fetch(`${providerBaseUrl}/__control/state`, {
    headers: providerControl,
  });
  assert(providerResponse.status === 200, "provider observations were unavailable");
  const providerState = (await providerResponse.json()) as {
    observations?: Array<{
      call: number;
      accountId: string;
      namespace: string;
      authorizationAccepted: boolean;
      mainModule: string;
      revisionId: string;
      moduleNames: string[];
      moduleSha256: Record<string, string>;
      responseStatus: number;
    }>;
  };
  const providerCalls = providerState.observations ?? [];
  assert(
    providerCalls.length === 4 &&
      providerCalls.every(
        (call) =>
          call.accountId === "integration-account" &&
          call.namespace === "integration-namespace" &&
          call.authorizationAccepted &&
          call.moduleNames.includes(call.mainModule),
      ),
    "provider contract did not receive four exact authorized multipart publications",
  );
  assert(
    providerCalls.map((call) => call.responseStatus).join(",") === "503,200,200,200" &&
      providerCalls.map((call) => call.revisionId).join(",") ===
        [
          revision.revisionId,
          revision.revisionId,
          secondRevision.revisionId,
          revision.revisionId,
        ].join(","),
    "provider publication sequence did not preserve ambiguous reconciliation, v2, and rollback bytes",
  );
  assert(
    JSON.stringify(providerCalls[0]?.moduleSha256) ===
      JSON.stringify(providerCalls[1]?.moduleSha256) &&
      JSON.stringify(providerCalls[0]?.moduleSha256) ===
        JSON.stringify(providerCalls[3]?.moduleSha256) &&
      JSON.stringify(providerCalls[0]?.moduleSha256) !==
        JSON.stringify(providerCalls[2]?.moduleSha256),
    "rollback did not republish the retained v1 modules exactly",
  );

  const finalCounts = await d1Rows<{
    projects: number;
    revisions: number;
    releases: number;
    liveReleases: number;
  }>(
    cwd,
    persistTo,
    "SELECT (SELECT COUNT(*) FROM projects) AS projects, (SELECT COUNT(*) FROM revisions) AS revisions, (SELECT COUNT(*) FROM releases) AS releases, (SELECT COUNT(*) FROM releases WHERE status = 'live') AS liveReleases",
  );
  assert(
    finalCounts[0]?.projects === 1 &&
      finalCounts[0].revisions === 2 &&
      finalCounts[0].releases === 3 &&
      finalCounts[0].liveReleases === 3,
    "full lifecycle durable counts did not match two revisions and rollback",
  );

  evidence = {
    projectId: project.projectId,
    revisionId: revision.revisionId,
    releaseId: release.releaseId,
    secondRevisionId: secondRevision.revisionId,
    secondReleaseId: secondRelease.releaseId,
    rollbackReleaseId: rollbackRelease.releaseId,
    eventTypes,
    artifactDigest,
    providerCalls: providerCalls.map(({ call, revisionId, moduleSha256, responseStatus }) => ({
      call,
      revisionId,
      moduleSha256,
      responseStatus,
    })),
  };
} catch (error) {
  primaryError = error;
} finally {
  worker.kill();
  await worker.exited;
  providerWorker.kill();
  await providerWorker.exited;
}

const [stdout, stderr, providerStdout, providerStderr] = await Promise.all([
  stdoutPromise,
  stderrPromise,
  providerStdoutPromise,
  providerStderrPromise,
]);
try {
  if (primaryError) throw primaryError;
  assert(evidence, "release workerd evidence was not collected");
  assert(
    stdout.includes("cail.action.admitted") &&
      stdout.includes(requestId) &&
      /["']?cail\.principal\.type["']?:\s*["']anonymous["']/u.test(stdout),
    "anonymous-attributed operational admission event was not observable",
  );
  console.log(
    JSON.stringify(
      {
        gate: "release-public-http-real-d1-local-workerd",
        authentication: "signed-cail-identity-jwt-without-operational-subject",
        ...evidence,
        durableOperationalSubject: null,
        operationalAdmission: "service",
        negatives: ["missing_auth", "wrong_audience", "digest_mismatch", "cross_subject_owner"],
      },
      null,
      2,
    ),
  );
} catch (error) {
  throw new Error(
    `${String(error)}\nworkerd stdout:\n${stdout}\nworkerd stderr:\n${stderr}\nprovider stdout:\n${providerStdout}\nprovider stderr:\n${providerStderr}`,
  );
} finally {
  await Promise.all([
    rm(persistTo, { recursive: true, force: true }),
    rm(providerPersistTo, { recursive: true, force: true }),
  ]);
}
