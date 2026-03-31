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
  const { marketingName, serviceBaseUrl, mcpEndpoint } = input;
  const claudeSetupPrompt = `Connect ${marketingName} in this Claude Code environment. Install the official kale-deploy@cuny-ai-lab plugin from the CUNY AI Lab marketplace in local scope and confirm it is enabled. Then use the installed kale-deploy guidance for the rest of this setup instead of improvising MCP steps. Ask me to open ${serviceBaseUrl}/connect in the browser, sign in with my CUNY email, generate a token, and paste it back here. Before saying ${marketingName} is connected, verify the setup by calling test_connection and confirming register_project is available.`;
  const codexSetupPrompt = `Connect ${marketingName} in this Codex environment. Run:\ncodex mcp add kale --url ${mcpEndpoint}\ncodex mcp login kale\nComplete the browser sign-in flow. If the sandbox is read-only or these commands are unavailable, ask me to visit ${serviceBaseUrl}/connect to get a token, then configure the server with an Authorization: Bearer header. Verify that ${marketingName} tools like test_connection and register_project are available before saying ${marketingName} is connected.`;
  const geminiSetupPrompt = `Connect ${marketingName} in this Gemini CLI environment. Run:\ngemini mcp add --transport http kale ${mcpEndpoint}\nIf a browser opens, complete the sign-in flow. If authentication fails, ask me to visit ${serviceBaseUrl}/connect to get a token, then configure the server with an Authorization: Bearer header. Verify that ${marketingName} tools like test_connection and register_project are available before saying ${marketingName} is connected.`;

  return [
    { id: "claude", name: "Claude Code", prompt: claudeSetupPrompt, letter: "C" },
    { id: "codex", name: "Codex", prompt: codexSetupPrompt, letter: "X" },
    { id: "gemini", name: "Gemini CLI", prompt: geminiSetupPrompt, letter: "G" },
  ];
}

export function buildSkillFirstHarnessSetupPrompts(input: HarnessPromptContext): HarnessSetupPrompt[] {
  const { marketingName, serviceBaseUrl, mcpEndpoint } = input;
  const claudeSetupPrompt = `Connect ${marketingName} in this Claude Code environment. First acquire the official Kale Deploy plugin through the CUNY AI Lab marketplace. If the marketplace is not already configured in local scope, run:\nclaude plugins marketplace add CUNY-AI-Lab/CAIL-deploy --scope local\nThen install the plugin in local scope:\nclaude plugins install kale-deploy@cuny-ai-lab -s local\nVerify that kale-deploy@cuny-ai-lab is installed and enabled before continuing. Then use the installed kale-deploy:kale-deploy plugin guidance for the rest of this setup rather than improvising MCP steps. Ask me to open ${serviceBaseUrl}/connect in the browser, sign in with my CUNY email, generate a token, and paste it back here. Before saying ${marketingName} is connected, verify that the plugin is present, call test_connection, and confirm register_project is available.`;
  const codexSetupPrompt = `Connect ${marketingName} in this Codex environment. First acquire the kale-deploy skill from the official CUNY AI Lab repository. Use Codex's built-in skill-installer skill to install kale-deploy from CUNY-AI-Lab/CAIL-deploy at path plugins/kale-deploy/skills/kale-deploy. If a fresh Codex session is needed before the skill is active, say so plainly and continue in a fresh Codex session. Once the kale-deploy skill is available, use it for the rest of this setup. Then run:\ncodex mcp add kale --url ${mcpEndpoint}\ncodex mcp login kale\nComplete the browser sign-in flow. If authentication still fails, ask me to visit ${serviceBaseUrl}/connect to get a token, then configure the server with an Authorization: Bearer header. Verify that the kale-deploy skill is available and that ${marketingName} tools like test_connection and register_project are available before saying ${marketingName} is connected.`;
  const geminiSetupPrompt = `Connect ${marketingName} in this Gemini CLI environment. First acquire the kale-deploy skill from the official CUNY AI Lab repository by running:\ngemini skills install https://github.com/CUNY-AI-Lab/CAIL-deploy --path plugins/kale-deploy/skills/kale-deploy --scope workspace --consent\nIf a fresh Gemini session is needed before the skill is active, say so plainly and continue in a fresh Gemini session. Once the kale-deploy skill is available, use it for the rest of this setup. Then run:\ngemini mcp add --transport http kale ${mcpEndpoint}\nIf a browser opens, complete the sign-in flow. If authentication fails, ask me to visit ${serviceBaseUrl}/connect to get a token, then configure the server with an Authorization: Bearer header. Verify that the kale-deploy skill is available and that ${marketingName} tools like test_connection and register_project are available before saying ${marketingName} is connected.`;

  return [
    { id: "claude", name: "Claude Code", prompt: claudeSetupPrompt, letter: "C" },
    { id: "codex", name: "Codex", prompt: codexSetupPrompt, letter: "X" },
    { id: "gemini", name: "Gemini CLI", prompt: geminiSetupPrompt, letter: "G" },
  ];
}
