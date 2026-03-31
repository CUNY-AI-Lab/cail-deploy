# Harness Onboarding Lab

This is an internal tool for testing whether Claude Code, Codex, and Gemini follow Kale Deploy onboarding directions from a fresh start.

It is not part of the public website flow.

## What It Uses

The baseline scenario is the exact harness prompt text that the Kale landing page serves today.

That prompt text now lives in:

- [harness-onboarding.ts](/Users/stephenzweibel/Apps/CAIL-deploy/packages/deploy-service/src/harness-onboarding.ts)

The public page and the internal lab both read from that same source so they do not drift.

## Run It

```bash
npm run harness:onboarding
```

Useful options:

```bash
npm run harness:onboarding -- --harness codex
npm run harness:onboarding -- --prompt-profile current
npm run harness:onboarding -- --timeout-ms 180000
npm run harness:onboarding -- --scenario-file /absolute/path/to/prompt-overrides.json
```

Outputs go under:

- `tmp/harness-onboarding/<timestamp>`

Each harness gets:

- the exact prompt it was given
- the raw run result
- postflight state checks
- a shared summary

Prompt profiles:

- `skill-first`: the current onboarding prompt text the Kale landing page serves today. It requires the harness to acquire the `cail-deploy` skill or plugin before MCP setup.
- `current`: the older pre-skill-first prompt variant, kept for comparison during rollout.

In `skill-first` runs, plain MCP connection is not enough. The lab marks the run as a failure unless it can observe the required `cail-deploy` skill or plugin after the prompt runs.

For Claude, the lab can now run the whole onboarding loop when a live Kale PAT is available from the local Claude config or `KALE_TEST_PAT`:

- start from a cleaned Claude environment
- wait for Claude to ask for the token handoff
- feed the token back into the same Claude session
- start a fresh Claude verification session
- require observable Kale-tool verification before calling the run a full success

## Fresh-State Strategy

- `codex`: isolated temp home seeded only with `~/.codex/auth.json`
- `claude`: live-home backup, cleanup, run, and restore because Claude login is not portable into an isolated temp home in this environment
- `gemini`: isolated temp home seeded with whatever Gemini auth files are present; if Gemini itself is not configured, the run is marked as a base harness auth failure rather than a Kale onboarding failure

## Alternate Directions

If the app’s onboarding directions are wrong, test a candidate rewrite without touching the website yet:

```json
{
  "claude": "New Claude onboarding prompt...",
  "codex": "New Codex onboarding prompt...",
  "gemini": "New Gemini onboarding prompt..."
}
```

Then run:

```bash
npm run harness:onboarding -- --scenario-file /absolute/path/to/overrides.json
```

That lets you compare current app directions against a proposed simpler flow before changing the product.
