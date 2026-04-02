import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  HARNESS_IDS,
  HARNESS_PROMPT_PROFILES,
  buildHarnessSetupPrompts,
  type HarnessId,
  type HarnessPromptProfile,
  type HarnessSetupPrompt
} from "./harness-onboarding";
import {
  askedForKaleHandoff,
  askedForKaleToken
} from "./harness-onboarding-intent";

type CliOptions = {
  outDir: string;
  harnesses: HarnessId[];
  promptProfile: HarnessPromptProfile;
  serviceBaseUrl: string;
  timeoutMs: number;
  scenarioFile?: string;
};

type SpawnResult = {
  command: string;
  args: string[];
  cwd: string;
  timedOut: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  assistantOutput?: string;
  sessionId?: string;
  observedToolCalls?: string[];
  turns?: Array<{
    label: string;
    sessionId?: string;
    stdout: string;
    stderr: string;
    assistantOutput?: string;
    observedToolCalls?: string[];
    exitCode: number | null;
    timedOut: boolean;
  }>;
};

type BackupEntry = {
  sourcePath: string;
  backupPath: string;
  existed: boolean;
};

type PreparedHarness = {
  harnessId: HarnessId;
  strategy: "isolated_home" | "live_home_backup_restore";
  workspaceDir: string;
  homeDir?: string;
  env: NodeJS.ProcessEnv;
  authSeeded: boolean;
  kalePatToken?: string;
  notes: string[];
  cleanup: () => Promise<void>;
};

type HarnessResult = {
  harnessId: HarnessId;
  harnessName: string;
  strategy: PreparedHarness["strategy"];
  workspaceDir: string;
  homeDir?: string;
  promptPath: string;
  runResultPath: string;
  postflightPath: string;
  cleanupApplied: string[];
  authSeeded: boolean;
  notes: string[];
  observed: {
    mcpConfigured: boolean;
    pluginInstalled: boolean;
    askedForHumanHandoff: boolean;
    mentionedVerification: boolean;
    skillAcquired: boolean;
    skillObserved: boolean;
  };
  outcome: string;
  summary: string;
};

type PromptOverrideFile = {
  name?: string;
  claude?: string;
  codex?: string;
  gemini?: string;
};

type ClaudeInitState = {
  plugins: string[];
  skills: string[];
  slashCommands: string[];
};

const DEFAULT_SERVICE_BASE_URL = "https://cuny.qzz.io/kale";
const KALE_PLUGIN_PACKAGE = "kale-deploy@cuny-ai-lab";
const LEGACY_PLUGIN_PACKAGE = "cail-deploy@cuny-ai-lab";
const KALE_SERVER_NAMES = ["kale", "cail"] as const;
const KALE_PLUGIN_NAMES = ["kale-deploy", "cail-deploy"] as const;
const KALE_SKILL_NAMES = ["kale-deploy", "kale-connect", "cail-deploy"] as const;

const HELP_TEXT = `Internal harness onboarding lab for Kale Deploy.

Usage:
  npm run harness:onboarding -- [options]

Options:
  --harness <ids>         Comma-separated subset of: claude,codex,gemini
  --prompt-profile <id>   Prompt profile: current or skill-first. Default: current
  --out-dir <path>        Output directory. Default: tmp/harness-onboarding/<timestamp>
  --service-base-url <u>  Kale front door. Default: https://cuny.qzz.io/kale
  --timeout-ms <n>        Per-harness timeout in milliseconds. Default: 120000
  --scenario-file <path>  JSON prompt overrides for alternative onboarding directions
  --help                  Show this help
`;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    return;
  }

  const runRoot = path.resolve(options.outDir);
  await fs.mkdir(runRoot, { recursive: true });

  const prompts = await loadPrompts(options);
  const promptById = new Map(prompts.map((prompt) => [prompt.id, prompt]));
  const summary: HarnessResult[] = [];

  for (const harnessId of options.harnesses) {
    const prompt = promptById.get(harnessId);
    if (!prompt) {
      throw new Error(`Missing prompt for harness ${harnessId}.`);
    }

    const result = await runHarness({
      harnessId,
      prompt,
      runRoot,
      serviceBaseUrl: options.serviceBaseUrl,
      timeoutMs: options.timeoutMs,
      promptProfile: options.promptProfile
    });
    summary.push(result);
  }

  const summaryPath = path.join(runRoot, "summary.json");
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
  const markdownPath = path.join(runRoot, "summary.md");
  await fs.writeFile(markdownPath, renderSummaryMarkdown(summary));

  process.stdout.write(`Harness onboarding run complete.\n`);
  process.stdout.write(`Summary JSON: ${summaryPath}\n`);
  process.stdout.write(`Summary Markdown: ${markdownPath}\n`);
  for (const result of summary) {
    process.stdout.write(`${result.harnessName}: ${result.outcome} - ${result.summary}\n`);
  }
}

function parseArgs(argv: string[]): CliOptions | undefined {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const options: CliOptions = {
    outDir: path.join("tmp", "harness-onboarding", timestamp),
    harnesses: [...HARNESS_IDS],
    promptProfile: "current",
    serviceBaseUrl: DEFAULT_SERVICE_BASE_URL,
    timeoutMs: 120_000
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      process.stdout.write(HELP_TEXT);
      return undefined;
    }
    if (arg === "--harness") {
      const raw = argv[index + 1];
      if (!raw) {
        throw new Error("--harness requires a value.");
      }
      const harnesses = raw.split(",").map((value) => value.trim()).filter(Boolean);
      if (harnesses.length === 0 || harnesses.some((value) => !HARNESS_IDS.includes(value as HarnessId))) {
        throw new Error(`--harness must contain only: ${HARNESS_IDS.join(", ")}`);
      }
      options.harnesses = harnesses as HarnessId[];
      index += 1;
      continue;
    }
    if (arg === "--out-dir") {
      const raw = argv[index + 1];
      if (!raw) {
        throw new Error("--out-dir requires a value.");
      }
      options.outDir = raw;
      index += 1;
      continue;
    }
    if (arg === "--prompt-profile") {
      const raw = argv[index + 1];
      if (!raw || !HARNESS_PROMPT_PROFILES.includes(raw as HarnessPromptProfile)) {
        throw new Error(`--prompt-profile must be one of: ${HARNESS_PROMPT_PROFILES.join(", ")}`);
      }
      options.promptProfile = raw as HarnessPromptProfile;
      index += 1;
      continue;
    }
    if (arg === "--service-base-url") {
      const raw = argv[index + 1];
      if (!raw) {
        throw new Error("--service-base-url requires a value.");
      }
      options.serviceBaseUrl = raw;
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      const raw = argv[index + 1];
      const timeoutMs = Number(raw);
      if (!raw || Number.isNaN(timeoutMs) || timeoutMs <= 0) {
        throw new Error("--timeout-ms requires a positive number.");
      }
      options.timeoutMs = timeoutMs;
      index += 1;
      continue;
    }
    if (arg === "--scenario-file") {
      const raw = argv[index + 1];
      if (!raw) {
        throw new Error("--scenario-file requires a value.");
      }
      options.scenarioFile = raw;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

async function loadPrompts(options: CliOptions): Promise<HarnessSetupPrompt[]> {
  const mcpEndpoint = `${options.serviceBaseUrl.replace(/\/$/, "")}/mcp`;
  const prompts = buildHarnessSetupPrompts(options.promptProfile, {
    marketingName: "Kale Deploy",
    serviceBaseUrl: options.serviceBaseUrl,
    mcpEndpoint
  });

  if (!options.scenarioFile) {
    return prompts;
  }

  const raw = await fs.readFile(path.resolve(options.scenarioFile), "utf8");
  const overrides = JSON.parse(raw) as PromptOverrideFile;
  return prompts.map((prompt) => ({
    ...prompt,
    prompt: overrides[prompt.id] ?? prompt.prompt
  }));
}

async function runHarness(input: {
  harnessId: HarnessId;
  prompt: HarnessSetupPrompt;
  runRoot: string;
  serviceBaseUrl: string;
  timeoutMs: number;
  promptProfile: HarnessPromptProfile;
}): Promise<HarnessResult> {
  const harnessRoot = path.join(input.runRoot, input.harnessId);
  const logDir = path.join(harnessRoot, "logs");
  await fs.mkdir(logDir, { recursive: true });
  const promptPath = path.join(harnessRoot, "prompt.txt");

  let prepared: PreparedHarness | undefined;
  try {
    prepared = await prepareHarness({
      harnessId: input.harnessId,
      harnessRoot
    });
    const effectivePrompt = applyAutomationAuthPrompt({
      harnessId: input.harnessId,
      prompt: input.prompt.prompt,
      kalePatToken: prepared.kalePatToken,
      serviceBaseUrl: input.serviceBaseUrl
    });
    await fs.writeFile(promptPath, effectivePrompt);

    const runResult = await runPrompt({
      harnessId: input.harnessId,
      prompt: effectivePrompt,
      prepared,
      logDir,
      timeoutMs: input.timeoutMs
    });
    if (!runResult.assistantOutput) {
      runResult.assistantOutput = runResult.stdout.trim();
    }
    const runResultPath = path.join(harnessRoot, "run-result.json");
    await fs.writeFile(runResultPath, JSON.stringify(runResult, null, 2));

    const postflight = await collectPostflight(input.harnessId, prepared);
    const postflightPath = path.join(harnessRoot, "postflight.json");
    await fs.writeFile(postflightPath, JSON.stringify(postflight, null, 2));

    const observed = summarizeObservedState(input.harnessId, runResult, postflight);
    const outcome = classifyOutcome(runResult, observed);
    const summary = summarizeOutcome(input.prompt.name, outcome, observed);

    return {
      harnessId: input.harnessId,
      harnessName: input.prompt.name,
      strategy: prepared.strategy,
      workspaceDir: prepared.workspaceDir,
      homeDir: prepared.homeDir,
      promptPath,
      runResultPath,
      postflightPath,
      cleanupApplied: prepared.notes,
      authSeeded: prepared.authSeeded,
      notes: prepared.notes,
      observed,
      outcome,
      summary
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failurePath = path.join(harnessRoot, "runner-error.txt");
    await fs.writeFile(failurePath, message);
    return {
      harnessId: input.harnessId,
      harnessName: input.prompt.name,
      strategy: prepared?.strategy ?? "isolated_home",
      workspaceDir: prepared?.workspaceDir ?? "",
      homeDir: prepared?.homeDir,
      promptPath,
      runResultPath: failurePath,
      postflightPath: "",
      cleanupApplied: prepared?.notes ?? [],
      authSeeded: prepared?.authSeeded ?? false,
      notes: prepared?.notes ?? [],
      observed: {
        mcpConfigured: false,
        pluginInstalled: false,
        askedForHumanHandoff: false,
        mentionedVerification: false,
        skillAcquired: false,
        skillObserved: false
      },
      outcome: "runner_error",
      summary: message
    };
  } finally {
    if (prepared) {
      await prepared.cleanup();
    }
  }
}

async function prepareHarness(input: {
  harnessId: HarnessId;
  harnessRoot: string;
}): Promise<PreparedHarness> {
  const workspaceDir = path.join(input.harnessRoot, "workspace");
  await fs.mkdir(workspaceDir, { recursive: true });
  const kalePatToken = process.env.KALE_TEST_PAT ?? await readClaudeCailPatToken();

  if (input.harnessId === "codex") {
    const homeDir = path.join(input.harnessRoot, "home");
    await fs.mkdir(path.join(homeDir, ".codex"), { recursive: true });
    const authSeeded = await copyIfExists(
      path.join(currentHome(), ".codex", "auth.json"),
      path.join(homeDir, ".codex", "auth.json")
    );
    await seedCodexKaleSkills(homeDir);
    const env = isolatedEnv(homeDir);
    const notes = [
      authSeeded ? "Seeded ~/.codex/auth.json into isolated home." : "Missing ~/.codex/auth.json; Codex may not be able to run.",
      "Preinstalled the Kale Deploy Codex skills into the isolated home before the run.",
      kalePatToken
        ? "Found a live Kale PAT for automated full-process Codex testing."
        : "No live Kale PAT was available, so Codex full-process testing may stop at the browser or token handoff."
    ];
    return {
      harnessId: input.harnessId,
      strategy: "isolated_home",
      workspaceDir,
      homeDir,
      env,
      authSeeded,
      kalePatToken,
      notes,
      cleanup: async () => {}
    };
  }

  if (input.harnessId === "gemini") {
    const homeDir = path.join(input.harnessRoot, "home");
    await fs.mkdir(path.join(homeDir, ".gemini"), { recursive: true });
    const copied: string[] = [];
    for (const fileName of [
      "oauth_creds.json",
      "google_accounts.json",
      "installation_id",
      "projects.json",
      "state.json",
      "trustedFolders.json",
      "mcp-oauth-tokens.json",
      "settings.json"
    ]) {
      const copiedFile = await copyIfExists(
        path.join(currentHome(), ".gemini", fileName),
        path.join(homeDir, ".gemini", fileName)
      );
      if (copiedFile) {
        copied.push(fileName);
      }
    }
    if (!copied.includes("settings.json")) {
      const settingsPath = path.join(homeDir, ".gemini", "settings.json");
      await fs.writeFile(settingsPath, JSON.stringify({
        security: {
          auth: {
            selectedType: "oauth-personal"
          }
        }
      }, null, 2));
      copied.push("settings.json (synthetic oauth-personal default)");
    }
    await seedGeminiKaleSkills(workspaceDir);
    await ensureGeminiProjectMcpConfig(workspaceDir);
    const env = isolatedEnv(homeDir);
    const authSeeded = copied.some((entry) => entry.startsWith("oauth_creds.json") || entry.startsWith("google_accounts.json"));
    const notes = [
      copied.length > 0
        ? `Seeded isolated Gemini home with: ${copied.join(", ")}.`
        : "No Gemini auth files were available to seed into the isolated home.",
      "Preinstalled the Kale Deploy Gemini skills and ensured project .gemini/settings.json declares the Kale MCP server before the run.",
      kalePatToken
        ? "Found a live Kale PAT for automated full-process Gemini testing."
        : "No live Kale PAT was available, so Gemini full-process testing may stop at the browser or token handoff."
    ];
    return {
      harnessId: input.harnessId,
      strategy: "isolated_home",
      workspaceDir,
      homeDir,
      env,
      authSeeded,
      kalePatToken,
      notes,
      cleanup: async () => {}
    };
  }

  const backupsRoot = path.join(input.harnessRoot, "backups");
  await fs.mkdir(backupsRoot, { recursive: true });
  const pluginStateBefore = await runCommand({
    command: "claude",
    args: ["plugins", "list"],
    cwd: workspaceDir,
    env: process.env,
    timeoutMs: 30_000
  });
  const pluginStateText = flattenOutput(pluginStateBefore);
  const hadInstalledKalePlugin = new RegExp(KALE_PLUGIN_PACKAGE).test(pluginStateText);
  const hadEnabledKalePlugin = new RegExp(`${KALE_PLUGIN_PACKAGE}[\\s\\S]*Status:\\s*✔ enabled`).test(pluginStateText);
  const hadInstalledLegacyPlugin = new RegExp(LEGACY_PLUGIN_PACKAGE).test(pluginStateText);
  const hadEnabledLegacyPlugin = new RegExp(`${LEGACY_PLUGIN_PACKAGE}[\\s\\S]*Status:\\s*✔ enabled`).test(pluginStateText);
  const backups = await Promise.all([
    backupPath(path.join(currentHome(), ".claude.json"), path.join(backupsRoot, ".claude.json")),
    backupPath(path.join(currentHome(), ".claude", "plugins"), path.join(backupsRoot, "plugins"))
  ]);
  const notes: string[] = ["Backed up live Claude config and plugins for restore after the run."];
  notes.push(kalePatToken
    ? "Found a live Kale PAT for automated full-process Claude testing."
    : "No live Kale PAT was available, so Claude full-process testing may stop at the token handoff.");

  for (const serverName of KALE_SERVER_NAMES) {
    await runCommand({
      command: "claude",
      args: ["mcp", "remove", serverName, "-s", "local"],
      cwd: workspaceDir,
      env: process.env,
      timeoutMs: 30_000
    });
    await runCommand({
      command: "claude",
      args: ["mcp", "remove", serverName, "-s", "user"],
      cwd: workspaceDir,
      env: process.env,
      timeoutMs: 30_000
    });
  }
  notes.push("Removed existing Claude Kale MCP entries from local and user scopes before the run.");

  for (const pluginPackage of [KALE_PLUGIN_PACKAGE, LEGACY_PLUGIN_PACKAGE]) {
    await uninstallClaudePluginEverywhere(workspaceDir, process.env, pluginPackage);
  }
  notes.push("Uninstalled existing Claude Kale plugin packages before the run.");

  await installClaudeKalePlugin(workspaceDir, process.env);
  notes.push("Preinstalled the Kale Deploy Claude plugin before the run.");
  await ensureClaudeKalePluginReady(workspaceDir, process.env);
  notes.push("Verified that the Kale Deploy Claude plugin loads in a headless Claude session before the run.");

  return {
    harnessId: input.harnessId,
    strategy: "live_home_backup_restore",
    workspaceDir,
    env: process.env,
    authSeeded: true,
    kalePatToken,
    notes,
    cleanup: async () => {
      await Promise.all(backups.map(restoreBackup));
      if (hadInstalledKalePlugin && hadEnabledKalePlugin) {
        await runCommand({
          command: "claude",
          args: ["plugins", "enable", KALE_PLUGIN_PACKAGE],
          cwd: workspaceDir,
          env: process.env,
          timeoutMs: 30_000
        });
      }
      if (hadInstalledLegacyPlugin && hadEnabledLegacyPlugin) {
        await runCommand({
          command: "claude",
          args: ["plugins", "enable", LEGACY_PLUGIN_PACKAGE],
          cwd: workspaceDir,
          env: process.env,
          timeoutMs: 30_000
        });
      }
    }
  };
}

async function runPrompt(input: {
  harnessId: HarnessId;
  prompt: string;
  prepared: PreparedHarness;
  logDir: string;
  timeoutMs: number;
}): Promise<SpawnResult> {
  if (input.harnessId === "codex") {
    return runCodexPromptFlow(input);
  }

  if (input.harnessId === "claude") {
    return runClaudePromptFlow(input);
  }

  return runGeminiPromptFlow(input);
}

async function collectPostflight(harnessId: HarnessId, prepared: PreparedHarness): Promise<Record<string, string>> {
  if (harnessId === "codex") {
    const mcpList = await runCommand({
      command: "codex",
      args: ["mcp", "list"],
      cwd: prepared.workspaceDir,
      env: prepared.env,
      timeoutMs: 30_000
    });
    const skillPath = await firstExistingPath(KALE_SKILL_NAMES.map((skillName) => path.join(prepared.homeDir ?? currentHome(), ".codex", "skills", skillName, "SKILL.md")));
    return {
      mcpList: flattenOutput(mcpList),
      skillPath: skillPath ?? ""
    };
  }

  if (harnessId === "claude") {
    const [mcpList, pluginsList] = await Promise.all([
      runCommand({
        command: "claude",
        args: ["mcp", "list"],
        cwd: prepared.workspaceDir,
        env: prepared.env,
        timeoutMs: 30_000
      }),
      runCommand({
        command: "claude",
        args: ["plugins", "list"],
        cwd: prepared.workspaceDir,
        env: prepared.env,
        timeoutMs: 30_000
      })
    ]);
    return {
      mcpList: flattenOutput(mcpList),
      pluginsList: flattenOutput(pluginsList)
    };
  }

  const mcpList = await runCommand({
    command: "gemini",
    args: ["mcp", "list"],
    cwd: prepared.workspaceDir,
    env: prepared.env,
    timeoutMs: 30_000
  });
  const extensionsList = await runCommand({
    command: "gemini",
    args: ["extensions", "list"],
    cwd: prepared.workspaceDir,
    env: prepared.env,
    timeoutMs: 30_000
  });
  const candidateSkillPaths = KALE_SKILL_NAMES.flatMap((skillName) => [
    path.join(prepared.workspaceDir, ".gemini", "skills", skillName, "SKILL.md"),
    path.join(prepared.homeDir ?? currentHome(), ".gemini", "skills", skillName, "SKILL.md"),
    path.join(prepared.homeDir ?? currentHome(), ".gemini", "extensions", skillName, "skills", "kale-deploy", "SKILL.md")
  ]);
  return {
    mcpList: flattenOutput(mcpList),
    extensionsList: flattenOutput(extensionsList),
    skillPath: await firstExistingPath(candidateSkillPaths) ?? ""
  };
}

function summarizeObservedState(
  harnessId: HarnessId,
  runResult: SpawnResult,
  postflight: Record<string, string>
): HarnessResult["observed"] {
  const assistantText = (runResult.assistantOutput ?? "").toLowerCase();
  const rawText = `${runResult.stdout}\n${runResult.stderr}`.toLowerCase();
  const postflightText = Object.values(postflight).join("\n").toLowerCase();
  const observedToolCallsText = (runResult.observedToolCalls ?? []).join("\n").toLowerCase();
  const kaleServerListed = /(^|\n)\s*[✓✗]?\s*(kale|cail)(\s|:)/.test(postflightText)
    || /(kale|cail)\s+https:\/\/cuny\.qzz\.io\/kale\/mcp/.test(postflightText)
    || /(kale|cail):\s+https:\/\/cuny\.qzz\.io\/kale\/mcp/.test(postflightText);
  const kaleServerDisconnected = /(^|\n)\s*[✗x]\s*(kale|cail):.*disconnected/im.test(postflightText)
    || /(kale|cail).*disconnected/.test(postflightText)
    || /(kale|cail).*failed to connect/.test(postflightText)
    || /(kale|cail).*requires authentication/.test(postflightText)
    || /(kale|cail).*not logged in/.test(postflightText)
    || /\bauth\s+oauth\b/.test(postflightText);
  const skillAcquired = harnessId === "claude"
    ? /(kale-deploy|cail-deploy)@cuny-ai-lab/.test(postflightText)
    : Boolean(postflight.skillPath) || /(kale-deploy|cail-deploy)/.test(postflightText);
  const skillObserved = skillAcquired
    || assistantText.includes("kale-deploy")
    || rawText.includes("kale-deploy")
    || assistantText.includes("cail-deploy")
    || rawText.includes("cail-deploy")
    || rawText.includes("skill-installer")
    || rawText.includes("gemini skills install")
    || rawText.includes("gemini skills link")
    || rawText.includes("claude plugins install")
    || rawText.includes("claude plugins marketplace add");
  return {
    mcpConfigured: kaleServerListed && !kaleServerDisconnected,
    pluginInstalled: /(kale-deploy|cail-deploy)@cuny-ai-lab/.test(postflightText),
    askedForHumanHandoff: askedForKaleHandoff(assistantText)
      || askedForKaleHandoff(rawText)
      || rawText.includes("[mcp info] mcp server 'kale' requires authentication")
      || rawText.includes("[mcp info] mcp server 'cail' requires authentication"),
    mentionedVerification: hasVerificationEvidence(assistantText, observedToolCallsText, rawText)
      || (rawText.includes("mcp__kale__test_connection") && rawText.includes("mcp__kale__register_project"))
      || (rawText.includes("mcp__cail__test_connection") && rawText.includes("mcp__cail__register_project")),
    skillAcquired,
    skillObserved
  };
}

function classifyOutcome(
  runResult: SpawnResult,
  observed: HarnessResult["observed"]
): string {
  const text = `${runResult.stdout}\n${runResult.stderr}`;
  if (observed.mcpConfigured && observed.mentionedVerification) {
    return "configured_and_verified";
  }
  if (observed.mcpConfigured) {
    return "configured_but_not_verified";
  }
  if (observed.askedForHumanHandoff) {
    return "awaiting_human_handoff";
  }
  if (runResult.timedOut) {
    return "timed_out";
  }
  if (/Please set an Auth method/i.test(text) || /Please run codex login/i.test(text)) {
    return "harness_auth_missing";
  }
  if (runResult.exitCode === 0) {
    return "completed_without_observable_setup";
  }
  return "failed";
}

function summarizeOutcome(
  harnessName: string,
  outcome: string,
  observed: HarnessResult["observed"]
): string {
  if (outcome === "configured_and_verified") {
    return `${harnessName} configured Kale and verified the required Kale tools.`;
  }
  if (outcome === "configured_but_not_verified") {
    return `${harnessName} configured Kale, but the output did not clearly show the required verification step.`;
  }
  if (outcome === "awaiting_human_handoff") {
    return `${harnessName} asked for the expected browser or token handoff.`;
  }
  if (outcome === "harness_auth_missing") {
    return `${harnessName} could not run from the fresh state because its own CLI login was missing.`;
  }
  if (outcome === "timed_out") {
    if (observed.mcpConfigured || observed.askedForHumanHandoff) {
      return `${harnessName} made onboarding progress but did not finish within the timeout.`;
    }
    return `${harnessName} did not finish within the timeout.`;
  }
  if (outcome === "completed_without_observable_setup") {
    return `${harnessName} exited cleanly, but Kale setup was not observable in harness state.`;
  }
  const details = [];
  if (!observed.mcpConfigured) {
    details.push("no kale MCP server observed");
  }
  if (!observed.pluginInstalled) {
    details.push("no kale plugin observed");
  }
  if (!observed.skillAcquired) {
    details.push("no installed kale add-on observed");
  }
  return `${harnessName} failed the onboarding test (${details.join(", ") || "no observable progress"}).`;
}

async function runCommand(input: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  stdinText?: string;
}): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const terminateChildTree = (signal: NodeJS.Signals): void => {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall back to direct child kill when process-group signaling is unavailable.
        }
      }
      child.kill(signal);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateChildTree("SIGTERM");
      setTimeout(() => terminateChildTree("SIGKILL"), 5_000).unref();
    }, input.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdin.setDefaultEncoding("utf8");
    if (input.stdinText) {
      child.stdin.write(input.stdinText);
    }
    child.stdin.end();
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        timedOut,
        exitCode,
        signal,
        stdout,
        stderr
      });
    });
  });
}

async function runCodexPromptFlow(input: {
  harnessId: HarnessId;
  prompt: string;
  prepared: PreparedHarness;
  logDir: string;
  timeoutMs: number;
}): Promise<SpawnResult> {
  const turns: NonNullable<SpawnResult["turns"]> = [];
  const redactSecrets = input.prepared.kalePatToken ? [input.prepared.kalePatToken] : [];
  const initialTurn = await runCodexJsonTurn({
    label: "initial",
    cwd: input.prepared.workspaceDir,
    env: input.prepared.env,
    logDir: input.logDir,
    timeoutMs: input.timeoutMs,
    prompt: input.prompt,
    redactSecrets
  });
  turns.push(initialTurn);

  let assistantOutputs = [initialTurn.assistantOutput ?? ""];
  let stdoutParts = [initialTurn.stdout];
  let stderrParts = [initialTurn.stderr];
  let finalTurn = initialTurn;
  let verificationAlreadyObserved = turnMentionsVerification(initialTurn);

  const initialMcpList = await captureMcpListSnapshot({
    harnessId: "codex",
    cwd: input.prepared.workspaceDir,
    env: input.prepared.env,
    logDir: input.logDir,
    label: "initial-postflight",
    timeoutMs: 30_000
  });
  const initialHasBearerToken = codexMcpListHasBearerToken(initialMcpList);

  if (!verificationAlreadyObserved && input.prepared.kalePatToken && !initialHasBearerToken) {
    const tokenTurnEnv = withKalePatEnv(input.prepared.env, input.prepared.kalePatToken);
    const tokenTurn = await runCodexJsonTurn({
      label: "token",
      cwd: input.prepared.workspaceDir,
      env: tokenTurnEnv,
      logDir: input.logDir,
      timeoutMs: input.timeoutMs,
      prompt: buildCodexTokenReply(),
      resumeSessionId: initialTurn.sessionId,
      redactSecrets
    });
    turns.push(tokenTurn);
    assistantOutputs.push(tokenTurn.assistantOutput ?? "");
    stdoutParts.push(tokenTurn.stdout);
    stderrParts.push(tokenTurn.stderr);
    finalTurn = tokenTurn;
    verificationAlreadyObserved = verificationAlreadyObserved || turnMentionsVerification(tokenTurn);
  }

  const shouldVerify = verificationAlreadyObserved || initialHasBearerToken || turns.some((turn) => turn.label === "token");
  if (!verificationAlreadyObserved && shouldVerify) {
    const verificationTurn = await runCodexJsonTurn({
      label: "verify",
      cwd: input.prepared.workspaceDir,
      env: withKalePatEnv(input.prepared.env, input.prepared.kalePatToken),
      logDir: input.logDir,
      timeoutMs: input.timeoutMs,
      prompt: buildCodexVerificationPrompt(),
      redactSecrets
    });
    turns.push(verificationTurn);
    assistantOutputs.push(verificationTurn.assistantOutput ?? "");
    stdoutParts.push(verificationTurn.stdout);
    stderrParts.push(verificationTurn.stderr);
    finalTurn = verificationTurn;
  }

  return {
    command: "codex",
    args: ["multi-turn-orchestration"],
    cwd: input.prepared.workspaceDir,
    timedOut: turns.some((turn) => turn.timedOut),
    exitCode: finalTurn.exitCode,
    signal: null,
    stdout: stdoutParts.filter(Boolean).join("\n"),
    stderr: stderrParts.filter(Boolean).join("\n"),
    assistantOutput: assistantOutputs.filter(Boolean).join("\n"),
    sessionId: finalTurn.sessionId,
    observedToolCalls: turns.flatMap((turn) => turn.observedToolCalls ?? []),
    turns
  };
}

async function runCodexJsonTurn(input: {
  label: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logDir: string;
  timeoutMs: number;
  prompt: string;
  resumeSessionId?: string;
  redactSecrets?: string[];
}): Promise<NonNullable<SpawnResult["turns"]>[number]> {
  const result = await runCommand({
    command: "codex",
    args: input.resumeSessionId
      ? [
        "exec",
        "resume",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        input.resumeSessionId,
        "-"
      ]
      : [
        "exec",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "-"
      ],
    cwd: input.cwd,
    env: input.env,
    timeoutMs: input.timeoutMs,
    stdinText: input.prompt
  });
  const stdout = redactSecretValues(result.stdout, input.redactSecrets);
  const stderr = redactSecretValues(result.stderr, input.redactSecrets);
  await fs.writeFile(path.join(input.logDir, `${input.label}.jsonl`), stdout);
  if (stderr.trim()) {
    await fs.writeFile(path.join(input.logDir, `${input.label}.stderr.txt`), stderr);
  }

  const parsed = parseCodexJsonResult(stdout);
  return {
    label: input.label,
    sessionId: parsed.sessionId,
    stdout,
    stderr,
    assistantOutput: parsed.resultText,
    observedToolCalls: parsed.toolCalls,
    exitCode: result.exitCode,
    timedOut: result.timedOut
  };
}

function parseCodexJsonResult(stdout: string): { sessionId?: string; resultText: string; toolCalls: string[] } {
  const assistantMessages: string[] = [];
  const toolCalls = new Set<string>();
  let sessionId: string | undefined;

  for (const line of stdout.split("\n").map((value) => value.trim()).filter(Boolean)) {
    try {
      const event = JSON.parse(line) as {
        type?: string;
        thread_id?: string;
        item?: {
          type?: string;
          text?: string;
          tool?: string;
          command?: string;
        };
      };
      if (event.type === "thread.started" && event.thread_id) {
        sessionId = event.thread_id;
      }
      const item = event.item;
      if (item?.type === "agent_message" && typeof item.text === "string") {
        assistantMessages.push(item.text);
      }
      if (item?.type === "mcp_tool_call" && item.tool) {
        toolCalls.add(item.tool);
      }
      if (item?.type === "command_execution" && item.command) {
        toolCalls.add(item.command);
      }
    } catch {
      continue;
    }
  }

  return {
    sessionId,
    resultText: assistantMessages.join("\n"),
    toolCalls: Array.from(toolCalls)
  };
}

function codexMcpListHasBearerToken(text: string): boolean {
  return /^\s*(kale|cail)\b.*\bbearer token\b/im.test(text);
}

function buildCodexTokenReply(): string {
  return [
    "The browser flow is not available in this harness.",
    "I visited https://cuny.qzz.io/kale/connect and generated a Kale token.",
    "The token is available in environment variable KALE_TEST_PAT. Do not print it or echo it back.",
    "Continue onboarding in this Codex environment.",
    "If kale was already added without token auth, remove it and re-add it with:",
    "codex mcp add kale --url https://cuny.qzz.io/kale/mcp --bearer-token-env-var KALE_TEST_PAT",
    "Stop once configuration is complete and say whether a fresh Codex session is needed before Kale tools appear."
  ].join("\n");
}

function applyAutomationAuthPrompt(input: {
  harnessId: HarnessId;
  prompt: string;
  kalePatToken?: string;
  serviceBaseUrl: string;
}): string {
  if (!input.kalePatToken) {
    return input.prompt;
  }

  const mcpEndpoint = `${input.serviceBaseUrl.replace(/\/$/, "")}/mcp`;
  const tokenNote = "Automation note: a Kale token is already available in environment variable KALE_TEST_PAT. Do not print it or echo it back.";

  if (input.harnessId === "codex") {
    return [
      input.prompt,
      tokenNote,
      "Do not start an interactive browser login flow and do not run `codex mcp login kale` in this automation harness.",
      "If Kale authentication is needed, use the bearer-token MCP path instead.",
      "If kale is already configured without token auth, remove it first and then re-add it.",
      `Use: codex mcp add kale --url ${mcpEndpoint} --bearer-token-env-var KALE_TEST_PAT`
    ].join("\n\n");
  }

  if (input.harnessId === "claude") {
    return [
      input.prompt,
      tokenNote,
      "Do not wait for a browser handoff in this automation harness.",
      "If Kale authentication is needed, use the token-header fallback instead of asking for human help.",
      `Use: claude mcp add --transport http --header "Authorization: Bearer $KALE_TEST_PAT" -s local kale ${mcpEndpoint}`
    ].join("\n\n");
  }

  return [
    input.prompt,
    tokenNote,
    "Do not wait for a browser handoff in this automation harness.",
    "If Kale authentication is needed, use the token-header MCP path instead of asking for human help.",
    `Use: gemini mcp add --transport http --scope project kale ${mcpEndpoint} -H "Authorization: Bearer $KALE_TEST_PAT"`
  ].join("\n\n");
}

function buildCodexVerificationPrompt(): string {
  return [
    "Use Kale Deploy tools in this environment.",
    "Call test_connection.",
    "Confirm that register_project is available.",
    "Keep the answer short and include the exact strings test_connection and register_project."
  ].join(" ");
}

async function runGeminiPromptFlow(input: {
  harnessId: HarnessId;
  prompt: string;
  prepared: PreparedHarness;
  logDir: string;
  timeoutMs: number;
}): Promise<SpawnResult> {
  const turns: NonNullable<SpawnResult["turns"]> = [];
  const redactSecrets = input.prepared.kalePatToken ? [input.prepared.kalePatToken] : [];
  const initialTurn = await runGeminiStreamTurn({
    label: "initial",
    cwd: input.prepared.workspaceDir,
    env: input.prepared.env,
    logDir: input.logDir,
    timeoutMs: input.timeoutMs,
    prompt: input.prompt,
    redactSecrets
  });
  turns.push(initialTurn);

  let assistantOutputs = [initialTurn.assistantOutput ?? ""];
  let stdoutParts = [initialTurn.stdout];
  let stderrParts = [initialTurn.stderr];
  let finalTurn = initialTurn;
  let verificationAlreadyObserved = turnMentionsVerification(initialTurn);

  const initialMcpList = await captureMcpListSnapshot({
    harnessId: "gemini",
    cwd: input.prepared.workspaceDir,
    env: input.prepared.env,
    logDir: input.logDir,
    label: "initial-postflight",
    timeoutMs: 30_000
  });
  const initialConnected = geminiMcpListShowsConnected(initialMcpList);
  const wantsHandoff = askedForKaleHandoff(`${initialTurn.assistantOutput ?? ""}\n${initialTurn.stdout}\n${initialTurn.stderr}`);

  if (!verificationAlreadyObserved && input.prepared.kalePatToken && (wantsHandoff || !initialConnected)) {
    const tokenTurn = await runGeminiStreamTurn({
      label: "token",
      cwd: input.prepared.workspaceDir,
      env: withKalePatEnv(input.prepared.env, input.prepared.kalePatToken),
      logDir: input.logDir,
      timeoutMs: input.timeoutMs,
      prompt: buildGeminiTokenReply(),
      resumeSessionId: initialTurn.sessionId,
      redactSecrets
    });
    turns.push(tokenTurn);
    assistantOutputs.push(tokenTurn.assistantOutput ?? "");
    stdoutParts.push(tokenTurn.stdout);
    stderrParts.push(tokenTurn.stderr);
    finalTurn = tokenTurn;
    verificationAlreadyObserved = verificationAlreadyObserved || turnMentionsVerification(tokenTurn);
  }

  const shouldVerify = verificationAlreadyObserved || initialConnected || turns.some((turn) => turn.label === "token");
  if (!verificationAlreadyObserved && shouldVerify) {
    const verificationTurn = await runGeminiStreamTurn({
      label: "verify",
      cwd: input.prepared.workspaceDir,
      env: withKalePatEnv(input.prepared.env, input.prepared.kalePatToken),
      logDir: input.logDir,
      timeoutMs: input.timeoutMs,
      prompt: buildGeminiVerificationPrompt(),
      redactSecrets
    });
    turns.push(verificationTurn);
    assistantOutputs.push(verificationTurn.assistantOutput ?? "");
    stdoutParts.push(verificationTurn.stdout);
    stderrParts.push(verificationTurn.stderr);
    finalTurn = verificationTurn;
  }

  return {
    command: "gemini",
    args: ["multi-turn-orchestration"],
    cwd: input.prepared.workspaceDir,
    timedOut: turns.some((turn) => turn.timedOut),
    exitCode: finalTurn.exitCode,
    signal: null,
    stdout: stdoutParts.filter(Boolean).join("\n"),
    stderr: stderrParts.filter(Boolean).join("\n"),
    assistantOutput: assistantOutputs.filter(Boolean).join("\n"),
    sessionId: finalTurn.sessionId,
    observedToolCalls: turns.flatMap((turn) => turn.observedToolCalls ?? []),
    turns
  };
}

async function runGeminiStreamTurn(input: {
  label: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logDir: string;
  timeoutMs: number;
  prompt: string;
  resumeSessionId?: string;
  redactSecrets?: string[];
}): Promise<NonNullable<SpawnResult["turns"]>[number]> {
  const result = await runCommand({
    command: "gemini",
    args: [
      "-p",
      input.prompt,
      ...(input.resumeSessionId ? ["--resume", input.resumeSessionId] : []),
      "-o",
      "stream-json",
      "--yolo"
    ],
    cwd: input.cwd,
    env: input.env,
    timeoutMs: input.timeoutMs
  });
  const stdout = redactSecretValues(result.stdout, input.redactSecrets);
  const stderr = redactSecretValues(result.stderr, input.redactSecrets);
  await fs.writeFile(path.join(input.logDir, `${input.label}.jsonl`), stdout);
  if (stderr.trim()) {
    await fs.writeFile(path.join(input.logDir, `${input.label}.stderr.txt`), stderr);
  }

  const parsed = parseGeminiStreamJsonResult(stdout);
  return {
    label: input.label,
    sessionId: parsed.sessionId,
    stdout,
    stderr,
    assistantOutput: parsed.resultText,
    observedToolCalls: parsed.toolCalls,
    exitCode: result.exitCode,
    timedOut: result.timedOut
  };
}

function parseGeminiStreamJsonResult(stdout: string): { sessionId?: string; resultText: string; toolCalls: string[] } {
  const assistantMessages: string[] = [];
  const toolCalls = new Set<string>();
  let sessionId: string | undefined;

  for (const line of stdout.split("\n").map((value) => value.trim()).filter(Boolean)) {
    try {
      const event = JSON.parse(line) as {
        type?: string;
        session_id?: string;
        role?: string;
        content?: string;
        tool_name?: string;
      };
      sessionId = event.session_id ?? sessionId;
      if (event.type === "message" && event.role === "assistant" && typeof event.content === "string" && event.content.trim()) {
        assistantMessages.push(event.content.trim());
      }
      if (event.type === "tool_use" && typeof event.tool_name === "string") {
        toolCalls.add(event.tool_name);
      }
    } catch {
      continue;
    }
  }

  return {
    sessionId,
    resultText: assistantMessages.join("\n"),
    toolCalls: Array.from(toolCalls)
  };
}

function geminiMcpListShowsConnected(text: string): boolean {
  return /connected/i.test(text) && !/disconnected/i.test(text);
}

function buildGeminiTokenReply(): string {
  return [
    "The browser flow is not available in this harness.",
    "I visited https://cuny.qzz.io/kale/connect and generated a Kale token.",
    "The token is available in environment variable KALE_TEST_PAT. Do not print it or echo it back.",
    "Continue onboarding in this Gemini CLI environment.",
    "If kale is already present, update or re-add it in project scope with:",
    "gemini mcp remove kale --scope project",
    "gemini mcp add --transport http --scope project kale https://cuny.qzz.io/kale/mcp -H \"Authorization: Bearer $KALE_TEST_PAT\"",
    "Stop once configuration is complete and say whether a fresh Gemini session is needed before Kale tools appear."
  ].join("\n");
}

function buildGeminiVerificationPrompt(): string {
  return [
    "Use Kale Deploy tools in this environment.",
    "Call test_connection.",
    "Confirm that register_project is available.",
    "Keep the answer short and include the exact strings test_connection and register_project."
  ].join(" ");
}

async function captureMcpListSnapshot(input: {
  harnessId: "codex" | "gemini";
  cwd: string;
  env: NodeJS.ProcessEnv;
  logDir: string;
  label: string;
  timeoutMs: number;
}): Promise<string> {
  const result = await runCommand({
    command: input.harnessId,
    args: ["mcp", "list"],
    cwd: input.cwd,
    env: input.env,
    timeoutMs: input.timeoutMs
  });
  const flattened = flattenOutput(result);
  await fs.writeFile(path.join(input.logDir, `${input.label}.txt`), flattened);
  return flattened;
}

function withKalePatEnv(env: NodeJS.ProcessEnv, kalePatToken?: string): NodeJS.ProcessEnv {
  if (!kalePatToken) {
    return env;
  }
  return {
    ...env,
    KALE_TEST_PAT: kalePatToken
  };
}

function turnMentionsVerification(turn: NonNullable<SpawnResult["turns"]>[number]): boolean {
  return hasVerificationEvidence(
    (turn.assistantOutput ?? "").toLowerCase(),
    (turn.observedToolCalls ?? []).join("\n").toLowerCase(),
    `${turn.stdout}\n${turn.stderr}`.toLowerCase()
  );
}

async function runClaudePromptFlow(input: {
  harnessId: HarnessId;
  prompt: string;
  prepared: PreparedHarness;
  logDir: string;
  timeoutMs: number;
}): Promise<SpawnResult> {
  const turns: NonNullable<SpawnResult["turns"]> = [];
  const initialTurn = await runClaudeStreamTurn({
    label: "initial",
    cwd: input.prepared.workspaceDir,
    env: input.prepared.env,
    logDir: input.logDir,
    timeoutMs: input.timeoutMs,
    prompt: input.prompt
  });
  turns.push(initialTurn);

  let assistantOutputs = [initialTurn.assistantOutput ?? ""];
  let stdoutParts = [initialTurn.stdout];
  let stderrParts = [initialTurn.stderr];
  let finalTurn = initialTurn;
  let verificationObserved = turnMentionsVerification(initialTurn);
  const shouldTokenReply = askedForKaleToken(initialTurn.assistantOutput ?? initialTurn.stdout)
    && Boolean(input.prepared.kalePatToken)
    && Boolean(initialTurn.sessionId);

  if (shouldTokenReply && input.prepared.kalePatToken && initialTurn.sessionId) {
    const tokenTurn = await runClaudeStreamTurn({
      label: "token",
      cwd: input.prepared.workspaceDir,
      env: input.prepared.env,
      logDir: input.logDir,
      timeoutMs: input.timeoutMs,
      resumeSessionId: initialTurn.sessionId,
      prompt: buildClaudeTokenReply(input.prepared.kalePatToken),
      redactSecrets: [input.prepared.kalePatToken]
    });
    turns.push(tokenTurn);
    assistantOutputs.push(tokenTurn.assistantOutput ?? "");
    stdoutParts.push(tokenTurn.stdout);
    stderrParts.push(tokenTurn.stderr);
    finalTurn = tokenTurn;
    verificationObserved = verificationObserved || turnMentionsVerification(tokenTurn);
  }

  const shouldRunFreshVerification = Boolean(input.prepared.kalePatToken)
    && !verificationObserved
    && (
      shouldTokenReply
      || initialTurn.timedOut
      || claudeTurnShowsKaleSetupProgress(initialTurn)
      || claudeTurnShowsKaleSetupProgress(finalTurn)
    );

  if (shouldRunFreshVerification && input.prepared.kalePatToken) {
    const verificationTurn = await runClaudeVerificationTurn({
      cwd: input.prepared.workspaceDir,
      env: input.prepared.env,
      logDir: input.logDir,
      timeoutMs: input.timeoutMs,
      redactSecrets: [input.prepared.kalePatToken]
    });
    turns.push(verificationTurn);
    assistantOutputs.push(verificationTurn.assistantOutput ?? "");
    stdoutParts.push(verificationTurn.stdout);
    stderrParts.push(verificationTurn.stderr);
    finalTurn = verificationTurn;
  }

  return {
    command: "claude",
    args: ["multi-turn-orchestration"],
    cwd: input.prepared.workspaceDir,
    timedOut: turns.some((turn) => turn.timedOut),
    exitCode: finalTurn.exitCode,
    signal: null,
    stdout: stdoutParts.filter(Boolean).join("\n"),
    stderr: stderrParts.filter(Boolean).join("\n"),
    assistantOutput: assistantOutputs.filter(Boolean).join("\n"),
    sessionId: finalTurn.sessionId,
    observedToolCalls: turns.flatMap((turn) => turn.observedToolCalls ?? []),
    turns
  };
}

function claudeTurnShowsKaleSetupProgress(turn: NonNullable<SpawnResult["turns"]>[number]): boolean {
  const text = (turn.assistantOutput ?? "").toLowerCase();
  return text.includes("kale mcp")
    || text.includes("token-header fallback")
    || text.includes("authenticated")
    || text.includes("endpoint is reachable")
    || text.includes("tools are reachable")
    || text.includes("get_runtime_manifest")
    || text.includes("test_connection")
    || text.includes("register_project");
}

async function runClaudeStreamTurn(input: {
  label: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logDir: string;
  timeoutMs: number;
  prompt: string;
  resumeSessionId?: string;
  redactSecrets?: string[];
}): Promise<NonNullable<SpawnResult["turns"]>[number]> {
  const result = await runCommand({
    command: "claude",
    args: [
      "-p",
      ...(input.resumeSessionId ? ["--resume", input.resumeSessionId] : []),
      "--verbose",
      "--include-partial-messages",
      "--output-format",
      "stream-json",
      "--permission-mode",
      "bypassPermissions",
      input.prompt
    ],
    cwd: input.cwd,
    env: input.env,
    timeoutMs: input.timeoutMs
  });
  const stdout = redactSecretValues(result.stdout, input.redactSecrets);
  const stderr = redactSecretValues(result.stderr, input.redactSecrets);
  await fs.writeFile(path.join(input.logDir, `${input.label}.jsonl`), stdout);
  if (stderr.trim()) {
    await fs.writeFile(path.join(input.logDir, `${input.label}.stderr.txt`), stderr);
  }

  const parsed = parseClaudeStreamJsonResult(stdout);
  return {
    label: input.label,
    sessionId: parsed.sessionId,
    stdout,
    stderr,
    assistantOutput: parsed.resultText,
    exitCode: result.exitCode,
    timedOut: result.timedOut
  };
}

async function runClaudeVerificationTurn(input: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  logDir: string;
  timeoutMs: number;
  redactSecrets?: string[];
}): Promise<NonNullable<SpawnResult["turns"]>[number]> {
  return runClaudeStreamTurn({
    label: "verify",
    cwd: input.cwd,
    env: input.env,
    logDir: input.logDir,
    timeoutMs: input.timeoutMs,
    prompt: buildClaudeVerificationPrompt(),
    redactSecrets: input.redactSecrets
  });
}

function parseClaudeStreamJsonResult(stdout: string): {
  sessionId?: string;
  resultText: string;
  toolCalls: string[];
  initState?: ClaudeInitState;
} {
  const toolCalls = new Set<string>();
  let sessionId: string | undefined;
  const assistantTextParts: string[] = [];
  let finalResultText = "";
  let initState: ClaudeInitState | undefined;

  for (const line of stdout.split("\n").map((value) => value.trim()).filter(Boolean)) {
    try {
      const event = JSON.parse(line) as {
        type?: string;
        subtype?: string;
        session_id?: string;
        result?: string;
        plugins?: Array<{
          name?: string;
        }>;
        skills?: string[];
        slash_commands?: string[];
        message?: {
          content?: Array<{
            type?: string;
            name?: string;
            text?: string;
          }>;
        };
      };
      sessionId = event.session_id ?? sessionId;
      if (event.type === "system" && event.subtype === "init") {
        initState = {
          plugins: (event.plugins ?? []).map((plugin) => plugin.name ?? "").filter(Boolean),
          skills: (event.skills ?? []).filter(Boolean),
          slashCommands: (event.slash_commands ?? []).filter(Boolean)
        };
      }
      if (event.type === "result" && typeof event.result === "string") {
        finalResultText = event.result;
      }
      if (event.type === "assistant") {
        for (const content of event.message?.content ?? []) {
          if (content.type === "tool_use" && content.name) {
            toolCalls.add(content.name);
          }
          if (content.type === "text" && typeof content.text === "string" && content.text.trim()) {
            assistantTextParts.push(content.text.trim());
          }
        }
      }
    } catch {
      continue;
    }
  }

  const combinedTextParts = assistantTextParts.filter(Boolean);
  const normalizedFinalResult = finalResultText.trim();
  if (normalizedFinalResult) {
    const joinedAssistantText = combinedTextParts.join("\n").trim();
    if (joinedAssistantText !== normalizedFinalResult && !joinedAssistantText.endsWith(normalizedFinalResult)) {
      combinedTextParts.push(normalizedFinalResult);
    }
  }

  return {
    sessionId,
    resultText: combinedTextParts.join("\n"),
    toolCalls: Array.from(toolCalls),
    initState
  };
}

function buildClaudeTokenReply(token: string): string {
  return [
    "Here is the Kale token. Do not repeat it back to me.",
    `Token: ${token}`,
    "Continue the onboarding flow in this Claude Code environment. Configure Kale with the token path exactly as instructed. If a fresh session is needed before the Kale tools appear, say so plainly once configuration is complete."
  ].join("\n\n");
}

function buildClaudeVerificationPrompt(): string {
  return [
    "Use Kale Deploy tools to verify that Kale is connected in this environment.",
    "Call test_connection.",
    "Confirm that register_project is available.",
    "Keep the answer short and definite."
  ].join(" ");
}

function redactSecretValues(text: string, secrets?: string[]): string {
  let output = text;
  for (const secret of secrets ?? []) {
    if (!secret) {
      continue;
    }
    output = output.split(secret).join("[REDACTED_KALE_PAT]");
  }
  return output;
}

function flattenOutput(result: SpawnResult): string {
  return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
}

function isolatedEnv(homeDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: homeDir,
    XDG_CONFIG_HOME: path.join(homeDir, ".config"),
    XDG_DATA_HOME: path.join(homeDir, ".local", "share"),
    XDG_STATE_HOME: path.join(homeDir, ".local", "state")
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function seedCodexKaleSkills(homeDir: string): Promise<void> {
  const sourceRoot = path.join(repoRoot(), "plugins", "kale-deploy", "skills");
  const targetRoot = path.join(homeDir, ".codex", "skills");
  await fs.mkdir(targetRoot, { recursive: true });
  for (const skillName of await fs.readdir(sourceRoot)) {
    const sourceDir = path.join(sourceRoot, skillName);
    const targetDir = path.join(targetRoot, skillName);
    await fs.rm(targetDir, { recursive: true, force: true });
    await fs.cp(sourceDir, targetDir, { recursive: true, force: true });
  }
}

async function seedGeminiKaleSkills(workspaceDir: string): Promise<void> {
  const sourceRoot = path.join(repoRoot(), "plugins", "kale-deploy", "skills");
  const targetRoot = path.join(workspaceDir, ".gemini", "skills");
  await fs.mkdir(targetRoot, { recursive: true });
  for (const skillName of await fs.readdir(sourceRoot)) {
    const sourceDir = path.join(sourceRoot, skillName);
    const targetDir = path.join(targetRoot, skillName);
    await fs.rm(targetDir, { recursive: true, force: true });
    await fs.cp(sourceDir, targetDir, { recursive: true, force: true });
  }
}

async function ensureGeminiProjectMcpConfig(workspaceDir: string): Promise<void> {
  const settingsDir = path.join(workspaceDir, ".gemini");
  const settingsPath = path.join(settingsDir, "settings.json");
  let parsed: Record<string, unknown> = {};
  const raw = await readIfExists(settingsPath);
  if (raw) {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  }

  const existingServers = parsed.mcpServers && typeof parsed.mcpServers === "object"
    ? { ...(parsed.mcpServers as Record<string, unknown>) }
    : {};
  existingServers.kale = {
    url: "https://cuny.qzz.io/kale/mcp",
    type: "http"
  };

  parsed.mcpServers = existingServers;
  await fs.mkdir(settingsDir, { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(parsed, null, 2));
}

async function installClaudeKalePlugin(workspaceDir: string, env: NodeJS.ProcessEnv): Promise<void> {
  const marketplaceAdd = await runCommand({
    command: "claude",
    args: ["plugins", "marketplace", "add", repoRoot()],
    cwd: workspaceDir,
    env,
    timeoutMs: 60_000
  });
  ensureCommandSucceeded(marketplaceAdd, "Claude Kale marketplace add");

  const pluginInstall = await runCommand({
    command: "claude",
    args: ["plugins", "install", KALE_PLUGIN_PACKAGE],
    cwd: workspaceDir,
    env,
    timeoutMs: 60_000
  });
  ensureCommandSucceeded(pluginInstall, "Claude Kale plugin install");
}

async function uninstallClaudePluginEverywhere(
  workspaceDir: string,
  env: NodeJS.ProcessEnv,
  pluginPackage: string
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await runCommand({
      command: "claude",
      args: ["plugins", "uninstall", pluginPackage],
      cwd: workspaceDir,
      env,
      timeoutMs: 30_000
    });
    const pluginList = await runCommand({
      command: "claude",
      args: ["plugins", "list"],
      cwd: workspaceDir,
      env,
      timeoutMs: 30_000
    });
    if (!flattenOutput(pluginList).includes(pluginPackage)) {
      return;
    }
  }
}

async function ensureClaudeKalePluginReady(workspaceDir: string, env: NodeJS.ProcessEnv): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const probe = await runCommand({
      command: "claude",
      args: [
        "-p",
        "--verbose",
        "--output-format",
        "stream-json",
        "--permission-mode",
        "bypassPermissions",
        "Reply with OK."
      ],
      cwd: workspaceDir,
      env,
      timeoutMs: 45_000
    });
    const parsed = parseClaudeStreamJsonResult(probe.stdout);
    const slashCommands = parsed.initState?.slashCommands ?? [];
    const skills = parsed.initState?.skills ?? [];
    const pluginNames = parsed.initState?.plugins ?? [];
    const pluginLoaded = pluginNames.some((value) => KALE_PLUGIN_NAMES.some((pluginName) => value === pluginName))
      && (
        slashCommands.some((value) => KALE_SKILL_NAMES.some((skillName) => value === `${skillName}:${skillName}`))
        || skills.some((value) => KALE_SKILL_NAMES.some((skillName) => value === `${skillName}:${skillName}`))
      );
    if (pluginLoaded) {
      return;
    }
    await sleep(1_500);
  }

  throw new Error("Claude Kale plugin installed, but the Kale plugin skill did not load into the headless session.");
}

function ensureCommandSucceeded(result: SpawnResult, label: string): void {
  if (!result.timedOut && result.exitCode === 0) {
    return;
  }
  throw new Error(`${label} failed.\n${flattenOutput(result)}`);
}

function hasVerificationEvidence(
  assistantText: string,
  observedToolCallsText: string,
  rawText: string
): boolean {
  const combinedText = `${observedToolCallsText}\n${rawText}`;
  const testConnectionObserved = /mcp(?:__|_)(kale|cail)(?:__|_)test_connection/.test(combinedText)
    || combinedText.includes('"name":"test_connection"')
    || combinedText.includes('"tool":"test_connection"')
    || assistantText.includes("test_connection");
  const registerProjectObserved = /mcp(?:__|_)(kale|cail)(?:__|_)register_project/.test(combinedText)
    || combinedText.includes('"name":"register_project"')
    || combinedText.includes('"tool":"register_project"')
    || combinedText.includes('"nextaction":"register_project"')
    || combinedText.includes('"next_action":"register_project"')
    || assistantText.includes("register_project");
  const confirmsOutcome = assistantText.includes("confirmed")
    || assistantText.includes("available")
    || assistantText.includes("succeeded")
    || assistantText.includes("authenticated")
    || assistantText.includes("connected")
    || assistantText.includes("verified");
  return testConnectionObserved && registerProjectObserved && confirmsOutcome;
}

async function copyIfExists(sourcePath: string, destinationPath: string): Promise<boolean> {
  try {
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(sourcePath, destinationPath);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function readIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function firstExistingPath(paths: string[]): Promise<string | undefined> {
  for (const filePath of paths) {
    if (await pathExists(filePath)) {
      return filePath;
    }
  }
  return undefined;
}

async function readClaudeCailPatToken(): Promise<string | undefined> {
  const claudeConfigPath = path.join(currentHome(), ".claude.json");
  const raw = await readIfExists(claudeConfigPath);
  if (!raw) {
    return undefined;
  }

  const parsed = JSON.parse(raw) as {
    mcpServers?: Record<string, { headers?: Record<string, string> }>;
    projects?: Record<string, { mcpServers?: Record<string, { headers?: Record<string, string> }> }>;
  };
  const authorizationHeaders = [
    parsed.mcpServers?.kale?.headers?.Authorization,
    parsed.mcpServers?.cail?.headers?.Authorization,
    ...Object.values(parsed.projects ?? {}).flatMap((project) => [
      project.mcpServers?.kale?.headers?.Authorization,
      project.mcpServers?.cail?.headers?.Authorization
    ])
  ].filter((value): value is string => typeof value === "string");

  for (const authorization of authorizationHeaders) {
    const match = authorization.match(/^Bearer\s+(kale_pat_[A-Za-z0-9_-]+)$/);
    if (match) {
      return match[1];
    }
  }

  return undefined;
}

async function backupPath(sourcePath: string, backupPath: string): Promise<BackupEntry> {
  try {
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.cp(sourcePath, backupPath, { recursive: true, force: true });
    return { sourcePath, backupPath, existed: true };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "ENOENT") {
      return { sourcePath, backupPath, existed: false };
    }
    throw error;
  }
}

async function restoreBackup(entry: BackupEntry): Promise<void> {
  if (!entry.existed) {
    await fs.rm(entry.sourcePath, { recursive: true, force: true });
    return;
  }
  await fs.rm(entry.sourcePath, { recursive: true, force: true });
  await fs.mkdir(path.dirname(entry.sourcePath), { recursive: true });
  await fs.cp(entry.backupPath, entry.sourcePath, { recursive: true, force: true });
}

function currentHome(): string {
  return process.env.HOME ?? os.homedir();
}

function repoRoot(): string {
  return path.resolve(process.cwd());
}

function renderSummaryMarkdown(results: HarnessResult[]): string {
  const lines = ["# Harness Onboarding Summary", ""];
  for (const result of results) {
    lines.push(`## ${result.harnessName}`);
    lines.push(`- Outcome: \`${result.outcome}\``);
    lines.push(`- Summary: ${result.summary}`);
    lines.push(`- Strategy: \`${result.strategy}\``);
    lines.push(`- Auth seeded: ${result.authSeeded ? "yes" : "no"}`);
    lines.push(`- Skill acquired: ${result.observed.skillAcquired ? "yes" : "no"}`);
    lines.push(`- Skill observed in run: ${result.observed.skillObserved ? "yes" : "no"}`);
    lines.push(`- Prompt: ${result.promptPath}`);
    lines.push(`- Run result: ${result.runResultPath}`);
    lines.push(`- Postflight: ${result.postflightPath || "n/a"}`);
    if (result.notes.length > 0) {
      lines.push(`- Notes: ${result.notes.join(" ")}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
