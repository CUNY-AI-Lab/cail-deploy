---
description: Inspect the current repository and report whether it is ready for Kale Deploy.
---

Diagnose this repository for Kale Deploy readiness.

Follow this sequence:

1. Treat this as a read-first command. Do not rewrite files unless the user explicitly asks for a fix after the diagnosis.
2. Prefer running the bundled script directly:
   - `node plugins/kale-deploy/scripts/kale-doctor.mjs`
   - if the user wants machine-readable output, use `--json`
   - the script now also checks the live Kale wrapper freshness automatically; use `--harness claude|codex|gemini` to narrow that check if needed
3. Report the detected project name and shape (`static` or `worker`).
4. Call out whether the repo has the minimum Kale files:
   - `package.json`
   - `wrangler.jsonc`
   - `kale.project.json`
   - `src/index.ts`
   - `AGENTS.md`
   - `CLAUDE.md`
5. For static projects, check whether `_headers` or `_redirects` exists and explain that those keep the project on the dedicated Worker lane today.
6. For Worker projects, check whether `src/index.ts` appears to expose `GET /api/health`.
7. Summarize the result as pass, warn, or fail.
8. If the repo is missing Kale structure, recommend `kale-adapt` rather than rebuilding the project from scratch.
9. If the script reports a stale local wrapper, tell the user the exact update command it returned.

When you finish, give the user:

- the detected shape
- the blocking issues, if any
- the next concrete command or file edits to make
