export const HARNESS_IDS = ["claude", "codex", "gemini"] as const;
export const HARNESS_PROMPT_PROFILES = ["current", "skill-first"] as const;
export const KALE_AGENT_BUNDLE_VERSION = "0.2.0";

export type HarnessId = typeof HARNESS_IDS[number];
export type HarnessPromptProfile = typeof HARNESS_PROMPT_PROFILES[number];
export type HarnessInstallSurface = "plugin_marketplace" | "app_add_on" | "extension";
export type HarnessInstallMode = "command" | "app_ui";
export type HarnessAuthMode = "oauth_browser" | "token_header";
export type HarnessUpdateMode = "automatic" | "manual" | "unknown";
export type HarnessWrapperKind = "plugin" | "add_on" | "extension";

export type RuntimeDynamicSkillPolicy = {
  local_bundle_role: "bootstrap_only";
  authoritative_tools: string[];
  runtime_manifest_fields: string[];
  test_connection_fields: string[];
  refresh_points: string[];
  notes: string[];
};

export type ConnectionDynamicSkillPolicy = {
  localBundleRole: "bootstrap_only";
  authoritativeTools: string[];
  runtimeManifestFields: string[];
  testConnectionFields: string[];
  refreshPoints: string[];
  notes: string[];
};

export type HarnessInstallInstruction = {
  id: HarnessId;
  name: string;
  letter: string;
  instruction: string;
  hint: string;
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
  return buildHarnessCatalog(input).map(({ id, name, letter, instruction, hint }) => ({
    id,
    name,
    letter,
    instruction,
    hint
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
        "Claude installs Kale as a local plugin bundle.",
        "The plugin install is separate from Kale MCP authentication."
      ],
      manualFallback: {
        authMode: "token_header",
        instruction: `claude mcp remove kale -s local 2>/dev/null\nclaude mcp remove kale -s user 2>/dev/null\nclaude mcp add --transport http --header "Authorization: Bearer THE_TOKEN" -s local kale ${input.mcpEndpoint}`,
        hint: "Use this only if the normal browser flow stalls",
        notes: [
          "Claude Code is currently most reliable through the token bridge when OAuth does not complete cleanly.",
          `Generate THE_TOKEN from ${connectUrl}.`
        ]
      },
      localWrapper: {
        kind: "plugin",
        packageName: "kale-deploy@cuny-ai-lab",
        bundleVersion: KALE_AGENT_BUNDLE_VERSION,
        updateMode: "manual",
        updateCommand: "claude plugins update kale-deploy@cuny-ai-lab -s local",
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

function buildInstalledHarnessSetupPrompts(input: HarnessPromptContext): HarnessSetupPrompt[] {
  const connectUrl = `${input.serviceBaseUrl.replace(/\/$/, "")}/connect`;
  const { marketingName } = input;
  const livePolicyInstruction = "When Kale tools appear, call get_runtime_manifest and read dynamic_skill_policy, client_update_policy, and agent_harnesses before trusting any local guidance. Then call test_connection and use dynamicSkillPolicy, clientUpdatePolicy, harnesses, nextAction, and summary as the live source of truth.";
  const claudeSetupPrompt = `Prepare this Claude Code environment for future ${marketingName} work. The official \`kale-deploy\` plugin is already installed. Use the installed \`kale-deploy:kale-connect\` command or the plugin's \`kale-connect\` guidance to connect Kale and check what, if anything, is still needed before GitHub-backed project work can begin. Do not build an app yet. ${livePolicyInstruction} If Kale authentication is needed, ask me to open ${connectUrl}, sign in, generate a token, and paste it back here. Before saying ${marketingName} is ready, confirm register_project is available.`;
  const codexSetupPrompt = `Prepare this Codex environment for future ${marketingName} work. The official \`kale-deploy\` add-on or bundled Kale skills are already installed. Use the installed \`kale-connect\` guidance to connect Kale and check what, if anything, is still needed before GitHub-backed project work can begin. Do not build an app yet. ${livePolicyInstruction} If Kale authentication is needed, ask me to open ${connectUrl}, sign in, generate a token, and paste it back here. Before saying ${marketingName} is ready, confirm register_project is available.`;
  const geminiSetupPrompt = `Prepare this Gemini CLI environment for future ${marketingName} work. The official \`kale-deploy\` extension or skills are already installed, and the Kale MCP server is already declared at \`.gemini/settings.json\` in the current project. Use the installed \`kale-connect\` skill to connect Kale and check what, if anything, is still needed before GitHub-backed project work can begin. Do not build an app yet. ${livePolicyInstruction} If Kale authentication is needed, ask me to open ${connectUrl}, sign in, generate a token, and paste it back here. Before saying ${marketingName} is ready, confirm register_project is available.`;

  return [
    { id: "claude", name: "Claude Code", prompt: claudeSetupPrompt, letter: "C" },
    { id: "codex", name: "Codex", prompt: codexSetupPrompt, letter: "X" },
    { id: "gemini", name: "Gemini CLI", prompt: geminiSetupPrompt, letter: "G" },
  ];
}
