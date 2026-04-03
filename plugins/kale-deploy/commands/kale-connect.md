---
description: Get Kale Deploy ready in the current environment without building a new project yet.
---

Prepare this environment for future Kale Deploy work.

Follow this sequence:

1. Do not scaffold a new app or run `kale-init`.
2. Check whether Kale tools are already available.
3. If Kale tools are available, call `get_runtime_manifest` and use `dynamic_skill_policy`, `client_update_policy`, and `agent_harnesses` as the current live policy over stale local plugin guidance.
4. In Claude Code, if the local Kale plugin is installed, do not search the MCP registry first. Start with the installed plugin guidance and `claude mcp list`.
5. If Kale is not connected, connect it using the installed plugin guidance.
6. In Claude Code, use `mcp-remote` only to complete OAuth for `https://cuny.qzz.io/kale/mcp`: `claude mcp add -s user kale -- npx -y mcp-remote https://cuny.qzz.io/kale/mcp --transport http-only`.
7. After OAuth succeeds in Claude Code, immediately replace the temporary bridge with one direct HTTP `kale` server that uses `headersHelper`:

```bash
KALE_PLUGIN_PATH="$(claude plugins list --json | node -e 'const fs = require("node:fs"); const plugins = JSON.parse(fs.readFileSync(0, "utf8")); const plugin = plugins.find((entry) => entry.id === "kale-deploy@cuny-ai-lab"); if (!plugin?.installPath) { process.stderr.write("Kale plugin is not installed.\n"); process.exit(1); } process.stdout.write(plugin.installPath);')"
node "$KALE_PLUGIN_PATH/scripts/kale-claude-connect.mjs" sync --mcp-endpoint https://cuny.qzz.io/kale/mcp
```

8. The helper reads the latest valid Kale OAuth token from the `mcp-remote` cache each time Claude connects. If it later reports no valid token, rerun the bootstrap and sync steps above. Do not invent `claude mcp auth`, `claude mcp login`, or `claude mcp authenticate` commands. Only if `mcp-remote` fails, ask the user to open `https://cuny.qzz.io/kale/connect`, sign in with a CUNY email, generate a token, and paste it back.
9. After setup, call `get_runtime_manifest` and `test_connection`, then use `dynamicSkillPolicy`, `clientUpdatePolicy`, `harnesses`, `nextAction`, and `summary` from the live response. If the harness can identify its own local bundle version, pass `harness` and `localBundleVersion` to `test_connection` too so Kale can warn about stale local wrapper copy.
10. Confirm that `register_project` is available.
11. Explain any remaining GitHub step honestly. GitHub App approval is repository-specific, so if no repository exists yet, say that the environment is ready for the next project step rather than claiming every repo is already connected.
