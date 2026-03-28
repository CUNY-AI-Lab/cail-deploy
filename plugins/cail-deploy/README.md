# CAIL Deploy Plugin

This plugin bundles the CAIL Deploy skills, the `cail-init` command, and the
remote CAIL MCP server.

It is intended to work as a shared plugin bundle for:

- Codex
- Claude Code

The bundled MCP server lives at:

- `https://cuny.qzz.io/kale/mcp`

Authentication uses OAuth through Cloudflare Access on first connection.

## Claude Code

This repo now acts as a Claude Code plugin marketplace.

From a shell, you can install the plugin from this local checkout with:

```bash
claude plugins marketplace add /Users/stephenzweibel/Apps/CAIL-deploy
claude plugins install cail-deploy@cuny-ai-lab
```

After install, Claude Code loads the bundled `.mcp.json` and uses the remote
CAIL MCP server automatically.

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
- the repo contains the Codex marketplace entry for `cail-deploy`
- the remote MCP server completes OAuth login successfully with `codex mcp add`

What I have not yet proven is a Codex shell command for plugin marketplace
installation analogous to Claude's `claude plugins install`. In this build, the
Codex install surface appears to be the app/UI consuming the repo marketplace,
with direct MCP setup still available from the CLI:

```bash
codex mcp add cail --url https://cuny.qzz.io/kale/mcp
```
