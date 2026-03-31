---
description: Get Kale Deploy ready in the current environment without building a new project yet.
---

Prepare this environment for future Kale Deploy work.

Follow this sequence:

1. Do not scaffold a new app or run `kale-init`.
2. Check whether Kale tools are already available.
3. If Kale is not connected, connect it using the installed plugin guidance.
4. If authentication is needed, ask the user to open `https://cuny.qzz.io/kale/connect`, sign in with a CUNY email, generate a token, and paste it back.
5. After setup, call `test_connection`.
6. Confirm that `register_project` is available.
7. Explain any remaining GitHub step honestly. GitHub App approval is repository-specific, so if no repository exists yet, say that the environment is ready for the next project step rather than claiming every repo is already connected.
