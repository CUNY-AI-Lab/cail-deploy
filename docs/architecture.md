# Architecture Notes

## Why GitHub-first

The deployment product should look like a GitHub integration, not like a CLI.

- Students install a GitHub App.
- A push to `main` creates a deployment.
- GitHub shows success or failure directly on the commit.

That mirrors the developer experience people already understand from Vercel and Netlify.

## Why not Dynamic Workers for MVP

Dynamic Workers and Sandboxes are useful for code previews and generated-code execution, but they are not required for the stable hosting path.

For the first version:

- published apps live as Workers for Platforms user Workers
- the gateway routes traffic by project slug
- the control plane provisions bindings and uploads the built Worker artifact

## Control-plane responsibilities

The deploy service owns:

- GitHub App authentication
- installation access token exchange
- check-run lifecycle management
- push webhook intake for the repository default branch
- control-plane state in D1
- webhook idempotency and build job tracking
- bounded rollback archival in R2
- project name registration
- per-project D1 creation
- user Worker upload to the dispatch namespace
- runner dispatch through Cloudflare Queues and callback handling

The student repository owns:

- source code
- build configuration

## Build execution decision

Builds should happen on a CAIL-owned runner, not in student GitHub Actions.

- The product goal is install-the-app and push, not install-the-app and then author workflow YAML.
- The deploy service can keep GitHub credentials, Cloudflare credentials, and deployment policy centralized.
- Cloudflare Workers are a good control plane, but not the right place to run arbitrary Node-based build pipelines.
- A managed runner keeps the public UX aligned with Vercel and Netlify while letting the control plane remain Worker-based.

For MVP, the deploy-service webhook creates the check run, dispatches a build job to the runner, and accepts a callback with the built Worker bundle plus deployment metadata.

## Durability and recovery

Avoid treating KV as the source of truth for deployment state.

- Project registration, build jobs, and deployment history should live in a control-plane D1 database.
- Each successful deployment should have a bounded rollback artifact in R2, and failed deployments should retain only lightweight manifests briefly.
- R2 should be a rollback cache, not an infinite archive. Keep only the newest successful bundles needed for rollback and a short-lived window of failed deployment manifests.
- Gateway reads should only expose projects with a successful latest deployment, so a reserved slug or failed deploy does not surface as a live app.
- The runner should receive build jobs via Cloudflare Queues so transient runner downtime does not turn a GitHub webhook into a lost build.

## Assistant adapter responsibilities

The assistant layer should:

- scaffold compatible projects
- steer code generation toward Hono and Workers-compatible patterns
- encode the runtime constraints that reduce deploy failures

The assistant layer should not be the only place the platform contract exists.
