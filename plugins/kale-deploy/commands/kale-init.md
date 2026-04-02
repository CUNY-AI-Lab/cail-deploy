---
description: Scaffold a new Kale Deploy project in the current directory.
---

Initialize a new Kale Deploy project named `$ARGUMENTS`.

Follow this sequence:

1. Confirm the current directory is empty or nearly empty.
2. If the repository already has meaningful code or config, stop and use `kale-adapt` instead of overwriting it with a fresh starter.
3. Pick the starter shape explicitly: `static` or `worker`.
4. Create a Kale Deploy starter directly in this directory. Do not clone or fetch a template repo.
5. If you are invoking `kale-init`, call it as `kale-init <project-name> --shape static|worker`.
6. Write:
   - `package.json`
   - `wrangler.jsonc`
   - `kale.project.json`
   - `tsconfig.json`
   - `src/index.ts`
   - `AGENTS.md`
   - `CLAUDE.md`
   - `.gitignore`
7. Start with the lightest Kale-compatible Worker shape that fits the chosen project shape.
8. If the project is mostly content or simple publishing, scaffold a static-first project:
   - write `kale.project.json` with `projectShape: "static_site"` and `requestTimeLogic: "none"`
   - point `wrangler.jsonc` `assets.directory` at a static folder such as `public`
   - do not add `/api/health`, auth, redirects, custom response headers, `_headers`, or `_redirects`
9. If the project is a Worker app, write `kale.project.json` with `projectShape: "worker_app"` and `requestTimeLogic: "allowed"`.
10. If the project is a Worker app, use a plain Worker handler when it cleanly covers `/` and `/api/health`. If route composition clearly helps, use Hono for routing.
11. For Worker apps, include a minimal HTML page at `/` and a JSON health route at `/api/health`.
12. Define standard Kale binding names in code: `DB`, `FILES`, `CACHE`, `AI`, `VECTORIZE`, and `ROOMS`.
13. Keep the generated project small and editable. Avoid frameworks that add unnecessary weight.
14. Make `AGENTS.md` the canonical repo-local instructions for assistants and keep `CLAUDE.md` as a thin pointer to it.
15. Explain that production bindings are attached by the Kale deploy service, even if local `wrangler.jsonc` only contains placeholders.
16. Do not scaffold a traditional Node server. The generated app should export a Worker-compatible request handler and must not call `app.listen(...)`.

When you finish, summarize the generated files and the next steps to deploy through GitHub.
