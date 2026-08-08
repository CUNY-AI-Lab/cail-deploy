# Kale Release Control Plane

This repository owns the greenfield Kale project, immutable revision, and release contracts.

- Use Bun for installs, scripts, and tests.
- Keep Cloudflare experimental imports inside `src/adapters/cloudflare/`.
- Do not introduce the deprecated `McpAgent`. Modern MCP uses the stateless `createMcpHandler` factory; the frozen MCP v1 compatibility lane and the MCP v2 lane must share the same OAuth principal, authority, payload, error, correlation, and tool-contract boundaries and must not create protocol-session authority.
- D1 is authoritative for ownership and release history; R2 stores immutable revision and prepared bytes.
- Never add GitHub, repository, webhook, or AWS-runner assumptions.
- Do not bind existing production resources or secrets.
