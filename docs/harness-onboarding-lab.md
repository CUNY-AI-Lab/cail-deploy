# Harness Onboarding Lab

This is an internal tool for testing whether Claude Code, Codex, and Gemini follow Kale Deploy onboarding directions from a fresh start.

It is not part of the public website flow.

## What It Uses

The public landing page and the harness both read from the same onboarding module, but they now use different parts of it:

- the website uses the per-agent install instructions
- the harness uses a smaller post-install bootstrap prompt

That shared source lives in:

- [harness-onboarding.ts](/Users/stephenzweibel/Apps/CAIL-deploy/packages/deploy-service/src/harness-onboarding.ts)

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

- `current`: the current post-install Kale bootstrap prompt the lab uses after the local Kale wrapper is already present
- `skill-first`: currently a compatibility alias of `current`, kept so older lab commands still run

The lab now treats install as setup, not as the graded step. It preinstalls the local Kale plugin, skill, or extension for the harness first, then grades the smaller post-install bootstrap flow: connect Kale, handle any browser or token handoff, and call a real Kale tool.

For Claude, the lab can now run the whole onboarding loop when a live Kale PAT is available from the local Claude config or `KALE_TEST_PAT`:

- start from a cleaned Claude environment
- preinstall the local `kale-deploy` wrapper for that harness
- wait for Claude to ask for the token handoff
- feed the token back into the same Claude session
- start a fresh Claude verification session
- require observable Kale-tool verification before calling the run a full success

## Fresh-State Strategy

- `codex`: isolated temp home seeded only with `~/.codex/auth.json`
- `codex`: isolated temp home seeded only with `~/.codex/auth.json`, plus the local `kale-deploy` skill
- `claude`: live-home backup, cleanup, local plugin install, run, and restore because Claude login is not portable into an isolated temp home in this environment
- `gemini`: isolated temp home seeded with whatever Gemini auth files are present, plus the local `kale-deploy` guidance; if Gemini itself is not configured, the run is marked as a base harness auth failure rather than a Kale onboarding failure

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

## Recurring Regression Workflow

The repo now includes:

- [.github/workflows/kale-harness-onboarding.yml](/Users/stephenzweibel/Apps/CAIL-deploy/.github/workflows/kale-harness-onboarding.yml)

That workflow is intentionally self-hosted. It assumes the runner already has:

- `codex`, `claude`, and `gemini` installed
- those harnesses already logged in locally
- a `KALE_TEST_PAT` GitHub Actions secret for the Kale token handoff

The scheduled run stays off until the repository variable below is enabled:

- `KALE_HARNESS_ONBOARDING_ENABLED=true`

Without a self-hosted runner and that variable, use the local `npm run harness:onboarding` path instead of expecting GitHub-hosted runners to produce a meaningful signal.
