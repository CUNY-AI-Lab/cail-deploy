# Claude Code Quickstart

Use this when you want one clean Claude Code path for Kale Deploy.

## 1. Install the Kale Deploy plugin

Run:

```bash
claude plugins marketplace add CUNY-AI-Lab/CAIL-deploy --scope user
claude plugins install kale-deploy@cuny-ai-lab -s user
```

Then confirm the plugin is installed and enabled before you continue.

## 2. Verify the service if Claude hesitates

The public front door is:

- [https://cuny.qzz.io/kale](https://cuny.qzz.io/kale)

## 3. Connect Kale in Claude Code

Ask Claude to use the installed `kale-deploy:kale-deploy` guidance to finish
the Kale setup.

The intended path is:

- [https://cuny.qzz.io/kale/mcp](https://cuny.qzz.io/kale/mcp)

Tell Claude to:

1. use `mcp-remote`
2. complete the browser OAuth flow
3. replace the temporary bridge with one direct HTTP `kale` entry
4. verify that `test_connection` and `register_project` are available

Important:

- do not let Claude start by searching the MCP registry if the local Kale plugin is already installed
- There is no supported `claude mcp auth`, `claude mcp login`, or `claude mcp authenticate` CLI subcommand today.

## 4. Bootstrap OAuth with `mcp-remote`

For Claude Code, use `mcp-remote` only to complete the browser OAuth flow.

Run:

```bash
claude mcp remove kale -s local 2>/dev/null
claude mcp remove kale -s user 2>/dev/null
claude mcp add -s user kale -- npx -y mcp-remote https://cuny.qzz.io/kale/mcp --transport http-only
```

Complete the browser login flow first.

Important:

- do not leave this stdio bridge as the steady-state Kale connection
- the real ready state is one user-scope direct HTTP `kale` server at `https://cuny.qzz.io/kale/mcp`

## 5. Finalize Claude to direct HTTP

After `mcp-remote` finishes OAuth, replace the temporary bridge with one direct
HTTP `kale` entry by running the installed helper from the plugin cache:

```bash
KALE_PLUGIN_PATH="$(claude plugins list --json | node -e 'const fs = require("node:fs"); const plugins = JSON.parse(fs.readFileSync(0, "utf8")); const plugin = plugins.find((entry) => entry.id === "kale-deploy@cuny-ai-lab"); if (!plugin?.installPath) { process.stderr.write("Kale plugin is not installed.\n"); process.exit(1); } process.stdout.write(plugin.installPath);')"
node "$KALE_PLUGIN_PATH/scripts/kale-claude-connect.mjs" sync --mcp-endpoint https://cuny.qzz.io/kale/mcp
```

If Claude still does not surface the Kale tools in the current conversation,
restart Claude Code once and start a fresh session.

## 6. Use the token bridge only if `mcp-remote` fails

If `mcp-remote` also fails, then use the token bridge.

Open:

- [https://cuny.qzz.io/kale/connect](https://cuny.qzz.io/kale/connect)

Then:

1. sign in with your CUNY email
2. click **Generate token**
3. copy the token
4. run:

```bash
claude mcp remove kale -s local 2>/dev/null
claude mcp remove kale -s user 2>/dev/null
claude mcp add --transport http --header "Authorization: Bearer THE_TOKEN" -s user kale https://cuny.qzz.io/kale/mcp
```

Replace `THE_TOKEN` with the token you copied from the connect page.

Token caveat:

- if you want Kale working on more than one computer, reuse the same token on both machines for now
- generating a new token at `/connect` currently revokes the previous active token for that user

## 7. Confirm that Kale is really usable

Ask Claude to confirm that Kale is connected and ready.

You want Claude to be able to say something definite like:

- Kale Deploy is connected and authenticated.

If Claude cannot do that yet, the connection is not really ready.

Claude should also be able to talk about tools like `test_connection` and `register_project`, not just repeat that the server was added.

## 8. Create or connect the repo

Ask Claude to:

- create or connect the GitHub repository
- check whether Kale needs a GitHub approval step

If Claude is starting from scratch, tell it whether this should be a pure static site or a Worker app.

## 9. Approve GitHub once

If Claude gives you a GitHub link or setup page:

1. open it in the browser
2. approve the GitHub app named `Kale Deploy`
3. choose only the repository you want if GitHub offers that option

## 10. Validate before going live

Ask Claude to do a test run before going live.

That checks the build without making the site live yet.

## 11. Go live

When the repo is ready:

1. push to the default branch, usually `main`
2. ask Claude to watch until the site is live

Kale Deploy is GitHub-triggered. It does not upload a local folder directly from Claude.

## 12. Secrets use the Kale project slug

Secret tools use the Kale project name, not `owner/repo`.

Good example:

- `projectName: kale-cache-smoke-test`

Wrong example:

- `projectName: szweibel/kale-cache-smoke-test`
- `projectName: szweibel-kale-cache-smoke-test`

If you only know the repo name, ask Claude to look up the project first and use the returned project name.

## 13. Secret management adds one more GitHub step

Ordinary deploys do not need a second GitHub authorization.

When Claude reaches that path, Kale may ask you to confirm your GitHub account in the browser so it can verify that you can manage settings for the repo.
