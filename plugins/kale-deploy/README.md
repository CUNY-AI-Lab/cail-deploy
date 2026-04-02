# Kale Deploy Plugin

This plugin bundles the Kale Deploy skills, command surfaces for starting and
repairing projects, and the remote Kale MCP server.

The local bundle is intentionally a bootstrap layer. Once Kale MCP tools are
available, agents should prefer the live runtime manifest and `test_connection`
output over any stale local install or update lore in the plugin copy. In
practice that means reading `dynamic_skill_policy`, `client_update_policy`, and
`agent_harnesses` from `get_runtime_manifest`, then using `dynamicSkillPolicy`,
`clientUpdatePolicy`, `harnesses`, `nextAction`, and `summary` from
`test_connection` as the live source of truth.

The bundled commands are:

- `kale-connect`: get the environment ready for Kale without scaffolding a repo
- `kale-init`: scaffold a new Kale starter with an explicit `static` or `worker` shape
- `kale-doctor`: inspect the current repo and report whether it is ready for Kale
- `kale-adapt`: bring an existing repo into Kale shape without rebuilding it from scratch

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

This repo also acts as a Claude Code plugin marketplace, but the tested Claude
onboarding path right now is the token flow below, not plugin installation and
not the interactive `/mcp` screen.

Open:

- `https://cuny.qzz.io/kale/connect`

Sign in with a CUNY email, click **Generate token**, and then run:

```bash
claude mcp remove kale -s local 2>/dev/null
claude mcp remove kale -s user 2>/dev/null
claude mcp add --transport http --header "Authorization: Bearer THE_TOKEN" -s local kale https://cuny.qzz.io/kale/mcp
```

Replace `THE_TOKEN` with the generated token, then ask Claude to call
`test_connection` before you rely on Kale for deployment.

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
