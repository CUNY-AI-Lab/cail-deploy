export const HARNESS_IDS = ["claude", "codex", "gemini"] as const;
export const HARNESS_PROMPT_PROFILES = ["current", "skill-first"] as const;

export type HarnessId = typeof HARNESS_IDS[number];
export type HarnessPromptProfile = typeof HARNESS_PROMPT_PROFILES[number];

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
  return buildLiveHarnessSetupPrompts(input);
}

export function buildSkillFirstHarnessSetupPrompts(input: HarnessPromptContext): HarnessSetupPrompt[] {
  return buildLiveHarnessSetupPrompts(input);
}

function buildLiveHarnessSetupPrompts(input: HarnessPromptContext): HarnessSetupPrompt[] {
  const { marketingName } = input;
  const claudeSetupPrompt = `Connect ${marketingName} in this Claude Code environment. If the CUNY AI Lab plugin marketplace is not already configured in local scope, run:\nclaude plugins marketplace add CUNY-AI-Lab/CAIL-deploy --scope local\nThen install the official plugin in local scope:\nclaude plugins install kale-deploy@cuny-ai-lab -s local\nConfirm that kale-deploy@cuny-ai-lab is installed and enabled. Then use the installed kale-deploy:kale-deploy plugin guidance for the rest of setup. Before saying ${marketingName} is ready, call test_connection and confirm register_project is available.`;
  const codexSetupPrompt = `Connect ${marketingName} in this Codex environment. Use Codex's built-in skill-installer skill to install the official kale-deploy skill from CUNY-AI-Lab/CAIL-deploy at path plugins/kale-deploy/skills/kale-deploy. Then use the installed kale-deploy skill for the rest of setup. Before saying ${marketingName} is ready, call test_connection and confirm register_project is available.`;
  const geminiSetupPrompt = `Connect ${marketingName} in this Gemini CLI environment. Run:\ngemini skills install https://github.com/CUNY-AI-Lab/CAIL-deploy --path plugins/kale-deploy/skills/kale-deploy --scope workspace --consent\nThen use the installed kale-deploy skill for the rest of setup. Before saying ${marketingName} is ready, call test_connection and confirm register_project is available.`;

  return [
    { id: "claude", name: "Claude Code", prompt: claudeSetupPrompt, letter: "C" },
    { id: "codex", name: "Codex", prompt: codexSetupPrompt, letter: "X" },
    { id: "gemini", name: "Gemini CLI", prompt: geminiSetupPrompt, letter: "G" },
  ];
}
