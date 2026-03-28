# Support Matrix

CAIL Deploy is not meant to run every kind of software project.

The supported category is:

- web applications that can run on Cloudflare Workers

This matrix is the practical guide.

## Works Well

These are good fits and should usually deploy cleanly.

- Hono apps
- static sites with a small API
- Worker-first TypeScript or JavaScript apps
- D1-backed forms, guestbooks, catalogs, and small data apps
- projects that use `request.formData()` and render HTML directly
- Worker-compatible framework adapters that already target Cloudflare cleanly

Examples:

- exhibit site
- course project site
- archive browser
- bibliography or submission form
- lightweight AI interface

## Works With Adaptation

These can work, but usually need code changes.

- existing JavaScript repos without a Wrangler config
- front-end projects that need a Worker entrypoint added
- repos using traditional Node libraries for routing but not depending on `app.listen(...)`
- projects that assume root-relative URLs and need cleanup for deployment assumptions
- apps that need storage moved from local files into D1 or R2

Typical changes:

- add `wrangler.jsonc`
- move to a Worker request handler
- replace `app.listen(...)`
- use D1/R2/KV instead of local disk
- remove unsupported Node packages

## Not Supported

These are outside the intended shape.

- Python backends
- Express, Koa, Fastify, or similar long-running Node server apps without a Worker-specific rewrite
- native Node modules or binary addons
- apps that require child processes at runtime
- apps that depend on sockets or a persistent server process
- projects that need a writable local filesystem
- CPU-heavy or long-running background jobs
- container-style workloads

Examples:

- Django, Flask, FastAPI
- a typical Express server with `app.listen(...)`
- apps that spawn FFmpeg or LibreOffice during requests
- projects that store runtime state in files on disk

## Language And Runtime Rules

Supported:

- TypeScript
- JavaScript

Preferred:

- Hono
- server-rendered HTML
- small JSON APIs

Avoid:

- Python
- native binaries
- heavy SPA stacks unless clearly needed

## Storage Rules

Use:

- `DB` for D1
- `FILES` for R2
- `CACHE` for KV

Do not assume:

- local SQLite files
- writing application state to disk
- persistent process memory

## URL And Hosting Rules

Public apps live on host-based URLs:

- `https://<project-name>.cuny.qzz.io`

That means apps should behave like a normal site at the host root.

Good:

- `href="styles.css"`
- `fetch("api/entries")`
- `action="submit"`

Risky:

- code that assumes a totally different host or deployment model

## What To Do If You Are Unsure

Ask:

- “Can this run as a Cloudflare Worker?”

If the answer is not clearly yes, start from `CAIL-init` and port only the pieces you need.
