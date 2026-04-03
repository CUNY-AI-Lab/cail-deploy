# Kale Deploy Plugin

This plugin bundles the Kale Deploy skills, command surfaces for starting and
repairing projects, and the remote Kale MCP server.

The local bundle is intentionally a bootstrap layer. Once Kale MCP tools are
available, agents should prefer the live runtime manifest and `test_connection`
output over any stale local install or update lore in the plugin copy. In
practice that means reading `dynamic_skill_policy`, `client_update_policy`, and
`agent_harnesses` from `get_runtime_manifest`, then using `dynamicSkillPolicy`,
`clientUpdatePolicy`, `harnesses`, `nextAction`, and `summary` from
`test_connection` as the live source of truth. When the harness can determine
its wrapper metadata, it should also pass `harness` and `localBundleVersion` to
`test_connection`.

The bundled commands are:

- `kale-connect`: get the environment ready for Kale without scaffolding a repo
- `kale-init`: scaffold a new Kale starter with an explicit `static` or `worker` shape
- `kale-doctor`: inspect the current repo and report whether it is ready for Kale
- `kale-adapt`: bring an existing repo into Kale shape without rebuilding it from scratch

`kale-doctor` now checks the live Kale connection-health endpoint with the
local wrapper bundle version and reports any stale-wrapper warning alongside the
repo readiness checks.

When `kale-init` is used, it now requires an explicit starter shape:

- `--shape static` for pure publishing sites
- `--shape worker` for forms, APIs, auth, or other request-time behavior

For an existing repository, prefer `kale-doctor` first and `kale-adapt` second.
That path is meant to preserve working code while normalizing the repo for Kale.

It is intended to work as a shared plugin bundle for:

- Codex
- Claude Code

The bundled MCP server lives at:

- `https://cuny.qzz.io/kale/mcp`

Authentication uses OAuth through Cloudflare Access on first connection.

## Recommended connection path

For readiness-only setup in an existing environment, use the bundled
`kale-connect` guidance. That path is meant to get Kale connected and verified
without scaffolding a new app yet.

For Codex, the normal path is the Kale add-on install shown in the Codex app or
on the Kale homepage. That add-on bundles the same remote MCP server and Kale
guidance.

If you need a manual or CLI fallback, use the direct MCP connection:

```bash
codex mcp add kale --url https://cuny.qzz.io/kale/mcp
codex mcp login kale
```

After the first browser sign-in, make sure Codex can actually see Kale tools
such as `get_repository_status` and `register_project` before you rely on it
for deployment.

## Claude Code

This repo also acts as a Claude Code plugin marketplace. The intended Claude
path is:

1. install the local `kale-deploy` plugin bundle
2. do not let Claude start by searching the MCP registry if the local Kale plugin is already installed
3. let Claude connect to `https://cuny.qzz.io/kale/mcp`
4. use `mcp-remote` only to complete OAuth:
   `claude mcp add -s user kale -- npx -y mcp-remote https://cuny.qzz.io/kale/mcp --transport http-only`
5. let `mcp-remote` handle the browser OAuth flow
6. immediately replace the temporary bridge with one direct HTTP `kale` server:

```bash
KALE_PLUGIN_PATH="$(claude plugins list --json | node -e 'const fs = require("node:fs"); const plugins = JSON.parse(fs.readFileSync(0, "utf8")); const plugin = plugins.find((entry) => entry.id === "kale-deploy@cuny-ai-lab"); if (!plugin?.installPath) { process.stderr.write("Kale plugin is not installed.\n"); process.exit(1); } process.stdout.write(plugin.installPath);')"
node "$KALE_PLUGIN_PATH/scripts/kale-claude-connect.mjs" sync --mcp-endpoint https://cuny.qzz.io/kale/mcp
```

7. ask Claude to call `test_connection` before you rely on Kale for deployment

The real success condition is one user-scope direct HTTP `kale` server that can
surface tools in fresh Claude sessions.

If `mcp-remote` fails, use the token fallback below:

1. open `https://cuny.qzz.io/kale/connect`
2. sign in with a CUNY email
3. click **Generate token**
4. run:

```bash
claude mcp remove kale -s local 2>/dev/null
claude mcp remove kale -s user 2>/dev/null
claude mcp add --transport http --header "Authorization: Bearer THE_TOKEN" -s user kale https://cuny.qzz.io/kale/mcp
```

Replace `THE_TOKEN` with the generated token, then ask Claude to call
`test_connection`.

For secret management, use the Kale `projectName` slug rather than `owner/repo`.
If you only know the repo, call `get_repository_status` first and use the
returned `projectName`.

## Codex

The Codex plugin bundle lives in this same directory and is referenced from the
repo marketplace metadata:

- `.codex-plugin/plugin.json`
- `.mcp.json`
- `/Users/stephenzweibel/Apps/CAIL-deploy/.agents/plugins/marketplace.json`

Codex can use the same remote MCP server through the bundled plugin metadata,
and the MCP connection authenticates through the same browser-based OAuth flow.
For existing repositories, the most useful command flow is usually:

1. run `kale-doctor`
2. fix or normalize with `kale-adapt`
3. connect Kale with `kale-connect` if needed
4. register and deploy through the MCP tools

I verified the Codex side at the packaging level:

- the plugin manifest is valid and points at the bundled `.mcp.json`
- the repo contains the Codex marketplace entry for `kale-deploy`
- the remote MCP server completes OAuth login successfully with `codex mcp add` plus `codex mcp login`

Codex add-on installation is an app/UI path, not a CLI subcommand path in this
build. The manual CLI fallback is still the MCP route above.
