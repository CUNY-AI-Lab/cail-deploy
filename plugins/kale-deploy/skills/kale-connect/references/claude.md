# Claude Code

Use this file when Kale needs to be connected or reconnected in Claude Code.

## Working path

The preferred Claude path is:

1. bootstrap OAuth with `mcp-remote`
2. immediately replace that temporary bridge with one user-scope direct HTTP `kale` server
3. let `headersHelper` read and refresh the latest valid Kale OAuth token

The steady-state success condition is one user-scope direct HTTP `kale` server at:

- `https://cuny.qzz.io/kale/mcp`

Do not treat the temporary `mcp-remote` bridge as the final ready state.

## Bootstrap OAuth

```bash
claude mcp remove kale -s local 2>/dev/null
claude mcp remove kale -s user 2>/dev/null
claude mcp add -s user kale -- npx -y mcp-remote https://cuny.qzz.io/kale/mcp --transport http-only
```

Let `mcp-remote` handle the browser OAuth flow.

## Finalize to the steady state

```bash
KALE_PLUGIN_PATH="$(claude plugins list --json | node -e 'const fs = require("node:fs"); const plugins = JSON.parse(fs.readFileSync(0, "utf8")); const plugin = plugins.find((entry) => entry.id === "kale-deploy@cuny-ai-lab"); if (!plugin?.installPath) { process.stderr.write("Kale plugin is not installed.\n"); process.exit(1); } process.stdout.write(plugin.installPath);')"
node "$KALE_PLUGIN_PATH/scripts/kale-claude-connect.mjs" sync --mcp-endpoint https://cuny.qzz.io/kale/mcp
```

That helper rewrites Claude to the direct HTTP `kale` server and configures `headersHelper`.

## Important constraints

- Do not invent `claude mcp auth`, `claude mcp login`, or `claude mcp authenticate` commands.
- If the local Kale plugin is installed, do not start by searching the MCP registry.
- If the helper reports that no valid Kale OAuth or refresh token exists, rerun the bootstrap and sync steps.

## Last-resort token path

Only use this if the OAuth bootstrap path fails completely.

1. Send the user to `https://cuny.qzz.io/kale/connect`
2. Tell them to sign in with a CUNY email
3. Ask them to paste back the `kale_pat_...` token
4. Configure Kale with:

```bash
claude mcp remove kale -s local 2>/dev/null
claude mcp remove kale -s user 2>/dev/null
claude mcp add -t http -H "Authorization: Bearer <the-token>" -s user kale https://cuny.qzz.io/kale/mcp
```
