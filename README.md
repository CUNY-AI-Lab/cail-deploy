# Kale Release Control Plane

Kale Deploy is the CUNY AI Lab's deployment MCP for Cloudflare Worker apps. An
authenticated Codex client can create a project, upload an immutable revision,
publish or approve a release, recover an ambiguous publication, preview the
latest live release, and roll back to an earlier live revision.

The production MCP endpoint is:

`https://kale-release-control-plane.ailab-452.workers.dev/mcp`

Browser authorization goes through CAIL Doorway so the normal CUNY login can
mint the private identity used by the consent page. Kale Deploy remains the
OAuth issuer and token owner.

This repository also contains the `kale-deploy` Codex plugin and its artifact
preparation helper. The plugin connects only to the institutional MCP above;
it does not use the retired GitHub-first deploy service.

Kale can publish Workers before the lab's DNS namespace is delegated. Until
that DNS work is complete, releases have an authenticated preview but no
friendly public project hostname.

Release history and ownership live in D1. Immutable revision and prepared
Worker bytes live in R2. Cloudflare Workflows performs publication into the
lab's Workers for Platforms namespace. The local Workerd/D1/R2/provider harness
crosses those same boundaries without standing in for a live publication.

## Use from Codex

Install the `kale-deploy` plugin from the repository's `cuny-ai-lab`
marketplace, authenticate its `kale` MCP server, and ask Codex to deploy a
Worker. The bundled skill validates the app, prepares exact artifact bytes, and
uses the release tools in their required order. Generated `.kale/` files are
local release material and should be ignored by the app repository.

```bash
codex plugin add kale-deploy@cuny-ai-lab
codex mcp login kale
```

## Use from Claude Code

The same `cuny-ai-lab` marketplace and `kale-deploy` plugin install into Claude
Code. Add the marketplace, install the plugin at user scope, then open `/mcp`
to complete the browser OAuth flow for the `kale` server.

```text
/plugin marketplace add CUNY-AI-Lab/cail-deploy
/plugin install kale-deploy@cuny-ai-lab
```

## Release

Merge only after the repository checks pass. Deploy is a direct production
cutover for this stateful control plane: the local Workerd/D1/R2/Workflow gate
proves the release before it reaches production. A successful release leaves
the public readiness check healthy while anonymous project creation remains
rejected.
