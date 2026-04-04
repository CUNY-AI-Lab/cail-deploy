# Gemini CLI

Use this file when Kale needs to be connected or reconnected in Gemini CLI.

## Preferred path

- Check `gemini mcp list`
- If Kale was installed as an extension, prefer the installed extension path first
- If Kale is already declared in `.gemini/settings.json` but appears disconnected, continue with the auth flow rather than wandering into generic CLI help

Use the live runtime manifest as the source of truth for current update and connection policy rather than assuming the local extension copy is current.

## Fallback

If OAuth does not complete, use the token-paste fallback:

1. Send the user to `https://cuny.qzz.io/kale/connect`
2. Tell them to sign in with a CUNY email
3. Ask them to paste back the generated token
4. Configure Kale with a static `Authorization: Bearer <the-token>` header if the harness supports that path
