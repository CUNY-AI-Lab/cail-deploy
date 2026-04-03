---
description: Bring an existing repository into Kale Deploy shape without rebuilding it from scratch.
---

Adapt the current repository to Kale Deploy conventions.

Follow this sequence:

1. Start by diagnosing the current repo shape and readiness.
2. Prefer running the bundled script directly:
   - `node plugins/kale-deploy/scripts/kale-adapt.mjs --shape static`
   - or `node plugins/kale-deploy/scripts/kale-adapt.mjs --shape worker`
3. If the user did not specify a shape, infer the lightest one that matches the repo:
   - `static` for pure publishing/static-output repos
   - `worker` when request-time logic is clearly required
4. Normalize the repo without throwing away existing app code:
   - `package.json`
   - `wrangler.jsonc`
   - `kale.project.json`
   - `tsconfig.json`
   - `.gitignore`
   - `AGENTS.md`
   - `CLAUDE.md`
5. Preserve the existing `src/index.ts` unless the user explicitly wants a starter entrypoint or the file is missing.
6. Use `--replace-entry` only when the user wants the starter code or the current entrypoint is clearly unusable for Kale.
7. Use `--refresh-guidance` only when the user wants Kale to replace existing `AGENTS.md` or `CLAUDE.md`.
8. After adapting the repo, explain any remaining follow-up work honestly.

Example output:

```
Detected shape: worker
  created  kale.project.json
  created  wrangler.jsonc
  updated  package.json (added dev and check scripts)
  skipped  src/index.ts (already exists)
  created  AGENTS.md
  created  CLAUDE.md
```

Do not silently convert a request-time Worker app into a pure static site, and do not delete user code just to make the repo look cleaner.
