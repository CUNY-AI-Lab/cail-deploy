# Kale Deploy Plugin

This plugin bundles the Kale Deploy skills, the `kale-init` command, and the
remote Kale MCP server.

It is intended to work as a shared plugin bundle for:

- Codex
- Claude Code

The bundled MCP server lives at:

- `https://cuny.qzz.io/kale/mcp`

Authentication uses OAuth through Cloudflare Access on first connection.

## Recommended connection path

For Codex, the most reliable setup path today is the direct remote MCP
connection, because it makes the OAuth/browser handshake visible and easy to
verify:

```bash
codex mcp add kale --url https://cuny.qzz.io/kale/mcp
```

After the first browser sign-in, make sure the harness can actually see Kale
tools such as `get_repository_status` and `register_project` before you rely on
it for deployment.

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

I verified the Codex side at the packaging level:

- the plugin manifest is valid and points at the bundled `.mcp.json`
- the repo contains the Codex marketplace entry for `kale-deploy`
- the remote MCP server completes OAuth login successfully with `codex mcp add`

What I have not yet proven is a Codex shell command for plugin marketplace
installation analogous to Claude's `claude plugins install`. In this build, the
Codex install surface appears to be the app/UI consuming the repo marketplace,
so the direct MCP setup remains the recommended path:

```bash
codex mcp add kale --url https://cuny.qzz.io/kale/mcp
```
