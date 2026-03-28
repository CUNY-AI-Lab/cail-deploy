# Kale Deploy Pilot Policy

This page defines what Kale Deploy is for during the pilot.

## Who The Pilot Is For

The pilot is for invited CUNY students, faculty, and staff working with the CUNY AI Lab team.

It is not yet a general public hosting platform.

## What Kale Deploy Is For

Kale Deploy is for small websites and web apps built with an AI agent and published to Cloudflare Workers.

Good pilot uses:

- exhibit sites
- course sites
- forms and submission tools
- small archive or catalog interfaces
- Worker-first prototypes and teaching examples

## What Is Enabled By Default

Self-service project resources:

- `DB` for D1
- `FILES` for R2
- `CACHE` for KV

Each project gets isolated platform-managed resources instead of sharing one global bucket or namespace.

## What Requires Approval

These are not self-service by default:

- `AI`
- `VECTORIZE`
- `ROOMS`
- unusually large static asset collections
- projects that are likely to generate significant cost or abuse risk

The reason is not technical novelty by itself. The reason is operational and financial control.

## What Is Not Supported

Kale Deploy is not for:

- Python backends
- long-running Node servers
- apps that need local disk at runtime
- apps that need native binaries
- CPU-heavy background jobs
- container-style workloads

If a project cannot be shaped as a Cloudflare Worker, it is not a Kale Deploy project.

## Data And Privacy Expectations

During the pilot:

- do not store regulated, confidential, or highly sensitive data
- do not treat Kale Deploy as a production records system
- do not promise users permanent retention or uptime guarantees

Safe pilot assumption:

- public content is fine
- low-risk demo data is fine
- anything sensitive should stay out

## Reliability Expectations

This is a pilot service.

That means:

- best-effort support
- no formal SLA
- occasional manual intervention may still be needed

## Support Expectations

Pilot users should know:

- who invited them
- who to contact when something breaks
- that GitHub approval is still part of the flow

The operating team should publish one clear support contact before broadening the cohort.

## Content Expectations

Do not use Kale Deploy for:

- abusive or harassing content
- unlawful content
- deceptive impersonation
- malware or phishing

The CUNY AI Lab team should reserve the right to disable projects that create risk for users or the institution.

## Default Operator Stance

If a project is cheap, low-risk, and clearly inside the Worker shape, it should usually be allowed.

If a limit does not protect cost, safety, privacy, or operator sanity, it should not exist just for its own sake.
