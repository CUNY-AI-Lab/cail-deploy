# Pilot Launch Checklist

Use this checklist before inviting a new batch of Kale Deploy pilot users.

## Platform Checks

- `npm run ops:healthcheck` passes
- the public front door loads at `https://cuny.qzz.io/kale`
- the runtime manifest loads at `https://runtime.cuny.qzz.io/.well-known/kale-runtime.json`
- the AWS runner reports healthy on `readyz`
- at least one known smoke-test project is still live

## GitHub Checks

- the `Kale Deploy` GitHub App is installed and working
- a push to a test repo creates a check run
- a successful build still produces a live project URL
- a failing build still returns a useful failure summary

## Access And Identity Checks

- the current Cloudflare Access policy still matches the intended pilot cohort
- at least one real user can complete the OTP or login flow
- Codex still completes MCP OAuth cleanly
- Claude Code still works through the `/connect` token path

## Support Checks

- the student quickstart is current
- the support matrix is current
- the troubleshooting page is current
- the pilot policy is current
- one operator is available to respond when the pilot opens

## Cohort Checks

- start with a small invited group
- make sure the group knows this is a pilot
- make sure they know where to report problems
- ask at least one person to go through the flow from scratch

## After Opening The Pilot

During the first few days, track:

- where people get stuck
- whether GitHub approval is confusing
- whether agents handle setup cleanly
- whether builds fail for reasons that should be documented

If the same confusion happens twice, update the docs or UI immediately.
