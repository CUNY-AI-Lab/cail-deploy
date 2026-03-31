export const HARNESS_IDS = ["claude", "codex", "gemini"] as const;
export const HARNESS_PROMPT_PROFILES = ["current", "skill-first"] as const;

export type HarnessId = typeof HARNESS_IDS[number];
export type HarnessPromptProfile = typeof HARNESS_PROMPT_PROFILES[number];

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

export function buildHarnessInstallInstructions(input: HarnessPromptContext): HarnessInstallInstruction[] {
  return buildLiveHarnessInstallInstructions(input);
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

function buildLiveHarnessInstallInstructions(input: HarnessPromptContext): HarnessInstallInstruction[] {
  const claudeInstallInstruction = `/plugin marketplace add CUNY-AI-Lab/CAIL-deploy\n/plugin install kale-deploy@cuny-ai-lab`;
  const codexInstallInstruction = `codex mcp add kale-deploy --url ${input.mcpEndpoint}`;
  const geminiInstallInstruction = `/extensions install https://github.com/CUNY-AI-Lab/CAIL-deploy`;

  return [
    { id: "claude", name: "Claude Code", instruction: claudeInstallInstruction, letter: "C", hint: "Paste inside Claude Code" },
    { id: "codex", name: "Codex", instruction: codexInstallInstruction, letter: "X", hint: "Run in your terminal" },
    { id: "gemini", name: "Gemini CLI", instruction: geminiInstallInstruction, letter: "G", hint: "Paste inside Gemini CLI" },
  ];
}

function buildInstalledHarnessSetupPrompts(input: HarnessPromptContext): HarnessSetupPrompt[] {
  const connectUrl = `${input.serviceBaseUrl.replace(/\/$/, "")}/connect`;
  const { marketingName } = input;
  const claudeSetupPrompt = `Prepare this Claude Code environment for future ${marketingName} work. The official \`kale-deploy\` plugin is already installed. Use the installed \`kale-deploy:kale-connect\` command or the plugin's \`kale-connect\` guidance to connect Kale and check what, if anything, is still needed before GitHub-backed project work can begin. Do not build an app yet. If Kale authentication is needed, ask me to open ${connectUrl}, sign in, generate a token, and paste it back here. Before saying ${marketingName} is ready, call test_connection and confirm register_project is available.`;
  const codexSetupPrompt = `Prepare this Codex environment for future ${marketingName} work. The official \`kale-deploy\` skills are already installed. Use the installed \`kale-connect\` skill to connect Kale and check what, if anything, is still needed before GitHub-backed project work can begin. Do not build an app yet. If Kale authentication is needed, ask me to open ${connectUrl}, sign in, generate a token, and paste it back here. Before saying ${marketingName} is ready, call test_connection and confirm register_project is available.`;
  const geminiSetupPrompt = `Prepare this Gemini CLI environment for future ${marketingName} work. The official \`kale-deploy\` skills are already installed, and the Kale MCP server is already declared at \`.gemini/settings.json\` in the current project. Use the installed \`kale-connect\` skill to connect Kale and check what, if anything, is still needed before GitHub-backed project work can begin. Do not build an app yet. If Kale authentication is needed, ask me to open ${connectUrl}, sign in, generate a token, and paste it back here. Before saying ${marketingName} is ready, call test_connection and confirm register_project is available.`;

  return [
    { id: "claude", name: "Claude Code", prompt: claudeSetupPrompt, letter: "C" },
    { id: "codex", name: "Codex", prompt: codexSetupPrompt, letter: "X" },
    { id: "gemini", name: "Gemini CLI", prompt: geminiSetupPrompt, letter: "G" },
  ];
}
