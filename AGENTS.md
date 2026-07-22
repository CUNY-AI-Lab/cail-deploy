# Kale Release Control Plane

This repository owns the greenfield Kale project, immutable revision, and release contracts.

- Use Bun for installs, scripts, and tests.
- Keep Cloudflare experimental imports inside `src/adapters/cloudflare/`.
- D1 is authoritative for ownership and release history; R2 stores immutable revision and prepared bytes.
- Never add GitHub, repository, webhook, or AWS-runner assumptions.
- Test resources must use the run ID recorded in `resources/manifest.json` and workers.dev ingress only.
- Do not bind existing production resources or secrets.

