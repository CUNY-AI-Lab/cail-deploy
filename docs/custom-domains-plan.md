# Future Custom Domains Plan

## Status

This is a planning document, not an active build.

Kale Deploy now has first-pass **Kale-managed URL labels** and redirects under `*.cuny.qzz.io`. That work stays in place. It gives us:

- a stable internal project identity that is no longer tied to the public hostname
- redirect and canonical-host logic in the gateway
- a Domains section in project settings

What it does **not** do yet is the thing users actually care about:

- attaching a domain they already control, such as `course.gc.cuny.edu` or `project.example.org`

That future feature is what this document describes.

## Goal

Let a project admin attach a user-owned hostname to a Kale Deploy project, verify control of that hostname, activate it safely, and optionally make it the canonical public URL.

## Non-goals for the first pass

- automatic DNS creation at third-party DNS providers
- apex-domain support on day one
- importing or managing user TLS certificates manually
- arbitrary URL masking or iframe-style forwarding
- replacing the existing Kale URL labels and redirects

## Why the current groundwork still matters

The recently added `project_domains` feature is still useful even though it is not the final custom-domain feature.

It already solved two real problems:

- public URL changes no longer require the underlying Worker/script name to change
- old public URLs can redirect to the new canonical host cleanly

That means custom domains can be layered on top of the current routing model instead of forcing another project-identity redesign.

## Proposed platform shape

The right underlying product is **Cloudflare for SaaS custom hostnames** on the `cuny.qzz.io` zone account.

High-level flow:

1. Kale creates a Cloudflare custom hostname record for the user-entered domain.
2. Kale stores the Cloudflare hostname id plus verification and status fields in the control plane.
3. Kale shows the user the DNS record Cloudflare requires.
4. Once Cloudflare marks the hostname active, Kale routes that hostname to the project.
5. The project admin chooses whether the custom domain is canonical or whether the Kale URL remains canonical.

This keeps the deployment runtime the same:

- deploy-service remains the control plane
- project-host-proxy remains the public hostname entry point
- gateway-worker remains the place that resolves `Host -> project`

## Cloudflare prerequisites

Before implementation, the `cuny.qzz.io` zone account needs:

- Cloudflare for SaaS / Custom Hostnames enabled
- a fallback origin configuration suitable for Worker-based routing
- wildcard Worker routing for hostname dispatch

Cloudflare’s current guidance is to use a wildcard route like `*/*` on the SaaS zone and let the Worker dispatch based on hostname. That is a good fit for Kale because the public proxy is already doing host-based routing.

## Data model

The current `project_domains` table is not enough by itself. It tracks Kale-managed labels, not full external hostnames or Cloudflare lifecycle state.

The next durable model should be a generalized hostname table, for example `project_hostnames`, with fields along these lines:

- `hostname`
- `project_name`
- `github_repo`
- `hostname_kind`
  - `kale_label`
  - `custom_hostname`
- `is_primary`
- `redirect_to_hostname`
- `status`
  - `pending_dns`
  - `pending_validation`
  - `active`
  - `error`
  - `removed`
- `cloudflare_custom_hostname_id`
- `ownership_verification_json`
- `ssl_validation_json`
- `verification_errors_json`
- `created_at`
- `updated_at`

The most important design rule is:

- routing should be keyed by the **visible hostname**
- deployment identity should stay keyed by the stable internal `project_name`

## Routing changes

The current routing path assumes Kale-managed hostnames under `*.cuny.qzz.io`. True custom domains require a broader host lookup.

### `project-host-proxy`

The public proxy needs to accept arbitrary incoming hostnames that Cloudflare forwards to the zone, not only `*.cuny.qzz.io`.

It should:

- preserve the original `Host`
- preserve the current public-routing headers
- forward custom-domain traffic into the same internal gateway flow

### `gateway-worker`

The gateway should resolve routes by exact hostname first:

1. look up the incoming hostname in the generalized hostname table
2. decide whether it is:
   - primary
   - redirecting
   - inactive
3. route to the stable internal project worker

The existing redirect/canonical-host logic for Kale labels should be reused rather than reimplemented.

## Control-plane changes

### New deploy-service responsibilities

The deploy service would add Cloudflare custom-hostname lifecycle management:

- create custom hostname
- fetch custom hostname details
- refresh status
- remove custom hostname

The control plane should store Cloudflare’s returned verification records and surface them in project settings without making users leave Kale to understand what to do next.

### Verification flow

When a project admin enters a custom domain, Kale should:

1. validate the hostname locally
2. create the Cloudflare custom hostname record
3. store the returned hostname id and verification details
4. show the required DNS record
5. poll or refresh status until Cloudflare marks it active

Cloudflare’s API exposes both ownership-verification data and certificate/DCV status. Kale should treat those as status inputs, not as opaque blobs hidden from the UI.

## Project settings UX

The browser control panel is the right home for this feature.

Recommended first-pass UI:

- a `Custom domains` section inside project settings
- one form to add a hostname
- a status card per hostname
- the exact DNS record to create
- a `Refresh status` action
- a `Make primary` action
- a `Remove` action

The page should also make one thing explicit:

- the existing Kale URL stays available unless the admin explicitly chooses to redirect it

That makes rollout safer and gives users a fallback while DNS propagates.

## Security and authorization

Custom domains should use the same project-admin gate as secrets:

- Cloudflare Access proves the user is a CUNY-authenticated person
- GitHub repo-admin verification proves the user may administer that project

Kale should never attach a hostname to a project just because someone typed it into a form. A hostname is only usable once Cloudflare says ownership validation and certificate provisioning are in a good state.

## Recommended first shipping scope

Keep the first real custom-domain release narrow:

- support subdomains and other hostnames that can point by `CNAME`
- support one canonical custom domain per project at first
- keep the Kale URL as fallback
- allow optional redirect from Kale URL to custom domain

Defer these until later:

- apex domains
- multiple active custom domains per project
- automatic DNS provider integrations
- organization-wide bulk domain management

## Rollout plan

### Phase 0: current groundwork

Keep the current Kale-label and redirect feature as-is.

### Phase 1: generalized hostname state

- add a generalized hostname table
- migrate existing `project_domains` rows into that model
- update gateway lookups to use hostname-first resolution

### Phase 2: Cloudflare integration

- add custom-hostname create/get/delete calls in deploy-service
- store returned ids and verification payloads
- add status refresh helpers

### Phase 3: control-panel UI

- add custom-domain entry and status cards
- show DNS instructions
- allow canonical/redirect selection

### Phase 4: limited pilot

- enable for a small set of projects
- start with subdomains, not apex domains
- document operator troubleshooting before wider rollout

## Open questions

- Do we allow any domain, or only institutional domains by default?
- Do we want one custom domain per project at first, or a small fixed limit?
- Should the custom domain become canonical automatically once active, or require a second confirmation click?
- How much operator support do we want to provide for DNS debugging?
- Do we eventually fold `project_domains` into `project_hostnames`, or keep Kale labels and external hostnames in separate tables?

## Sources

- Cloudflare for SaaS overview: https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/
- Hostname routing for Workers for Platforms: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/get-started/hostname-routing/
- Worker as fallback origin: https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/
- Create custom hostnames: https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/create-custom-hostnames/
- Hostname validation: https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/
- Custom Hostnames API: https://developers.cloudflare.com/api/resources/custom_hostnames/
