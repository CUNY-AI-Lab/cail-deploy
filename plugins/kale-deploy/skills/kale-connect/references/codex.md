# Codex

Use this file when Kale needs to be connected or reconnected in Codex.

## Preferred path

Prefer the installed Kale add-on path first when it is available in the Codex app.

If you need the CLI path, use the direct MCP connection:

```bash
codex mcp add kale --url https://cuny.qzz.io/kale/mcp
codex mcp login kale
```

Complete the browser sign-in flow, then verify that Kale tools actually appear before relying on deployment guidance.

## What to check

- `codex mcp list`
- Kale tools such as `get_runtime_manifest`, `test_connection`, and `register_project`

## Fallback

If the OAuth flow does not complete cleanly, use the token-paste fallback:

1. Send the user to `https://cuny.qzz.io/kale/connect`
2. Tell them to sign in with a CUNY email
3. Ask them to paste back the generated token
4. Configure Codex with a static `Authorization: Bearer <the-token>` header if the harness supports that path
