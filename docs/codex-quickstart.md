# Codex Quickstart

Use this when you want one clean Codex-first path for Kale Deploy.

## 1. Connect Kale in Codex

Run:

```bash
codex mcp add cail --url https://cuny.qzz.io/kale/mcp
```

If Codex opens a browser, complete the CUNY sign-in flow there.

## 2. Confirm the connection

Ask Codex to call Kale Deploy's `test_connection` tool.

You want Codex to be able to say something definite like:

- Kale Deploy is connected and authenticated.

If Codex cannot say that yet, the connection is not really ready.

## 3. Create or connect the repo

Ask Codex to:

- create or connect the GitHub repository
- call `register_project`
- tell you if Kale returns a `guidedInstallUrl`

## 4. Approve GitHub once

If Codex gives you a GitHub link or setup page:

1. open it in the browser
2. approve the GitHub app named `CAIL Deploy`
3. choose only the repository you want if GitHub offers that option

## 5. Validate before going live

Ask Codex to call `validate_project`.

That checks the build without making the site live yet.

## 6. Go live

When the repo is ready:

1. push to the default branch, usually `main`
2. ask Codex to watch `get_project_status`

Kale Deploy is GitHub-triggered. It does not upload a local folder directly from Codex.

## 7. What “ready” means

There are four different states that matter:

- configured: Codex knows about the Kale MCP server
- authenticated: the browser OAuth step is complete
- deployable: the repo is registered and GitHub approval is done
- live: a push has built successfully and the project URL is serving

Do not treat “configured” as enough by itself.
