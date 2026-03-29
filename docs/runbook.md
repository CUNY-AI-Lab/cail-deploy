# Kale Deploy Runbook

This runbook is for the small team operating Kale Deploy during the pilot.

## What To Watch

Check these first when someone reports a problem:

- public front door: `https://cuny.qzz.io/kale`
- public runtime manifest: `https://runtime.cuny.qzz.io/.well-known/cail-runtime.json`
- deploy-service health: `https://cuny.qzz.io/kale/healthz`
- direct deploy-service health: `https://cail-deploy-service.ailab-452.workers.dev/healthz`
- direct gateway health: `https://cail-gateway.ailab-452.workers.dev/healthz`
- runner health on the EC2 host: `http://127.0.0.1:8080/readyz`

The fastest repeatable check is:

```bash
npm run ops:healthcheck
```

The same check also runs from GitHub Actions every hour:

- workflow: `.github/workflows/kale-healthcheck.yml`
- triggers: manual and scheduled

Required GitHub repository secrets:

- `KALE_AWS_ACCESS_KEY_ID`
- `KALE_AWS_SECRET_ACCESS_KEY`

Optional GitHub repository secret:

- `KALE_AWS_SESSION_TOKEN`

Notes:

- the scheduled GitHub Actions healthcheck currently checks the EC2 instance state, not the runner `readyz` endpoint over SSH
- keep the SSH-based `readyz` check for local/manual operator use
- if you later grant `ssm:SendCommand`, the GitHub workflow can be extended to check the runner process from inside the instance without opening SSH

If you want the script to check the runner over SSH too:

```bash
export KALE_RUNNER_HOST=54.235.218.250
export KALE_RUNNER_SSH_KEY=/Users/stephenzweibel/.ssh/kale-build-runner-us-east-1.pem
npm run ops:healthcheck
```

## Current Production Shape

- deploy-service runs on Cloudflare Workers behind `https://cuny.qzz.io/kale`
- project traffic runs on Cloudflare Workers behind `https://<project>.cuny.qzz.io`
- the build runner runs on AWS EC2 as one dispatcher container that launches disposable per-build containers
- GitHub is the source of truth for repository changes

## First Checks

When something breaks:

1. Run `npm run ops:healthcheck`.
2. Check whether GitHub shows a check run on the affected repository.
3. Check whether the runner is healthy.
4. Check whether the latest build job is `queued`, `running`, or `failed`.

## Runner Operations

SSH:

```bash
ssh -i /Users/stephenzweibel/.ssh/kale-build-runner-us-east-1.pem ec2-user@54.235.218.250
```

SSM:

```bash
aws ssm start-session --profile pdf-accessibility --region us-east-1 --target i-0a6504fec9b1bcfaf
```

Useful runner commands on the host:

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}'
curl -fsS http://127.0.0.1:8080/readyz
curl -fsS http://127.0.0.1:8080/healthz
docker logs --tail 200 cail-build-runner
docker restart cail-build-runner
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
```

If the runner is down:

1. Confirm the EC2 instance is still running.
2. Check `docker ps`.
3. Read `docker logs --tail 200 cail-build-runner`.
4. Restart the container.
5. Re-run `npm run ops:healthcheck`.

## GitHub Checks And Webhooks

If a push did not trigger deployment:

1. Open the repository on GitHub.
2. Check whether a Kale or CAIL check run exists on the latest commit.
3. If there is no check run, inspect GitHub App webhook deliveries.
4. If there is a failed check run, open the details page and inspect the failure summary.

Useful operator pages:

- `https://cuny.qzz.io/kale/github/app`
- `https://cuny.qzz.io/kale/github/install`

## Cloudflare Checks

If the control plane looks unhealthy:

1. Check `https://cuny.qzz.io/kale/healthz`.
2. Check `https://cail-deploy-service.ailab-452.workers.dev/healthz`.
3. Check `https://cail-gateway.ailab-452.workers.dev/healthz`.
4. Check `https://runtime.cuny.qzz.io/.well-known/cail-runtime.json`.
5. Check `https://cuny.qzz.io/kale/github/app` and confirm the app ID and slug are still populated.

If the project host is broken but the control plane is healthy:

1. Check the latest deployment status for that project.
2. Confirm the project host still resolves.
3. Confirm the gateway health endpoint still returns `ok`.

## Common Failure Shapes

No GitHub check run:

- webhook delivery failed
- app is not installed on that repo
- wrong branch was pushed

Build queued forever:

- runner is down
- queue polling is broken
- runner token or queue token is invalid
- disposable worker containers cannot be launched from the dispatcher

Build fails immediately:

- repo is outside the supported Worker shape
- install or build step is broken
- bindings requested by the repo are not allowed
- disposable worker image tag is missing or stale

App deployed but project host fails:

- gateway or host proxy routing issue
- deployed Worker threw at request time

## Emergency Actions

To pause new builds quickly:

1. Stop the runner container on AWS.
2. Do not stop the control plane unless the issue is broader than builds.

To stop a bad app from being publicly reachable:

1. Identify the project slug.
2. Disable or replace the deployed Worker through the control plane path.
3. If needed, delete the latest deployment record only after you understand the impact.

## After Any Incident

Write down:

- what failed
- how users noticed
- what fixed it
- what still feels manual

This pilot will only improve if the team records the rough edges.
