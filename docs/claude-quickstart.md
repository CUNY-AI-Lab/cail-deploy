# Claude Code Quickstart

Use this when you want one clean Claude Code path for Kale Deploy.

## 1. Add Kale to Claude Code

Run:

```bash
claude mcp add --transport http cail https://cuny.qzz.io/kale/mcp
```

## 2. Authenticate in Claude

In Claude Code itself:

1. start Claude Code normally
2. run `/mcp`
3. open `cail`
4. choose `Authenticate`

Claude will open a browser login flow for Kale Deploy.

## 3. Confirm that Kale is really usable

Ask Claude to call Kale Deploy's `test_connection` tool.

You want Claude to be able to say something definite like:

- Kale Deploy is connected and authenticated.

If Claude cannot do that yet, the connection is not really ready.

## 4. Create or connect the repo

Ask Claude to:

- create or connect the GitHub repository
- call `register_project`
- tell you if Kale returns a `guidedInstallUrl`

## 5. Approve GitHub once

If Claude gives you a GitHub link or setup page:

1. open it in the browser
2. approve the GitHub app named `CAIL Deploy`
3. choose only the repository you want if GitHub offers that option

## 6. Validate before going live

Ask Claude to call `validate_project`.

That checks the build without making the site live yet.

## 7. Go live

When the repo is ready:

1. push to the default branch, usually `main`
2. ask Claude to watch `get_project_status`

Kale Deploy is GitHub-triggered. It does not upload a local folder directly from Claude.

## 8. Secrets use the Kale project slug

Secret tools use the Kale `projectName` slug, not `owner/repo`.

Good example:

- `projectName: kale-cache-smoke-test`

Wrong example:

- `projectName: szweibel/kale-cache-smoke-test`
- `projectName: szweibel-kale-cache-smoke-test`

If you only know the repo name, ask Claude to call `get_repository_status` first and use the returned `projectName`.

## 9. Secret management adds one more GitHub step

Ordinary deploys do not need a second GitHub authorization.

Only these tools do:

- `list_project_secrets`
- `set_project_secret`
- `delete_project_secret`

When Claude reaches that path, Kale may ask you to confirm your GitHub user account in the browser so it can verify write/admin access on the repo.
