#!/usr/bin/env node

import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DEFAULT_KALE_BASE_URL = "https://cuny.qzz.io/kale";
const DEFAULT_BRANCH = "main";
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 5 * 1000;
const CHECK_RUN_NAME = "Kale Deploy";

const config = readConfig();
let kaleMcpSessionPromise;

await main().catch((error) => {
  console.error(`FAIL ${formatError(error)}`);
  process.exit(1);
});

async function main() {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "kale-lifecycle-smoke-"));
  const repoDir = path.join(workspaceRoot, "repo");

  try {
    const runId = config.runId ?? buildRunId();
    logStep(`Starting Kale lifecycle smoke for ${config.repositoryFullName} (${runId})`);

    const initialRegistration = await registerProject();
    assertInstalled(initialRegistration);
    const projectName = initialRegistration.projectName;
    const projectUrl = initialRegistration.projectUrl;

    logStep(`Using project ${projectName} at ${projectUrl}`);
    await cloneRepository(repoDir);

    await runScenarioSequence(repoDir, projectName, projectUrl, runId, [
      {
        key: "worker-initial",
        commitLabel: "worker",
        template: buildWorkerTemplate,
        expectedRuntimeLane: "dedicated_worker",
        checkWorkerHealth: true
      },
      {
        key: "worker-redeploy",
        commitLabel: "worker",
        template: buildWorkerTemplate,
        expectedRuntimeLane: "dedicated_worker",
        checkWorkerHealth: true
      },
      {
        key: "static-promotion",
        commitLabel: "static",
        template: buildStaticTemplate,
        expectedRuntimeLane: "shared_static",
        expectedStaticAssetPath: (marker) => `/smoke-${marker}.txt`
      },
      {
        key: "static-redeploy",
        commitLabel: "static",
        template: buildStaticTemplate,
        expectedRuntimeLane: "shared_static",
        expectedStaticAssetPath: (marker) => `/smoke-${marker}.txt`
      },
      {
        key: "worker-demotion",
        commitLabel: "worker",
        template: buildWorkerTemplate,
        expectedRuntimeLane: "dedicated_worker",
        checkWorkerHealth: true
      }
    ]);

    await deleteProject(projectName);
    await waitForDeletedProject(projectName);
    await waitForProjectUrlUnavailable(projectUrl);

    const restoredRegistration = await registerProject();
    assertInstalled(restoredRegistration);
    if (restoredRegistration.projectName !== projectName) {
      throw new Error(
        `Re-registering ${config.repositoryFullName} returned ${restoredRegistration.projectName} instead of ${projectName}.`
      );
    }

    await runScenarioSequence(repoDir, projectName, projectUrl, runId, [
      {
        key: "worker-restore",
        commitLabel: "restore",
        template: buildWorkerTemplate,
        expectedRuntimeLane: "dedicated_worker",
        checkWorkerHealth: true
      }
    ]);

    logStep(`Lifecycle smoke passed for ${config.repositoryFullName}`);
  } finally {
    await closeKaleMcpSession();
    if (config.keepWorkspace) {
      logStep(`Keeping workspace at ${workspaceRoot}`);
    } else {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }
}

function readConfig() {
  const repositoryFullName = process.env.KALE_SMOKE_REPOSITORY?.trim();
  const githubToken = process.env.KALE_SMOKE_GITHUB_TOKEN?.trim();
  const kaleToken = process.env.KALE_SMOKE_KALE_TOKEN?.trim();

  if (!repositoryFullName) {
    throw new Error("Set KALE_SMOKE_REPOSITORY to owner/repo for the dedicated lifecycle smoke repository.");
  }
  if (!githubToken) {
    throw new Error("Set KALE_SMOKE_GITHUB_TOKEN to a token that can push to the lifecycle smoke repository.");
  }
  if (!kaleToken) {
    throw new Error(
      "Set KALE_SMOKE_KALE_TOKEN to a valid Kale MCP bearer token (usually a kale_pat_* token from /connect) created by a user who already linked GitHub admin access for the smoke repo."
    );
  }

  return {
    repositoryFullName,
    githubToken,
    kaleToken,
    kaleBaseUrl: process.env.KALE_BASE_URL?.trim() || DEFAULT_KALE_BASE_URL,
    defaultBranch: process.env.KALE_SMOKE_DEFAULT_BRANCH?.trim() || DEFAULT_BRANCH,
    preferredProjectName: process.env.KALE_SMOKE_PROJECT_NAME?.trim(),
    timeoutMs: parsePositiveInt(process.env.KALE_SMOKE_TIMEOUT_SECONDS, DEFAULT_TIMEOUT_MS / 1000) * 1000,
    pollIntervalMs: parsePositiveInt(process.env.KALE_SMOKE_POLL_INTERVAL_SECONDS, DEFAULT_POLL_INTERVAL_MS / 1000) * 1000,
    gitAuthorName: process.env.KALE_SMOKE_GIT_AUTHOR_NAME?.trim() || "Kale Lifecycle Smoke",
    gitAuthorEmail: process.env.KALE_SMOKE_GIT_AUTHOR_EMAIL?.trim() || "ailab@gc.cuny.edu",
    runId: process.env.KALE_SMOKE_RUN_ID?.trim(),
    keepWorkspace: process.env.KALE_SMOKE_KEEP_WORKSPACE === "1"
  };
}

function parsePositiveInt(value, fallback) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildRunId() {
  return `${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

async function runScenarioSequence(repoDir, projectName, projectUrl, runId, scenarios) {
  for (const scenario of scenarios) {
    const marker = `${runId}-${scenario.key}`;
    logStep(`Running scenario ${scenario.key}`);
    await pushTemplateCommit(
      repoDir,
      scenario.template(projectName, marker),
      `smoke(${scenario.commitLabel}): ${marker}`
    );
    await waitForKaleCheckRun(config.repositoryFullName, await getHeadSha(repoDir));
    await waitForLiveProject(projectName, projectUrl, {
      expectedRuntimeLane: scenario.expectedRuntimeLane,
      expectedMarker: marker,
      checkWorkerHealth: Boolean(scenario.checkWorkerHealth),
      expectedStaticAssetPath: typeof scenario.expectedStaticAssetPath === "function"
        ? scenario.expectedStaticAssetPath(marker)
        : scenario.expectedStaticAssetPath
    });
  }
}

async function registerProject() {
  const response = await callKaleTool("register_project", {
    repository: config.repositoryFullName,
    ...(config.preferredProjectName ? { projectName: config.preferredProjectName } : {})
  });

  if (response.isError || !response.payload.ok) {
    throw new Error(`register_project failed: ${response.payload.error ?? response.payload.summary ?? response.text ?? "unknown error"}`);
  }

  return response.payload;
}

function assertInstalled(registration) {
  if (registration.installStatus !== "installed") {
    throw new Error(
      `Smoke repo ${config.repositoryFullName} is not installed in Kale Deploy. Guided install: ${registration.guidedInstallUrl ?? registration.installUrl ?? "missing"}`
    );
  }
}

async function deleteProject(projectName) {
  logStep(`Deleting ${projectName} from Kale`);
  const response = await callKaleTool("delete_project", {
    projectName,
    confirmProjectName: projectName
  });

  if (response.isError || !response.payload.deletedFromKaleOnly) {
    if (response.payload.nextAction === "connect_github_user") {
      throw new Error(
        `delete_project requires a Kale token whose owner already linked GitHub admin access. Continue at ${response.payload.connectGitHubUserUrl ?? "the project settings page"}`
      );
    }

    throw new Error(`delete_project failed: ${response.payload.error ?? response.payload.summary ?? response.text ?? "unknown error"}`);
  }
}

async function waitForDeletedProject(projectName) {
  logStep(`Waiting for ${projectName} to disappear from project status`);
  await pollUntil(async () => {
    const status = await getProjectStatus(projectName);
    if (!status) {
      return true;
    }
    return false;
  }, `Timed out waiting for ${projectName} to be deleted from Kale.`);
}

async function waitForProjectUrlUnavailable(projectUrl) {
  logStep(`Waiting for ${projectUrl} to stop serving publicly`);
  await pollUntil(async () => {
    try {
      const response = await fetch(projectUrl, {
        method: "GET",
        headers: {
          accept: "text/html,application/json;q=0.9,*/*;q=0.8",
          "user-agent": "KaleLifecycleSmoke/1.0"
        }
      });
      return response.status >= 400;
    } catch {
      return true;
    }
  }, `Timed out waiting for ${projectUrl} to stop serving after project deletion.`);
}

async function getProjectStatus(projectName) {
  const response = await callKaleTool("get_project_status", { projectName });
  if (response.isError && response.payload.error === "Project not found.") {
    return null;
  }

  if (response.isError) {
    throw new Error(`get_project_status failed: ${response.payload.error ?? response.payload.summary ?? response.text ?? "unknown error"}`);
  }

  return response.payload;
}

async function waitForLiveProject(projectName, projectUrl, options) {
  logStep(`Waiting for ${projectName} to go live as ${options.expectedRuntimeLane}`);

  let lastSummary = "";
  await pollUntil(async () => {
    const status = await getProjectStatus(projectName);
    if (!status) {
      return false;
    }

    if (status.status === "failed") {
      throw new Error(
        `Build failed for ${projectName}: ${status.error_message ?? "unknown error"}${status.build_log_url ? ` (${status.build_log_url})` : ""}`
      );
    }

    const summary = `${status.status}:${status.runtime_lane ?? "unknown"}:${status.deployment_id ?? "none"}`;
    if (summary !== lastSummary) {
      logStep(`Project status ${summary}`);
      lastSummary = summary;
    }

    if (
      status.status === "live"
      && options.expectedRuntimeLane === "shared_static"
      && status.runtime_lane === "dedicated_worker"
      && status.recommended_runtime_lane === "shared_static"
      && await isServingExpectedStaticContent(projectUrl, options)
    ) {
      throw new Error(
        `${projectName} is serving the expected static content, but Kale kept runtime_lane=dedicated_worker instead of promoting to shared_static.`
      );
    }

    if (status.status !== "live" || status.runtime_lane !== options.expectedRuntimeLane) {
      return false;
    }

    if (options.checkWorkerHealth) {
      try {
        const healthUrl = `${projectUrl.replace(/\/$/, "")}/api/health?smoke_bust=${encodeURIComponent(options.expectedMarker)}`;
        const health = await fetchJson(healthUrl);
        return health.ok === true && health.marker === options.expectedMarker;
      } catch {
        return false;
      }
    }

    if (options.expectedStaticAssetPath) {
      try {
        const assetUrl = new URL(options.expectedStaticAssetPath, ensureTrailingSlash(projectUrl)).toString();
        const assetBody = await fetchText(assetUrl);
        return assetBody.includes(options.expectedMarker);
      } catch {
        return false;
      }
    }

    try {
      const rootBody = await fetchText(projectUrl);
      return rootBody.includes(options.expectedMarker);
    } catch {
      return false;
    }
  }, `Timed out waiting for ${projectName} to serve ${options.expectedMarker} as ${options.expectedRuntimeLane}.`);
}

async function isServingExpectedStaticContent(projectUrl, options) {
  if (options.checkWorkerHealth || !options.expectedStaticAssetPath) {
    return false;
  }

  try {
    const assetUrl = new URL(options.expectedStaticAssetPath, ensureTrailingSlash(projectUrl)).toString();
    const assetBody = await fetchText(assetUrl);
    if (!assetBody.includes(options.expectedMarker)) {
      return false;
    }

    const rootBody = await fetchText(projectUrl);
    return rootBody.includes(options.expectedMarker);
  } catch {
    return false;
  }
}

async function waitForKaleCheckRun(repositoryFullName, sha) {
  logStep(`Waiting for the Kale Deploy check run on ${sha.slice(0, 7)}`);

  let lastStatus = "";
  await pollUntil(async () => {
    const payload = await githubJson(`/repos/${repositoryFullName}/commits/${sha}/check-runs`);
    const checkRuns = Array.isArray(payload.check_runs) ? payload.check_runs : [];
    const run = checkRuns.find((entry) => entry.name === CHECK_RUN_NAME);

    if (!run) {
      return false;
    }

    const statusLabel = `${run.status}:${run.conclusion ?? "pending"}`;
    if (statusLabel !== lastStatus) {
      logStep(`Check run ${statusLabel}`);
      lastStatus = statusLabel;
    }

    if (run.status !== "completed") {
      return false;
    }

    if (run.conclusion !== "success") {
      throw new Error(
        `${CHECK_RUN_NAME} failed for ${sha.slice(0, 7)} with conclusion ${run.conclusion ?? "unknown"}${run.details_url ? ` (${run.details_url})` : ""}`
      );
    }

    return true;
  }, `Timed out waiting for the ${CHECK_RUN_NAME} check run on ${sha.slice(0, 7)}.`);
}

async function cloneRepository(repoDir) {
  logStep(`Cloning ${config.repositoryFullName}`);
  const remoteUrl = `https://x-access-token:${encodeURIComponent(config.githubToken)}@github.com/${config.repositoryFullName}.git`;
  await runCommand("git", [
    "clone",
    "--depth",
    "1",
    "--branch",
    config.defaultBranch,
    remoteUrl,
    repoDir
  ]);

  await runCommand("git", ["config", "user.name", config.gitAuthorName], { cwd: repoDir });
  await runCommand("git", ["config", "user.email", config.gitAuthorEmail], { cwd: repoDir });
}

async function pushTemplateCommit(repoDir, files, commitMessage) {
  await replaceRepoContents(repoDir, files);
  await runCommand("git", ["add", "-A"], { cwd: repoDir });

  const diff = await runCommand("git", ["status", "--short"], { cwd: repoDir, captureStdout: true });
  if (!diff.stdout.trim()) {
    throw new Error(`No repository changes were staged for commit '${commitMessage}'.`);
  }

  await runCommand("git", ["commit", "-m", commitMessage], { cwd: repoDir });
  await runCommand("git", ["push", "origin", `HEAD:${config.defaultBranch}`], { cwd: repoDir });
}

async function getHeadSha(repoDir) {
  const result = await runCommand("git", ["rev-parse", "HEAD"], { cwd: repoDir, captureStdout: true });
  return result.stdout.trim();
}

async function replaceRepoContents(repoDir, files) {
  const entries = await readdir(repoDir, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.name !== ".git")
    .map((entry) => rm(path.join(repoDir, entry.name), { recursive: true, force: true })));

  for (const [relativePath, content] of Object.entries(files)) {
    const destination = path.join(repoDir, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content, "utf8");
  }
}

function buildWorkerTemplate(projectName, marker) {
  return {
    "AGENTS.md": buildAgentsMd(projectName, "worker"),
    "kale.project.json": `${JSON.stringify({
      projectShape: "worker_app",
      requestTimeLogic: "allowed"
    }, null, 2)}\n`,
    "package.json": `${JSON.stringify({
      name: projectName,
      private: true,
      type: "module"
    }, null, 2)}\n`,
    "wrangler.jsonc": `{
  "name": "${projectName}",
  "main": "src/index.js",
  "compatibility_date": "2026-04-02"
}
`,
    "src/index.js": `const marker = ${JSON.stringify(marker)};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, marker, runtimeLane: "dedicated_worker" });
    }

    return new Response(
      \`<!doctype html><html lang="en"><body><h1>Kale Lifecycle Smoke Worker</h1><p>\${marker}</p></body></html>\`,
      { headers: { "content-type": "text/html; charset=utf-8" } }
    );
  }
};
`
  };
}

function buildStaticTemplate(projectName, marker) {
  return {
    "AGENTS.md": buildAgentsMd(projectName, "static"),
    "kale.project.json": `${JSON.stringify({
      projectShape: "static_site",
      staticOutputDir: "public",
      requestTimeLogic: "none"
    }, null, 2)}\n`,
    "package.json": `${JSON.stringify({
      name: projectName,
      private: true,
      type: "module"
    }, null, 2)}\n`,
    "wrangler.jsonc": `{
  "name": "${projectName}",
  "main": "src/index.js",
  "compatibility_date": "2026-04-02",
  "assets": {
    "directory": "public",
    "html_handling": "auto-trailing-slash"
  }
}
`,
    "src/index.js": `export default {
  async fetch() {
    return new Response("Not found.", { status: 404 });
  }
};
`,
    "public/index.html": `<!doctype html>
<html lang="en">
  <body>
    <h1>Kale Lifecycle Smoke Static</h1>
    <p>${escapeHtml(marker)}</p>
  </body>
</html>
`,
    [`public/smoke-${marker}.txt`]: `${marker}\n`
  };
}

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function buildAgentsMd(projectName, shape) {
  if (shape === "static") {
    return `# ${projectName}

This is a dedicated Kale lifecycle smoke repository.

- Keep this repo as a pure static-site smoke fixture.
- Do not add request-time routes, custom response headers, _headers, or _redirects.
- The public root page must stay live and readable after deploy.
`;
  }

  return `# ${projectName}

This is a dedicated Kale lifecycle smoke repository.

- Keep this repo as a Worker smoke fixture.
- Keep /api/health available so Kale can verify the live dedicated Worker path.
- The root page must stay live and readable after deploy.
`;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function getKaleMcpSession() {
  kaleMcpSessionPromise ??= createKaleMcpSession();
  return await kaleMcpSessionPromise;
}

async function createKaleMcpSession() {
  const client = new Client({
    name: "kale-lifecycle-smoke",
    version: "0.1.0"
  });
  const transport = new StreamableHTTPClientTransport(new URL(`${config.kaleBaseUrl}/mcp`), {
    requestInit: {
      headers: {
        authorization: `Bearer ${config.kaleToken}`
      }
    }
  });

  try {
    await client.connect(transport);
    await client.listTools();
    return { client, transport };
  } catch (error) {
    await safeCloseKaleMcpSession({ client, transport });
    throw new Error(
      `Kale MCP authentication failed. Refresh KALE_SMOKE_KALE_TOKEN from ${config.kaleBaseUrl}/connect and try again. ${formatError(error)}`
    );
  }
}

async function githubJson(pathname) {
  const response = await fetch(`https://api.github.com${pathname}`, {
    method: "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${config.githubToken}`,
      "user-agent": "KaleLifecycleSmoke/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`GitHub API request failed with ${response.status}: ${await response.text()}`);
  }

  return await response.json();
}

async function fetchText(url) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      accept: "text/html,application/json;q=0.9,*/*;q=0.8",
      "user-agent": "KaleLifecycleSmoke/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`Live URL request failed with ${response.status}: ${url}`);
  }

  return await response.text();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "user-agent": "KaleLifecycleSmoke/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`JSON request failed with ${response.status}: ${url}`);
  }

  return await response.json();
}

async function closeKaleMcpSession() {
  if (!kaleMcpSessionPromise) {
    return;
  }

  const sessionPromise = kaleMcpSessionPromise;
  kaleMcpSessionPromise = undefined;

  try {
    const session = await sessionPromise;
    await safeCloseKaleMcpSession(session);
  } catch {
    // Session creation already surfaced the underlying error.
  }
}

async function safeCloseKaleMcpSession(session) {
  try {
    await session.client.close();
  } catch {
    // Best-effort close on smoke shutdown.
  }

  try {
    await session.transport.close();
  } catch {
    // Transport may already be closed after client shutdown.
  }
}

async function callKaleTool(name, args = {}) {
  const { client } = await getKaleMcpSession();

  try {
    const result = await client.callTool({
      name,
      arguments: args
    });

    return {
      isError: Boolean(result.isError),
      payload: normalizeToolPayload(result.structuredContent),
      text: extractToolText(result.content)
    };
  } catch (error) {
    throw new Error(`Kale MCP tool ${name} failed: ${formatError(error)}`);
  }
}

function normalizeToolPayload(payload) {
  return payload && typeof payload === "object" ? payload : {};
}

function extractToolText(content) {
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

async function pollUntil(check, timeoutMessage) {
  const deadline = Date.now() + config.timeoutMs;

  while (Date.now() < deadline) {
    const done = await check();
    if (done) {
      return;
    }
    await sleep(config.pollIntervalMs);
  }

  throw new Error(timeoutMessage);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCommand(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: options.captureStdout ? ["ignore", "pipe", "inherit"] : "inherit"
    });

    let stdout = "";
    if (options.captureStdout && child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
    }

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout });
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
    });
  });
}

function logStep(message) {
  console.log(`SMOKE ${message}`);
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
