import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createRequire } from "node:module";

import type {
  BuildRunnerCheckRunConclusion,
  BuildRunnerCompletePayload,
  BuildRunnerFailureKind,
  BuildRunnerJobRequest,
  BuildRunnerSourceLease,
  BuildRunnerStartPayload,
  StaticAssetUpload,
  WorkerBinding,
  WorkerAssetsConfig,
  WorkerUploadMetadata
} from "@cuny-ai-lab/build-contract";
import ignore from "ignore";
import { parse as parseJsonc } from "jsonc-parser";
import * as mime from "mime-types";
import { parse as parseToml } from "smol-toml";

const DEFAULT_BATCH_SIZE = 1;
const DEFAULT_IDLE_POLL_DELAY_MS = 5_000;
const DEFAULT_VISIBILITY_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_RETRY_DELAY_SECONDS = 60;
const DEFAULT_LOG_TAIL_CHARS = 12_000;
const DEFAULT_COMPATIBILITY_DATE = new Date().toISOString().slice(0, 10);
const FALLBACK_ENTRYPOINTS = ["src/index.ts", "src/index.js", "index.ts", "index.js"];
const IGNORE_FILES = new Set(["README.md"]);
const PYTHON_MARKER_FILES = [
  "pyproject.toml",
  "requirements.txt",
  "Pipfile",
  "environment.yml",
  "manage.py",
  "app.py",
  "main.py",
  "wsgi.py",
  "asgi.py"
];
const TRADITIONAL_NODE_SERVER_PACKAGES = new Set([
  "express",
  "koa",
  "fastify",
  "hapi",
  "@nestjs/core",
  "@nestjs/platform-express",
  "sails",
  "socket.io"
]);
const require = createRequire(import.meta.url);
const WRANGLER_CLI_PATH = require.resolve("wrangler/wrangler-dist/cli.js");
const SANDBOXED_CHILD_ENV_KEYS = [
  "HOME",
  "LOGNAME",
  "PATH",
  "PWD",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ"
] as const;

type RunnerConfig = {
  runnerId: string;
  cloudflareAccountId: string;
  buildQueueId: string;
  queuesApiToken: string;
  buildRunnerToken: string;
  workRoot: string;
  batchSize: number;
  idlePollDelayMs: number;
  visibilityTimeoutMs: number;
  retryDelaySeconds: number;
  keepWorkdirs: boolean;
  healthPort?: number;
};

type RunnerState = {
  startedAt: string;
  runnerId: string;
  status: "starting" | "idle" | "building" | "stopping" | "stopped";
  startupChecksPassed: boolean;
  shutdownRequested: boolean;
  inFlightJobs: string[];
  lastPollAt?: string;
  lastJobCompletedAt?: string;
  lastError?: string;
};

type PulledQueueMessage = {
  body: unknown;
  id: string;
  attempts: number;
  lease_id: string;
  metadata?: Record<string, string>;
};

type QueuePullResponse = {
  success: boolean;
  errors?: Array<{ message: string }>;
  result?: {
    message_backlog_count?: number;
    messages?: PulledQueueMessage[];
  };
};

type QueueAckEntry = {
  lease_id: string;
  delay_seconds?: number;
};

type QueueAckResponse = {
  success: boolean;
  errors?: Array<{ message: string }>;
};

type StartCallbackResponse = {
  ok?: boolean;
  alreadyCompleted?: boolean;
};

type CompleteCallbackResponse = {
  ok?: boolean;
  alreadyCompleted?: boolean;
};

type PackageManager = "npm" | "pnpm" | "yarn";

type ProjectPackageJson = {
  description?: string;
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type WranglerAssets = {
  directory?: string;
  html_handling?: string;
  not_found_handling?: string;
  run_worker_first?: boolean | string[];
};

type WranglerConfig = {
  name?: string;
  main?: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  d1_databases?: Array<{
    binding?: string;
    database_id?: string;
    preview_database_id?: string;
  }>;
  kv_namespaces?: Array<{
    binding?: string;
    id?: string;
    preview_id?: string;
  }>;
  r2_buckets?: Array<{
    binding?: string;
    bucket_name?: string;
    preview_bucket_name?: string;
  }>;
  ai?: {
    binding?: string;
  };
  vectorize?: Array<{
    binding?: string;
    index_name?: string;
  }>;
  durable_objects?: {
    bindings?: Array<{
      name?: string;
      class_name?: string;
      script_name?: string;
    }>;
  };
  observability?: {
    enabled?: boolean;
  };
  assets?: WranglerAssets;
};

type ResolvedWranglerConfig = {
  configPath: string;
  configDir: string;
  config: WranglerConfig;
};

type BuildPlan = {
  workerName: string;
  compatibilityDate: string;
  compatibilityFlags?: string[];
  requestedBindings: WorkerBinding[];
  observabilityEnabled?: boolean;
  assetsDirectory?: string;
  assetsConfig?: WorkerAssetsConfig;
  wranglerArgs: string[];
};

type PreparedArtifact = {
  workerFiles: Array<{ name: string; file: File }>;
  mainModule: string;
  description?: string;
  staticAssets?: StaticAssetUpload;
  allFiles: Array<{ name: string; file: File }>;
  workerUpload: WorkerUploadMetadata;
};

type LoggedCommandResult = {
  output: string;
};

type JobWorkspace = {
  root: string;
  sourceRoot: string;
  bundleRoot: string;
};

void main();

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const state = createRunnerState(config);
  const shutdown = registerShutdownHandlers(state);
  const healthServer = await startHealthServer(config, state);
  await mkdir(config.workRoot, { recursive: true });

  try {
    await verifyRunnerHost();
    state.startupChecksPassed = true;
    state.status = "idle";
    console.log(`[build-runner] runner=${config.runnerId} queue=${config.buildQueueId} polling`);

    while (!shutdown.requested) {
      try {
        state.lastPollAt = new Date().toISOString();
        const messages = await pullMessages(config);
        if (messages.length === 0) {
          state.status = "idle";
          if (shutdown.requested) {
            break;
          }
          await sleep(config.idlePollDelayMs);
          continue;
        }

        const acknowledgements: QueueAckEntry[] = [];
        const retries: QueueAckEntry[] = [];

        for (const message of messages) {
          const outcome = await handleQueueMessage(config, state, message);
          if (outcome === "retry") {
            retries.push({ lease_id: message.lease_id, delay_seconds: config.retryDelaySeconds });
          } else {
            acknowledgements.push({ lease_id: message.lease_id });
          }
        }

        await acknowledgeMessages(config, acknowledgements, retries);
        if (state.inFlightJobs.length === 0) {
          state.status = shutdown.requested ? "stopping" : "idle";
        }
      } catch (error) {
        state.lastError = errorMessage(error);
        console.error("[build-runner] poll loop error", error);
        if (shutdown.requested) {
          break;
        }
        await sleep(config.idlePollDelayMs);
      }
    }
  } finally {
    state.status = "stopped";
    await stopHealthServer(healthServer);
    if (shutdown.requested) {
      console.log("[build-runner] shutdown complete");
    }
  }
}

async function handleQueueMessage(
  config: RunnerConfig,
  state: RunnerState,
  message: PulledQueueMessage
): Promise<"ack" | "retry"> {
  let request: BuildRunnerJobRequest | undefined;
  let workspace: JobWorkspace | undefined;
  const logs: string[] = [];

  try {
    request = parseJobRequest(message.body);
    state.status = "building";
    state.inFlightJobs.push(request.jobId);
    workspace = await createWorkspace(config);

    const startResponse = await postBuildStart(config, request);
    if (startResponse.alreadyCompleted) {
      console.log(`[build-runner] job=${request.jobId} already completed, acknowledging duplicate delivery`);
      return "ack";
    }

    const sourceLease = await fetchSourceLease(config, request);
    await checkoutRepositoryArchive(sourceLease, workspace);

    const packageJson = await readProjectPackageJson(workspace.sourceRoot);
    const packageManager = detectPackageManager(workspace.sourceRoot, packageJson);
    await assertProjectCompatibility(workspace.sourceRoot, packageJson);

    if (packageJson) {
      await installDependencies(packageManager, workspace.sourceRoot, logs);
      if (hasBuildScript(packageJson)) {
        await runBuildScript(packageManager, workspace.sourceRoot, logs);
      }
    }

    const buildPlan = await createBuildPlan(workspace.sourceRoot, request.deployment.suggestedProjectName);
    await runWranglerBundle(buildPlan, workspace.sourceRoot, workspace.bundleRoot, logs);

    const artifact = await prepareArtifact(
      workspace.sourceRoot,
      workspace.bundleRoot,
      buildPlan,
      packageJson
    );
    await postBuildSuccess(config, request, artifact);

    state.lastError = undefined;
    console.log(`[build-runner] job=${request.jobId} built successfully`);
    return "ack";
  } catch (error) {
    if (error instanceof RetryableRunnerError) {
      console.error(
        `[build-runner] retrying job=${request?.jobId ?? "unknown"} because of retryable error`,
        error.message
      );
      return "retry";
    }

    if (!request) {
      console.error("[build-runner] dropping malformed queue message", error);
      return "ack";
    }

    try {
      state.lastError = errorMessage(error);
      await postBuildFailure(config, request, error, logs);
      console.error(`[build-runner] job=${request.jobId} failed`, error);
      return "ack";
    } catch (callbackError) {
      state.lastError = errorMessage(callbackError);
      console.error(`[build-runner] failed to report failure for job=${request.jobId}`, callbackError);
      return "retry";
    }
  } finally {
    if (request) {
      const completedJobId = request.jobId;
      state.inFlightJobs = state.inFlightJobs.filter((jobId) => jobId !== completedJobId);
      state.lastJobCompletedAt = new Date().toISOString();
      if (state.inFlightJobs.length === 0) {
        state.status = state.shutdownRequested ? "stopping" : "idle";
      }
    }
    if (workspace && !config.keepWorkdirs) {
      await rm(workspace.root, { recursive: true, force: true });
    }
  }
}

function loadConfig(env: NodeJS.ProcessEnv): RunnerConfig {
  return {
    runnerId: required(env.RUNNER_ID ?? env.HOSTNAME ?? "build-runner", "RUNNER_ID"),
    cloudflareAccountId: required(env.CLOUDFLARE_ACCOUNT_ID, "CLOUDFLARE_ACCOUNT_ID"),
    buildQueueId: required(env.BUILD_QUEUE_ID, "BUILD_QUEUE_ID"),
    queuesApiToken: required(env.QUEUES_API_TOKEN, "QUEUES_API_TOKEN"),
    buildRunnerToken: required(env.BUILD_RUNNER_TOKEN, "BUILD_RUNNER_TOKEN"),
    workRoot: env.RUNNER_WORKDIR_ROOT ?? path.join(tmpdir(), "cail-build-runner"),
    batchSize: parsePositiveInteger(env.BUILD_BATCH_SIZE, DEFAULT_BATCH_SIZE),
    idlePollDelayMs: parsePositiveInteger(env.BUILD_IDLE_POLL_DELAY_MS, DEFAULT_IDLE_POLL_DELAY_MS),
    visibilityTimeoutMs: parsePositiveInteger(env.BUILD_VISIBILITY_TIMEOUT_MS, DEFAULT_VISIBILITY_TIMEOUT_MS),
    retryDelaySeconds: parsePositiveInteger(env.BUILD_RETRY_DELAY_SECONDS, DEFAULT_RETRY_DELAY_SECONDS),
    keepWorkdirs: env.RUNNER_KEEP_WORKDIRS === "1" || env.RUNNER_KEEP_WORKDIRS === "true",
    healthPort: parseOptionalPositiveInteger(env.RUNNER_HEALTH_PORT)
  };
}

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }

  return value;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalPositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function createRunnerState(config: RunnerConfig): RunnerState {
  return {
    startedAt: new Date().toISOString(),
    runnerId: config.runnerId,
    status: "starting",
    startupChecksPassed: false,
    shutdownRequested: false,
    inFlightJobs: []
  };
}

function registerShutdownHandlers(state: RunnerState): { requested: boolean } {
  const shutdown = { requested: false };

  const requestShutdown = (signal: string) => {
    if (shutdown.requested) {
      return;
    }

    shutdown.requested = true;
    state.shutdownRequested = true;
    state.status = state.inFlightJobs.length > 0 ? "stopping" : "stopped";
    console.log(`[build-runner] received ${signal}, stopping after current work`);
  };

  process.once("SIGINT", () => requestShutdown("SIGINT"));
  process.once("SIGTERM", () => requestShutdown("SIGTERM"));
  return shutdown;
}

async function startHealthServer(config: RunnerConfig, state: RunnerState): Promise<Server | undefined> {
  if (!config.healthPort) {
    return undefined;
  }

  const server = createServer((request, response) => {
    if (request.url === "/healthz") {
      respondJson(response, 200, {
        ok: true,
        runnerId: state.runnerId,
        status: state.status,
        shutdownRequested: state.shutdownRequested,
        startupChecksPassed: state.startupChecksPassed,
        inFlightJobs: state.inFlightJobs,
        startedAt: state.startedAt,
        lastPollAt: state.lastPollAt,
        lastJobCompletedAt: state.lastJobCompletedAt,
        lastError: state.lastError
      });
      return;
    }

    if (request.url === "/readyz") {
      const ready = state.startupChecksPassed && !state.shutdownRequested;
      respondJson(response, ready ? 200 : 503, {
        ok: ready,
        runnerId: state.runnerId,
        status: state.status
      });
      return;
    }

    respondJson(response, 404, { ok: false, error: "Not found" });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.healthPort, "0.0.0.0", () => resolve());
  });
  console.log(`[build-runner] healthz listening on ${config.healthPort}`);
  return server;
}

async function stopHealthServer(server: Server | undefined): Promise<void> {
  if (!server) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function respondJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function verifyRunnerHost(): Promise<void> {
  await verifyCommandAvailable("tar", ["--version"]);
  await verifyCommandAvailable("npm", ["--version"]);
  await verifyCommandAvailable("corepack", ["--version"]);
}

async function verifyCommandAvailable(command: string, args: string[]): Promise<void> {
  try {
    await runCommand(command, args, process.cwd(), {
      logLabel: `${command} availability check`,
      logTailChars: 256
    });
  } catch (error) {
    throw new Error(`Required host command '${command}' is unavailable: ${errorMessage(error)}`);
  }
}

async function pullMessages(config: RunnerConfig): Promise<PulledQueueMessage[]> {
  const response = await fetch(queueApiUrl(config, "pull"), {
    method: "POST",
    headers: queueHeaders(config),
    body: JSON.stringify({
      batch_size: config.batchSize,
      visibility_timeout_ms: config.visibilityTimeoutMs
    })
  });

  if (!response.ok) {
    throw new Error(`Queue pull failed with status ${response.status}.`);
  }

  const body = await response.json() as QueuePullResponse;
  if (!body.success) {
    throw new Error(body.errors?.map((entry) => entry.message).join("; ") || "Queue pull failed.");
  }

  return body.result?.messages ?? [];
}

async function acknowledgeMessages(
  config: RunnerConfig,
  acknowledgements: QueueAckEntry[],
  retries: QueueAckEntry[]
): Promise<void> {
  if (acknowledgements.length === 0 && retries.length === 0) {
    return;
  }

  const response = await fetch(queueApiUrl(config, "ack"), {
    method: "POST",
    headers: queueHeaders(config),
    body: JSON.stringify({
      acks: acknowledgements,
      retries
    })
  });

  if (!response.ok) {
    throw new Error(`Queue ack failed with status ${response.status}.`);
  }

  const body = await response.json() as QueueAckResponse;
  if (!body.success) {
    throw new Error(body.errors?.map((entry) => entry.message).join("; ") || "Queue ack failed.");
  }
}

function queueApiUrl(config: RunnerConfig, action: "pull" | "ack"): string {
  return `https://api.cloudflare.com/client/v4/accounts/${config.cloudflareAccountId}/queues/${config.buildQueueId}/messages/${action}`;
}

function queueHeaders(config: RunnerConfig): Record<string, string> {
  return {
    authorization: `Bearer ${config.queuesApiToken}`,
    "content-type": "application/json"
  };
}

function parseJobRequest(body: unknown): BuildRunnerJobRequest {
  const parsed = typeof body === "string" ? JSON.parse(body) : body;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Queue message body is not an object.");
  }

  const request = parsed as Partial<BuildRunnerJobRequest>;
  if (
    !request.jobId ||
    !request.repository?.fullName ||
    !request.source?.tokenUrl ||
    !request.callback?.startUrl ||
    !request.callback?.completeUrl ||
    !request.deployment?.suggestedProjectName
  ) {
    throw new Error("Queue message is missing required build fields.");
  }

  return request as BuildRunnerJobRequest;
}

async function createWorkspace(config: RunnerConfig): Promise<JobWorkspace> {
  const root = await mkdtemp(path.join(config.workRoot, "job-"));
  const sourceRoot = path.join(root, "source");
  const bundleRoot = path.join(root, "bundle");

  await mkdir(sourceRoot, { recursive: true });
  await mkdir(bundleRoot, { recursive: true });

  return { root, sourceRoot, bundleRoot };
}

async function postBuildStart(config: RunnerConfig, request: BuildRunnerJobRequest): Promise<StartCallbackResponse> {
  const payload: BuildRunnerStartPayload = {
    runnerId: config.runnerId,
    startedAt: new Date().toISOString(),
    summary: "CAIL build runner is preparing the repository and compiling the Worker bundle."
  };

  const response = await fetch(request.callback.startUrl, {
    method: "POST",
    headers: jsonHeaders(config),
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new RetryableRunnerError(`Build start callback failed with status ${response.status}.`);
  }

  return await response.json() as StartCallbackResponse;
}

async function fetchSourceLease(config: RunnerConfig, request: BuildRunnerJobRequest): Promise<BuildRunnerSourceLease> {
  const response = await fetch(request.source.tokenUrl, {
    method: "GET",
    headers: authHeaders(config)
  });

  if (!response.ok) {
    throw new RetryableRunnerError(`Source lease request failed with status ${response.status}.`);
  }

  const body = await response.json() as BuildRunnerSourceLease;
  if (!body.accessToken || !body.archiveUrl) {
    throw new RetryableRunnerError("Source lease response was missing access credentials.");
  }

  return body;
}

async function checkoutRepositoryArchive(sourceLease: BuildRunnerSourceLease, workspace: JobWorkspace): Promise<void> {
  const archivePath = path.join(workspace.root, "source.tar.gz");
  const response = await fetch(sourceLease.archiveUrl, {
    method: "GET",
    headers: {
      authorization: `Bearer ${sourceLease.accessToken}`,
      accept: "application/vnd.github+json"
    }
  });

  if (response.status >= 500) {
    throw new RetryableRunnerError(`GitHub archive download failed with status ${response.status}.`);
  }

  if (!response.ok || !response.body) {
    throw new PermanentRunnerError(`GitHub archive download failed with status ${response.status}.`);
  }

  await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream), createWriteStream(archivePath));
  await runCommand("tar", ["-xzf", archivePath, "-C", workspace.sourceRoot, "--strip-components=1"], workspace.root, {
    logLabel: "tar extract",
    logTailChars: DEFAULT_LOG_TAIL_CHARS
  });
}

async function readProjectPackageJson(projectRoot: string): Promise<ProjectPackageJson | undefined> {
  const packageJsonPath = path.join(projectRoot, "package.json");
  if (!(await exists(packageJsonPath))) {
    return undefined;
  }

  const raw = await readFile(packageJsonPath, "utf8");
  const parsed = JSON.parse(raw) as ProjectPackageJson;
  return parsed;
}

function detectPackageManager(projectRoot: string, packageJson: ProjectPackageJson | undefined): PackageManager {
  const declared = packageJson?.packageManager?.split("@", 1)[0];
  if (declared === "pnpm" || declared === "yarn" || declared === "npm") {
    return declared;
  }

  if (existsSync(path.join(projectRoot, "pnpm-lock.yaml"))) {
    return "pnpm";
  }

  if (existsSync(path.join(projectRoot, "yarn.lock"))) {
    return "yarn";
  }

  return "npm";
}

function hasBuildScript(packageJson: ProjectPackageJson): boolean {
  return typeof packageJson.scripts?.build === "string" && packageJson.scripts.build.length > 0;
}

async function installDependencies(packageManager: PackageManager, projectRoot: string, logs: string[]): Promise<void> {
  const lockfileExists = {
    npm: existsSync(path.join(projectRoot, "package-lock.json")),
    pnpm: existsSync(path.join(projectRoot, "pnpm-lock.yaml")),
    yarn: existsSync(path.join(projectRoot, "yarn.lock"))
  };

  const result = await runCommand(...packageManagerInstallCommand(packageManager, lockfileExists[packageManager]), projectRoot, {
    env: buildSandboxedChildEnv(),
    inheritProcessEnv: false,
    logLabel: `${packageManager} install`,
    logTailChars: DEFAULT_LOG_TAIL_CHARS
  });
  logs.push(formatCommandLog(`${packageManager} install`, result.output));
}

async function runBuildScript(packageManager: PackageManager, projectRoot: string, logs: string[]): Promise<void> {
  const command = packageManagerCommand(packageManager);
  const args = packageManager === "npm" ? ["run", "build"] : [packageManager, "run", "build"];
  const result = await runCommand(command, args, projectRoot, {
    env: buildSandboxedChildEnv(),
    inheritProcessEnv: false,
    logLabel: `${packageManager} run build`,
    logTailChars: DEFAULT_LOG_TAIL_CHARS
  });
  logs.push(formatCommandLog(`${packageManager} run build`, result.output));
}

function packageManagerCommand(packageManager: PackageManager): string {
  return packageManager === "npm" ? "npm" : "corepack";
}

function packageManagerInstallCommand(
  packageManager: PackageManager,
  hasLockfile: boolean
): [string, string[]] {
  if (packageManager === "npm") {
    return ["npm", [hasLockfile ? "ci" : "install"]];
  }

  if (packageManager === "pnpm") {
    return ["corepack", ["pnpm", "install", ...(hasLockfile ? ["--frozen-lockfile"] : [])]];
  }

  return ["corepack", ["yarn", "install", ...(hasLockfile ? ["--immutable"] : [])]];
}

async function createBuildPlan(projectRoot: string, suggestedProjectName: string): Promise<BuildPlan> {
  const resolvedConfig = await resolveWranglerConfig(projectRoot);
  if (resolvedConfig) {
    if (!resolvedConfig.config.main) {
      throw new CompatibilityRunnerError(
        "needs_adaptation",
        "This repository has a Wrangler config but no Worker entrypoint.",
        "CAIL Deploy currently expects a Worker script. Add a `main` entry to `wrangler.jsonc` or run `CAIL-init` to scaffold a compatible Worker app."
      );
    }

    const assetsDirectory = resolvedConfig.config.assets?.directory
      ? path.resolve(resolvedConfig.configDir, resolvedConfig.config.assets.directory)
      : undefined;

    return {
      workerName: suggestedProjectName,
      compatibilityDate: resolvedConfig.config.compatibility_date ?? DEFAULT_COMPATIBILITY_DATE,
      compatibilityFlags: normalizeStringArray(resolvedConfig.config.compatibility_flags),
      requestedBindings: extractRequestedBindings(resolvedConfig.config),
      observabilityEnabled: typeof resolvedConfig.config.observability?.enabled === "boolean"
        ? resolvedConfig.config.observability.enabled
        : undefined,
      assetsDirectory,
      assetsConfig: resolvedConfig.config.assets
        ? {
            ...(resolvedConfig.config.assets.html_handling
              ? { html_handling: resolvedConfig.config.assets.html_handling }
              : {}),
            ...(resolvedConfig.config.assets.not_found_handling
              ? { not_found_handling: resolvedConfig.config.assets.not_found_handling }
              : {}),
            ...(resolvedConfig.config.assets.run_worker_first !== undefined
              ? { run_worker_first: resolvedConfig.config.assets.run_worker_first }
              : {})
          }
        : undefined,
      wranglerArgs: ["deploy", "--dry-run", "--outdir"]
    };
  }

  const fallbackEntrypoint = await detectFallbackEntrypoint(projectRoot);
  if (!fallbackEntrypoint) {
    throw new CompatibilityRunnerError(
      "needs_adaptation",
      "This repository is missing the CAIL setup files needed for deployment.",
      "Run `CAIL-init` in the repository to add `AGENTS.md`, `wrangler.jsonc`, and a Worker entrypoint, or commit a valid Wrangler config manually."
    );
  }

  return {
    workerName: suggestedProjectName,
    compatibilityDate: DEFAULT_COMPATIBILITY_DATE,
    requestedBindings: [],
    wranglerArgs: [
      "deploy",
      fallbackEntrypoint,
      "--dry-run",
      "--outdir"
    ]
  };
}

async function assertProjectCompatibility(
  projectRoot: string,
  packageJson: ProjectPackageJson | undefined
): Promise<void> {
  const resolvedConfig = await resolveWranglerConfig(projectRoot);
  if (resolvedConfig?.config.main) {
    return;
  }

  if (resolvedConfig) {
    throw new CompatibilityRunnerError(
      "needs_adaptation",
      "This repository has a Wrangler config but no Worker entrypoint.",
      "CAIL Deploy currently expects a Worker script. Add a `main` entry to `wrangler.jsonc` or run `CAIL-init` to scaffold a compatible Worker app."
    );
  }

  const fallbackEntrypoint = await detectFallbackEntrypoint(projectRoot);
  if (fallbackEntrypoint) {
    return;
  }

  const pythonMarkers = await detectPythonMarkers(projectRoot);
  if (pythonMarkers.length > 0) {
    throw new CompatibilityRunnerError(
      "unsupported",
      "This repository looks like a Python project, which CAIL cannot deploy directly.",
      `CAIL Deploy currently hosts Cloudflare Worker apps written for the Workers runtime. Found Python markers: ${pythonMarkers.join(", ")}. Create a Worker-compatible frontend or port the server side to TypeScript/Hono before deploying.`
    );
  }

  const serverPackages = detectTraditionalNodeServerPackages(packageJson);
  if (serverPackages.length > 0) {
    throw new CompatibilityRunnerError(
      "needs_adaptation",
      "This repository looks like a traditional Node server app.",
      `CAIL Deploy runs Cloudflare Worker apps instead of long-running Node servers. Detected server packages: ${serverPackages.join(", ")}. Add a Worker-compatible adapter or start from \`CAIL-init\`.`
    );
  }

  throw new CompatibilityRunnerError(
    "needs_adaptation",
    "This repository is missing the CAIL setup files needed for deployment.",
    "Run `CAIL-init` in the repository to add `AGENTS.md`, `wrangler.jsonc`, and a Worker entrypoint, or commit a valid Wrangler config manually."
  );
}

async function resolveWranglerConfig(projectRoot: string): Promise<ResolvedWranglerConfig | null> {
  const redirectedConfigPath = await resolveRedirectedConfigPath(projectRoot);
  if (redirectedConfigPath) {
    return await loadWranglerConfig(redirectedConfigPath);
  }

  for (const candidate of ["wrangler.jsonc", "wrangler.json", "wrangler.toml"]) {
    const configPath = path.join(projectRoot, candidate);
    if (await exists(configPath)) {
      return await loadWranglerConfig(configPath);
    }
  }

  return null;
}

async function resolveRedirectedConfigPath(projectRoot: string): Promise<string | undefined> {
  const deployConfigPath = path.join(projectRoot, ".wrangler", "deploy", "config.json");
  if (!(await exists(deployConfigPath))) {
    return undefined;
  }

  const raw = await readFile(deployConfigPath, "utf8");
  const parsed = JSON.parse(raw) as { configPath?: string };
  if (!parsed.configPath) {
    return undefined;
  }

  return path.resolve(path.dirname(deployConfigPath), parsed.configPath);
}

async function loadWranglerConfig(configPath: string): Promise<ResolvedWranglerConfig> {
  const raw = await readFile(configPath, "utf8");
  let config: WranglerConfig;

  if (configPath.endsWith(".toml")) {
    config = parseToml(raw) as WranglerConfig;
  } else {
    config = parseJsonc(raw) as WranglerConfig;
  }

  return {
    configPath,
    configDir: path.dirname(configPath),
    config
  };
}

async function detectFallbackEntrypoint(projectRoot: string): Promise<string | null> {
  for (const candidate of FALLBACK_ENTRYPOINTS) {
    if (await exists(path.join(projectRoot, candidate))) {
      return candidate;
    }
  }

  return null;
}

async function runWranglerBundle(
  buildPlan: BuildPlan,
  projectRoot: string,
  bundleRoot: string,
  logs: string[]
): Promise<void> {
  const args = [...buildPlan.wranglerArgs, bundleRoot];
  const config = await resolveWranglerConfig(projectRoot);
  if (config) {
    args.push("--config", config.configPath);
  }
  args.push("--name", buildPlan.workerName, "--compatibility-date", buildPlan.compatibilityDate);
  for (const flag of buildPlan.compatibilityFlags ?? []) {
    args.push("--compatibility-flag", flag);
  }

  const result = await runCommand(process.execPath, [WRANGLER_CLI_PATH, ...args], projectRoot, {
    env: buildSandboxedChildEnv({ CI: "1" }),
    inheritProcessEnv: false,
    logLabel: "wrangler deploy --dry-run",
    logTailChars: DEFAULT_LOG_TAIL_CHARS
  });

  logs.push(formatCommandLog("wrangler deploy --dry-run", result.output));
}

async function prepareArtifact(
  projectRoot: string,
  bundleRoot: string,
  buildPlan: BuildPlan,
  packageJson: ProjectPackageJson | undefined
): Promise<PreparedArtifact> {
  const workerFiles = await collectWorkerFiles(bundleRoot);
  const mainModule = resolveMainModule(workerFiles);
  const staticAssets = await collectStaticAssets(
    projectRoot,
    buildPlan.workerName,
    buildPlan.assetsDirectory,
    buildPlan.assetsConfig
  );
  const allFiles = [
    ...workerFiles,
    ...(staticAssets?.files ? await loadStaticAssetFiles(projectRoot, buildPlan.assetsDirectory!, staticAssets) : [])
  ];

  const workerUpload: WorkerUploadMetadata = {
    main_module: mainModule,
    compatibility_date: buildPlan.compatibilityDate,
    ...(buildPlan.compatibilityFlags && buildPlan.compatibilityFlags.length > 0
      ? { compatibility_flags: buildPlan.compatibilityFlags }
      : {}),
    bindings: buildPlan.requestedBindings,
    ...(typeof buildPlan.observabilityEnabled === "boolean"
      ? { observability: { enabled: buildPlan.observabilityEnabled } }
      : {})
  };

  return {
    workerFiles,
    mainModule,
    description: packageJson?.description,
    staticAssets,
    allFiles,
    workerUpload
  };
}

async function collectWorkerFiles(bundleRoot: string): Promise<Array<{ name: string; file: File }>> {
  const files = await listFilesRecursive(bundleRoot);
  const filtered = files.filter((entry) => !IGNORE_FILES.has(entry.relative) && !entry.relative.endsWith(".map"));

  return await Promise.all(
    filtered.map(async (entry) => ({
      name: entry.relative,
      file: await fileFromPath(entry.absolute, mimeTypeForFile(entry.relative))
    }))
  );
}

function resolveMainModule(files: Array<{ name: string; file: File }>): string {
  if (files.some((entry) => entry.name === "index.js")) {
    return "index.js";
  }

  const rootJsFile = files.find((entry) => !entry.name.includes("/") && entry.name.endsWith(".js"));
  if (rootJsFile) {
    return rootJsFile.name;
  }

  throw new PermanentRunnerError("Wrangler bundle did not produce a root JavaScript entrypoint.");
}

function extractRequestedBindings(config: WranglerConfig): WorkerBinding[] {
  const bindings: WorkerBinding[] = [];

  for (const database of config.d1_databases ?? []) {
    if (!database.binding) {
      continue;
    }

    bindings.push({
      type: "d1",
      name: database.binding,
      id: database.database_id ?? database.preview_database_id ?? ""
    });
  }

  for (const namespace of config.kv_namespaces ?? []) {
    if (!namespace.binding) {
      continue;
    }

    bindings.push({
      type: "kv_namespace",
      name: namespace.binding,
      namespace_id: namespace.id ?? namespace.preview_id ?? ""
    });
  }

  for (const bucket of config.r2_buckets ?? []) {
    if (!bucket.binding) {
      continue;
    }

    bindings.push({
      type: "r2_bucket",
      name: bucket.binding,
      bucket_name: bucket.bucket_name ?? bucket.preview_bucket_name ?? ""
    });
  }

  if (config.ai?.binding) {
    bindings.push({
      type: "ai",
      name: config.ai.binding
    });
  }

  for (const index of config.vectorize ?? []) {
    if (!index.binding) {
      continue;
    }

    bindings.push({
      type: "vectorize",
      name: index.binding,
      index_name: index.index_name ?? ""
    });
  }

  for (const durableObject of config.durable_objects?.bindings ?? []) {
    if (!durableObject.name || !durableObject.class_name) {
      continue;
    }

    bindings.push({
      type: "durable_object_namespace",
      name: durableObject.name,
      class_name: durableObject.class_name,
      ...(durableObject.script_name ? { script_name: durableObject.script_name } : {})
    });
  }

  return dedupeBindingsByName(bindings);
}

function dedupeBindingsByName(bindings: WorkerBinding[]): WorkerBinding[] {
  const byName = new Map<string, WorkerBinding>();
  for (const binding of bindings) {
    byName.set(binding.name, binding);
  }
  return [...byName.values()];
}

async function collectStaticAssets(
  projectRoot: string,
  isolationKey: string,
  assetsDirectory: string | undefined,
  assetsConfig: WorkerAssetsConfig | undefined
): Promise<StaticAssetUpload | undefined> {
  if (!assetsDirectory) {
    return undefined;
  }

  if (!(await exists(assetsDirectory))) {
    throw new PermanentRunnerError(`Configured assets directory '${path.relative(projectRoot, assetsDirectory)}' does not exist after the build.`);
  }

  const descriptors = await listStaticAssetDescriptors(assetsDirectory);
  if (descriptors.length === 0) {
    return undefined;
  }

  return {
    ...(assetsConfig ? { config: assetsConfig } : {}),
    isolationKey,
    files: descriptors
  };
}

async function listStaticAssetDescriptors(assetsDirectory: string): Promise<StaticAssetUpload["files"]> {
  const matcher = await loadAssetsIgnoreMatcher(assetsDirectory);
  const files = await listFilesRecursive(assetsDirectory, matcher);

  return files.map((entry, index) => ({
    path: `/${entry.relative}`,
    partName: `asset-${index}`,
    ...(mimeTypeForFile(entry.relative) ? { contentType: mimeTypeForFile(entry.relative) } : {})
  }));
}

async function loadStaticAssetFiles(
  projectRoot: string,
  assetsDirectory: string,
  staticAssets: StaticAssetUpload
): Promise<Array<{ name: string; file: File }>> {
  const matcher = await loadAssetsIgnoreMatcher(assetsDirectory);
  const files = await listFilesRecursive(assetsDirectory, matcher);
  const byPath = new Map(files.map((entry) => [`/${entry.relative}`, entry.absolute]));

  return await Promise.all(
    staticAssets.files.map(async (descriptor: StaticAssetUpload["files"][number]) => {
      const absolutePath = byPath.get(descriptor.path);
      if (!absolutePath) {
        throw new PermanentRunnerError(
          `Static asset '${descriptor.path}' disappeared while preparing the deployment payload from '${path.relative(projectRoot, assetsDirectory)}'.`
        );
      }

      return {
        name: descriptor.partName,
        file: await fileFromPath(absolutePath, descriptor.contentType)
      };
    })
  );
}

async function loadAssetsIgnoreMatcher(assetsDirectory: string) {
  const matcher = ignore();
  matcher.add([".assetsignore"]);

  const ignorePath = path.join(assetsDirectory, ".assetsignore");
  if (await exists(ignorePath)) {
    matcher.add(await readFile(ignorePath, "utf8"));
  }

  return matcher;
}

async function listFilesRecursive(
  root: string,
  matcher?: ReturnType<typeof ignore>
): Promise<Array<{ absolute: string; relative: string }>> {
  const entries: Array<{ absolute: string; relative: string }> = [];

  async function walk(currentAbsolute: string): Promise<void> {
    const children = await readdir(currentAbsolute, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));

    for (const child of children) {
      const absolutePath = path.join(currentAbsolute, child.name);
      const relativePath = normalizeRelativePath(path.relative(root, absolutePath));
      if (matcher?.ignores(relativePath)) {
        continue;
      }

      if (child.isDirectory()) {
        await walk(absolutePath);
        continue;
      }

      if (child.isFile()) {
        entries.push({ absolute: absolutePath, relative: relativePath });
      }
    }
  }

  await walk(root);
  return entries;
}

async function fileFromPath(filePath: string, contentType: string | undefined): Promise<File> {
  const content = await readFile(filePath);
  return new File([content], path.basename(filePath), contentType ? { type: contentType } : undefined);
}

function mimeTypeForFile(filePath: string): string | undefined {
  const value = mime.lookup(filePath);
  return typeof value === "string" ? value : undefined;
}

async function postBuildSuccess(
  config: RunnerConfig,
  request: BuildRunnerJobRequest,
  artifact: PreparedArtifact
): Promise<void> {
  if (request.trigger.event === "validate") {
    const payload: BuildRunnerCompletePayload = {
      status: "success",
      runnerId: config.runnerId,
      completedAt: new Date().toISOString(),
      summary: "CAIL Validate built the Worker bundle successfully without deploying it."
    };

    const response = await fetch(request.callback.completeUrl, {
      method: "POST",
      headers: jsonHeaders(config),
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new RetryableRunnerError(`Success callback failed with status ${response.status}.`);
    }

    await response.json() as CompleteCallbackResponse;
    return;
  }

  const payload: BuildRunnerCompletePayload = {
    status: "success",
    runnerId: config.runnerId,
    completedAt: new Date().toISOString(),
    deployment: {
      projectName: request.deployment.suggestedProjectName,
      ...(artifact.description ? { description: artifact.description } : {}),
      workerUpload: artifact.workerUpload,
      ...(artifact.staticAssets ? { staticAssets: artifact.staticAssets } : {})
    }
  };

  const body = new FormData();
  body.append("result", JSON.stringify(payload));

  for (const entry of artifact.workerFiles) {
    body.append(entry.name, entry.file, entry.file.name || path.basename(entry.name));
  }

  if (artifact.staticAssets) {
    const staticAssetFiles = artifact.allFiles.filter((entry) =>
      artifact.staticAssets?.files.some((descriptor: StaticAssetUpload["files"][number]) => descriptor.partName === entry.name)
    );
    for (const entry of staticAssetFiles) {
      body.append(entry.name, entry.file, entry.file.name || path.basename(entry.name));
    }
  }

  const response = await fetch(request.callback.completeUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.buildRunnerToken}`
    },
    body
  });

  if (!response.ok) {
    throw new RetryableRunnerError(`Success callback failed with status ${response.status}.`);
  }

  await response.json() as CompleteCallbackResponse;
}

async function postBuildFailure(
  config: RunnerConfig,
  request: BuildRunnerJobRequest,
  error: unknown,
  logs: string[]
): Promise<void> {
  const message = errorMessage(error);
  const detail = error instanceof PermanentRunnerError ? error.detail : undefined;
  const compatibility = error instanceof CompatibilityRunnerError ? error : undefined;
  const payload: BuildRunnerCompletePayload = {
    status: "failure",
    runnerId: config.runnerId,
    completedAt: new Date().toISOString(),
    summary: compatibility?.summary ?? message,
    ...(detail || logs.length > 0
      ? {
          text: truncateLogTail(
            [compatibility?.detail ?? detail, ...logs].filter(Boolean).join("\n\n"),
            DEFAULT_LOG_TAIL_CHARS
          )
        }
      : {}),
    errorMessage: compatibility?.summary ?? message,
    failureKind: compatibility?.failureKind ?? "build_failure",
    checkRunConclusion: compatibility?.checkRunConclusion ?? "failure"
  };

  const response = await fetch(request.callback.completeUrl, {
    method: "POST",
    headers: jsonHeaders(config),
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new RetryableRunnerError(`Failure callback failed with status ${response.status}.`);
  }

  await response.json() as CompleteCallbackResponse;
}

function authHeaders(config: RunnerConfig): Record<string, string> {
  return {
    authorization: `Bearer ${config.buildRunnerToken}`
  };
}

function jsonHeaders(config: RunnerConfig): Record<string, string> {
  return {
    ...authHeaders(config),
    "content-type": "application/json"
  };
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  options: {
    env?: Record<string, string>;
    inheritProcessEnv?: boolean;
    logLabel: string;
    logTailChars: number;
  }
): Promise<LoggedCommandResult> {
  const child = spawn(command, args, {
    cwd,
    env: options.inheritProcessEnv === false
      ? options.env
      : {
          ...process.env,
          ...options.env
        },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let output = "";
  const append = (chunk: Buffer | string) => {
    output = truncateLogTail(output + chunk.toString(), options.logTailChars);
  };

  child.stdout?.on("data", append);
  child.stderr?.on("data", append);

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", (error) => reject(new RetryableRunnerError(`Failed to start ${options.logLabel}: ${error.message}`)));
    child.once("close", (code, signal) => {
      if (signal) {
        reject(new PermanentRunnerError(`${options.logLabel} was terminated by signal ${signal}.`, formatCommandLog(options.logLabel, output)));
        return;
      }
      resolve(code ?? 0);
    });
  });

  if (exitCode !== 0) {
    throw new PermanentRunnerError(
      `${options.logLabel} exited with status ${exitCode}.`,
      formatCommandLog(options.logLabel, output)
    );
  }

  return { output };
}

function buildSandboxedChildEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of SANDBOXED_CHILD_ENV_KEYS) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }

  return {
    ...env,
    ...extra
  };
}

function formatCommandLog(label: string, output: string): string {
  const trimmed = output.trim();
  return trimmed ? `$ ${label}\n${trimmed}` : `$ ${label}`;
}

function truncateLogTail(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  return value.slice(value.length - limit);
}

function normalizeStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined;
}

function detectTraditionalNodeServerPackages(packageJson: ProjectPackageJson | undefined): string[] {
  if (!packageJson) {
    return [];
  }

  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies
  };

  return Object.keys(dependencies ?? {}).filter((name) => TRADITIONAL_NODE_SERVER_PACKAGES.has(name));
}

async function detectPythonMarkers(projectRoot: string): Promise<string[]> {
  const matches: string[] = [];

  for (const marker of PYTHON_MARKER_FILES) {
    if (await exists(path.join(projectRoot, marker))) {
      matches.push(marker);
    }
  }

  return matches;
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RetryableRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableRunnerError";
  }
}

class PermanentRunnerError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
    this.name = "PermanentRunnerError";
  }
}

class CompatibilityRunnerError extends PermanentRunnerError {
  readonly checkRunConclusion: BuildRunnerCheckRunConclusion = "action_required";

  constructor(
    readonly failureKind: Extract<BuildRunnerFailureKind, "needs_adaptation" | "unsupported">,
    readonly summary: string,
    readonly detail: string
  ) {
    super(summary, detail);
    this.name = "CompatibilityRunnerError";
  }
}
