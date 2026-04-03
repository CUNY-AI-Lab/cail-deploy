export const HARNESS_IDS = ["claude", "codex", "gemini"] as const;
export const HARNESS_PROMPT_PROFILES = ["current", "skill-first"] as const;
export const KALE_AGENT_BUNDLE_VERSION = "0.2.7";

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

export type HarnessInstallInstruction = {
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

export function buildHarnessInstallInstructions(input: HarnessPromptContext): HarnessInstallInstruction[] {
  return buildHarnessCatalog(input).map(({ id, name, letter, installMode, instruction, hint, installNotes, manualFallback }) => ({
    id,
    name,
    letter,
    installMode,
    instruction,
    hint,
    installNotes,
    manualFallback: manualFallback ? {
      instruction: manualFallback.instruction,
      hint: manualFallback.hint,
      notes: manualFallback.notes
    } : undefined
  }));
}

export function buildRuntimeHarnessCatalog(input: HarnessPromptContext): RuntimeHarnessCatalogEntry[] {
  return buildHarnessCatalog(input).map((entry) => ({
    id: entry.id,
    name: entry.name,
    letter: entry.letter,
    install_surface: entry.installSurface,
    install_mode: entry.installMode,
    install_instruction: entry.instruction,
    install_hint: entry.hint,
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
  }));
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
    manualFallback: entry.manualFallback ? {
      authMode: entry.manualFallback.authMode,
      instruction: entry.manualFallback.instruction,
      hint: entry.manualFallback.hint,
      notes: entry.manualFallback.notes
    } : undefined,
    localWrapper: {
      kind: entry.localWrapper.kind,
      packageName: entry.localWrapper.packageName,
      bundleVersion: entry.localWrapper.bundleVersion,
      updateMode: entry.localWrapper.updateMode,
      updateCommand: entry.localWrapper.updateCommand,
      restartRequiredAfterUpdate: entry.localWrapper.restartRequiredAfterUpdate,
      notes: entry.localWrapper.notes
    }
  }));
}

export function buildRuntimeClientUpdatePolicy() {
  return {
    remote_mcp_update_mode: "automatic",
    local_wrapper_update_mode: "harness_specific",
    runtime_manifest_preferred: true,
    notes: [
      "Remote Kale MCP and runtime changes apply immediately.",
      "Local add-on, plugin, skill, or extension updates depend on the harness install surface.",
      "When the local wrapper and the runtime manifest disagree, prefer the runtime manifest."
    ]
  };
}

export function buildConnectionClientUpdatePolicy() {
  return {
    remoteMcpUpdateMode: "automatic",
    localWrapperUpdateMode: "harness_specific",
    runtimeManifestPreferred: true,
    notes: [
      "Remote Kale MCP and runtime changes apply immediately.",
      "Local add-on, plugin, skill, or extension updates depend on the harness install surface.",
      "When the local wrapper and the runtime manifest disagree, prefer the runtime manifest."
    ]
  };
}

export function buildRuntimeDynamicSkillPolicy(): RuntimeDynamicSkillPolicy {
  return {
    local_bundle_role: "bootstrap_only",
    authoritative_tools: ["get_runtime_manifest", "test_connection"],
    runtime_manifest_fields: [
      "dynamic_skill_policy",
      "client_update_policy",
      "agent_harnesses",
      "agent_build_guidance",
      "agent_api.auth.human_handoff_rules"
    ],
    test_connection_fields: [
      "dynamicSkillPolicy",
      "clientUpdatePolicy",
      "harnesses",
      "nextAction",
      "summary"
    ],
    wrapper_check_query_parameters: [
      "harness",
      "localBundleVersion"
    ],
    refresh_points: [
      "When Kale tools first appear, call get_runtime_manifest before following local install guidance.",
      "After authentication succeeds, call get_runtime_manifest and test_connection again before continuing.",
      "When the local bundle and the live service disagree, prefer the live service fields."
    ],
    notes: [
      "The checked-in plugin, command, and skill copy is a bootstrap layer.",
      "Use the runtime manifest for install, update, and handoff policy.",
      "Use test_connection for the current next step and repository-specific readiness."
    ]
  };
}

export function buildConnectionDynamicSkillPolicy(): ConnectionDynamicSkillPolicy {
  return {
    localBundleRole: "bootstrap_only",
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
  if (profile === "skill-first") {
    return buildSkillFirstHarnessSetupPrompts(input);
  }
  return buildCurrentAppHarnessSetupPrompts(input);
}

export function buildCurrentAppHarnessSetupPrompts(input: HarnessPromptContext): HarnessSetupPrompt[] {
  return buildInstalledHarnessSetupPrompts(input);
}

export function buildSkillFirstHarnessSetupPrompts(input: HarnessPromptContext): HarnessSetupPrompt[] {
  return buildInstalledHarnessSetupPrompts(input);
}

function buildHarnessCatalog(input: HarnessPromptContext): HarnessCatalogEntry[] {
  const connectUrl = `${input.serviceBaseUrl.replace(/\/$/, "")}/connect`;
  const claudeBootstrapCommand = `claude mcp remove kale -s local 2>/dev/null\nclaude mcp remove kale -s user 2>/dev/null\nclaude mcp add -s user kale -- npx -y mcp-remote ${input.mcpEndpoint} --transport http-only`;
  const claudeFinalizeCommand = `KALE_PLUGIN_PATH="$(claude plugins list --json | node -e 'const fs = require(\"node:fs\"); const plugins = JSON.parse(fs.readFileSync(0, \"utf8\")); const plugin = plugins.find((entry) => entry.id === \"kale-deploy@cuny-ai-lab\"); if (!plugin?.installPath) { process.stderr.write(\"Kale plugin is not installed.\\\\n\"); process.exit(1); } process.stdout.write(plugin.installPath);')"\nnode "$KALE_PLUGIN_PATH/scripts/kale-claude-connect.mjs" sync --mcp-endpoint ${input.mcpEndpoint}`;

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
        "Use mcp-remote only to complete the OAuth browser flow, then replace the temporary bridge with one direct HTTP kale entry.",
        "The steady-state Claude ready state is a single user-scope kale HTTP server at the Kale MCP endpoint.",
        "Do not invent claude mcp auth, login, or authenticate commands."
      ],
      manualFallback: {
        authMode: "oauth_bridge_to_http",
        instruction: `${claudeBootstrapCommand}\n# complete the browser OAuth flow, then replace the temporary bridge:\n${claudeFinalizeCommand}`,
        hint: "Current recommended Claude bootstrap and finalize path",
        notes: [
          "Use mcp-remote only long enough to complete the OAuth browser flow.",
          "After OAuth succeeds, immediately rewrite Claude to one direct HTTP kale server with the installed kale-claude-connect helper.",
          "Do not leave the temporary stdio bridge as the steady-state Claude connection.",
          `If mcp-remote itself fails, fall back to the token bridge from ${connectUrl}.`,
          `Last-resort token bridge:\nclaude mcp remove kale -s local 2>/dev/null\nclaude mcp remove kale -s user 2>/dev/null\nclaude mcp add --transport http --header "Authorization: Bearer THE_TOKEN" -s user kale ${input.mcpEndpoint}`,
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

  const harness = buildHarnessCatalog(input).find((entry) => entry.id === normalizedHarnessId);
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
    return {
      harnessId: harness.id,
      status: "unparseable",
      warning: true,
      localBundleVersion: normalizedBundleVersion,
      expectedBundleVersion: harness.localWrapper.bundleVersion,
      updateMode: harness.localWrapper.updateMode,
      updateCommand: harness.localWrapper.updateCommand,
      restartRequiredAfterUpdate: harness.localWrapper.restartRequiredAfterUpdate,
      summary: `${harness.name} reported local bundle version '${normalizedBundleVersion}', which Kale could not compare with the current bundle '${harness.localWrapper.bundleVersion}'.`,
      notes: [
        "Use a simple dotted version such as 0.2.4 when reporting local wrapper versions.",
        ...harness.localWrapper.notes
      ]
    };
  }

  if (comparison < 0) {
    return {
      harnessId: harness.id,
      status: "stale",
      warning: true,
      localBundleVersion: normalizedBundleVersion,
      expectedBundleVersion: harness.localWrapper.bundleVersion,
      updateMode: harness.localWrapper.updateMode,
      updateCommand: harness.localWrapper.updateCommand,
      restartRequiredAfterUpdate: harness.localWrapper.restartRequiredAfterUpdate,
      summary: `${harness.name} reported local bundle version ${normalizedBundleVersion}, but Kale currently publishes ${harness.localWrapper.bundleVersion}. Refresh or update the local wrapper before relying on stale local guidance.`,
      notes: harness.localWrapper.notes
    };
  }

  if (comparison > 0) {
    return {
      harnessId: harness.id,
      status: "ahead",
      warning: false,
      localBundleVersion: normalizedBundleVersion,
      expectedBundleVersion: harness.localWrapper.bundleVersion,
      updateMode: harness.localWrapper.updateMode,
      updateCommand: harness.localWrapper.updateCommand,
      restartRequiredAfterUpdate: harness.localWrapper.restartRequiredAfterUpdate,
      summary: `${harness.name} reported local bundle version ${normalizedBundleVersion}, which is newer than the currently published Kale bundle ${harness.localWrapper.bundleVersion}.`,
      notes: harness.localWrapper.notes
    };
  }

  return {
    harnessId: harness.id,
    status: "current",
    warning: false,
    localBundleVersion: normalizedBundleVersion,
    expectedBundleVersion: harness.localWrapper.bundleVersion,
    updateMode: harness.localWrapper.updateMode,
    updateCommand: harness.localWrapper.updateCommand,
    restartRequiredAfterUpdate: harness.localWrapper.restartRequiredAfterUpdate,
    summary: `${harness.name} reported the current Kale bundle version ${normalizedBundleVersion}.`,
    notes: harness.localWrapper.notes
  };
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
  const connectUrl = `${input.serviceBaseUrl.replace(/\/$/, "")}/connect`;
  const { marketingName } = input;
  const livePolicyInstruction = "When Kale tools appear, call get_runtime_manifest and read dynamic_skill_policy, client_update_policy, and agent_harnesses before trusting any local guidance. Then call test_connection and use dynamicSkillPolicy, clientUpdatePolicy, harnesses, nextAction, and summary as the live source of truth.";
  const claudeSetupPrompt = `Prepare this Claude Code environment for future ${marketingName} work. The official \`kale-deploy\` plugin is already installed. Use the installed \`kale-deploy:kale-connect\` command or the plugin's \`kale-connect\` guidance to connect Kale and check what, if anything, is still needed before GitHub-backed project work can begin. Do not build an app yet. ${livePolicyInstruction} In Claude Code, do not search the MCP registry first when the local Kale plugin is installed. Start with the installed plugin guidance and \`claude mcp list\`. Use \`mcp-remote\` only to complete the browser OAuth flow: \`claude mcp remove kale -s local 2>/dev/null && claude mcp remove kale -s user 2>/dev/null && claude mcp add -s user kale -- npx -y mcp-remote ${input.mcpEndpoint} --transport http-only\`. After OAuth succeeds, replace that temporary bridge with one direct HTTP \`kale\` server by running the installed \`kale-claude-connect.mjs\` helper from the plugin cache. The ready state is one user-scope \`kale\` HTTP server at ${input.mcpEndpoint}. Do not invent \`claude mcp auth\`, \`claude mcp login\`, or \`claude mcp authenticate\` commands. Only if \`mcp-remote\` also fails, ask me to open ${connectUrl}, sign in, generate a token, and paste it back here. Before saying ${marketingName} is ready, confirm register_project is available.`;
  const codexSetupPrompt = `Prepare this Codex environment for future ${marketingName} work. The official \`kale-deploy\` add-on or bundled Kale skills are already installed. Use the installed \`kale-connect\` guidance to connect Kale and check what, if anything, is still needed before GitHub-backed project work can begin. Do not build an app yet. ${livePolicyInstruction} If Kale authentication is needed, ask me to open ${connectUrl}, sign in, generate a token, and paste it back here. Before saying ${marketingName} is ready, confirm register_project is available.`;
  const geminiSetupPrompt = `Prepare this Gemini CLI environment for future ${marketingName} work. The official \`kale-deploy\` extension or skills are already installed, and the Kale MCP server is already declared at \`.gemini/settings.json\` in the current project. Use the installed \`kale-connect\` skill to connect Kale and check what, if anything, is still needed before GitHub-backed project work can begin. Do not build an app yet. ${livePolicyInstruction} If Kale authentication is needed, ask me to open ${connectUrl}, sign in, generate a token, and paste it back here. Before saying ${marketingName} is ready, confirm register_project is available.`;

  return [
    { id: "claude", name: "Claude Code", prompt: claudeSetupPrompt, letter: "C" },
    { id: "codex", name: "Codex", prompt: codexSetupPrompt, letter: "X" },
    { id: "gemini", name: "Gemini CLI", prompt: geminiSetupPrompt, letter: "G" },
  ];
}
