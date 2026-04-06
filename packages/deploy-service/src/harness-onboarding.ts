export const HARNESS_IDS = ["claude", "codex", "gemini"] as const;
export const HARNESS_PROMPT_PROFILES = ["current", "skill-first"] as const;
export const KALE_AGENT_BUNDLE_VERSION = "0.2.9";

export type HarnessId = typeof HARNESS_IDS[number];
export type HarnessPromptProfile = typeof HARNESS_PROMPT_PROFILES[number];
export type HarnessInstallSurface = "plugin_marketplace" | "app_add_on" | "extension";
export type HarnessInstallMode = "command" | "app_ui";
export type HarnessAuthMode = "oauth_browser" | "oauth_bridge_to_http" | "stdio_oauth_bridge" | "token_header";
export type HarnessUpdateMode = "automatic" | "manual" | "unknown";
export type HarnessWrapperKind = "plugin" | "add_on" | "extension";

export type RuntimeDynamicSkillPolicy = {
  local_bundle_role: "bootstrap_only";
  authoritative_tools: string[];
  runtime_manifest_fields: string[];
  test_connection_fields: string[];
  wrapper_check_query_parameters: string[];
  refresh_points: string[];
  notes: string[];
};

export type ConnectionDynamicSkillPolicy = {
  localBundleRole: "bootstrap_only";
  authoritativeTools: string[];
  runtimeManifestFields: string[];
  testConnectionFields: string[];
  wrapperCheckQueryParameters: string[];
  refreshPoints: string[];
  notes: string[];
};

export type WrapperStatusKind =
  | "current"
  | "stale"
  | "ahead"
  | "unparseable"
  | "unknown_harness";

export type RuntimeLocalWrapperStatus = {
  harness_id: HarnessId | string;
  status: WrapperStatusKind;
  warning: boolean;
  local_bundle_version: string;
  expected_bundle_version?: string;
  summary: string;
  update_mode?: HarnessUpdateMode;
  update_command?: string;
  restart_required_after_update?: boolean;
  notes: string[];
};

export type ConnectionLocalWrapperStatus = {
  harnessId: HarnessId | string;
  status: WrapperStatusKind;
  warning: boolean;
  localBundleVersion: string;
  expectedBundleVersion?: string;
  summary: string;
  updateMode?: HarnessUpdateMode;
  updateCommand?: string;
  restartRequiredAfterUpdate?: boolean;
  notes: string[];
};

export type LandingPageHarnessInstallInstruction = {
  id: HarnessId;
  name: string;
  letter: string;
  installMode: HarnessInstallMode;
  instruction: string;
  hint: string;
  installNotes: string[];
  manualFallback?: {
    instruction: string;
    hint: string;
    notes: string[];
  };
};

export type HarnessSetupPrompt = {
  id: HarnessId;
  name: string;
  letter: string;
  prompt: string;
};

export type HarnessPromptContext = {
  marketingName: string;
  serviceBaseUrl: string;
  mcpEndpoint: string;
};

export type HarnessCatalogEntry = {
  id: HarnessId;
  name: string;
  letter: string;
  installSurface: HarnessInstallSurface;
  installMode: HarnessInstallMode;
  instruction: string;
  hint: string;
  installNotes: string[];
  manualFallback?: {
    authMode: HarnessAuthMode;
    instruction: string;
    hint: string;
    notes: string[];
  };
  localWrapper: {
    kind: HarnessWrapperKind;
    packageName: string;
    bundleVersion: string;
    updateMode: HarnessUpdateMode;
    updateCommand?: string;
    restartRequiredAfterUpdate?: boolean;
    notes: string[];
  };
};

const CLIENT_UPDATE_POLICY_NOTES = [
  "Remote Kale MCP and runtime changes apply immediately.",
  "Local add-on, plugin, skill, or extension updates depend on the harness install surface.",
  "When the local wrapper and the runtime manifest disagree, prefer the runtime manifest."
] as const;

const CONNECTION_CLIENT_UPDATE_POLICY_BASE = {
  remoteMcpUpdateMode: "automatic" as const,
  localWrapperUpdateMode: "harness_specific" as const,
  runtimeManifestPreferred: true as const,
  notes: CLIENT_UPDATE_POLICY_NOTES
};

const CONNECTION_DYNAMIC_SKILL_POLICY_BASE = {
  localBundleRole: "bootstrap_only" as const,
  authoritativeTools: ["get_runtime_manifest", "test_connection"],
  runtimeManifestFields: [
    "dynamic_skill_policy",
    "client_update_policy",
    "agent_harnesses",
    "agent_build_guidance",
    "agent_api.auth.human_handoff_rules"
  ],
  testConnectionFields: [
    "dynamicSkillPolicy",
    "clientUpdatePolicy",
    "harnesses",
    "nextAction",
    "summary"
  ],
  wrapperCheckQueryParameters: [
    "harness",
    "localBundleVersion"
  ],
  refreshPoints: [
    "When Kale tools first appear, call get_runtime_manifest before following local install guidance.",
    "After authentication succeeds, call get_runtime_manifest and test_connection again before continuing.",
    "When the local bundle and the live service disagree, prefer the live service fields."
  ],
  notes: [
    "The checked-in plugin, command, and skill copy is a bootstrap layer.",
    "Use the runtime manifest for install, update, and handoff policy.",
    "Use test_connection for the current next step and repository-specific readiness."
  ]
} satisfies ConnectionDynamicSkillPolicy;

export type RuntimeHarnessCatalogEntry = {
  id: HarnessId;
  name: string;
  letter: string;
  install_surface: HarnessInstallSurface;
  install_mode: HarnessInstallMode;
  install_instruction: string;
  install_hint: string;
  install_notes: string[];
  manual_fallback?: {
    auth_mode: HarnessAuthMode;
    instruction: string;
    hint: string;
    notes: string[];
  };
  local_wrapper: {
    kind: HarnessWrapperKind;
    package_name: string;
    bundle_version: string;
    update_mode: HarnessUpdateMode;
    update_command?: string;
    restart_required_after_update?: boolean;
    notes: string[];
  };
};

export type ConnectionHarnessCatalogEntry = {
  id: HarnessId;
  name: string;
  letter: string;
  installSurface: HarnessInstallSurface;
  installMode: HarnessInstallMode;
  installInstruction: string;
  installHint: string;
  installNotes: string[];
  manualFallback?: {
    authMode: HarnessAuthMode;
    instruction: string;
    hint: string;
    notes: string[];
  };
  localWrapper: {
    kind: HarnessWrapperKind;
    packageName: string;
    bundleVersion: string;
    updateMode: HarnessUpdateMode;
    updateCommand?: string;
    restartRequiredAfterUpdate?: boolean;
    notes: string[];
  };
};

export function buildHarnessPromptContext(
  marketingName: string,
  serviceBaseUrl: string
): HarnessPromptContext {
  return {
    marketingName,
    serviceBaseUrl,
    mcpEndpoint: `${serviceBaseUrl}/mcp`
  };
}

function buildConnectUrl(input: HarnessPromptContext): string {
  return `${input.serviceBaseUrl.replace(/\/$/, "")}/connect`;
}

function buildClaudeBootstrapCommand(input: HarnessPromptContext): string {
  return `claude mcp remove kale -s local 2>/dev/null
claude mcp remove kale -s user 2>/dev/null
claude mcp add -s user kale -- npx -y mcp-remote ${input.mcpEndpoint} --transport http-only`;
}

function buildClaudeFinalizeCommand(input: HarnessPromptContext): string {
  return `KALE_PLUGIN_PATH="$(claude plugins list --json | node -e 'const fs = require(\"node:fs\"); const plugins = JSON.parse(fs.readFileSync(0, \"utf8\")); const plugin = plugins.find((entry) => entry.id === \"kale-deploy@cuny-ai-lab\"); if (!plugin?.installPath) { process.stderr.write(\"Kale plugin is not installed.\\n\"); process.exit(1); } process.stdout.write(plugin.installPath);')"
node "$KALE_PLUGIN_PATH/scripts/kale-claude-connect.mjs" sync --mcp-endpoint ${input.mcpEndpoint}`;
}

function buildClaudeTokenBridgeCommand(input: HarnessPromptContext): string {
  return `claude mcp remove kale -s local 2>/dev/null
claude mcp remove kale -s user 2>/dev/null
claude mcp add --transport http --header "Authorization: Bearer THE_TOKEN" -s user kale ${input.mcpEndpoint}`;
}

function findHarnessCatalogEntry(
  input: HarnessPromptContext,
  harnessId: string
): HarnessCatalogEntry | undefined {
  return buildHarnessCatalog(input).find((entry) => entry.id === harnessId);
}

function buildKnownHarnessLocalWrapperStatus(
  harness: HarnessCatalogEntry,
  status: WrapperStatusKind,
  warning: boolean,
  localBundleVersion: string,
  summary: string,
  notes = harness.localWrapper.notes
): ConnectionLocalWrapperStatus {
  return {
    harnessId: harness.id,
    status,
    warning,
    localBundleVersion,
    expectedBundleVersion: harness.localWrapper.bundleVersion,
    updateMode: harness.localWrapper.updateMode,
    updateCommand: harness.localWrapper.updateCommand,
    restartRequiredAfterUpdate: harness.localWrapper.restartRequiredAfterUpdate,
    summary,
    notes
  };
}

function buildLandingPageHarnessInstallInstructionFromConnection(
  entry: ConnectionHarnessCatalogEntry
): LandingPageHarnessInstallInstruction {
  return {
    id: entry.id,
    name: entry.name,
    letter: entry.letter,
    installMode: entry.installMode,
    instruction: entry.installInstruction,
    hint: entry.installHint,
    installNotes: [],
    manualFallback: undefined
  };
}

function buildLandingPageManualFallbackFromConnection(
  fallback: ConnectionHarnessCatalogEntry["manualFallback"]
): LandingPageHarnessInstallInstruction["manualFallback"] {
  if (!fallback) {
    return undefined;
  }

  return {
    instruction: fallback.instruction,
    hint: fallback.hint,
    notes: []
  };
}

function buildConnectionManualFallback(entry: HarnessCatalogEntry): ConnectionHarnessCatalogEntry["manualFallback"] {
  if (!entry.manualFallback) {
    return undefined;
  }

  return {
    authMode: entry.manualFallback.authMode,
    instruction: entry.manualFallback.instruction,
    hint: entry.manualFallback.hint,
    notes: entry.manualFallback.notes
  };
}

function buildConnectionLocalWrapper(entry: HarnessCatalogEntry): ConnectionHarnessCatalogEntry["localWrapper"] {
  return {
    kind: entry.localWrapper.kind,
    packageName: entry.localWrapper.packageName,
    bundleVersion: entry.localWrapper.bundleVersion,
    updateMode: entry.localWrapper.updateMode,
    updateCommand: entry.localWrapper.updateCommand,
    restartRequiredAfterUpdate: entry.localWrapper.restartRequiredAfterUpdate,
    notes: entry.localWrapper.notes
  };
}

function buildRuntimeHarnessCatalogEntryFromConnection(
  entry: ConnectionHarnessCatalogEntry
): RuntimeHarnessCatalogEntry {
  return {
    id: entry.id,
    name: entry.name,
    letter: entry.letter,
    install_surface: entry.installSurface,
    install_mode: entry.installMode,
    install_instruction: entry.installInstruction,
    install_hint: entry.installHint,
    install_notes: entry.installNotes,
    manual_fallback: entry.manualFallback ? {
      auth_mode: entry.manualFallback.authMode,
      instruction: entry.manualFallback.instruction,
      hint: entry.manualFallback.hint,
      notes: entry.manualFallback.notes
    } : undefined,
    local_wrapper: {
      kind: entry.localWrapper.kind,
      package_name: entry.localWrapper.packageName,
      bundle_version: entry.localWrapper.bundleVersion,
      update_mode: entry.localWrapper.updateMode,
      update_command: entry.localWrapper.updateCommand,
      restart_required_after_update: entry.localWrapper.restartRequiredAfterUpdate,
      notes: entry.localWrapper.notes
    }
  };
}

function buildRuntimeClientUpdatePolicyFromConnection(
  policy: ReturnType<typeof buildConnectionClientUpdatePolicy>
) {
  return {
    remote_mcp_update_mode: policy.remoteMcpUpdateMode,
    local_wrapper_update_mode: policy.localWrapperUpdateMode,
    runtime_manifest_preferred: policy.runtimeManifestPreferred,
    notes: [...policy.notes]
  };
}

function buildRuntimeDynamicSkillPolicyFromConnection(
  policy: ConnectionDynamicSkillPolicy
): RuntimeDynamicSkillPolicy {
  return {
    local_bundle_role: policy.localBundleRole,
    authoritative_tools: [...policy.authoritativeTools],
    runtime_manifest_fields: [...policy.runtimeManifestFields],
    test_connection_fields: [...policy.testConnectionFields],
    wrapper_check_query_parameters: [...policy.wrapperCheckQueryParameters],
    refresh_points: [...policy.refreshPoints],
    notes: [...policy.notes]
  };
}

function buildRuntimeLocalWrapperStatusFromConnection(status: ConnectionLocalWrapperStatus): RuntimeLocalWrapperStatus {
  return {
    harness_id: status.harnessId,
    status: status.status,
    warning: status.warning,
    local_bundle_version: status.localBundleVersion,
    expected_bundle_version: status.expectedBundleVersion,
    summary: status.summary,
    update_mode: status.updateMode,
    update_command: status.updateCommand,
    restart_required_after_update: status.restartRequiredAfterUpdate,
    notes: status.notes
  };
}

export function buildLandingPageHarnessInstallInstructions(input: HarnessPromptContext): LandingPageHarnessInstallInstruction[] {
  return buildConnectionHarnessCatalog(input).map(buildLandingPageHarnessInstallInstructionFromConnection);
}

export function buildRuntimeHarnessCatalog(input: HarnessPromptContext): RuntimeHarnessCatalogEntry[] {
  return buildConnectionHarnessCatalog(input).map(buildRuntimeHarnessCatalogEntryFromConnection);
}

export function buildConnectionHarnessCatalog(input: HarnessPromptContext): ConnectionHarnessCatalogEntry[] {
  return buildHarnessCatalog(input).map((entry) => ({
    id: entry.id,
    name: entry.name,
    letter: entry.letter,
    installSurface: entry.installSurface,
    installMode: entry.installMode,
    installInstruction: entry.instruction,
    installHint: entry.hint,
    installNotes: entry.installNotes,
    manualFallback: buildConnectionManualFallback(entry),
    localWrapper: buildConnectionLocalWrapper(entry)
  }));
}

export function buildRuntimeClientUpdatePolicy() {
  return buildRuntimeClientUpdatePolicyFromConnection(buildConnectionClientUpdatePolicy());
}

export function buildConnectionClientUpdatePolicy() {
  return {
    remoteMcpUpdateMode: CONNECTION_CLIENT_UPDATE_POLICY_BASE.remoteMcpUpdateMode,
    localWrapperUpdateMode: CONNECTION_CLIENT_UPDATE_POLICY_BASE.localWrapperUpdateMode,
    runtimeManifestPreferred: CONNECTION_CLIENT_UPDATE_POLICY_BASE.runtimeManifestPreferred,
    notes: [...CONNECTION_CLIENT_UPDATE_POLICY_BASE.notes]
  };
}

export function buildRuntimeDynamicSkillPolicy(): RuntimeDynamicSkillPolicy {
  return buildRuntimeDynamicSkillPolicyFromConnection(buildConnectionDynamicSkillPolicy());
}

export function buildConnectionDynamicSkillPolicy(): ConnectionDynamicSkillPolicy {
  return {
    localBundleRole: CONNECTION_DYNAMIC_SKILL_POLICY_BASE.localBundleRole,
    authoritativeTools: [...CONNECTION_DYNAMIC_SKILL_POLICY_BASE.authoritativeTools],
    runtimeManifestFields: [...CONNECTION_DYNAMIC_SKILL_POLICY_BASE.runtimeManifestFields],
    testConnectionFields: [...CONNECTION_DYNAMIC_SKILL_POLICY_BASE.testConnectionFields],
    wrapperCheckQueryParameters: [...CONNECTION_DYNAMIC_SKILL_POLICY_BASE.wrapperCheckQueryParameters],
    refreshPoints: [...CONNECTION_DYNAMIC_SKILL_POLICY_BASE.refreshPoints],
    notes: [...CONNECTION_DYNAMIC_SKILL_POLICY_BASE.notes]
  };
}

export function buildRuntimeLocalWrapperStatus(
  input: HarnessPromptContext,
  harnessId: string | undefined,
  localBundleVersion: string | undefined
): RuntimeLocalWrapperStatus | undefined {
  const status = evaluateLocalWrapperStatus(input, harnessId, localBundleVersion);
  if (!status) {
    return undefined;
  }

  return buildRuntimeLocalWrapperStatusFromConnection(status);
}

export function buildConnectionLocalWrapperStatus(
  input: HarnessPromptContext,
  harnessId: string | undefined,
  localBundleVersion: string | undefined
): ConnectionLocalWrapperStatus | undefined {
  return evaluateLocalWrapperStatus(input, harnessId, localBundleVersion);
}

export function buildHarnessSetupPrompts(
  profile: HarnessPromptProfile,
  input: HarnessPromptContext
): HarnessSetupPrompt[] {
  if (profile !== "current" && profile !== "skill-first") {
    throw new Error(`Unsupported harness prompt profile '${profile}'.`);
  }

  return buildInstalledHarnessSetupPrompts(input);
}

function buildHarnessCatalog(input: HarnessPromptContext): HarnessCatalogEntry[] {
  const connectUrl = buildConnectUrl(input);
  const claudeBootstrapCommand = buildClaudeBootstrapCommand(input);
  const claudeFinalizeCommand = buildClaudeFinalizeCommand(input);
  const claudeTokenBridgeCommand = buildClaudeTokenBridgeCommand(input);

  return [
    {
      id: "claude",
      name: "Claude Code",
      letter: "C",
      installSurface: "plugin_marketplace",
      installMode: "command",
      instruction: `/plugin marketplace add CUNY-AI-Lab/CAIL-deploy\n/plugin install kale-deploy@cuny-ai-lab`,
      hint: "Paste inside Claude Code",
      installNotes: [
        "Claude installs Kale as a user-scope plugin bundle.",
        "The plugin install provides Kale skills and the Claude finalization helper.",
        "In Claude Code, do not search the MCP registry first when the local Kale plugin is installed. Start with the installed plugin and claude mcp list.",
        "Use mcp-remote only to complete the OAuth browser flow, then replace the temporary bridge with one direct HTTP kale entry that uses headersHelper.",
        "The preferred Claude ready state is a single user-scope kale HTTP server at the Kale MCP endpoint.",
        "Do not invent claude mcp auth, login, or authenticate commands."
      ],
      manualFallback: {
        authMode: "oauth_bridge_to_http",
        instruction: `${claudeBootstrapCommand}\n# complete the browser OAuth flow, then replace the temporary bridge:\n${claudeFinalizeCommand}`,
        hint: "Current recommended Claude bootstrap and finalize path",
        notes: [
          "Use mcp-remote only long enough to complete the OAuth browser flow.",
          "After OAuth succeeds, immediately rewrite Claude to one direct HTTP kale server with the installed kale-claude-connect helper.",
          "The direct HTTP entry uses headersHelper to read the latest valid Kale mcp-remote OAuth token at connection time.",
          "If the cached access token is stale but a valid refresh token exists, the helper refreshes it automatically.",
          "Only rerun the mcp-remote bootstrap if the helper reports that no valid Kale OAuth or refresh token is available.",
          "Do not leave the temporary stdio bridge as the long-term Claude connection.",
          `If mcp-remote itself fails, fall back to the token bridge from ${connectUrl}.`,
          `Last-resort token bridge:\n${claudeTokenBridgeCommand}`,
          `Generate THE_TOKEN from ${connectUrl}.`
        ]
      },
      localWrapper: {
        kind: "plugin",
        packageName: "kale-deploy@cuny-ai-lab",
        bundleVersion: KALE_AGENT_BUNDLE_VERSION,
        updateMode: "manual",
        updateCommand: "claude plugins update kale-deploy@cuny-ai-lab -s user",
        restartRequiredAfterUpdate: true,
        notes: [
          "Claude supports plugin updates directly.",
          "Local plugin updates require a restart to apply."
        ]
      }
    },
    {
      id: "codex",
      name: "Codex",
      letter: "X",
      installSurface: "app_add_on",
      installMode: "app_ui",
      instruction: `Install the Kale Deploy add-on in the Codex app or from the Kale homepage.\n\nIf you need the manual fallback:\ncodex mcp add kale --url ${input.mcpEndpoint}\ncodex mcp login kale`,
      hint: "Use the add-on installer first; the MCP commands are the fallback",
      installNotes: [
        "Codex uses the Kale add-on as the normal install surface.",
        "The Codex CLI exposes MCP management, not plugin management."
      ],
      manualFallback: {
        authMode: "oauth_browser",
        instruction: `codex mcp add kale --url ${input.mcpEndpoint}\ncodex mcp login kale`,
        hint: "Use this when you need the direct MCP path",
        notes: [
          "The browser OAuth flow should open automatically from codex mcp login.",
          "Remote MCP changes update immediately even if the local add-on is stale."
        ]
      },
      localWrapper: {
        kind: "add_on",
        packageName: "kale-deploy",
        bundleVersion: KALE_AGENT_BUNDLE_VERSION,
        updateMode: "unknown",
        notes: [
          "Codex CLI does not currently expose add-on update commands.",
          "If the add-on looks stale, refresh or reinstall it in the Codex app."
        ]
      }
    },
    {
      id: "gemini",
      name: "Gemini CLI",
      letter: "G",
      installSurface: "extension",
      installMode: "command",
      instruction: `/extensions install https://github.com/CUNY-AI-Lab/CAIL-deploy --auto-update`,
      hint: "Paste inside Gemini CLI",
      installNotes: [
        "Gemini installs Kale as an extension.",
        "The --auto-update flag keeps the extension on the latest published version."
      ],
      localWrapper: {
        kind: "extension",
        packageName: "kale-deploy",
        bundleVersion: KALE_AGENT_BUNDLE_VERSION,
        updateMode: "manual",
        updateCommand: "gemini extensions update kale-deploy",
        notes: [
          "Gemini extensions support explicit update commands.",
          "Using --auto-update at install time is the preferred public path.",
          "Gemini also supports linking local skills, which reflect source changes immediately."
        ]
      }
    }
  ];
}

function evaluateLocalWrapperStatus(
  input: HarnessPromptContext,
  harnessId: string | undefined,
  localBundleVersion: string | undefined
): ConnectionLocalWrapperStatus | undefined {
  const normalizedHarnessId = harnessId?.trim().toLowerCase();
  const normalizedBundleVersion = localBundleVersion?.trim();
  if (!normalizedHarnessId || !normalizedBundleVersion) {
    return undefined;
  }

  const harness = findHarnessCatalogEntry(input, normalizedHarnessId);
  if (!harness) {
    return {
      harnessId: normalizedHarnessId,
      status: "unknown_harness",
      warning: true,
      localBundleVersion: normalizedBundleVersion,
      summary: `Kale does not recognize the local harness '${normalizedHarnessId}', so it cannot verify whether the wrapper is current.`,
      notes: [
        "Report one of the supported harness ids: claude, codex, or gemini."
      ]
    };
  }

  const comparison = compareBundleVersions(normalizedBundleVersion, harness.localWrapper.bundleVersion);
  if (comparison === null) {
    return buildKnownHarnessLocalWrapperStatus(
      harness,
      "unparseable",
      true,
      normalizedBundleVersion,
      `${harness.name} reported local bundle version '${normalizedBundleVersion}', which Kale could not compare with the current bundle '${harness.localWrapper.bundleVersion}'.`,
      [
        "Use a simple dotted version such as 0.2.4 when reporting local wrapper versions.",
        ...harness.localWrapper.notes
      ]
    );
  }

  if (comparison < 0) {
    return buildKnownHarnessLocalWrapperStatus(
      harness,
      "stale",
      true,
      normalizedBundleVersion,
      `${harness.name} reported local bundle version ${normalizedBundleVersion}, but Kale currently publishes ${harness.localWrapper.bundleVersion}. Refresh or update the local wrapper before relying on stale local guidance.`
    );
  }

  if (comparison > 0) {
    return buildKnownHarnessLocalWrapperStatus(
      harness,
      "ahead",
      false,
      normalizedBundleVersion,
      `${harness.name} reported local bundle version ${normalizedBundleVersion}, which is newer than the currently published Kale bundle ${harness.localWrapper.bundleVersion}.`
    );
  }

  return buildKnownHarnessLocalWrapperStatus(
    harness,
    "current",
    false,
    normalizedBundleVersion,
    `${harness.name} reported the current Kale bundle version ${normalizedBundleVersion}.`
  );
}

function compareBundleVersions(left: string, right: string): number | null {
  const leftParts = parseBundleVersion(left);
  const rightParts = parseBundleVersion(right);
  if (!leftParts || !rightParts) {
    return null;
  }

  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }

  return 0;
}

function parseBundleVersion(version: string): number[] | null {
  if (!/^\d+(?:\.\d+)*$/.test(version)) {
    return null;
  }
  return version.split(".").map((segment) => Number(segment));
}

function buildInstalledHarnessSetupPrompts(input: HarnessPromptContext): HarnessSetupPrompt[] {
  const connectUrl = buildConnectUrl(input);
  const claudeBootstrapCommand = buildClaudeBootstrapCommand(input).replace(/\n/g, " && ");
  const { marketingName } = input;

  const claudeSetupPrompt = [
    `Goal: Prepare this Claude Code environment for ${marketingName}. Do not build an app yet.`,
    "",
    `1. The \`kale-deploy\` plugin is already installed. Run \`claude mcp list\` to check whether a \`kale\` server is already connected.`,
    `2. If connected, skip to step 5. If not, bootstrap OAuth: \`${claudeBootstrapCommand}\``,
    `3. After the browser OAuth flow completes, replace the temporary bridge with one direct HTTP \`kale\` server by running the installed \`kale-claude-connect.mjs\` helper. It configures \`headersHelper\` so Claude reuses and refreshes the Kale OAuth token automatically.`,
    `4. If OAuth fails, ask the user to generate a token at ${connectUrl} and paste it back.`,
    `5. Call \`get_runtime_manifest\` and use \`dynamic_skill_policy\`, \`client_update_policy\`, and \`agent_harnesses\` as live truth over any local guidance.`,
    `6. Call \`test_connection\` and use \`nextAction\` and \`summary\` for the current next step.`,
    `7. Confirm \`register_project\` is available. Only then say ${marketingName} is ready.`,
    "",
    `Do not search the MCP registry first. Do not invent \`claude mcp auth\`, \`claude mcp login\`, or \`claude mcp authenticate\` commands. The ready state is one user-scope \`kale\` HTTP server at ${input.mcpEndpoint}.`
  ].join("\n");

  const codexSetupPrompt = [
    `Goal: Prepare this Codex environment for ${marketingName}. Do not build an app yet.`,
    "",
    `1. The \`kale-deploy\` add-on or bundled Kale skills are already installed. Use the installed \`kale-connect\` guidance to connect Kale.`,
    `2. If Kale authentication is needed, ask the user to visit ${connectUrl}, sign in, generate a token, and paste it back.`,
    `3. Call \`get_runtime_manifest\` and use \`dynamic_skill_policy\`, \`client_update_policy\`, and \`agent_harnesses\` as live truth.`,
    `4. Call \`test_connection\` and use \`nextAction\` and \`summary\` for the current next step.`,
    `5. Confirm \`register_project\` is available. Only then say ${marketingName} is ready.`
  ].join("\n");

  const geminiSetupPrompt = [
    `Goal: Prepare this Gemini CLI environment for ${marketingName}. Do not build an app yet.`,
    "",
    `1. The \`kale-deploy\` extension or skills are already installed, and the Kale MCP server is declared in \`.gemini/settings.json\`. Use the installed \`kale-connect\` skill to connect Kale.`,
    `2. If Kale authentication is needed, ask the user to visit ${connectUrl}, sign in, generate a token, and paste it back.`,
    `3. Call \`get_runtime_manifest\` and use \`dynamic_skill_policy\`, \`client_update_policy\`, and \`agent_harnesses\` as live truth.`,
    `4. Call \`test_connection\` and use \`nextAction\` and \`summary\` for the current next step.`,
    `5. Confirm \`register_project\` is available. Only then say ${marketingName} is ready.`
  ].join("\n");

  return [
    { id: "claude", name: "Claude Code", prompt: claudeSetupPrompt, letter: "C" },
    { id: "codex", name: "Codex", prompt: codexSetupPrompt, letter: "X" },
    { id: "gemini", name: "Gemini CLI", prompt: geminiSetupPrompt, letter: "G" },
  ];
}
