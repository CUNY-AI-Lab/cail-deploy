# Codex Quickstart

Use this when you want one clean Codex-first path for Kale Deploy.

## 1. Install or connect Kale in Codex

The normal path is to install the Kale add-on shown on the Kale homepage or in
the Codex app.

If you need the manual fallback, run:

```bash
codex mcp add kale --url https://cuny.qzz.io/kale/mcp
codex mcp login kale
```

Codex will open a browser sign-in flow for Kale Deploy. Finish that sign-in,
then come back to Codex.

## 2. Confirm the connection

Ask Codex to confirm that Kale is connected and ready.

Once Kale tools are visible, Codex should call `get_runtime_manifest` and read
`dynamic_skill_policy`, `client_update_policy`, and `agent_harnesses`, then use
`test_connection` for the live `nextAction` and `summary`.

You want Codex to be able to say something definite like:

- Kale Deploy is connected and authenticated.

If Codex cannot say that yet, the connection is not really ready.

## 3. Create or connect the repo

Ask Codex to:

- create or connect the GitHub repository
- check whether Kale needs a GitHub approval step

If Codex is starting from scratch, tell it whether this should be a pure static site or a Worker app.

## 4. Approve GitHub once

If Codex gives you a GitHub link or setup page:

1. open it in the browser
2. approve the GitHub app named `Kale Deploy`
3. choose only the repository you want if GitHub offers that option

## 5. Validate before going live

Ask Codex to do a test run before going live.

That checks the build without making the site live yet.

## 6. Go live

When the repo is ready:

1. push to the default branch, usually `main`
2. ask Codex to watch until the site is live

Kale Deploy is GitHub-triggered. It does not upload a local folder directly from Codex.

## 7. What “ready” means

There are four different states that matter:

- connected: Codex can use Kale
- approved: GitHub is connected for this repo
- tested: Kale can do a build check
- live: a push has published the site successfully

Do not treat “connected” as enough by itself.
