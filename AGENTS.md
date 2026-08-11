# Kale Release Control Plane

This repository owns the greenfield Kale project, immutable revision, and release contracts.

- Use Bun for installs, scripts, and tests.
- Keep Cloudflare experimental imports inside `src/adapters/cloudflare/`.
- Do not introduce the deprecated `McpAgent`. Modern MCP uses the stateless `createMcpHandler` factory; the frozen MCP v1 compatibility lane and the MCP v2 lane must share the same OAuth principal, authority, payload, error, correlation, and tool-contract boundaries and must not create protocol-session authority.
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
