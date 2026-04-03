---
description: Get Kale Deploy ready in the current environment without building a new project yet.
---

Prepare this environment for future Kale Deploy work.

Follow this sequence:

1. Do not scaffold a new app or run `kale-init`.
2. Check whether Kale tools are already available.
3. If Kale tools are available, call `get_runtime_manifest` — live policy overrides local guidance.
4. If Kale is not connected, follow the harness-specific connection steps in the `kale-connect` skill's "What to do" and "Agent notes" sections.
5. After setup, call `get_runtime_manifest` and `test_connection`. Use the live response fields for next steps.
6. Confirm that `register_project` is available.
7. Explain any remaining GitHub step honestly. GitHub App approval is repository-specific, so if no repository exists yet, say the environment is ready rather than claiming every repo is already connected.
