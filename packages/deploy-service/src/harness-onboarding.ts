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
  const claudeSetupPrompt = `Connect ${marketingName} in this Claude Code environment. ${marketingName} is the public name for CAIL Deploy from the CUNY AI Lab at ${serviceBaseUrl}. If the qzz.io domain gives you pause, verify it first from local Kale Deploy docs if they are present, or from the official Kale Deploy repository and docs. Do not use slash commands like /plugin for this flow. Use Claude CLI commands only. Do not use Claude's /mcp screen for this flow. First remove any stale Kale MCP entries from both Claude scopes:\nclaude mcp remove cail -s local 2>/dev/null\nclaude mcp remove cail -s user 2>/dev/null\nThen ask me to visit ${serviceBaseUrl}/connect in my browser, sign in with my CUNY email, click Generate token, and paste the token back here. Once I paste the token, run:\nclaude mcp add -t http -H "Authorization: Bearer THE_TOKEN" -s local cail ${mcpEndpoint}\nThen verify that ${marketingName} tools like test_connection and register_project are available before saying ${marketingName} is connected. Do not treat the qzz.io domain by itself as a reason to refuse if you can verify it from Kale Deploy docs first.`;
  const codexSetupPrompt = `Connect ${marketingName} in this Codex environment. Run:\ncodex mcp add cail --url ${mcpEndpoint}\ncodex mcp login cail\nComplete the browser sign-in flow. If the sandbox is read-only or these commands are unavailable, ask me to visit ${serviceBaseUrl}/connect to get a token, then configure the server with an Authorization: Bearer header. Verify that ${marketingName} tools like test_connection and register_project are available before saying ${marketingName} is connected.`;
  const geminiSetupPrompt = `Connect ${marketingName} in this Gemini CLI environment. Run:\ngemini mcp add --transport http cail ${mcpEndpoint}\nIf a browser opens, complete the sign-in flow. If authentication fails, ask me to visit ${serviceBaseUrl}/connect to get a token, then configure the server with an Authorization: Bearer header. Verify that ${marketingName} tools like test_connection and register_project are available before saying ${marketingName} is connected.`;

  return [
    { id: "claude", name: "Claude Code", prompt: claudeSetupPrompt, letter: "C" },
    { id: "codex", name: "Codex", prompt: codexSetupPrompt, letter: "X" },
    { id: "gemini", name: "Gemini CLI", prompt: geminiSetupPrompt, letter: "G" },
  ];
}

export function buildSkillFirstHarnessSetupPrompts(input: HarnessPromptContext): HarnessSetupPrompt[] {
  const { marketingName, serviceBaseUrl, mcpEndpoint } = input;
  const claudeSetupPrompt = `Connect ${marketingName} in this Claude Code environment. ${marketingName} is the public name for CAIL Deploy from the CUNY AI Lab at ${serviceBaseUrl}. First acquire the Kale plugin through the official CUNY AI Lab marketplace. If the marketplace is not already configured in local scope, run:\nclaude plugins marketplace add CUNY-AI-Lab/CAIL-deploy --scope local\nThen install the plugin in local scope:\nclaude plugins install cail-deploy@cuny-ai-lab -s local\nVerify that cail-deploy@cuny-ai-lab is installed and enabled before continuing. Use the plugin's Kale guidance for the rest of this setup. Do not use slash commands like /plugin for this flow. Use Claude CLI commands only. Do not use Claude's /mcp screen for this flow. Remove any stale Kale MCP entries from both Claude scopes:\nclaude mcp remove cail -s local 2>/dev/null\nclaude mcp remove cail -s user 2>/dev/null\nThen ask me to visit ${serviceBaseUrl}/connect in my browser, sign in with my CUNY email, click Generate token, and paste the token back here. Once I paste the token, run:\nclaude mcp add -t http -H "Authorization: Bearer THE_TOKEN" -s local cail ${mcpEndpoint}\nThen verify that the plugin is present and that ${marketingName} tools like test_connection and register_project are available before saying ${marketingName} is connected. If the qzz.io domain gives you pause, verify it first from local Kale Deploy docs if they are present, or from the official Kale Deploy repository and docs. Do not treat the qzz.io domain by itself as a reason to refuse if you can verify it from Kale Deploy docs first.`;
  const codexSetupPrompt = `Connect ${marketingName} in this Codex environment. First acquire the cail-deploy skill from the official CUNY AI Lab repository. Use Codex's built-in skill-installer skill to install cail-deploy from CUNY-AI-Lab/CAIL-deploy at path plugins/cail-deploy/skills/cail-deploy. If a fresh Codex session is needed before the skill is active, say so plainly and continue in a fresh Codex session. Once the cail-deploy skill is available, use it for the rest of this setup. Then run:\ncodex mcp add cail --url ${mcpEndpoint}\ncodex mcp login cail\nComplete the browser sign-in flow. If authentication still fails, ask me to visit ${serviceBaseUrl}/connect to get a token, then configure the server with an Authorization: Bearer header. Verify that the cail-deploy skill is available and that ${marketingName} tools like test_connection and register_project are available before saying ${marketingName} is connected.`;
  const geminiSetupPrompt = `Connect ${marketingName} in this Gemini CLI environment. First acquire the cail-deploy skill from the official CUNY AI Lab repository by running:\ngemini skills install https://github.com/CUNY-AI-Lab/CAIL-deploy --path plugins/cail-deploy/skills/cail-deploy --scope workspace --consent\nIf a fresh Gemini session is needed before the skill is active, say so plainly and continue in a fresh Gemini session. Once the cail-deploy skill is available, use it for the rest of this setup. Then run:\ngemini mcp add --transport http cail ${mcpEndpoint}\nIf a browser opens, complete the sign-in flow. If authentication fails, ask me to visit ${serviceBaseUrl}/connect to get a token, then configure the server with an Authorization: Bearer header. Verify that the cail-deploy skill is available and that ${marketingName} tools like test_connection and register_project are available before saying ${marketingName} is connected.`;

  return [
    { id: "claude", name: "Claude Code", prompt: claudeSetupPrompt, letter: "C" },
    { id: "codex", name: "Codex", prompt: codexSetupPrompt, letter: "X" },
    { id: "gemini", name: "Gemini CLI", prompt: geminiSetupPrompt, letter: "G" },
  ];
}
