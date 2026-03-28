---
description: Scaffold a new CAIL Deploy project in the current directory.
---

Initialize a new CAIL Deploy project named `$ARGUMENTS`.

Follow this sequence:

1. Confirm the current directory is empty or nearly empty.
2. Create a CAIL Deploy starter directly in this directory. Do not clone or fetch a template repo.
3. Write:
   - `package.json`
   - `wrangler.jsonc`
   - `tsconfig.json`
   - `src/index.ts`
   - `AGENTS.md`
   - `CLAUDE.md`
   - `.gitignore`
4. Use Hono for routing.
5. Include a minimal HTML page at `/` and a JSON health route at `/api/health`.
6. Define standard CAIL binding names in code: `DB`, `FILES`, `CACHE`, `AI`, `VECTORIZE`, and `ROOMS`.
7. Keep the generated project small and editable. Avoid frameworks that add unnecessary weight.
8. Make `AGENTS.md` the canonical repo-local instructions for assistants and keep `CLAUDE.md` as a thin pointer to it.
9. Explain that production bindings are attached by the CAIL deploy service, even if local `wrangler.jsonc` only contains placeholders.
10. Do not scaffold a traditional Node server. The generated app should export a Worker-compatible request handler and must not call `app.listen(...)`.

When you finish, summarize the generated files and the next steps to deploy through GitHub.
