# Reviewed primitive source pins

These packages are unpublished. This repository consumes reviewed local tarballs generated from exact clean commits, not a registry release or a moving sibling checkout.

| Package | Source revision | Tarball SHA-256 | Evidence |
|---|---|---|---|
| `@cuny-ai-lab/cail-identity` 4.6.0 | `68282174936e2dd08c161a48915c060ad5b0099d` | `0406fd9cdbedd0133ce7e01c0a1461eb1dedd7925a02bb3ad2e5edd714cbd29c` | Integration source acceptance `9b323c165f247916fe33795851bf510ba38e8aad` (17/17) |
| `@cuny-ai-lab/cail-log` 0.6.0 | `482b2a102fddac589d6db8a03cbea171df819872` | `7c638f58dd8e38736200050f00288cae2f9773011f00d8cf0ec22919bc52fa9e` | Integration source acceptance `54d26fe33761432bf9c7772f303b9d1cee84a7d5` |

The identity tarball contains `contract/identity-jwt-claims-v1.json`. Deploy uses only the verified ownership subject and optional signed operational subject. It never derives or maps one from the other. A verified identity without `log_sub` continues the release with service-attributed operational events.
