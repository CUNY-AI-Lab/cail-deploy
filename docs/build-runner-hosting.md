# Build Runner Hosting

The runner no longer needs to live on a laptop. The recommended path is a small CAIL-owned Linux VM running one long-lived dispatcher container that starts a fresh disposable build container for each job.

## Recommended host

- 2 vCPU minimum
- 4 GB RAM minimum
- 20+ GB persistent disk
- outbound HTTPS access to GitHub and Cloudflare

This is enough for one dispatcher handling the current `BUILD_BATCH_SIZE=1` default and spinning up one isolated build container at a time.

## Files

The runner deployment artifacts live in:

- `packages/build-runner/Dockerfile`
- `packages/build-runner/compose.yaml`
- `packages/build-runner/.env.runner.example`

## Setup

1. Clone this repository onto the VM.
2. Install Docker Engine and the Docker Compose plugin.
3. Copy the env template:

```bash
cd packages/build-runner
cp .env.runner.example .env.runner
```

4. Fill in:

- `QUEUES_API_TOKEN`
- `BUILD_RUNNER_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `BUILD_QUEUE_ID`
- `RUNNER_ID`
- optionally `BUILD_WORKER_IMAGE` if you do not want the default `kale-build-runner:local`

5. Start the service:

```bash
docker compose up -d --build
```

## Operations

Check health locally on the VM:

```bash
curl http://127.0.0.1:8080/readyz
curl http://127.0.0.1:8080/healthz
```

Inspect logs:

```bash
docker compose logs -f build-runner
```

Restart after env changes:

```bash
docker compose up -d --build
```

Stop the service:

```bash
docker compose down
```

## Behavior

- The runner now exposes:
  - `GET /healthz`
  - `GET /readyz`
- The long-lived container is only the dispatcher. Each build job runs in a fresh disposable container on the same host.
- Disposable build containers run without the host Docker socket, with a separate ephemeral workspace, and with only package-cache volumes shared across jobs.
- `SIGTERM` and `SIGINT` trigger a graceful shutdown. The runner stops polling, finishes the current job, and exits cleanly.
- Startup performs a host preflight for the Docker CLI, and each disposable build container performs its own preflight for `tar`, `npm`, and `corepack`.

## Notes

- The runner is independent of the public project domain. It can stay on a VM while the deploy-service sits behind a public front door like `https://cuny.qzz.io/kale`.
- The Compose file binds the health port only to `127.0.0.1`, not the public internet.
- The dispatcher needs access to `/var/run/docker.sock` so it can launch disposable build containers on the host daemon.
- The shared cache volume is for package downloads only. Project workspaces are not reused across builds.
