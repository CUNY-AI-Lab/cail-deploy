# Codex

Use this file when Kale needs to be connected or reconnected in Codex.

## Preferred path

Prefer the installed Kale plugin path first when it is available in Codex
(Codex 0.121.0+ supports plugin marketplaces).

If Kale is not yet installed, add the Kale marketplace from your shell:

```bash
codex marketplace add CUNY-AI-Lab/CAIL-deploy
```

Then open Codex, run `/plugins`, search for Kale Deploy, and install it.

The plugin install registers the Kale skills and the kale MCP server. Complete
the browser sign-in flow, then verify that Kale tools actually appear before
relying on deployment guidance.

If you are on a Codex build older than 0.121.0 (no plugin marketplace), use the
direct MCP connection instead:

```bash
codex mcp add kale --url https://cuny.qzz.io/kale/mcp
codex mcp login kale
```

## What to check

- `codex mcp list`
- Kale tools such as `get_runtime_manifest`, `test_connection`, and `register_project`

## Fallback

If the OAuth flow does not complete cleanly, use the token-paste fallback:

1. Send the user to `https://cuny.qzz.io/kale/connect`
2. Tell them to sign in with a CUNY email
3. Ask them to paste back the generated token
4. Configure Codex with a static `Authorization: Bearer <the-token>` header if the harness supports that path
