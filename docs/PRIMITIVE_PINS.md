# Reviewed primitive source pins

These packages are unpublished. This repository consumes reviewed local tarballs generated from exact clean commits, not a registry release or a moving sibling checkout.

| Package | Source revision | Tarball SHA-256 | Evidence |
|---|---|---|---|
| `@cuny-ai-lab/cail-identity` 4.6.0 | `68282174936e2dd08c161a48915c060ad5b0099d` | `0406fd9cdbedd0133ce7e01c0a1461eb1dedd7925a02bb3ad2e5edd714cbd29c` | Integration source acceptance `9b323c165f247916fe33795851bf510ba38e8aad` (17/17) |
| `@cuny-ai-lab/cail-log` 0.6.0 | `cb6ffc0cfd4cb544639cbf288ff6eb24c7027e98` | `8689422456eb4b7c672538ba91efb7606e9287df473a99a91ee2a60b5f9ba215` | Independent UUIDv7 source/dist/package acceptance (111/111 tests, 541 assertions); source tree `618c4bdfae0effadbe23cfd6c4dfb1fcf6440697` |

The identity tarball contains `contract/identity-jwt-claims-v1.json`. Deploy uses only the verified ownership subject and optional signed operational subject. It never derives or maps one from the other. A verified identity without `log_sub` continues the release with service-attributed operational events.

The Log tarball is the deterministic 50,269-byte package produced from the exact clean source head and tree above. Request correlation accepts canonical lowercase UUIDv4 or UUIDv7 with the IETF variant. Action, call, and usage identifiers remain UUIDv4-only.
