# Kale Release Control Plane

## Recommended CAIL fleet practice

For the colleague-facing engineering and agent-review defaults, see the [CAIL Fleet Engineering and Review Practice](https://github.com/CUNY-AI-Lab/cail-knowledge-base/pull/27). This is recommended unless this repository's own contract or CI makes a rule mandatory. Use Luna workers for bounded independent tasks and Astra for an independent review of substantial or load-bearing changes; keep one primary owner responsible for the combined result and real-path verification.

This repository owns the greenfield Kale project, immutable revision, and release contracts.

- Use Bun for installs, scripts, and tests.
- Keep Cloudflare experimental imports inside `src/adapters/cloudflare/`.
- Use the stateless `createMcpHandler` factory. Its maintained protocol negotiation serves current and 2025 stateless clients through one OAuth principal, tool dispatcher, and error boundary; do not add a second protocol implementation or protocol-session authority.
- D1 is authoritative for ownership and release history; R2 stores immutable revision and prepared bytes.
- Keep product code free of GitHub, repository, webhook, or AWS-runner
  assumptions; GitHub Actions is release plumbing only.
- Do not bind existing production resources or secrets.

## Production release guardrails

Production is a direct stateful cutover: serialize main deploys, re-check the
current main SHA after queueing, and stop stale runs before upload. Only the
push-main deploy/readback steps receive the least-privilege Cloudflare token.
Read back the exact SHA tag/message and current 100% version before accepting
the release. Smoke `/health` for ready and unauthenticated `/v1/projects` for
`401 authentication_required`. Do not add previews, percentage ramps,
migrations, or automatic rollback; stop on a failed readback or smoke.
