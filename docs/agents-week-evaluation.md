# Agents Week 2026 Evaluation

## Status

This is a planning document, not an active build.

It evaluates seven announcements from Cloudflare Agents Week 2026 (April 13–17, 2026) for their fit with Kale Deploy. Each section covers what the feature is, what it would change in this repo, the main risks, and a recommendation. Nothing here is a commitment.

The shortlist was chosen because each item either overlaps the current architecture or unblocks something already on the roadmap (`README.md` "Still not finished", `docs/custom-domains-plan.md`). The rest of Agents Week is out of scope for this doc.

## Summary

| # | Announcement | CF status | Kale fit | Effort | Recommendation |
|---|---|---|---|---|---|
| 1 | Artifacts | Private beta, public beta ~May 2026 | High | M | Pilot as build-runner mirror after public beta |
| 2 | Durable Object Facets on Dynamic Workers | Open beta | Medium | M | Evaluate only if a realtime binding is needed |
| 3 | Cloudflare Registrar API | Beta | High | S | Layer into `custom-domains-plan.md` |
| 4 | Enhanced Developer Security (scannable tokens) | GA | High | S | Audit token scopes now; adopt scannable format later |
| 5 | Managed OAuth for Access | GA | Medium | S | Skip for MCP, keep for future internal tools |
| 6 | Workflows v2 | GA | Low–Medium | L | Defer; Queues pipeline works |
| 7 | AI Platform | GA | Low–Medium | S | Route through it when `AI` binding is revisited |

Effort legend: S ≈ days, M ≈ one to two weeks, L ≈ several weeks.

## 1. Artifacts

### What it is

Git-compatible versioned storage built on Durable Objects and R2. Agents create repos programmatically, import from existing Git remotes, clone over standard HTTPS Git, and fork from a known-good starting point with blobless clones that mount in 10–15 seconds. Pricing in beta is $0.15 per 1,000 operations (first 10k free) and $0.50 per GB-month (first 1 GB free).

### Current Kale state

- Source control is GitHub-only. `packages/deploy-service` registers repos via the shared GitHub App; pushes to the default branch trigger a webhook.
- `packages/build-runner` pulls from GitHub on every build.
- Rollback keeps only the latest two successful deploy bundles per project in R2 (`README.md` Archive Policy).

### What would change

Import every Kale-connected GitHub repo into an Artifacts mirror on registration and re-import on webhook push. The build runner clones from the Artifacts mirror instead of GitHub.

- Faster cold clones, especially with blobless clone on large repos.
- Removes GitHub API rate limits from the build hot path.
- Build continues to work during GitHub incidents.
- Opens the door to git-native rollback and per-commit deploy attribution via `git-notes`, replacing the "last two bundles" R2 policy.
- Long-term, enables an "agent-only, no GitHub" onboarding lane that would close the "no human GitHub approval step" gap from `README.md`.

### Risks

- Public beta only arrives around May 2026. Too new to depend on for the pilot.
- Two sources of truth must stay in sync. Import lag would be a user-visible defect, especially around force-pushes and rebases.
- Import semantics for non-fast-forward updates are not yet documented in depth.
- Deepens Cloudflare coupling, which is probably acceptable for this stack but worth naming.

### Recommendation

Track until public beta lands. First experiment once GA: an optional `ARTIFACTS_MIRROR` flag in `deploy-service` that imports on registration and re-imports on webhook push, with the build runner preferring the Artifacts URL and falling back to GitHub. Validate against the existing `npm run ops:lifecycle-smoke` runner before touching real projects. Defer the "no GitHub" onboarding lane to a separate product decision.

## 2. Durable Object Facets on Dynamic Workers

### What it is

A Dynamic Worker can instantiate Durable Object classes at runtime, each with its own isolated SQLite database. A "supervisor" DO dynamically loads code through a Worker Loader binding and calls `this.ctx.facets.get()` to mount a facet. Open beta on Workers Paid.

### Current Kale state

- Projects get `DB` (D1), `FILES` (R2), and `CACHE` (KV) self-service (`AGENTS.md`).
- No Durable Object binding is provisioned today.
- `ROOMS` is listed in the binding vocabulary but treated as approval-only.

### What would change

Facets are the right primitive for two things Kale is missing today:

1. **Per-project realtime state.** A project-scoped DO namespace backing a future `REALTIME` or `ROOMS` binding, suitable for RWSDK `useSyncedState`, collaborative editors, presence, and similar use cases.
2. **Dynamically loaded project code with isolated SQLite.** If Kale ever moves away from Workers-for-Platforms dispatch and towards runtime-loaded per-project code, facets become the natural isolation primitive.

Neither is required by anything on the current roadmap.

### Risks

- Open beta, not GA. Observability and debugging for facets are still maturing.
- Per-project Durable Object namespaces interact with Workers-for-Platforms dispatch in ways that need explicit verification.
- The supervisor pattern is a conceptual shift from today's straightforward WfP deploys.

### Recommendation

Not urgent. Revisit when there is a concrete user request for realtime features, and at that point evaluate facets as the backing primitive for a new approval-only binding. Otherwise skip.

## 3. Cloudflare Registrar API (beta)

### What it is

Programmatic domain search, availability check, and at-cost registration for a curated TLD set. Exposed through Cloudflare's MCP so agents like Claude Code or Cursor can drive the end-to-end flow. Pricing: registry-cost passthrough with WHOIS privacy included. Beta covers initial registration only; renewals, transfers, and contact updates are planned.

### Current Kale state

- `docs/custom-domains-plan.md` describes a planned flow using Cloudflare for SaaS custom hostnames, assuming the user already owns the domain somewhere.
- There is no path today to register a new domain from inside Kale.
- Public URLs today are Kale-managed labels on `*.cuny.qzz.io`.

### What would change

An agent walking a student through project setup could:

1. Suggest project names.
2. Call the Registrar API to check availability across `.app`, `.dev`, `.com`, etc.
3. Present the price for explicit confirmation.
4. Register the domain at cost.
5. Attach it to the project through the planned custom-hostnames flow.

This turns `custom-domains-plan.md` from a "bring your own domain" story into a "pick and attach a domain in one flow" story.

### Risks

- Beta, limited TLD coverage.
- Real money is involved. Students must not accidentally register paid domains. A price-confirm step is mandatory.
- Renewal and transfer are not in the beta, so we would need to document that ownership eventually lives in the buyer's Cloudflare account.
- Adds a billing surface that Kale does not handle today.

### Recommendation

Good alignment with `custom-domains-plan.md`. Add an optional "register a new domain" branch to that plan, behind explicit project-admin confirmation with price clearly shown. Keep it scoped to the curated Cloudflare TLD set until the API matures. Low implementation effort, meaningful user-visible upside.

## 4. Enhanced Developer Security (scannable tokens, GA)

### What it is

Three new Cloudflare token formats with a `cf` prefix and checksum, designed for credential-scanner detection:

- User API Key: `cfk_[40 chars][checksum]`
- User API Token: `cfut_[40 chars][checksum]`
- Account API Token: `cfat_[40 chars][checksum]`

Plus OAuth application visibility, resource-scoped RBAC (Access apps, IdPs, policies, service tokens, targets), and GitHub-partnership automated revocation when a token leaks publicly. Existing tokens stay valid; rolling to the new format is opt-in.

### Current Kale state

- Kale issues its own MCP bearer tokens as `kale_pat_*` values (`README.md`).
- The GitHub App has its own tokens for webhook handling and check runs.
- Several Cloudflare account tokens power the deploy-service, gateway, host-proxy, and build runner; scopes have not been recently audited.
- No GitHub secret-scanner integration for Kale-issued tokens.

### What would change

Two actions, independent of each other:

1. **Resource-scoped audit of Cloudflare account tokens.** Narrow each token to just the resources it touches (specific Workers scripts, KV namespaces, D1 databases, R2 buckets). Pure good-hygiene, requires no product changes.
2. **Scannable format for `kale_pat_*`.** Add a checksum suffix to future Kale tokens and register the pattern with GitHub's secret-scanning partner program. If a student accidentally commits a Kale token, GitHub notifies `deploy-service`, which can auto-revoke through a new internal endpoint. Existing tokens remain valid through a rotation window.

### Risks

- Scanner registration is a public commitment. Getting the regex or checksum wrong leaks more than it protects.
- Rotation path for live MCP sessions needs thinking — revoking an in-use token mid-session should give a clean error, not a mysterious 401.
- Secret-scanner partnership process for non-core issuers may take time.

### Recommendation

Start the resource-scoped audit now. It is independent of every other item in this doc and it closes a real attack surface.

Design the scannable `kale_pat_` format as a v2 item. Implement it once the GitHub scanner onboarding is documented for external issuers. No rush.

## 5. Managed OAuth for Access (GA)

### What it is

Cloudflare Access can now implement RFC 9728 discovery. A protected endpoint returns `WWW-Authenticate` pointing to `/.well-known/oauth-authorization-server`; agents run the OAuth flow programmatically and authenticate as the invoking human, not as a service account. Human browser flows stay unchanged.

### Current Kale state

- Kale already runs full MCP OAuth 2.1 via `@cloudflare/workers-oauth-provider` in `deploy-service` — DCR, refresh rotation, bearer validation, KV-backed grants (`README.md`).
- Cloudflare Access gates the browser-facing authorize endpoint only; it does not touch the MCP surface.
- `docs/cloudflare-access-auth.md` documents the current setup.

### What would change

Very little for the public MCP surface. Kale already implements OAuth end-to-end with user attribution; switching to Managed OAuth would duplicate infrastructure that already works.

Where it might help later: any new internal tool that needs agent access but is not worth building a bespoke OAuth surface for — for example, a future per-project caps admin UI (`README.md` "Still not finished") or an operator dashboard. Managed OAuth is the shortest path there.

### Risks

- Two OAuth surfaces in the same stack (Managed Access + `workers-oauth-provider`) would confuse both agents and operators.
- Managed Access discovery metadata may diverge from what existing MCP tooling expects.

### Recommendation

Skip for the MCP surface. Keep it in mind for future internal admin tools that otherwise would need their own OAuth.

## 6. Workflows v2 (GA)

### What it is

Rearchitected durable-execution control plane. A new SousChef component manages metadata for subsets of instances; a Gatekeeper leases concurrency slots across SousChefs. Resulting limits:

| | v1 | v2 |
|---|---|---|
| Concurrent instances | 4,500 | 50,000 |
| Creation rate | 100 per 10s | 300 per second |
| Queued per workflow | 1M | 2M |

Migration was zero-downtime; existing Workflows users see the new ceilings automatically.

### Current Kale state

- Build pipeline is deploy-service webhook → Cloudflare Queue → AWS build runner pulls jobs → callback with artifact metadata.
- No Workflows usage today. No durable-execution primitives in the control plane.

### What would change

Workflows could replace the Queue and callback pattern with a durable workflow per deploy: clone → install → build → upload → classify → promote or deploy. Failure handling becomes explicit compensating steps instead of implicit runner retries.

### Risks

- The build itself still needs real compute. Workflows orchestrates steps; it does not execute `npm install`. The AWS runner does not go away.
- Migrating a working pipeline to Workflows is multi-week work for behavior users will not see.
- Running two orchestration stacks during migration is risky; must commit or skip.

### Recommendation

Defer. The current Queue pipeline works and scales for the pilot. Revisit only if a future change introduces multi-stage coordination (parallel builds, split plan/apply, long-running validation) where Workflow semantics add clarity.

## 7. AI Platform (GA)

### What it is

AI Gateway expanded into a unified inference layer: 70+ models across 12+ providers (OpenAI, Anthropic, Google, Alibaba, Bytedance, others). The same `env.AI.run()` binding used for Workers AI now calls third-party models with a one-line change. Unified credits consolidate billing; custom metadata enables per-request cost attribution. A public REST API is planned for non-Workers environments.

### Current Kale state

- `AI` listed in the binding vocabulary as approval-only (`AGENTS.md`).
- No projects currently use `AI`.
- Pilot policy (`docs/pilot-policy.md`) is conservative on AI access.

### What would change

When Kale eventually promotes `AI` toward wider availability, route through AI Platform rather than binding Workers AI directly:

- One API across providers, so students can prototype against Claude, GPT, Gemini, or open-source under a single budget.
- Per-project cost attribution through metadata headers, which plugs into the existing approval-and-caps model.
- Provider swaps without code changes, reducing lock-in for project code.

### Risks

- Third-party providers mean real dollars per request. Caps must be strict and enforced before any self-service promotion.
- Approval policy in `docs/pilot-policy.md` assumes Workers AI semantics and would need a refresh.
- Credit consolidation ties Cloudflare billing to AI provider spend in ways that should be understood before exposing to projects.

### Recommendation

Small change, high future value. When the `AI` binding is next revisited, design the platform shape around AI Platform with per-project metadata, not raw Workers AI. Update `platform/runtime.md` to document that intent when the change lands. Until then, no action.

## Prioritized next steps

In order of low-risk and high-value first:

1. **Resource-scoped Cloudflare account token audit** (§4). Independent of everything else; pure hygiene.
2. **Draft a registrar-integrated addendum** to `docs/custom-domains-plan.md` (§3). Low effort; unblocks a visible user feature once Registrar API matures.
3. **Prototype an Artifacts mirror** (§1) after public beta lands in May 2026. Gate behind an `ARTIFACTS_MIRROR` flag and validate with `npm run ops:lifecycle-smoke` before any project depends on it.
4. **Document AI Platform intent** in `platform/runtime.md` (§7) when the `AI` binding self-service question is next reopened.

Deferred:

- Workflows v2 (§6) — wait for multi-stage coordination need.
- Managed OAuth for Access (§5) — not duplicative work on MCP.
- Durable Object Facets (§2) — wait for a concrete realtime use case.

## Open questions

- How does Artifacts import handle non-fast-forward updates, force-pushes, and rebases? Does a re-import mirror the new state or fail loudly?
- Can Workers for Platforms dispatch bind per-project Durable Object namespaces cleanly, or does every realtime project need its own WfP dispatch entry? (Affects §2.)
- What is the GitHub secret-scanner onboarding path for non-core token issuers like `kale_pat_`? (Affects §4.)
- Does the Registrar API expose DNSSEC, at-cost renewal, or contact updates today, or only initial registration? (Affects §3.)
- Does AI Platform pass through provider-specific features such as Anthropic prompt caching, tool use, and structured outputs without degradation? (Affects §7.)

## Sources

- [Welcome to Agents Week](https://blog.cloudflare.com/welcome-to-agents-week/)
- [Artifacts: versioned storage that speaks Git](https://blog.cloudflare.com/artifacts-git-for-agents-beta/)
- [Durable Object Facets in Dynamic Workers](https://blog.cloudflare.com/durable-object-facets-dynamic-workers/)
- [Cloudflare Registrar API beta](https://blog.cloudflare.com/registrar-api-beta/)
- [Securing non-human identities](https://blog.cloudflare.com/improved-developer-security/)
- [Managed OAuth for Access](https://blog.cloudflare.com/managed-oauth-for-access/)
- [Workflows v2](https://blog.cloudflare.com/workflows-v2/)
- [AI Platform](https://blog.cloudflare.com/ai-platform/)
