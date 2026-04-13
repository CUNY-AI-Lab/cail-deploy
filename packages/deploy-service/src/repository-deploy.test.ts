import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import test from "node:test";

import { CloudflareApiClient } from "./lib/cloudflare";
import { listLiveDedicatedWorkerProjectsForOwner } from "./lib/control-plane";
import {
  createTestContext,
  fetchApp,
  fetchRaw,
  jsonResponse,
  installAccessFetchMock,
  installGitHubFetchMock,
  createAccessJwt,
  repositoryRecord,
  sealStoredValueForTest
} from "./test-support";

function sharedStaticRuntimeEvidence() {
  return {
    source: "build_runner" as const,
    framework: "next" as const,
    classification: "shared_static_eligible" as const,
    confidence: "high" as const,
    basis: ["next_output_export"] as const,
    summary: "Next.js static export."
  };
}

function isSharedStaticRuntimeProbePath(pathname: string): boolean {
  return (
    pathname.endsWith("/api/health")
    || pathname.endsWith("/api")
    || pathname.endsWith("/healthz")
    || pathname.endsWith("/health")
  );
}

function sharedStaticNotFoundResponse(): Response {
  return new Response(null, { status: 404 });
}

function buildDeploymentForm(
  metadata: Record<string, unknown>,
  files: Array<{ name: string; content: string; type: string; fileName?: string }>
): FormData {
  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));

  for (const file of files) {
    form.append(
      file.name,
      new File([file.content], file.fileName ?? file.name, { type: file.type })
    );
  }

  return form;
}

function buildRepositoryArtifactPrefix(repositoryFullName: string, deploymentId: string): string {
  const [owner, repo] = repositoryFullName.split("/", 2);
  return `deployments/repos/${owner}/${repo}/${deploymentId}`;
}

test("project registration returns structured state for an existing project", async () => {
  const { env, db } = createTestContext({
    GITHUB_APP_ID: undefined,
    GITHUB_APP_PRIVATE_KEY: undefined,
    GITHUB_APP_SLUG: undefined
  });

  db.putProject({
    projectName: "cail-deploy-smoke-test",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/cail-deploy-smoke-test",
    deploymentUrl: "https://cail-deploy-smoke-test.cuny.qzz.io",
    hasAssets: false,
    latestDeploymentId: "dep-1",
    createdAt: "2026-03-26T22:40:54.747Z",
    updatedAt: "2026-03-26T22:41:04.957Z"
  });

  const response = await fetchApp("POST", "/api/projects/register", env, {
    repositoryFullName: "szweibel/cail-deploy-smoke-test"
  });
  assert.equal(response.status, 200);

  const body = await response.json() as {
    ok: boolean;
    projectName: string;
    projectAvailable: boolean;
    projectUrl: string;
    installStatus: string;
    guidedInstallUrl?: string;
    latestStatus: string;
    servingStatus: string;
  };

  assert.equal(body.ok, true);
  assert.equal(body.projectName, "cail-deploy-smoke-test");
  assert.equal(body.projectAvailable, true);
  assert.equal(body.projectUrl, "https://cail-deploy-smoke-test.cuny.qzz.io");
  assert.equal(body.installStatus, "app_unconfigured");
  assert.equal(body.guidedInstallUrl, undefined);
  assert.equal(body.latestStatus, "live");
  assert.equal(body.servingStatus, "live");
});

test("CloudflareApiClient paginates R2 bucket lookup", async (t: TestContext) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);

    assert.equal(url.pathname, "/client/v4/accounts/account-123/r2/buckets");
    if (url.searchParams.get("cursor") === "page-2") {
      return new Response(JSON.stringify({
        success: true,
        errors: [],
        result: { buckets: [{ name: "wanted-bucket" }] },
        result_info: {}
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    return new Response(JSON.stringify({
      success: true,
      errors: [],
      result: { buckets: [{ name: "other-bucket" }] },
      result_info: { cursor: "page-2" }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = new CloudflareApiClient({
    accountId: "account-123",
    apiToken: "token-123"
  });
  const bucket = await client.findR2BucketByName("wanted-bucket");
  assert.equal(bucket?.name, "wanted-bucket");
});

test("CloudflareApiClient falls back to account token verification for R2 object cleanup", async (t: TestContext) => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    requests.push(`${request.method} ${url.origin}${url.pathname}${url.search}`);

    if (url.origin === "https://api.cloudflare.com" && url.pathname === "/client/v4/user/tokens/verify") {
      return new Response(JSON.stringify({ success: false, errors: [{ code: 1001, message: "unauthorized" }] }), {
        status: 401,
        headers: { "content-type": "application/json" }
      });
    }

    if (url.origin === "https://api.cloudflare.com"
      && url.pathname === "/client/v4/accounts/account-123/tokens/verify") {
      return new Response(JSON.stringify({
        success: true,
        errors: [],
        result: { id: "account-token-id-123" }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    if (url.origin === "https://account-123.r2.cloudflarestorage.com"
      && url.pathname === "/files-bucket"
      && url.searchParams.get("list-type") === "2") {
      assert.match(request.headers.get("authorization") ?? "", /Credential=account-token-id-123\//);
      return new Response(
        "<ListBucketResult><Name>files-bucket</Name><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated></ListBucketResult>",
        { status: 200, headers: { "content-type": "application/xml" } }
      );
    }

    if (url.origin === "https://api.cloudflare.com"
      && url.pathname === "/client/v4/accounts/account-123/r2/buckets/files-bucket") {
      return new Response(JSON.stringify({ success: true, errors: [], result: {} }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    throw new Error(`Unexpected fetch during test: ${request.method} ${request.url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = new CloudflareApiClient({
    accountId: "account-123",
    apiToken: "token-123"
  });
  await client.emptyAndDeleteR2Bucket("files-bucket");

  assert.deepEqual(requests, [
    "GET https://api.cloudflare.com/client/v4/user/tokens/verify",
    "GET https://api.cloudflare.com/client/v4/accounts/account-123/tokens/verify",
    "GET https://account-123.r2.cloudflarestorage.com/files-bucket?list-type=2&max-keys=1000",
    "DELETE https://api.cloudflare.com/client/v4/accounts/account-123/r2/buckets/files-bucket"
  ]);
});

test("repository status returns a repo-first lifecycle summary", async () => {
  const { env, db } = createTestContext({
    GITHUB_APP_ID: undefined,
    GITHUB_APP_PRIVATE_KEY: undefined,
    GITHUB_APP_SLUG: undefined
  });

  db.putProject({
    projectName: "cail-deploy-smoke-test",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/cail-deploy-smoke-test",
    deploymentUrl: "https://cail-deploy-smoke-test.cuny.qzz.io",
    hasAssets: false,
    latestDeploymentId: "dep-1",
    createdAt: "2026-03-26T22:40:54.747Z",
    updatedAt: "2026-03-26T22:41:04.957Z"
  });

  const response = await fetchApp("GET", "/api/repositories/szweibel/cail-deploy-smoke-test/status", env);
  assert.equal(response.status, 200);

  const body = await response.json() as {
    ok: boolean;
    repositoryStatusUrl: string;
    workflowStage: string;
    nextAction: string;
    summary: string;
    deploymentUrl: string;
  };

  assert.equal(body.ok, true);
  assert.equal(body.repositoryStatusUrl, "https://deploy.example/api/repositories/szweibel/cail-deploy-smoke-test/status");
  assert.equal(body.workflowStage, "live");
  assert.equal(body.nextAction, "view_live_project");
  assert.match(body.summary, /site is live/i);
  assert.equal(body.deploymentUrl, "https://cail-deploy-smoke-test.cuny.qzz.io");
});

test("project registration pauses while repository deletion cleanup is still pending", async () => {
  const { env, db } = createTestContext({
    GITHUB_APP_ID: undefined,
    GITHUB_APP_PRIVATE_KEY: undefined,
    GITHUB_APP_SLUG: undefined
  });

  db.putProject({
    projectName: "cail-deploy-smoke-test",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/cail-deploy-smoke-test",
    deploymentUrl: "https://cail-deploy-smoke-test.cuny.qzz.io",
    hasAssets: false,
    latestDeploymentId: undefined,
    createdAt: "2026-03-26T22:40:54.747Z",
    updatedAt: "2026-03-26T22:41:04.957Z"
  });
  db.putProjectDeletionBacklog({
    github_repo: "szweibel/cail-deploy-smoke-test",
    project_name: "cail-deploy-smoke-test",
    requested_at: "2026-04-04T10:00:00.000Z",
    updated_at: "2026-04-04T10:00:10.000Z",
    worker_script_names_json: JSON.stringify(["cail-deploy-smoke-test"]),
    database_ids_json: JSON.stringify([]),
    files_bucket_names_json: JSON.stringify([]),
    cache_namespace_ids_json: JSON.stringify([]),
    artifact_prefixes_json: JSON.stringify([]),
    last_error: "worker_script cail-deploy-smoke-test: boom"
  });

  const response = await fetchApp("POST", "/api/projects/register", env, {
    repositoryFullName: "szweibel/cail-deploy-smoke-test"
  });
  assert.equal(response.status, 409);

  const body = await response.json() as {
    ok: boolean;
    workflowStage: string;
    nextAction: string;
    summary: string;
  };
  assert.equal(body.ok, false);
  assert.equal(body.workflowStage, "cleanup_pending");
  assert.equal(body.nextAction, "wait_for_delete_cleanup");
  assert.match(body.summary, /finishing cleanup/i);
});

test("project registration returns a repo-aware guided install URL when the app is configured", async (t: TestContext) => {
  const { env } = createTestContext();
  installGitHubFetchMock(t, {
    repositoryName: "cail-deploy-smoke-test",
    headSha: "unused"
  });

  const response = await fetchApp("POST", "/api/projects/register", env, {
    repositoryFullName: "szweibel/cail-deploy-smoke-test"
  });
  assert.equal(response.status, 200);

  const body = await response.json() as {
    guidedInstallUrl: string;
    installStatus: string;
  };

  assert.equal(
    body.guidedInstallUrl,
    "https://deploy.example/github/install?repositoryFullName=szweibel%2Fcail-deploy-smoke-test&projectName=cail-deploy-smoke-test"
  );
  assert.equal(body.installStatus, "installed");
});

test("project registration returns suggested alternative slugs on conflict", async () => {
  const { env, db } = createTestContext({
    GITHUB_APP_ID: undefined,
    GITHUB_APP_PRIVATE_KEY: undefined,
    GITHUB_APP_SLUG: undefined
  });

  db.putProject({
    projectName: "archive",
    ownerLogin: "otherperson",
    githubRepo: "otherperson/archive",
    deploymentUrl: "https://archive.cuny.qzz.io",
    hasAssets: false,
    latestDeploymentId: "dep-archive",
    createdAt: "2026-03-26T22:40:54.747Z",
    updatedAt: "2026-03-26T22:41:04.957Z"
  });

  const response = await fetchApp("POST", "/api/projects/register", env, {
    repositoryFullName: "szweibel/archive"
  });
  assert.equal(response.status, 409);

  const body = await response.json() as {
    ok: boolean;
    nextAction: string;
    existingRepositoryFullName: string;
    suggestedProjectNames: Array<{ projectName: string; projectUrl: string }>;
  };

  assert.equal(body.ok, false);
  assert.equal(body.nextAction, "choose_different_project_name");
  assert.equal(body.existingRepositoryFullName, "otherperson/archive");
  assert.ok(body.suggestedProjectNames.length > 0);
  assert.equal(body.suggestedProjectNames[0]?.projectName, "archive-szweibel");
  assert.equal(body.suggestedProjectNames[0]?.projectUrl, "https://archive-szweibel.cuny.qzz.io");
});

test("project registration rejects slugs longer than the public hostname limit", async () => {
  const { env } = createTestContext({
    GITHUB_APP_ID: undefined,
    GITHUB_APP_PRIVATE_KEY: undefined,
    GITHUB_APP_SLUG: undefined
  });

  const response = await fetchApp("POST", "/api/projects/register", env, {
    repositoryFullName: "szweibel/archive",
    projectName: "a".repeat(64)
  });
  assert.equal(response.status, 400);

  const body = await response.json() as { error: string };
  assert.match(body.error, /no longer than 63 characters/i);
});

test("project registration treats same-owner different repositories as a conflict", async () => {
  const { env, db } = createTestContext({
    GITHUB_APP_ID: undefined,
    GITHUB_APP_PRIVATE_KEY: undefined,
    GITHUB_APP_SLUG: undefined
  });

  db.putProject({
    projectName: "archive",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/archive-one",
    deploymentUrl: "https://archive.cuny.qzz.io",
    hasAssets: false,
    latestDeploymentId: "dep-archive",
    createdAt: "2026-03-26T22:40:54.747Z",
    updatedAt: "2026-03-26T22:41:04.957Z"
  });

  const response = await fetchApp("POST", "/api/projects/register", env, {
    repositoryFullName: "szweibel/archive-two",
    projectName: "archive"
  });
  assert.equal(response.status, 409);

  const body = await response.json() as {
    existingRepositoryFullName: string;
    nextAction: string;
  };

  assert.equal(body.existingRepositoryFullName, "szweibel/archive-one");
  assert.equal(body.nextAction, "choose_different_project_name");
});

test("project registration treats redirect labels as claimed names too", async () => {
  const { env, db } = createTestContext({
    GITHUB_APP_ID: undefined,
    GITHUB_APP_PRIVATE_KEY: undefined,
    GITHUB_APP_SLUG: undefined
  });

  db.putProjectDomain({
    domain_label: "archive",
    project_name: "archive-project",
    github_repo: "otherperson/archive",
    is_primary: 0,
    created_at: "2026-03-26T22:40:54.747Z",
    updated_at: "2026-03-26T22:41:04.957Z"
  });

  const response = await fetchApp("POST", "/api/projects/register", env, {
    repositoryFullName: "szweibel/archive",
    projectName: "archive"
  });
  assert.equal(response.status, 409);

  const body = await response.json() as {
    existingRepositoryFullName: string;
    nextAction: string;
  };

  assert.equal(body.existingRepositoryFullName, "otherperson/archive");
  assert.equal(body.nextAction, "choose_different_project_name");
});

test("project registration avoids reserved platform hostnames", async () => {
  const { env } = createTestContext({
    GITHUB_APP_ID: undefined,
    GITHUB_APP_PRIVATE_KEY: undefined,
    GITHUB_APP_SLUG: undefined
  });

  const response = await fetchApp("POST", "/api/projects/register", env, {
    repositoryFullName: "szweibel/runtime"
  });
  assert.equal(response.status, 200);

  const body = await response.json() as {
    projectName: string;
    projectUrl: string;
  };

  assert.equal(body.projectName, "runtime-app");
  assert.equal(body.projectUrl, "https://runtime-app.cuny.qzz.io");
});

test("guided install stores repo context and renders a GitHub handoff page", async (t: TestContext) => {
  const { env } = createTestContext();
  installGitHubFetchMock(t, {
    repositoryName: "cail-deploy-smoke-test",
    headSha: "unused",
    installed: false
  });

  const response = await fetchApp(
    "GET",
    "/github/install?repositoryFullName=szweibel/cail-deploy-smoke-test&projectName=cail-deploy-smoke-test",
    env
  );

  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /cail_github_install_context=/);
  assert.match(setCookie, /Path=\//);
  const html = await response.text();
  assert.match(html, /GitHub needed/);
  assert.match(html, /Ready for GitHub approval/);
  assert.match(html, /Continue to GitHub/);
  assert.match(html, /View setup progress/);
  assert.match(html, /Check for updates/);
  assert.match(html, /repository-live-refresh-bootstrap/);
});

test("guided install explains when the repository is already covered", async (t: TestContext) => {
  const { env } = createTestContext();
  installGitHubFetchMock(t, {
    repositoryName: "cail-deploy-smoke-test",
    headSha: "unused",
    installed: true
  });

  const response = await fetchApp(
    "GET",
    "/github/install?repositoryFullName=szweibel/cail-deploy-smoke-test&projectName=cail-deploy-smoke-test",
    env
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Already connected/);
  assert.match(html, /This repo already has GitHub access/);
  assert.match(html, /View setup progress/);
  assert.match(html, /Open GitHub again/);
  assert.match(html, /Check for updates/);
});

test("setup page verifies repository coverage for the guided install context", async (t: TestContext) => {
  const { env } = createTestContext();
  installGitHubFetchMock(t, {
    repositoryName: "cail-deploy-smoke-test",
    headSha: "unused",
    installed: true
  });

  const response = await fetchApp(
    "GET",
    "/github/setup?repositoryFullName=szweibel/cail-deploy-smoke-test&projectName=cail-deploy-smoke-test&installation_id=42&setup_action=install",
    env
  );
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /Ready to deploy/);
  assert.match(html, /szweibel\/cail-deploy-smoke-test/);
  assert.match(html, /GitHub is connected/);
  assert.match(html, /Push to the default branch/);
  assert.match(html, /Check for updates/);
  assert.match(html, /https:\/\/deploy\.example\/api\/projects\/cail-deploy-smoke-test\/status/);
  assert.match(html, /https:\/\/deploy\.example\/api\/repositories\/szweibel\/cail-deploy-smoke-test\/status/);
});

test("setup page explains when GitHub returned but the repository is still not covered", async (t: TestContext) => {
  const { env } = createTestContext();
  installGitHubFetchMock(t, {
    repositoryName: "cail-deploy-smoke-test",
    headSha: "unused",
    installed: false
  });

  const response = await fetchApp(
    "GET",
    "/github/setup?repositoryFullName=szweibel/cail-deploy-smoke-test&projectName=cail-deploy-smoke-test&installation_id=42&setup_action=install",
    env
  );
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /GitHub did not grant access to this repo/);
  assert.match(html, /Try the GitHub flow again/);
  assert.match(html, /Connect GitHub for this repo/);
});

test("validate queues a build-only job and returns a pollable status URL", async (t: TestContext) => {
  const { env, db, queue } = createTestContext();
  installGitHubFetchMock(t, {
    repositoryName: "cail-assets-build-test",
    headSha: "abc123def456"
  });

  const response = await fetchApp("POST", "/api/validate", env, {
    repositoryFullName: "szweibel/cail-assets-build-test",
    ref: "main"
  });
  assert.equal(response.status, 202);

  const body = await response.json() as {
    ok: boolean;
    jobId: string;
    jobKind: string;
    status: string;
    buildStatus: string;
    statusUrl: string;
  };

  assert.equal(body.ok, true);
  assert.equal(body.jobKind, "validation");
  assert.equal(body.status, "queued");
  assert.equal(body.buildStatus, "queued");
  assert.match(body.statusUrl, /\/api\/build-jobs\/.+\/status$/);
  assert.equal(queue.sent.length, 1);
  assert.equal(queue.sent[0]?.trigger.event, "validate");

  const savedJob = db.getBuildJob(body.jobId);
  assert.ok(savedJob);
  assert.equal(savedJob?.eventName, "validate");
  assert.equal(savedJob?.headSha, "abc123def456");
});

test("validate expires a stale queued build before applying the repo concurrency cap", async (t: TestContext) => {
  const { env, db, queue } = createTestContext();
  installGitHubFetchMock(t, {
    repositoryName: "cail-assets-build-test",
    headSha: "abc123def456"
  });
  db.putBuildJob({
    jobId: "job-stale-queued",
    eventName: "push",
    installationId: 42,
    repository: repositoryRecord("cail-assets-build-test"),
    ref: "refs/heads/main",
    headSha: "old-sha",
    checkRunId: 123,
    status: "queued",
    projectName: "cail-assets-build-test",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z"
  });

  const response = await fetchApp("POST", "/api/validate", env, {
    repositoryFullName: "szweibel/cail-assets-build-test",
    ref: "main"
  });
  assert.equal(response.status, 202);
  assert.equal(queue.sent.length, 1);

  const staleJob = db.getBuildJob("job-stale-queued");
  assert.equal(staleJob?.status, "failure");
  assert.ok(staleJob?.completedAt);
  assert.match(staleJob?.errorMessage ?? "", /stayed queued too long without starting/i);
});

test("validate still blocks when the repo already has a fresh queued build", async (t: TestContext) => {
  const { env, db, queue } = createTestContext();
  installGitHubFetchMock(t, {
    repositoryName: "cail-assets-build-test",
    headSha: "abc123def456"
  });
  const now = new Date().toISOString();
  db.putBuildJob({
    jobId: "job-fresh-queued",
    eventName: "push",
    installationId: 42,
    repository: repositoryRecord("cail-assets-build-test"),
    ref: "refs/heads/main",
    headSha: "fresh-sha",
    checkRunId: 124,
    status: "queued",
    projectName: "cail-assets-build-test",
    createdAt: now,
    updatedAt: now
  });

  const response = await fetchApp("POST", "/api/validate", env, {
    repositoryFullName: "szweibel/cail-assets-build-test",
    ref: "main"
  });
  assert.equal(response.status, 429);
  assert.equal(queue.sent.length, 0);
});

test("validate reuses the repository's existing project slug by default", async (t: TestContext) => {
  const { env, db, queue } = createTestContext();
  installGitHubFetchMock(t, {
    repositoryName: "cail-assets-build-test",
    headSha: "abc123def456"
  });

  db.putProject({
    projectName: "custom-assets-site",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/cail-assets-build-test",
    deploymentUrl: "https://custom-assets-site.cuny.qzz.io",
    hasAssets: false,
    latestDeploymentId: "dep-1",
    createdAt: "2026-03-28T00:00:00.000Z",
    updatedAt: "2026-03-28T00:05:00.000Z"
  });

  const response = await fetchApp("POST", "/api/validate", env, {
    repositoryFullName: "szweibel/cail-assets-build-test",
    ref: "main"
  });
  assert.equal(response.status, 202);
  assert.equal(queue.sent.length, 1);
  assert.equal(queue.sent[0]?.deployment.suggestedProjectName, "custom-assets-site");
});

test("validate does not enforce a daily cap by default", async (t: TestContext) => {
  const { env, db, queue } = createTestContext();
  installGitHubFetchMock(t, {
    repositoryName: "cail-assets-build-test",
    headSha: "abc123def456"
  });

  for (let index = 0; index < 25; index += 1) {
    db.putBuildJob({
      jobId: `job-${index}`,
      eventName: "validate",
      installationId: 42,
      repository: repositoryRecord("cail-assets-build-test"),
      ref: "refs/heads/main",
      headSha: `sha-${index}`,
      checkRunId: 500 + index,
      status: "success",
      projectName: "cail-assets-build-test",
      createdAt: `2026-03-28T0${Math.min(index, 9)}:00:00.000Z`,
      updatedAt: `2026-03-28T0${Math.min(index, 9)}:05:00.000Z`,
      completedAt: `2026-03-28T0${Math.min(index, 9)}:05:00.000Z`
    });
  }

  const response = await fetchApp("POST", "/api/validate", env, {
    repositoryFullName: "szweibel/cail-assets-build-test",
    ref: "main"
  });
  assert.equal(response.status, 202);

  const body = await response.json() as {
    ok: boolean;
    status: string;
  };

  assert.equal(body.ok, true);
  assert.equal(body.status, "queued");
  assert.equal(queue.sent.length, 1);
});

test("build completion records failure even when the GitHub check-run update fails", async (t: TestContext) => {
  const { env, db } = createTestContext({
    BUILD_RUNNER_TOKEN: "runner-token"
  });
  db.putBuildJob({
    jobId: "job-check-update-failure",
    eventName: "push",
    installationId: 42,
    repository: repositoryRecord("check-run-update-fails"),
    ref: "refs/heads/main",
    headSha: "failed-sha",
    checkRunId: 77,
    status: "in_progress",
    projectName: "check-run-update-fails",
    createdAt: "2026-03-28T12:00:00.000Z",
    updatedAt: "2026-03-28T12:01:00.000Z",
    startedAt: "2026-03-28T12:01:00.000Z"
  });

  let patchAttempts = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);

    if (url.pathname === "/app/installations/42/access_tokens" && request.method === "POST") {
      return jsonResponse({ token: "installation-token", expires_at: "2030-01-01T00:00:00.000Z" });
    }

    if (url.pathname === "/repos/szweibel/check-run-update-fails/check-runs/77" && request.method === "PATCH") {
      patchAttempts += 1;
      throw new Error("GitHub check-run API unavailable");
    }

    throw new Error(`Unexpected fetch during test: ${request.method} ${request.url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const response = await fetchApp(
    "POST",
    "/internal/build-jobs/job-check-update-failure/complete",
    env,
    {
      status: "failure",
      summary: "Build failed before deployment.",
      text: "Detailed build failure",
      failureKind: "build_failure",
      completedAt: "2026-03-28T12:02:00.000Z"
    },
    {
      authorization: "Bearer runner-token"
    }
  );

  assert.equal(response.status, 200);
  const body = await response.json() as {
    ok: boolean;
    job: {
      status: string;
      errorMessage?: string;
      errorDetail?: string;
    };
  };
  assert.equal(body.ok, true);
  assert.equal(body.job.status, "failure");
  assert.equal(body.job.errorMessage, "Build failed before deployment.");
  assert.equal(body.job.errorDetail, "Detailed build failure");
  assert.equal(patchAttempts, 1);

  const storedJob = db.getBuildJob("job-check-update-failure");
  assert.equal(storedJob?.status, "failure");
  assert.equal(storedJob?.errorMessage, "Build failed before deployment.");
});

test("deployments reject oversized total upload bundles before provisioning resources", async () => {
  const { env } = createTestContext();
  const metadata = {
    projectName: "oversized-upload",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/oversized-upload",
    workerUpload: {
      main_module: "index.js",
      compatibility_date: "2026-03-28",
      bindings: []
    },
    staticAssets: {
      files: [
        {
          path: "assets/hero.bin",
          partName: "asset-hero",
          contentType: "application/octet-stream"
        }
      ]
    }
  };
  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));
  form.append("index.js", new File([new Uint8Array(46 * 1024 * 1024)], "index.js", { type: "application/javascript" }));
  form.append("asset-hero", new File([new Uint8Array(46 * 1024 * 1024)], "hero.bin", { type: "application/octet-stream" }));

  const response = await fetchRaw(new Request("https://deploy.example/api/deployments", {
    method: "POST",
    headers: {
      authorization: "Bearer deploy-token"
    },
    body: form
  }), {
    ...env,
    DEPLOY_API_TOKEN: "deploy-token",
    CLOUDFLARE_API_TOKEN: "cloudflare-token"
  });

  assert.equal(response.status, 413);
  const body = await response.json() as { error: string };
  assert.match(body.error, /deployment bundle is too large/i);
});

test("live dedicated-worker counting dedupes by repo and ignores shared-static projects", async () => {
  const { db } = createTestContext();
  db.putProject({
    projectName: "worker-one",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/worker-one",
    deploymentUrl: "https://worker-one.cuny.qzz.io",
    runtimeLane: "dedicated_worker",
    hasAssets: false,
    latestDeploymentId: "dep-1",
    createdAt: "2026-04-05T10:00:00.000Z",
    updatedAt: "2026-04-05T10:00:00.000Z"
  });
  db.putProject({
    projectName: "worker-one-renamed",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/worker-one",
    deploymentUrl: "https://worker-one-renamed.cuny.qzz.io",
    runtimeLane: "dedicated_worker",
    hasAssets: false,
    latestDeploymentId: "dep-2",
    createdAt: "2026-04-05T10:05:00.000Z",
    updatedAt: "2026-04-05T10:05:00.000Z"
  });
  db.putProject({
    projectName: "worker-two",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/worker-two",
    deploymentUrl: "https://worker-two.cuny.qzz.io",
    runtimeLane: "dedicated_worker",
    hasAssets: false,
    latestDeploymentId: "dep-3",
    createdAt: "2026-04-05T10:10:00.000Z",
    updatedAt: "2026-04-05T10:10:00.000Z"
  });
  db.putProject({
    projectName: "static-site",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/static-site",
    deploymentUrl: "https://static-site.cuny.qzz.io",
    runtimeLane: "shared_static",
    hasAssets: true,
    latestDeploymentId: "dep-4",
    createdAt: "2026-04-05T10:15:00.000Z",
    updatedAt: "2026-04-05T10:15:00.000Z"
  });

  const counted = await listLiveDedicatedWorkerProjectsForOwner(
    db as unknown as D1Database,
    "szweibel"
  );
  assert.deepEqual(counted.map((project) => project.projectName), [
    "worker-two",
    "worker-one-renamed"
  ]);
});

test("dedicated-worker cap blocks a sixth live worker for the same owner before provisioning", async (t: TestContext) => {
  const { env, db } = createTestContext();
  for (let index = 1; index <= 5; index += 1) {
    db.putProject({
      projectName: `worker-${index}`,
      ownerLogin: "szweibel",
      githubRepo: `szweibel/worker-${index}`,
      deploymentUrl: `https://worker-${index}.cuny.qzz.io`,
      runtimeLane: "dedicated_worker",
      hasAssets: false,
      latestDeploymentId: `dep-${index}`,
      createdAt: `2026-04-05T10:0${index}:00.000Z`,
      updatedAt: `2026-04-05T10:0${index}:00.000Z`
    });
  }

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    throw new Error(`Unexpected fetch during capacity rejection: ${request.method} ${request.url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const response = await fetchRaw(new Request("https://deploy.example/api/deployments", {
    method: "POST",
    headers: {
      authorization: "Bearer deploy-token"
    },
    body: buildDeploymentForm({
      projectName: "worker-6",
      ownerLogin: "szweibel",
      githubRepo: "szweibel/worker-6",
      workerUpload: {
        main_module: "index.js",
        compatibility_date: "2026-04-05",
        bindings: []
      }
    }, [
      {
        name: "index.js",
        fileName: "index.js",
        content: "export default { fetch() { return new Response('worker six'); } };",
        type: "application/javascript"
      }
    ])
  }), {
    ...env,
    DEPLOY_API_TOKEN: "deploy-token"
  });

  assert.equal(response.status, 429);
  const body = await response.json() as { error: string };
  assert.match(body.error, /caps live dedicated-worker projects at 5 per GitHub owner/i);
  assert.match(body.error, /worker-1/);
  assert.equal(db.selectProject("worker-6"), null);
  assert.equal(db.selectProjectDomain("worker-6"), null);
});

test("owner capacity overrides can raise the dedicated-worker cap above the default", async (t: TestContext) => {
  const { env, db } = createTestContext();
  db.putOwnerCapacityOverride({
    owner_login: "szweibel",
    max_live_dedicated_workers: 6,
    note: "Teaching week",
    created_at: "2026-04-05T09:00:00.000Z",
    updated_at: "2026-04-05T09:00:00.000Z"
  });
  for (let index = 1; index <= 5; index += 1) {
    db.putProject({
      projectName: `worker-${index}`,
      ownerLogin: "szweibel",
      githubRepo: `szweibel/worker-${index}`,
      deploymentUrl: `https://worker-${index}.cuny.qzz.io`,
      runtimeLane: "dedicated_worker",
      hasAssets: false,
      latestDeploymentId: `dep-${index}`,
      createdAt: `2026-04-05T12:0${index}:00.000Z`,
      updatedAt: `2026-04-05T12:0${index}:00.000Z`
    });
  }

  const uploadedScripts: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/client/v4/accounts/account-123/d1/database") {
      return jsonResponse({ success: true, errors: [], result: [] });
    }

    if (request.method === "POST" && url.pathname === "/client/v4/accounts/account-123/d1/database") {
      return jsonResponse({
        success: true,
        errors: [],
        result: {
          uuid: "db-worker-6",
          name: "cail-szweibel-worker-6"
        }
      });
    }

    if (request.method === "PUT"
      && url.pathname === "/client/v4/accounts/account-123/workers/dispatch/namespaces/cail-production/scripts/worker-6") {
      uploadedScripts.push("worker-6");
      return new Response("", { status: 200 });
    }

    throw new Error(`Unexpected fetch during overridden capacity deploy: ${request.method} ${request.url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const response = await fetchRaw(new Request("https://deploy.example/api/deployments", {
    method: "POST",
    headers: {
      authorization: "Bearer deploy-token"
    },
    body: buildDeploymentForm({
      projectName: "worker-6",
      ownerLogin: "szweibel",
      githubRepo: "szweibel/worker-6",
      workerUpload: {
        main_module: "index.js",
        compatibility_date: "2026-04-05",
        bindings: []
      }
    }, [
      {
        name: "index.js",
        fileName: "index.js",
        content: "export default { fetch() { return new Response('worker six'); } };",
        type: "application/javascript"
      }
    ])
  }), {
    ...env,
    DEPLOY_API_TOKEN: "deploy-token"
  });

  assert.equal(response.status, 200);
  assert.deepEqual(uploadedScripts, ["worker-6"]);
});

test("redeploying an already-counted dedicated worker is still allowed at the owner cap", async (t: TestContext) => {
  const { env, db } = createTestContext();
  for (let index = 1; index <= 5; index += 1) {
    db.putProject({
      projectName: `worker-${index}`,
      ownerLogin: "szweibel",
      githubRepo: `szweibel/worker-${index}`,
      deploymentUrl: `https://worker-${index}.cuny.qzz.io`,
      databaseId: `db-${index}`,
      filesBucketName: `kale-files-worker-${index}`,
      cacheNamespaceId: `kv-${index}`,
      runtimeLane: "dedicated_worker",
      recommendedRuntimeLane: "dedicated_worker",
      hasAssets: false,
      latestDeploymentId: `dep-${index}`,
      createdAt: `2026-04-05T10:1${index}:00.000Z`,
      updatedAt: `2026-04-05T10:1${index}:00.000Z`
    });
  }

  const uploadedScripts: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);

    if (request.method === "PUT"
      && url.pathname === "/client/v4/accounts/account-123/workers/dispatch/namespaces/cail-production/scripts/worker-5") {
      uploadedScripts.push("worker-5");
      return new Response("", { status: 200 });
    }

    throw new Error(`Unexpected fetch during dedicated redeploy at capacity: ${request.method} ${request.url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const response = await fetchRaw(new Request("https://deploy.example/api/deployments", {
    method: "POST",
    headers: {
      authorization: "Bearer deploy-token"
    },
    body: buildDeploymentForm({
      projectName: "worker-5",
      ownerLogin: "szweibel",
      githubRepo: "szweibel/worker-5",
      workerUpload: {
        main_module: "index.js",
        compatibility_date: "2026-04-05",
        bindings: []
      }
    }, [
      {
        name: "index.js",
        fileName: "index.js",
        content: "export default { fetch() { return new Response('redeploy'); } };",
        type: "application/javascript"
      }
    ])
  }), {
    ...env,
    DEPLOY_API_TOKEN: "deploy-token"
  });

  assert.equal(response.status, 200);
  assert.deepEqual(uploadedScripts, ["worker-5"]);
});

test("shared-static fallback over the worker cap rolls back the temporary dedicated deploy", async (t: TestContext) => {
  const { env, db, archive } = createTestContext();
  for (let index = 1; index <= 5; index += 1) {
    db.putProject({
      projectName: `worker-${index}`,
      ownerLogin: "szweibel",
      githubRepo: `szweibel/worker-${index}`,
      deploymentUrl: `https://worker-${index}.cuny.qzz.io`,
      runtimeLane: "dedicated_worker",
      recommendedRuntimeLane: "dedicated_worker",
      hasAssets: false,
      latestDeploymentId: `dep-${index}`,
      createdAt: `2026-04-05T11:0${index}:00.000Z`,
      updatedAt: `2026-04-05T11:0${index}:00.000Z`
    });
  }

  const uploadedScripts: string[] = [];
  const deletedScripts: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const uploadSessionMatch = url.pathname.match(/\/workers\/dispatch\/namespaces\/cail-production\/scripts\/([^/]+)\/assets-upload-session$/);
    const scriptMatch = url.pathname.match(/\/workers\/dispatch\/namespaces\/cail-production\/scripts\/([^/]+)$/);

    if (request.method === "POST" && uploadSessionMatch) {
      return jsonResponse({
        success: true,
        errors: [],
        result: {
          jwt: "assets-upload-jwt",
          buckets: []
        }
      });
    }

    if (request.method === "PUT" && scriptMatch) {
      uploadedScripts.push(scriptMatch[1]!);
      return new Response("", { status: 200 });
    }

    if (request.method === "GET" && url.origin === "https://shared-static-over-cap.cuny.qzz.io") {
      if (url.pathname === "/") {
        return new Response("<h1>Wrong body</h1>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }

      if (isSharedStaticRuntimeProbePath(url.pathname) || url.pathname.endsWith("/__kale_missing_page__")) {
        return sharedStaticNotFoundResponse();
      }
    }

    if (request.method === "DELETE" && scriptMatch) {
      deletedScripts.push(scriptMatch[1]!);
      return new Response("", { status: 200 });
    }

    if (url.pathname.includes("/client/v4/accounts/account-123/d1/database")
      || url.pathname.includes("/storage/kv/namespaces")
      || url.pathname.includes("/r2/buckets")) {
      throw new Error(`Unexpected project provisioning during shared-static-cap rollback: ${request.method} ${request.url}`);
    }

    throw new Error(`Unexpected fetch during shared-static-cap rollback: ${request.method} ${request.url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const response = await fetchRaw(new Request("https://deploy.example/api/deployments", {
    method: "POST",
    headers: {
      authorization: "Bearer deploy-token"
    },
    body: buildDeploymentForm({
      projectName: "shared-static-over-cap",
      ownerLogin: "szweibel",
      githubRepo: "szweibel/shared-static-over-cap",
      runtimeEvidence: sharedStaticRuntimeEvidence(),
      workerUpload: {
        main_module: "index.js",
        compatibility_date: "2026-04-05",
        bindings: []
      },
      staticAssets: {
        config: {
          html_handling: "auto-trailing-slash",
          not_found_handling: "404-page"
        },
        files: [
          {
            path: "/index.html",
            partName: "asset-0",
            contentType: "text/html; charset=utf-8"
          }
        ]
      }
    }, [
      {
        name: "index.js",
        fileName: "index.js",
        content: "export default { fetch() { return new Response('preview worker'); } };",
        type: "application/javascript"
      },
      {
        name: "asset-0",
        fileName: "index.html",
        content: "<h1>Expected body</h1>",
        type: "text/html; charset=utf-8"
      }
    ])
  }), {
    ...env,
    DEPLOY_API_TOKEN: "deploy-token"
  });

  assert.equal(response.status, 429);
  const body = await response.json() as { error: string };
  assert.match(body.error, /caps live dedicated-worker projects at 5 per GitHub owner/i);
  assert.deepEqual(uploadedScripts, ["shared-static-over-cap"]);
  assert.deepEqual(deletedScripts, ["shared-static-over-cap"]);
  assert.equal(db.selectProject("shared-static-over-cap"), null);
  assert.equal(db.selectProjectDomain("shared-static-over-cap"), null);
  const archivedObjects = await archive.list({
    prefix: "deployments/repos/szweibel/shared-static-over-cap/"
  });
  assert.deepEqual(archivedObjects.objects, []);
});

test("shared static candidates auto-demote after validation without project resource provisioning", async (t: TestContext) => {
  const { env, db, archive } = createTestContext();
  const uploadedScripts: string[] = [];
  const deletedScripts: string[] = [];
  const validationRequestPaths: string[] = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const uploadSessionMatch = url.pathname.match(/\/workers\/dispatch\/namespaces\/cail-production\/scripts\/([^/]+)\/assets-upload-session$/);
    const scriptMatch = url.pathname.match(/\/workers\/dispatch\/namespaces\/cail-production\/scripts\/([^/]+)$/);

    if (request.method === "POST" && uploadSessionMatch) {
      return new Response(JSON.stringify({
        success: true,
        errors: [],
        result: {
          jwt: "assets-upload-jwt",
          buckets: []
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    if (request.method === "PUT" && scriptMatch) {
      const scriptName = scriptMatch[1]!;
      uploadedScripts.push(scriptName);
      const form = await request.formData();
      const metadataEntry = form.get("metadata");
      assert.ok(metadataEntry instanceof File);
      const workerUpload = JSON.parse(await metadataEntry.text()) as {
        bindings?: Array<Record<string, string>>;
        assets?: {
          jwt?: string;
        };
      };
      assert.equal(workerUpload.bindings?.find((binding) => binding.name === "DB"), undefined);
      assert.equal(workerUpload.assets?.jwt, "assets-upload-jwt");
      return new Response("", { status: 200 });
    }

    if (request.method === "GET" && url.origin === "https://shared-static-site.cuny.qzz.io") {
      validationRequestPaths.push(url.pathname);
      assert.ok(url.searchParams.get("__kale_validate"));

      if (url.pathname === "/") {
        return new Response("<h1>Shared Static</h1>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }

      if (isSharedStaticRuntimeProbePath(url.pathname)) {
        return sharedStaticNotFoundResponse();
      }

      if (url.pathname.endsWith("/__kale_missing_page__")) {
        return sharedStaticNotFoundResponse();
      }
    }

    if (url.pathname.includes("/client/v4/accounts/account-123/d1/database")) {
      throw new Error(`Unexpected D1 provisioning during shared-static success: ${request.method} ${request.url}`);
    }

    if (request.method === "DELETE" && scriptMatch) {
      const scriptName = scriptMatch[1]!;
      deletedScripts.push(scriptName);
      return new Response("", { status: scriptName === "shared-static-site" ? 404 : 200 });
    }

    throw new Error(`Unexpected fetch during test: ${request.method} ${request.url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const metadata = {
    projectName: "shared-static-site",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/shared-static-site",
    runtimeEvidence: sharedStaticRuntimeEvidence(),
    workerUpload: {
      main_module: "index.js",
      compatibility_date: "2026-04-01",
      bindings: []
    },
    staticAssets: {
      config: {
        html_handling: "auto-trailing-slash",
        not_found_handling: "404-page"
      },
      files: [
        {
          path: "/index.html",
          partName: "asset-0",
          contentType: "text/html; charset=utf-8"
        }
      ]
    }
  };
  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));
  form.append("index.js", new File(["export default { fetch() { return new Response('ok'); } };"], "index.js", {
    type: "application/javascript"
  }));
  form.append("asset-0", new File(["<h1>Shared Static</h1>"], "index.html", {
    type: "text/html; charset=utf-8"
  }));

  const response = await fetchRaw(new Request("https://deploy.example/api/deployments", {
    method: "POST",
    headers: {
      authorization: "Bearer deploy-token"
    },
    body: form
  }), {
    ...env,
    DEPLOY_API_TOKEN: "deploy-token"
  });

  assert.equal(response.status, 200);
  const body = await response.json() as {
    deploymentId: string;
    project: {
      runtimeLane: string;
      recommendedRuntimeLane: string;
      databaseId?: string;
      filesBucketName?: string;
      cacheNamespaceId?: string;
    };
  };
  assert.equal(body.project.runtimeLane, "shared_static");
  assert.equal(body.project.recommendedRuntimeLane, "shared_static");
  assert.equal(body.project.databaseId, undefined);
  assert.equal(body.project.filesBucketName, undefined);
  assert.equal(body.project.cacheNamespaceId, undefined);
  assert.equal(uploadedScripts.length, 1);
  assert.equal(uploadedScripts[0], "shared-static-site");
  assert.deepEqual(deletedScripts, ["shared-static-site"]);
  assert.ok(validationRequestPaths.includes("/"));
  assert.ok(validationRequestPaths.includes("/__kale_missing_page__"));

  const storedProject = db.selectProject("shared-static-site") as {
    runtime_lane: string;
    database_id: string | null;
    files_bucket_name: string | null;
    cache_namespace_id: string | null;
  } | null;
  assert.equal(storedProject?.runtime_lane, "shared_static");
  assert.equal(storedProject?.database_id, null);
  assert.equal(storedProject?.files_bucket_name, null);
  assert.equal(storedProject?.cache_namespace_id, null);

  const artifactPrefix = buildRepositoryArtifactPrefix("szweibel/shared-static-site", body.deploymentId);
  const manifest = archive.readText(`${artifactPrefix}/manifest.json`);
  assert.ok(manifest);
  assert.match(manifest ?? "", /index\.html/);
  assert.equal(
    archive.readText(`${artifactPrefix}/assets/index.html`),
    "<h1>Shared Static</h1>"
  );

  const statusResponse = await fetchApp("GET", "/api/projects/shared-static-site/status", env);
  assert.equal(statusResponse.status, 200);
  const statusBody = await statusResponse.json() as {
    runtime_evidence_framework?: string;
    runtime_evidence_classification?: string;
    runtime_evidence_confidence?: string;
    runtime_evidence_basis?: string[];
    runtime_evidence_summary?: string;
  };
  assert.equal(statusBody.runtime_evidence_framework, "next");
  assert.equal(statusBody.runtime_evidence_classification, "shared_static_eligible");
  assert.equal(statusBody.runtime_evidence_confidence, "high");
  assert.deepEqual(statusBody.runtime_evidence_basis, ["next_output_export"]);
  assert.match(statusBody.runtime_evidence_summary ?? "", /static export/i);
});

test("static asset deploys without runner evidence stay fully dedicated", async (t: TestContext) => {
  const { env, db } = createTestContext();
  db.putProject({
    projectName: "shared-static-no-evidence",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/shared-static-no-evidence",
    deploymentUrl: "https://shared-static-no-evidence.cuny.qzz.io",
    databaseId: "db-existing",
    hasAssets: false,
    latestDeploymentId: "dep-old",
    createdAt: "2026-03-28T10:00:00.000Z",
    updatedAt: "2026-03-28T10:05:00.000Z"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);

    if (
      request.method === "POST"
      && url.pathname === "/client/v4/accounts/account-123/workers/dispatch/namespaces/cail-production/scripts/shared-static-no-evidence/assets-upload-session"
    ) {
      return new Response(JSON.stringify({
        success: true,
        errors: [],
        result: {
          jwt: "assets-upload-jwt",
          buckets: []
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    if (
      request.method === "PUT"
      && url.pathname === "/client/v4/accounts/account-123/workers/dispatch/namespaces/cail-production/scripts/shared-static-no-evidence"
    ) {
      const form = await request.formData();
      const metadataEntry = form.get("metadata");
      assert.ok(metadataEntry instanceof File);
      const workerUpload = JSON.parse(await metadataEntry.text()) as {
        bindings?: Array<Record<string, string>>;
      };
      assert.notEqual(workerUpload.bindings?.find((binding) => binding.name === "DB"), undefined);
      return new Response("", { status: 200 });
    }

    throw new Error(`Unexpected fetch during test: ${request.method} ${request.url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const metadata = {
    projectName: "shared-static-no-evidence",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/shared-static-no-evidence",
    workerUpload: {
      main_module: "index.js",
      compatibility_date: "2026-04-01",
      bindings: []
    },
    staticAssets: {
      files: [
        {
          path: "/index.html",
          partName: "asset-0",
          contentType: "text/html; charset=utf-8"
        }
      ]
    }
  };
  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));
  form.append("index.js", new File(["export default { fetch() { return new Response('ok'); } };"], "index.js", {
    type: "application/javascript"
  }));
  form.append("asset-0", new File(["<h1>No Evidence</h1>"], "index.html", {
    type: "text/html; charset=utf-8"
  }));

  const response = await fetchRaw(new Request("https://deploy.example/api/deployments", {
    method: "POST",
    headers: {
      authorization: "Bearer deploy-token"
    },
    body: form
  }), {
    ...env,
    DEPLOY_API_TOKEN: "deploy-token"
  });

  assert.equal(response.status, 200);
  const body = await response.json() as {
    project: {
      runtimeLane: string;
      recommendedRuntimeLane: string;
      databaseId?: string;
    };
  };
  assert.equal(body.project.runtimeLane, "dedicated_worker");
  assert.equal(body.project.recommendedRuntimeLane, "dedicated_worker");
  assert.equal(body.project.databaseId, "db-existing");
});

test("shared static candidates stay on dedicated workers when the archive cannot be written", async (t: TestContext) => {
  const { env, db } = createTestContext();
  const uploadedScripts: string[] = [];
  env.DEPLOYMENT_ARCHIVE = {
    async put() {
      throw new Error("archive unavailable");
    },
    async list() {
      return {
        objects: [],
        truncated: false,
        cursor: undefined
      };
    },
    async delete() {}
  } as unknown as R2Bucket;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const uploadSessionMatch = url.pathname.match(/\/workers\/dispatch\/namespaces\/cail-production\/scripts\/([^/]+)\/assets-upload-session$/);
    const scriptMatch = url.pathname.match(/\/workers\/dispatch\/namespaces\/cail-production\/scripts\/([^/]+)$/);

    if (request.method === "GET" && url.pathname === "/client/v4/accounts/account-123/d1/database") {
      return new Response(JSON.stringify({
        success: true,
        errors: [],
        result: []
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    if (request.method === "POST" && url.pathname === "/client/v4/accounts/account-123/d1/database") {
      return new Response(JSON.stringify({
        success: true,
        errors: [],
        result: {
          uuid: "db-shared-static-failure",
          name: "cail-shared-static-failure"
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    if (request.method === "POST" && uploadSessionMatch) {
      return new Response(JSON.stringify({
        success: true,
        errors: [],
        result: {
          jwt: "assets-upload-jwt",
          buckets: []
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    if (request.method === "PUT" && scriptMatch) {
      const scriptName = scriptMatch[1]!;
      uploadedScripts.push(scriptName);
      const form = await request.formData();
      const metadataEntry = form.get("metadata");
      assert.ok(metadataEntry instanceof File);
      const workerUpload = JSON.parse(await metadataEntry.text()) as {
        bindings?: Array<Record<string, string>>;
      };
      const hasDbBinding = workerUpload.bindings?.some((binding) => binding.name === "DB") ?? false;
      assert.equal(scriptName, "shared-static-failure");
      assert.equal(hasDbBinding, false);
      return new Response("", { status: 200 });
    }

    throw new Error(`Unexpected fetch during test: ${request.method} ${request.url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const metadata = {
    projectName: "shared-static-failure",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/shared-static-failure",
    runtimeEvidence: sharedStaticRuntimeEvidence(),
    workerUpload: {
      main_module: "index.js",
      compatibility_date: "2026-04-01",
      bindings: []
    },
    staticAssets: {
      files: [
        {
          path: "/index.html",
          partName: "asset-0",
          contentType: "text/html; charset=utf-8"
        }
      ]
    }
  };
  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));
  form.append("index.js", new File(["export default { fetch() { return new Response('ok'); } };"], "index.js", {
    type: "application/javascript"
  }));
  form.append("asset-0", new File(["<h1>Broken Archive</h1>"], "index.html", {
    type: "text/html; charset=utf-8"
  }));

  const response = await fetchRaw(new Request("https://deploy.example/api/deployments", {
    method: "POST",
    headers: {
      authorization: "Bearer deploy-token"
    },
    body: form
  }), {
    ...env,
    DEPLOY_API_TOKEN: "deploy-token"
  });

  assert.equal(response.status, 200);
  const body = await response.json() as {
    project: {
      runtimeLane: string;
      recommendedRuntimeLane: string;
    };
  };
  assert.equal(body.project.runtimeLane, "dedicated_worker");
  assert.equal(body.project.recommendedRuntimeLane, "shared_static");
  assert.deepEqual(uploadedScripts, ["shared-static-failure"]);

  const storedProject = db.selectProject("shared-static-failure") as {
    latest_deployment_id: string | null;
    runtime_lane: string;
  } | null;
  assert.notEqual(storedProject?.latest_deployment_id, null);
  assert.equal(storedProject?.runtime_lane, "dedicated_worker");
});

test("shared static candidates stay on dedicated workers when validation detects different responses", async (t: TestContext) => {
  const { env, db } = createTestContext();
  const uploadedScripts: string[] = [];
  const validationRequestPaths: string[] = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const uploadSessionMatch = url.pathname.match(/\/workers\/dispatch\/namespaces\/cail-production\/scripts\/([^/]+)\/assets-upload-session$/);
    const scriptMatch = url.pathname.match(/\/workers\/dispatch\/namespaces\/cail-production\/scripts\/([^/]+)$/);

    if (request.method === "GET" && url.pathname === "/client/v4/accounts/account-123/d1/database") {
      return new Response(JSON.stringify({
        success: true,
        errors: [],
        result: []
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    if (request.method === "POST" && url.pathname === "/client/v4/accounts/account-123/d1/database") {
      return new Response(JSON.stringify({
        success: true,
        errors: [],
        result: {
          uuid: "db-shared-static-mismatch",
          name: "cail-shared-static-mismatch"
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    if (request.method === "POST" && uploadSessionMatch) {
      return new Response(JSON.stringify({
        success: true,
        errors: [],
        result: {
          jwt: "assets-upload-jwt",
          buckets: []
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    if (request.method === "PUT" && scriptMatch) {
      const scriptName = scriptMatch[1]!;
      uploadedScripts.push(scriptName);
      const form = await request.formData();
      const metadataEntry = form.get("metadata");
      assert.ok(metadataEntry instanceof File);
      const workerUpload = JSON.parse(await metadataEntry.text()) as {
        bindings?: Array<Record<string, string>>;
      };
      const hasDbBinding = workerUpload.bindings?.some((binding) => binding.name === "DB") ?? false;
      assert.equal(scriptName, "shared-static-mismatch");
      assert.equal(hasDbBinding, false);
      return new Response("", { status: 200 });
    }

    if (request.method === "GET" && url.origin === "https://shared-static-mismatch.cuny.qzz.io") {
      validationRequestPaths.push(url.pathname);
      assert.ok(url.searchParams.get("__kale_validate"));

      if (url.pathname === "/") {
        return new Response("<h1>Dynamic Preview</h1>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }

      if (isSharedStaticRuntimeProbePath(url.pathname)) {
        return sharedStaticNotFoundResponse();
      }

      if (url.pathname.endsWith("/__kale_missing_page__")) {
        return sharedStaticNotFoundResponse();
      }
    }

    throw new Error(`Unexpected fetch during test: ${request.method} ${request.url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const metadata = {
    projectName: "shared-static-mismatch",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/shared-static-mismatch",
    runtimeEvidence: sharedStaticRuntimeEvidence(),
    workerUpload: {
      main_module: "index.js",
      compatibility_date: "2026-04-01",
      bindings: []
    },
    staticAssets: {
      files: [
        {
          path: "/index.html",
          partName: "asset-0",
          contentType: "text/html; charset=utf-8"
        }
      ]
    }
  };
  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));
  form.append("index.js", new File(["export default { fetch() { return new Response('ok'); } };"], "index.js", {
    type: "application/javascript"
  }));
  form.append("asset-0", new File(["<h1>Static Body</h1>"], "index.html", {
    type: "text/html; charset=utf-8"
  }));

  const response = await fetchRaw(new Request("https://deploy.example/api/deployments", {
    method: "POST",
    headers: {
      authorization: "Bearer deploy-token"
    },
    body: form
  }), {
    ...env,
    DEPLOY_API_TOKEN: "deploy-token"
  });

  assert.equal(response.status, 200);
  const body = await response.json() as {
    project: {
      runtimeLane: string;
      recommendedRuntimeLane: string;
    };
  };
  assert.equal(body.project.runtimeLane, "dedicated_worker");
  assert.equal(body.project.recommendedRuntimeLane, "shared_static");
  assert.deepEqual(uploadedScripts, ["shared-static-mismatch"]);
  assert.ok(validationRequestPaths.includes("/"));

  const storedProject = db.selectProject("shared-static-mismatch") as {
    runtime_lane: string;
  } | null;
  assert.equal(storedProject?.runtime_lane, "dedicated_worker");
});

test("shared static validation caps public fetches even when retries are configured too high", async (t: TestContext) => {
  const { env, db } = createTestContext({
    SHARED_STATIC_VALIDATION_ATTEMPTS: "120",
    SHARED_STATIC_VALIDATION_RETRY_MS: "0"
  });
  db.putProject({
    projectName: "shared-static-budget",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/shared-static-budget",
    deploymentUrl: "https://shared-static-budget.cuny.qzz.io",
    databaseId: "db-existing",
    runtimeLane: "dedicated_worker",
    recommendedRuntimeLane: "dedicated_worker",
    hasAssets: false,
    latestDeploymentId: "dep-old",
    createdAt: "2026-03-28T10:00:00.000Z",
    updatedAt: "2026-03-28T10:05:00.000Z"
  });
  const uploadedScripts: string[] = [];
  const validationRequestPaths: string[] = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const uploadSessionMatch = url.pathname.match(/\/workers\/dispatch\/namespaces\/cail-production\/scripts\/([^/]+)\/assets-upload-session$/);
    const scriptMatch = url.pathname.match(/\/workers\/dispatch\/namespaces\/cail-production\/scripts\/([^/]+)$/);

    if (request.method === "POST" && uploadSessionMatch) {
      return new Response(JSON.stringify({
        success: true,
        errors: [],
        result: {
          jwt: "assets-upload-jwt",
          buckets: []
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    if (request.method === "PUT" && scriptMatch) {
      uploadedScripts.push(scriptMatch[1]!);
      return new Response("", { status: 200 });
    }

    if (request.method === "GET" && url.origin === "https://shared-static-budget.cuny.qzz.io") {
      validationRequestPaths.push(url.pathname);
      return new Response("<h1>Still serving the previous candidate</h1>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }

    if (url.pathname.includes("/client/v4/accounts/account-123/d1/database")) {
      throw new Error(`Unexpected D1 provisioning during validation budget test: ${request.method} ${request.url}`);
    }

    throw new Error(`Unexpected fetch during test: ${request.method} ${request.url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const metadata = {
    projectName: "shared-static-budget",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/shared-static-budget",
    runtimeEvidence: sharedStaticRuntimeEvidence(),
    workerUpload: {
      main_module: "index.js",
      compatibility_date: "2026-04-01",
      bindings: []
    },
    staticAssets: {
      files: [
        {
          path: "/index.html",
          partName: "asset-0",
          contentType: "text/html; charset=utf-8"
        }
      ]
    }
  };

  const response = await fetchRaw(new Request("https://deploy.example/api/deployments", {
    method: "POST",
    headers: {
      authorization: "Bearer deploy-token"
    },
    body: buildDeploymentForm(metadata, [
      {
        name: "index.js",
        fileName: "index.js",
        content: "export default { fetch() { return new Response('ok'); } };",
        type: "application/javascript"
      },
      {
        name: "asset-0",
        fileName: "index.html",
        content: "<h1>Static Body</h1>",
        type: "text/html; charset=utf-8"
      }
    ])
  }), {
    ...env,
    DEPLOY_API_TOKEN: "deploy-token"
  });

  assert.equal(response.status, 200);
  const body = await response.json() as {
    project: {
      runtimeLane: string;
      recommendedRuntimeLane: string;
    };
  };
  assert.equal(body.project.runtimeLane, "dedicated_worker");
  assert.equal(body.project.recommendedRuntimeLane, "shared_static");
  assert.deepEqual(uploadedScripts, ["shared-static-budget"]);
  assert.ok(validationRequestPaths.length < 120);
  assert.ok(validationRequestPaths.length <= 30);
  assert.ok(validationRequestPaths.every((pathname) => pathname === "/"));
});

test("shared static candidates stay on dedicated workers when the live candidate exposes request-time API routes", async (t: TestContext) => {
  const { env, db } = createTestContext();
  const uploadedScripts: string[] = [];
  const validationRequestPaths: string[] = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const uploadSessionMatch = url.pathname.match(/\/workers\/dispatch\/namespaces\/cail-production\/scripts\/([^/]+)\/assets-upload-session$/);
    const scriptMatch = url.pathname.match(/\/workers\/dispatch\/namespaces\/cail-production\/scripts\/([^/]+)$/);

    if (request.method === "GET" && url.pathname === "/client/v4/accounts/account-123/d1/database") {
      return new Response(JSON.stringify({
        success: true,
        errors: [],
        result: []
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    if (request.method === "POST" && url.pathname === "/client/v4/accounts/account-123/d1/database") {
      return new Response(JSON.stringify({
        success: true,
        errors: [],
        result: {
          uuid: "db-shared-static-api-route",
          name: "cail-shared-static-api-route"
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    if (request.method === "POST" && uploadSessionMatch) {
      return new Response(JSON.stringify({
        success: true,
        errors: [],
        result: {
          jwt: "assets-upload-jwt",
          buckets: []
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    if (request.method === "PUT" && scriptMatch) {
      const scriptName = scriptMatch[1]!;
      uploadedScripts.push(scriptName);
      const form = await request.formData();
      const metadataEntry = form.get("metadata");
      assert.ok(metadataEntry instanceof File);
      const workerUpload = JSON.parse(await metadataEntry.text()) as {
        bindings?: Array<Record<string, string>>;
      };
      const hasDbBinding = workerUpload.bindings?.some((binding) => binding.name === "DB") ?? false;
      assert.equal(scriptName, "shared-static-api-route");
      assert.equal(hasDbBinding, false);
      return new Response("", { status: 200 });
    }

    if (request.method === "GET" && url.origin === "https://shared-static-api-route.cuny.qzz.io") {
      validationRequestPaths.push(url.pathname);
      assert.ok(url.searchParams.get("__kale_validate"));

      if (url.pathname === "/") {
        return new Response("<h1>Static Body</h1>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }

      if (url.pathname.endsWith("/api/health")) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      if (isSharedStaticRuntimeProbePath(url.pathname)) {
        return sharedStaticNotFoundResponse();
      }

      if (url.pathname.endsWith("/__kale_missing_page__")) {
        return sharedStaticNotFoundResponse();
      }
    }

    throw new Error(`Unexpected fetch during test: ${request.method} ${request.url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const metadata = {
    projectName: "shared-static-api-route",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/shared-static-api-route",
    runtimeEvidence: sharedStaticRuntimeEvidence(),
    workerUpload: {
      main_module: "index.js",
      compatibility_date: "2026-04-01",
      bindings: []
    },
    staticAssets: {
      files: [
        {
          path: "/index.html",
          partName: "asset-0",
          contentType: "text/html; charset=utf-8"
        }
      ]
    }
  };

  const response = await fetchRaw(new Request("https://deploy.example/api/deployments", {
    method: "POST",
    headers: {
      authorization: "Bearer deploy-token"
    },
    body: buildDeploymentForm(metadata, [
      {
        name: "index.js",
        fileName: "index.js",
        content: "export default { fetch() { return new Response('ok'); } };",
        type: "application/javascript"
      },
      {
        name: "asset-0",
        fileName: "index.html",
        content: "<h1>Static Body</h1>",
        type: "text/html; charset=utf-8"
      }
    ])
  }), {
    ...env,
    DEPLOY_API_TOKEN: "deploy-token"
  });

  assert.equal(response.status, 200);
  const body = await response.json() as {
    project: {
      runtimeLane: string;
      recommendedRuntimeLane: string;
    };
  };
  assert.equal(body.project.runtimeLane, "dedicated_worker");
  assert.equal(body.project.recommendedRuntimeLane, "shared_static");
  assert.deepEqual(uploadedScripts, ["shared-static-api-route"]);
  assert.ok(validationRequestPaths.includes("/api/health"));

  const storedProject = db.selectProject("shared-static-api-route") as {
    runtime_lane: string;
  } | null;
  assert.equal(storedProject?.runtime_lane, "dedicated_worker");
});

test("shared static candidates stay on dedicated workers when the live candidate adds request-time response headers", async (t: TestContext) => {
  const { env, db } = createTestContext();
  const uploadedScripts: string[] = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const uploadSessionMatch = url.pathname.match(/\/workers\/dispatch\/namespaces\/cail-production\/scripts\/([^/]+)\/assets-upload-session$/);
    const scriptMatch = url.pathname.match(/\/workers\/dispatch\/namespaces\/cail-production\/scripts\/([^/]+)$/);

    if (request.method === "GET" && url.pathname === "/client/v4/accounts/account-123/d1/database") {
      return new Response(JSON.stringify({
        success: true,
        errors: [],
        result: []
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    if (request.method === "POST" && url.pathname === "/client/v4/accounts/account-123/d1/database") {
      return new Response(JSON.stringify({
        success: true,
        errors: [],
        result: {
          uuid: "db-shared-static-header-route",
          name: "cail-shared-static-header-route"
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    if (request.method === "POST" && uploadSessionMatch) {
      return new Response(JSON.stringify({
        success: true,
        errors: [],
        result: {
          jwt: "assets-upload-jwt",
          buckets: []
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    if (request.method === "PUT" && scriptMatch) {
      const scriptName = scriptMatch[1]!;
      uploadedScripts.push(scriptName);
      return new Response("", { status: 200 });
    }

    if (request.method === "GET" && url.origin === "https://shared-static-header-route.cuny.qzz.io") {
      assert.ok(url.searchParams.get("__kale_validate"));

      if (url.pathname === "/") {
        return new Response("<h1>Static Body</h1>", {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": "default-src 'self'"
          }
        });
      }

      if (isSharedStaticRuntimeProbePath(url.pathname)) {
        return sharedStaticNotFoundResponse();
      }

      if (url.pathname.endsWith("/__kale_missing_page__")) {
        return sharedStaticNotFoundResponse();
      }
    }

    throw new Error(`Unexpected fetch during test: ${request.method} ${request.url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const metadata = {
    projectName: "shared-static-header-route",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/shared-static-header-route",
    runtimeEvidence: sharedStaticRuntimeEvidence(),
    workerUpload: {
      main_module: "index.js",
      compatibility_date: "2026-04-01",
      bindings: []
    },
    staticAssets: {
      files: [
        {
          path: "/index.html",
          partName: "asset-0",
          contentType: "text/html; charset=utf-8"
        }
      ]
    }
  };

  const response = await fetchRaw(new Request("https://deploy.example/api/deployments", {
    method: "POST",
    headers: {
      authorization: "Bearer deploy-token"
    },
    body: buildDeploymentForm(metadata, [
      {
        name: "index.js",
        fileName: "index.js",
        content: "export default { fetch() { return new Response('ok'); } };",
        type: "application/javascript"
      },
      {
        name: "asset-0",
        fileName: "index.html",
        content: "<h1>Static Body</h1>",
        type: "text/html; charset=utf-8"
      }
    ])
  }), {
    ...env,
    DEPLOY_API_TOKEN: "deploy-token"
  });

  assert.equal(response.status, 200);
  const body = await response.json() as {
    project: {
      runtimeLane: string;
      recommendedRuntimeLane: string;
    };
  };
  assert.equal(body.project.runtimeLane, "dedicated_worker");
  assert.equal(body.project.recommendedRuntimeLane, "shared_static");
  assert.deepEqual(uploadedScripts, ["shared-static-header-route"]);

  const storedProject = db.selectProject("shared-static-header-route") as {
    runtime_lane: string;
  } | null;
  assert.equal(storedProject?.runtime_lane, "dedicated_worker");
});

test("a second deploy can move a live dedicated project onto the shared static lane", async (t: TestContext) => {
  const { env, db, archive } = createTestContext();
  db.putProject({
    projectName: "redeploy-static-upgrade",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/redeploy-static-upgrade",
    deploymentUrl: "https://redeploy-static-upgrade.cuny.qzz.io",
    databaseId: "db-existing",
    runtimeLane: "dedicated_worker",
    recommendedRuntimeLane: "dedicated_worker",
    hasAssets: false,
    latestDeploymentId: "dep-old",
    createdAt: "2026-03-28T10:00:00.000Z",
    updatedAt: "2026-03-28T10:05:00.000Z"
  });

  const uploadedScripts: string[] = [];
  const deletedScripts: string[] = [];
  const validationRequestPaths: string[] = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const uploadSessionMatch = url.pathname.match(/\/workers\/dispatch\/namespaces\/cail-production\/scripts\/([^/]+)\/assets-upload-session$/);
    const scriptMatch = url.pathname.match(/\/workers\/dispatch\/namespaces\/cail-production\/scripts\/([^/]+)$/);

    if (request.method === "POST" && uploadSessionMatch) {
      return new Response(JSON.stringify({
        success: true,
        errors: [],
        result: {
          jwt: "assets-upload-jwt",
          buckets: []
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    if (request.method === "PUT" && scriptMatch) {
      const scriptName = scriptMatch[1]!;
      uploadedScripts.push(scriptName);
      const form = await request.formData();
      const metadataEntry = form.get("metadata");
      assert.ok(metadataEntry instanceof File);
      const workerUpload = JSON.parse(await metadataEntry.text()) as {
        bindings?: Array<Record<string, string>>;
      };
      assert.equal(workerUpload.bindings?.find((binding) => binding.name === "DB"), undefined);
      return new Response("", { status: 200 });
    }

    if (request.method === "GET" && url.origin === "https://redeploy-static-upgrade.cuny.qzz.io") {
      validationRequestPaths.push(url.pathname);
      assert.ok(url.searchParams.get("__kale_validate"));

      if (url.pathname === "/") {
        return new Response("<h1>Redeploy Static</h1>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }

      if (isSharedStaticRuntimeProbePath(url.pathname)) {
        return sharedStaticNotFoundResponse();
      }

      if (url.pathname.endsWith("/__kale_missing_page__")) {
        return sharedStaticNotFoundResponse();
      }
    }

    if (url.pathname.includes("/client/v4/accounts/account-123/d1/database")) {
      throw new Error(`Unexpected D1 provisioning during dedicated -> shared static redeploy: ${request.method} ${request.url}`);
    }

    if (request.method === "DELETE" && scriptMatch) {
      deletedScripts.push(scriptMatch[1]!);
      return new Response("", { status: 200 });
    }

    throw new Error(`Unexpected fetch during test: ${request.method} ${request.url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const metadata = {
    projectName: "redeploy-static-upgrade",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/redeploy-static-upgrade",
    runtimeEvidence: sharedStaticRuntimeEvidence(),
    workerUpload: {
      main_module: "index.js",
      compatibility_date: "2026-04-01",
      bindings: []
    },
    staticAssets: {
      config: {
        html_handling: "auto-trailing-slash",
        not_found_handling: "404-page"
      },
      files: [
        {
          path: "/index.html",
          partName: "asset-0",
          contentType: "text/html; charset=utf-8"
        }
      ]
    }
  };

  const response = await fetchRaw(new Request("https://deploy.example/api/deployments", {
    method: "POST",
    headers: {
      authorization: "Bearer deploy-token"
    },
    body: buildDeploymentForm(metadata, [
      {
        name: "index.js",
        fileName: "index.js",
        content: "export default { fetch() { return new Response('ok'); } };",
        type: "application/javascript"
      },
      {
        name: "asset-0",
        fileName: "index.html",
        content: "<h1>Redeploy Static</h1>",
        type: "text/html; charset=utf-8"
      }
    ])
  }), {
    ...env,
    DEPLOY_API_TOKEN: "deploy-token"
  });

  assert.equal(response.status, 200);
  const body = await response.json() as {
    project: {
      runtimeLane: string;
      recommendedRuntimeLane: string;
      databaseId?: string;
    };
  };
  assert.equal(body.project.runtimeLane, "shared_static");
  assert.equal(body.project.recommendedRuntimeLane, "shared_static");
  assert.equal(body.project.databaseId, "db-existing");
  assert.equal(uploadedScripts.length, 1);
  assert.equal(uploadedScripts[0], "redeploy-static-upgrade");
  assert.deepEqual(deletedScripts, ["redeploy-static-upgrade"]);
  assert.ok(validationRequestPaths.includes("/"));

  const storedProject = db.selectProject("redeploy-static-upgrade") as {
    runtime_lane: string;
    database_id: string | null;
    latest_deployment_id: string | null;
  } | null;
  assert.equal(storedProject?.runtime_lane, "shared_static");
  assert.equal(storedProject?.database_id, "db-existing");
  assert.notEqual(storedProject?.latest_deployment_id, "dep-old");

  const latestDeploymentId = storedProject?.latest_deployment_id;
  assert.ok(latestDeploymentId);
  assert.equal(
    archive.readText(`${buildRepositoryArtifactPrefix("szweibel/redeploy-static-upgrade", latestDeploymentId)}/assets/index.html`),
    "<h1>Redeploy Static</h1>"
  );
});

test("a second deploy can move a live shared static project back to a dedicated worker app", async (t: TestContext) => {
  const { env, db } = createTestContext();
  db.putProject({
    projectName: "redeploy-worker-upgrade",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/redeploy-worker-upgrade",
    deploymentUrl: "https://redeploy-worker-upgrade.cuny.qzz.io",
    runtimeLane: "shared_static",
    recommendedRuntimeLane: "shared_static",
    hasAssets: true,
    latestDeploymentId: "dep-static",
    createdAt: "2026-03-28T10:00:00.000Z",
    updatedAt: "2026-03-28T10:05:00.000Z"
  });

  const uploadedScripts: string[] = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const scriptMatch = url.pathname.match(/\/workers\/dispatch\/namespaces\/cail-production\/scripts\/([^/]+)$/);

    if (request.method === "GET" && url.pathname === "/client/v4/accounts/account-123/d1/database") {
      return new Response(JSON.stringify({
        success: true,
        errors: [],
        result: []
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    if (request.method === "POST" && url.pathname === "/client/v4/accounts/account-123/d1/database") {
      return new Response(JSON.stringify({
        success: true,
        errors: [],
        result: {
          uuid: "db-redeploy-worker-upgrade",
          name: "cail-redeploy-worker-upgrade"
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    if (request.method === "PUT" && scriptMatch) {
      const scriptName = scriptMatch[1]!;
      uploadedScripts.push(scriptName);
      const form = await request.formData();
      const metadataEntry = form.get("metadata");
      assert.ok(metadataEntry instanceof File);
      const workerUpload = JSON.parse(await metadataEntry.text()) as {
        bindings?: Array<Record<string, string>>;
      };
      assert.equal(scriptName, "redeploy-worker-upgrade");
      assert.notEqual(workerUpload.bindings?.find((binding) => binding.name === "DB"), undefined);
      return new Response("", { status: 200 });
    }

    if (url.pathname.includes("/assets-upload-session") || (request.method === "DELETE" && scriptMatch)) {
      throw new Error(`Unexpected static preview call during shared static -> dedicated redeploy: ${request.method} ${request.url}`);
    }

    throw new Error(`Unexpected fetch during test: ${request.method} ${request.url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const metadata = {
    projectName: "redeploy-worker-upgrade",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/redeploy-worker-upgrade",
    workerUpload: {
      main_module: "index.js",
      compatibility_date: "2026-04-01",
      bindings: []
    }
  };

  const response = await fetchRaw(new Request("https://deploy.example/api/deployments", {
    method: "POST",
    headers: {
      authorization: "Bearer deploy-token"
    },
    body: buildDeploymentForm(metadata, [
      {
        name: "index.js",
        fileName: "index.js",
        content: "export default { fetch() { return new Response('live worker'); } };",
        type: "application/javascript"
      }
    ])
  }), {
    ...env,
    DEPLOY_API_TOKEN: "deploy-token"
  });

  assert.equal(response.status, 200);
  const body = await response.json() as {
    project: {
      runtimeLane: string;
      recommendedRuntimeLane: string;
      databaseId?: string;
    };
  };
  assert.equal(body.project.runtimeLane, "dedicated_worker");
  assert.equal(body.project.recommendedRuntimeLane, "dedicated_worker");
  assert.equal(body.project.databaseId, "db-redeploy-worker-upgrade");
  assert.deepEqual(uploadedScripts, ["redeploy-worker-upgrade"]);

  const storedProject = db.selectProject("redeploy-worker-upgrade") as {
    runtime_lane: string;
    database_id: string | null;
    latest_deployment_id: string | null;
  } | null;
  assert.equal(storedProject?.runtime_lane, "dedicated_worker");
  assert.equal(storedProject?.database_id, "db-redeploy-worker-upgrade");
  assert.notEqual(storedProject?.latest_deployment_id, "dep-static");
});

test("deployments keep repo-scoped DB, FILES, and CACHE resources when a repo changes slugs", async (t: TestContext) => {
  const { env, db } = createTestContext();
  db.putProject({
    projectName: "old-slug",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/renameable-project",
    deploymentUrl: "https://old-slug.cuny.qzz.io",
    databaseId: "db-existing",
    filesBucketName: "kale-files-old-slug",
    cacheNamespaceId: "kv-existing",
    hasAssets: false,
    latestDeploymentId: "dep-old",
    createdAt: "2026-03-28T10:00:00.000Z",
    updatedAt: "2026-03-28T10:05:00.000Z"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);

    if (url.pathname === "/client/v4/accounts/account-123/workers/dispatch/namespaces/cail-production/scripts/new-slug") {
      const form = await request.formData();
      const metadataEntry = form.get("metadata");
      assert.ok(metadataEntry instanceof File);
      const workerUpload = JSON.parse(await metadataEntry.text()) as {
        bindings: Array<Record<string, string>>;
      };

      const dbBinding = workerUpload.bindings.find((binding) => binding.name === "DB");
      const cacheBinding = workerUpload.bindings.find((binding) => binding.name === "CACHE");
      const filesBinding = workerUpload.bindings.find((binding) => binding.name === "FILES");
      assert.equal(dbBinding?.id, "db-existing");
      assert.equal(cacheBinding?.namespace_id, "kv-existing");
      assert.equal(filesBinding?.bucket_name, "kale-files-old-slug");
      return new Response("", { status: 200 });
    }

    if (
      url.pathname.includes("/d1/database")
      || url.pathname.includes("/storage/kv/namespaces")
      || url.pathname.includes("/r2/buckets")
    ) {
      throw new Error(`Unexpected resource provisioning lookup during slug rename: ${request.method} ${request.url}`);
    }

    throw new Error(`Unexpected fetch during test: ${request.method} ${request.url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const metadata = {
    projectName: "new-slug",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/renameable-project",
    workerUpload: {
      main_module: "index.js",
      compatibility_date: "2026-03-28",
      bindings: [
        { type: "d1", name: "DB", id: "placeholder-db" },
        { type: "kv_namespace", name: "CACHE", namespace_id: "placeholder-cache" },
        { type: "r2_bucket", name: "FILES", bucket_name: "placeholder-files" }
      ]
    }
  };
  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));
  form.append("index.js", new File(["export default { fetch() { return new Response('ok'); } };"], "index.js", {
    type: "application/javascript"
  }));

  const response = await fetchRaw(new Request("https://deploy.example/api/deployments", {
    method: "POST",
    headers: {
      authorization: "Bearer deploy-token"
    },
    body: form
  }), {
    ...env,
    DEPLOY_API_TOKEN: "deploy-token"
  });

  assert.equal(response.status, 200);
  const body = await response.json() as {
    project: {
      projectName: string;
    };
  };
  assert.equal(body.project.projectName, "new-slug");

  const renamedProject = db.selectProject("new-slug") as {
    database_id: string | null;
    files_bucket_name: string | null;
    cache_namespace_id: string | null;
  } | null;
  assert.equal(renamedProject?.database_id, "db-existing");
  assert.equal(renamedProject?.files_bucket_name, "kale-files-old-slug");
  assert.equal(renamedProject?.cache_namespace_id, "kv-existing");
});

test("new project resources are named from the repository instead of the current slug", async (t: TestContext) => {
  const { env } = createTestContext();
  const createdResourceNames: string[] = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/client/v4/accounts/account-123/d1/database") {
      return jsonResponse({ success: true, errors: [], result: [] });
    }

    if (request.method === "POST" && url.pathname === "/client/v4/accounts/account-123/d1/database") {
      const body = await request.json() as { name: string };
      createdResourceNames.push(`d1:${body.name}`);
      return jsonResponse({
        success: true,
        errors: [],
        result: {
          uuid: "db-new",
          name: body.name
        }
      });
    }

    if (request.method === "GET" && url.pathname === "/client/v4/accounts/account-123/storage/kv/namespaces") {
      return jsonResponse({ success: true, errors: [], result: [] });
    }

    if (request.method === "POST" && url.pathname === "/client/v4/accounts/account-123/storage/kv/namespaces") {
      const body = await request.json() as { title: string };
      createdResourceNames.push(`kv:${body.title}`);
      return jsonResponse({
        success: true,
        errors: [],
        result: {
          id: "kv-new",
          title: body.title
        }
      });
    }

    if (request.method === "GET" && url.pathname === "/client/v4/accounts/account-123/r2/buckets") {
      return jsonResponse({
        success: true,
        errors: [],
        result: { buckets: [] },
        result_info: {}
      });
    }

    if (request.method === "POST" && url.pathname === "/client/v4/accounts/account-123/r2/buckets") {
      const body = await request.json() as { name: string };
      createdResourceNames.push(`r2:${body.name}`);
      return jsonResponse({
        success: true,
        errors: [],
        result: { name: body.name }
      });
    }

    if (url.pathname === "/client/v4/accounts/account-123/workers/dispatch/namespaces/cail-production/scripts/course-site") {
      return new Response("", { status: 200 });
    }

    throw new Error(`Unexpected fetch during test: ${request.method} ${request.url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const form = buildDeploymentForm({
    projectName: "course-site",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/repo-scoped-app",
    workerUpload: {
      main_module: "index.js",
      compatibility_date: "2026-03-28",
      bindings: [
        { type: "d1", name: "DB", id: "placeholder-db" },
        { type: "kv_namespace", name: "CACHE", namespace_id: "placeholder-cache" },
        { type: "r2_bucket", name: "FILES", bucket_name: "placeholder-files" }
      ]
    }
  }, [
    {
      name: "index.js",
      fileName: "index.js",
      content: "export default { fetch() { return new Response('ok'); } };",
      type: "application/javascript"
    }
  ]);

  const response = await fetchRaw(new Request("https://deploy.example/api/deployments", {
    method: "POST",
    headers: {
      authorization: "Bearer deploy-token"
    },
    body: form
  }), {
    ...env,
    DEPLOY_API_TOKEN: "deploy-token"
  });

  assert.equal(response.status, 200);
  assert.deepEqual(createdResourceNames.sort(), [
    "d1:cail-szweibel-repo-scoped-app",
    "kv:kale-cache-szweibel-repo-scoped-app",
    "r2:kale-files-szweibel-repo-scoped-app"
  ].sort());
});

test("deployments keep repo-scoped project secrets when a repo changes slugs", async (t: TestContext) => {
  const { env, db } = createTestContext();
  db.putProject({
    projectName: "old-slug",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/renameable-project",
    deploymentUrl: "https://old-slug.cuny.qzz.io",
    databaseId: "db-existing",
    hasAssets: false,
    latestDeploymentId: "dep-old",
    createdAt: "2026-03-28T10:00:00.000Z",
    updatedAt: "2026-03-28T10:05:00.000Z"
  });
  const sealed = JSON.parse(await sealStoredValueForTest(env, "sk-rename-secret")) as { ciphertext: string; iv: string };
  db.putProjectSecret({
    github_repo: "szweibel/renameable-project",
    project_name: "old-slug",
    secret_name: "OPENAI_API_KEY",
    ciphertext: sealed.ciphertext,
    iv: sealed.iv,
    github_user_id: 9001,
    github_login: "szweibel",
    created_at: "2026-03-28T10:00:00.000Z",
    updated_at: "2026-03-28T10:00:00.000Z"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);

    if (url.pathname === "/client/v4/accounts/account-123/workers/dispatch/namespaces/cail-production/scripts/new-slug") {
      const form = await request.formData();
      const metadataEntry = form.get("metadata");
      assert.ok(metadataEntry instanceof File);
      const workerUpload = JSON.parse(await metadataEntry.text()) as {
        bindings: Array<Record<string, string>>;
      };

      const secretBinding = workerUpload.bindings.find((binding) => binding.name === "OPENAI_API_KEY");
      assert.deepEqual(secretBinding, {
        type: "secret_text",
        name: "OPENAI_API_KEY",
        text: "sk-rename-secret"
      });
      return new Response("", { status: 200 });
    }

    if (
      url.pathname.includes("/d1/database")
      || url.pathname.includes("/storage/kv/namespaces")
      || url.pathname.includes("/r2/buckets")
    ) {
      throw new Error(`Unexpected resource provisioning lookup during slug rename: ${request.method} ${request.url}`);
    }

    throw new Error(`Unexpected fetch during test: ${request.method} ${request.url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const metadata = {
    projectName: "new-slug",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/renameable-project",
    workerUpload: {
      main_module: "index.js",
      compatibility_date: "2026-03-28",
      bindings: [
        { type: "d1", name: "DB", id: "placeholder-db" }
      ]
    }
  };
  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));
  form.append("index.js", new File(["export default { fetch() { return new Response('ok'); } };"], "index.js", {
    type: "application/javascript"
  }));

  const response = await fetchRaw(new Request("https://deploy.example/api/deployments", {
    method: "POST",
    headers: {
      authorization: "Bearer deploy-token"
    },
    body: form
  }), {
    ...env,
    DEPLOY_API_TOKEN: "deploy-token"
  });

  assert.equal(response.status, 200);
});

test("deployments inject stored project secrets as secret_text bindings", async (t: TestContext) => {
  const { env, db } = createTestContext();
  db.putProject({
    projectName: "secret-app",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/secret-app",
    deploymentUrl: "https://secret-app.cuny.qzz.io",
    databaseId: "db-existing",
    hasAssets: false,
    latestDeploymentId: "dep-1",
    createdAt: "2026-03-29T12:00:00.000Z",
    updatedAt: "2026-03-29T12:05:00.000Z"
  });
  const sealed = JSON.parse(await sealStoredValueForTest(env, "sk-live-secret")) as { ciphertext: string; iv: string };
  db.putProjectSecret({
    github_repo: "szweibel/secret-app",
    project_name: "secret-app",
    secret_name: "OPENAI_API_KEY",
    ciphertext: sealed.ciphertext,
    iv: sealed.iv,
    github_user_id: 9001,
    github_login: "szweibel",
    created_at: "2026-03-29T12:00:00.000Z",
    updated_at: "2026-03-29T12:00:00.000Z"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);

    if (url.pathname === "/client/v4/accounts/account-123/workers/dispatch/namespaces/cail-production/scripts/secret-app") {
      const form = await request.formData();
      const metadataEntry = form.get("metadata");
      assert.ok(metadataEntry instanceof File);
      const workerUpload = JSON.parse(await metadataEntry.text()) as {
        bindings: Array<Record<string, string>>;
      };

      const secretBinding = workerUpload.bindings.find((binding) => binding.name === "OPENAI_API_KEY");
      assert.deepEqual(secretBinding, {
        type: "secret_text",
        name: "OPENAI_API_KEY",
        text: "sk-live-secret"
      });
      return new Response("", { status: 200 });
    }

    throw new Error(`Unexpected fetch during test: ${request.method} ${request.url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const metadata = {
    projectName: "secret-app",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/secret-app",
    workerUpload: {
      main_module: "index.js",
      compatibility_date: "2026-03-29",
      bindings: [
        { type: "d1", name: "DB", id: "placeholder-db" }
      ]
    }
  };
  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));
  form.append("index.js", new File(["export default { fetch() { return new Response('ok'); } };"], "index.js", {
    type: "application/javascript"
  }));

  const response = await fetchRaw(new Request("https://deploy.example/api/deployments", {
    method: "POST",
    headers: {
      authorization: "Bearer deploy-token"
    },
    body: form
  }), {
    ...env,
    DEPLOY_API_TOKEN: "deploy-token"
  });

  assert.equal(response.status, 200);
});

test("validate requires auth when Cloudflare Access is configured", async () => {
  const { env } = createTestContext({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud"
  });

  const response = await fetchApp("POST", "/api/validate", env, {
    repositoryFullName: "szweibel/cail-assets-build-test",
    ref: "main"
  });

  assert.equal(response.status, 401);
  const body = await response.json() as {
    nextAction: string;
    connectionHealthUrl: string;
    oauthProtectedResourceMetadata: string;
  };
  assert.equal(body.nextAction, "complete_browser_login");
  assert.equal(body.connectionHealthUrl, "https://deploy.example/.well-known/kale-connection.json");
  assert.equal(body.oauthProtectedResourceMetadata, "https://deploy.example/.well-known/oauth-protected-resource/mcp");
});

test("project registration requires auth when Cloudflare Access is configured", async () => {
  const { env } = createTestContext({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud"
  });

  const response = await fetchApp("POST", "/api/projects/register", env, {
    repositoryFullName: "szweibel/cail-assets-build-test"
  });

  assert.equal(response.status, 401);
});

test("project status requires auth when Cloudflare Access is configured", async () => {
  const { env, db } = createTestContext({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud"
  });
  db.putProject({
    projectName: "cail-assets-build-test",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/cail-assets-build-test",
    deploymentUrl: "https://cail-assets-build-test.cuny.qzz.io",
    hasAssets: true,
    latestDeploymentId: "dep-live",
    createdAt: "2026-03-26T20:00:00.000Z",
    updatedAt: "2026-03-26T20:10:00.000Z"
  });

  const response = await fetchApp("GET", "/api/projects/cail-assets-build-test/status", env);
  assert.equal(response.status, 401);
});

test("api auth session is permanently disabled in favor of MCP OAuth", async () => {
  const { env } = createTestContext();

  const response = await fetchApp("GET", "/api/auth/session", env);
  assert.equal(response.status, 410);
  const body = await response.json() as { error: string };
  assert.match(body.error, /standard MCP OAuth discovery/i);
});

test("Cloudflare Access allows an allowed email to call project registration directly", async (t: TestContext) => {
  const { env } = createTestContext({
    GITHUB_APP_ID: undefined,
    GITHUB_APP_PRIVATE_KEY: undefined,
    GITHUB_APP_SLUG: undefined,
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud",
    CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS: "cuny.edu"
  });
  installAccessFetchMock(t);
  const accessJwt = await createAccessJwt("person@cuny.edu");

  const registerResponse = await fetchApp(
    "POST",
    "/api/projects/register",
    env,
    {
      repositoryFullName: "szweibel/cail-assets-build-test"
    },
    {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": "person@cuny.edu"
    }
  );
  assert.equal(registerResponse.status, 200);

  const registerBody = await registerResponse.json() as {
    ok: boolean;
    projectName: string;
    installStatus: string;
  };
  assert.equal(registerBody.ok, true);
  assert.equal(registerBody.projectName, "cail-assets-build-test");
  assert.equal(registerBody.installStatus, "app_unconfigured");
});

test("Cloudflare Access allows subdomains of configured email domains", async (t: TestContext) => {
  const { env } = createTestContext({
    GITHUB_APP_ID: undefined,
    GITHUB_APP_PRIVATE_KEY: undefined,
    GITHUB_APP_SLUG: undefined,
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud",
    CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS: "cuny.edu"
  });
  installAccessFetchMock(t);
  const accessJwt = await createAccessJwt("person@gc.cuny.edu");

  const response = await fetchApp(
    "POST",
    "/api/projects/register",
    env,
    {
      repositoryFullName: "szweibel/cail-assets-build-test"
    },
    {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": "person@gc.cuny.edu"
    }
  );

  assert.equal(response.status, 200);
  const body = await response.json() as {
    ok: boolean;
  };
  assert.equal(body.ok, true);
});

test("Cloudflare Access rejects disallowed email domains", async (t: TestContext) => {
  const { env } = createTestContext({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud",
    CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS: "cuny.edu"
  });
  installAccessFetchMock(t);
  const accessJwt = await createAccessJwt("person@example.com");

  const response = await fetchApp(
    "POST",
    "/api/projects/register",
    env,
    {
      repositoryFullName: "szweibel/cail-assets-build-test"
    },
    {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": "person@example.com"
    }
  );

  assert.equal(response.status, 403);
});

test("build-job status requires auth when Cloudflare Access is configured", async () => {
  const { env, db } = createTestContext({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud"
  });
  db.putBuildJob({
    jobId: "job-protected-1",
    eventName: "validate",
    installationId: 1,
    repository: repositoryRecord("cail-assets-build-test"),
    ref: "main",
    headSha: "validate-sha",
    checkRunId: 99,
    status: "success",
    createdAt: "2026-03-26T21:00:00.000Z",
    updatedAt: "2026-03-26T21:05:00.000Z"
  });

  const response = await fetchApp("GET", "/api/build-jobs/job-protected-1/status", env);
  assert.equal(response.status, 401);
});

test("broad status APIs redact detailed build logs", async () => {
  const { env, db } = createTestContext({
    GITHUB_APP_ID: undefined,
    GITHUB_APP_PRIVATE_KEY: undefined,
    GITHUB_APP_SLUG: undefined
  });
  db.putProject({
    projectName: "cail-assets-build-test",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/cail-assets-build-test",
    deploymentUrl: "https://cail-assets-build-test.cuny.qzz.io",
    hasAssets: true,
    latestDeploymentId: "dep-live",
    createdAt: "2026-03-26T20:00:00.000Z",
    updatedAt: "2026-03-26T20:10:00.000Z"
  });
  db.putBuildJob({
    jobId: "job-failed-1",
    eventName: "push",
    installationId: 1,
    repository: repositoryRecord("cail-assets-build-test"),
    ref: "main",
    headSha: "failed-sha",
    checkRunId: 101,
    status: "failure",
    createdAt: "2026-03-26T21:00:00.000Z",
    updatedAt: "2026-03-26T21:05:00.000Z",
    completedAt: "2026-03-26T21:05:00.000Z",
    projectName: "cail-assets-build-test",
    errorKind: "build_failure",
    errorMessage: "Build failed.",
    errorDetail: "Sensitive build log line",
    buildLogUrl: "https://logs.example/job-failed-1"
  });

  const repositoryStatusResponse = await fetchApp("GET", "/api/repositories/szweibel/cail-assets-build-test/status", env);
  assert.equal(repositoryStatusResponse.status, 200);
  const repositoryStatus = await repositoryStatusResponse.json() as Record<string, unknown>;
  assert.equal(repositoryStatus.latestStatus, "live");
  assert.equal(repositoryStatus.servingStatus, "live");
  assert.equal(repositoryStatus.buildStatus, "failure");
  assert.equal(repositoryStatus.workflowStage, "live");
  assert.equal(repositoryStatus.nextAction, "inspect_failure");
  assert.match(String(repositoryStatus.summary), /latest build failed/i);
  assert.match(String(repositoryStatus.errorHint), /build output/i);
  assert.equal("errorDetail" in repositoryStatus, false);
  assert.equal("buildLogUrl" in repositoryStatus, false);

  const projectStatusResponse = await fetchApp("GET", "/api/projects/cail-assets-build-test/status", env);
  assert.equal(projectStatusResponse.status, 200);
  const projectStatus = await projectStatusResponse.json() as Record<string, unknown>;
  assert.equal(projectStatus.status, "live");
  assert.equal(projectStatus.serving_status, "live");
  assert.equal(projectStatus.latest_build_status, "failure");
  assert.match(String(projectStatus.error_hint), /build output/i);
  assert.equal("error_detail" in projectStatus, false);
  assert.equal("build_log_url" in projectStatus, false);

  const buildJobStatusResponse = await fetchApp("GET", "/api/build-jobs/job-failed-1/status", env);
  assert.equal(buildJobStatusResponse.status, 200);
  const buildJobStatus = await buildJobStatusResponse.json() as Record<string, unknown>;
  assert.equal(buildJobStatus.status, "failed");
  assert.match(String(buildJobStatus.error_hint), /build output/i);
  assert.equal("error_detail" in buildJobStatus, false);
  assert.equal("build_log_url" in buildJobStatus, false);
});

test("validate accepts Cloudflare Access auth", async (t: TestContext) => {
  const { env, queue } = createTestContext({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud",
    CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS: "cuny.edu"
  });
  installGitHubFetchMock(t, {
    repositoryName: "cail-assets-build-test",
    headSha: "abc123def456"
  });
  installAccessFetchMock(t);
  const accessJwt = await createAccessJwt("person@cuny.edu");

  const response = await fetchApp(
    "POST",
    "/api/validate",
    env,
    {
      repositoryFullName: "szweibel/cail-assets-build-test",
      ref: "main"
    },
    {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": "person@cuny.edu"
    }
  );

  assert.equal(response.status, 202);
  assert.equal(queue.sent.length, 1);
});

test("project status ignores validate jobs while build-job status normalizes validation success to passed", async () => {
  const { env, db } = createTestContext();
  db.putProject({
    projectName: "cail-assets-build-test",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/cail-assets-build-test",
    deploymentUrl: "https://cail-assets-build-test.cuny.qzz.io",
    hasAssets: true,
    latestDeploymentId: "dep-live",
    createdAt: "2026-03-26T20:00:00.000Z",
    updatedAt: "2026-03-26T20:10:00.000Z"
  });
  db.putBuildJob({
    jobId: "job-validate-1",
    eventName: "validate",
    installationId: 1,
    repository: repositoryRecord("cail-assets-build-test"),
    ref: "main",
    headSha: "validate-sha",
    checkRunId: 99,
    status: "success",
    createdAt: "2026-03-26T21:00:00.000Z",
    updatedAt: "2026-03-26T21:05:00.000Z",
    startedAt: "2026-03-26T21:00:10.000Z",
    completedAt: "2026-03-26T21:05:00.000Z",
    projectName: "cail-assets-build-test"
  });

  const projectStatusResponse = await fetchApp("GET", "/api/projects/cail-assets-build-test/status", env);
  assert.equal(projectStatusResponse.status, 200);
  const projectStatus = await projectStatusResponse.json() as {
    status: string;
    build_status?: string;
    deployment_url: string;
  };
  assert.equal(projectStatus.status, "live");
  assert.equal(projectStatus.build_status, undefined);
  assert.equal(projectStatus.deployment_url, "https://cail-assets-build-test.cuny.qzz.io");

  const buildJobStatusResponse = await fetchApp("GET", "/api/build-jobs/job-validate-1/status", env);
  assert.equal(buildJobStatusResponse.status, 200);
  const buildJobStatus = await buildJobStatusResponse.json() as {
    jobKind: string;
    status: string;
    build_status: string;
  };
  assert.equal(buildJobStatus.jobKind, "validation");
  assert.equal(buildJobStatus.status, "passed");
  assert.equal(buildJobStatus.build_status, "success");
});
