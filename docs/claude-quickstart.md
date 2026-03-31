# Claude Code Quickstart

Use this when you want one clean Claude Code path for Kale Deploy.

## 1. Verify the service if Claude hesitates

Kale Deploy is the public name for CAIL Deploy from the CUNY AI Lab.

The public front door is:

- [https://cuny.qzz.io/kale](https://cuny.qzz.io/kale)

If Claude hesitates because `qzz.io` is unfamiliar, have it verify that URL against the official Kale Deploy repository or docs first.

## 2. Generate a Kale token

Open:

- [https://cuny.qzz.io/kale/connect](https://cuny.qzz.io/kale/connect)

Then:

1. sign in with your CUNY email
2. click **Generate token**
3. copy the token

## 3. Add Kale to Claude Code with the token

Run:

```bash
claude mcp remove cail -s local 2>/dev/null
claude mcp remove cail -s user 2>/dev/null
claude mcp add --transport http --header "Authorization: Bearer THE_TOKEN" -s local cail https://cuny.qzz.io/kale/mcp
```

Replace `THE_TOKEN` with the token you copied from the connect page.

That cleanup avoids stale Claude config shadowing the new server entry.

Do not use Claude's interactive `/mcp` screen for this flow right now. The token path is the reliable Claude path.

## 4. Confirm that Kale is really usable

Ask Claude to confirm that Kale is connected and ready.

You want Claude to be able to say something definite like:

- Kale Deploy is connected and authenticated.

If Claude cannot do that yet, the connection is not really ready.

Claude should also be able to talk about tools like `test_connection` and `register_project`, not just repeat that the server was added.

## 5. Create or connect the repo

Ask Claude to:

- create or connect the GitHub repository
- check whether Kale needs a GitHub approval step

## 6. Approve GitHub once

If Claude gives you a GitHub link or setup page:

1. open it in the browser
2. approve the GitHub app named `CAIL Deploy`
3. choose only the repository you want if GitHub offers that option

## 7. Validate before going live

Ask Claude to do a test run before going live.

That checks the build without making the site live yet.

## 8. Go live

When the repo is ready:

1. push to the default branch, usually `main`
2. ask Claude to watch until the site is live

Kale Deploy is GitHub-triggered. It does not upload a local folder directly from Claude.

## 9. Secrets use the Kale project slug

Secret tools use the Kale project name, not `owner/repo`.

Good example:

- `projectName: kale-cache-smoke-test`

Wrong example:

- `projectName: szweibel/kale-cache-smoke-test`
- `projectName: szweibel-kale-cache-smoke-test`

If you only know the repo name, ask Claude to look up the project first and use the returned project name.

## 10. Secret management adds one more GitHub step

Ordinary deploys do not need a second GitHub authorization.

When Claude reaches that path, Kale may ask you to confirm your GitHub account in the browser so it can verify that you can manage settings for the repo.
