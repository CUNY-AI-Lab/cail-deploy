#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const [, , rawName] = process.argv;

if (!rawName) {
  console.error("Usage: cail-init <project-name>");
  process.exit(1);
}

if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rawName)) {
  console.error("Project names must be lowercase kebab-case.");
  process.exit(1);
}

const root = process.cwd();
await mkdir(path.join(root, "src"), { recursive: true });

await writeFile(path.join(root, ".gitignore"), "node_modules/\n.wrangler/\n");
await writeFile(path.join(root, "package.json"), packageJson(rawName));
await writeFile(path.join(root, "tsconfig.json"), tsconfigJson());
await writeFile(path.join(root, "wrangler.jsonc"), wranglerJsonc(rawName));
await writeFile(path.join(root, "AGENTS.md"), agentsMd(rawName));
await writeFile(path.join(root, "CLAUDE.md"), claudeMd(rawName));
await writeFile(path.join(root, "src", "index.ts"), indexTs(rawName));

console.log(`Initialized ${rawName} in ${root}`);

function packageJson(name) {
  return `${JSON.stringify({
    name,
    private: true,
    type: "module",
    scripts: {
      dev: "wrangler dev",
      check: "tsc --noEmit"
    },
    dependencies: {
      hono: "^4.12.9"
    },
    devDependencies: {
      "typescript": "^6.0.2",
      "wrangler": "^4.77.0"
    }
  }, null, 2)}\n`;
}

function tsconfigJson() {
  return `${JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      noEmit: true,
      lib: ["ES2022", "DOM", "DOM.Iterable"]
    },
    include: ["src/**/*.ts"]
  }, null, 2)}\n`;
}

function wranglerJsonc(name) {
  return `{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "${name}",
  "main": "src/index.ts",
  "compatibility_date": "2026-03-26"
}
`;
}

function agentsMd(name) {
  return `# ${name}

This repository targets CAIL Deploy on Cloudflare Workers.

## What to build

- Prefer TypeScript and Hono unless there is a clear reason not to.
- Prefer small server-rendered HTML routes and lightweight JSON APIs.
- Keep the project simple and editable for collaborators who may not be deeply technical.

## Deployment assumptions

- Production bindings are attached by the CAIL Deploy service, not by this repository.
- Keep \`wrangler.jsonc\` minimal and local-development-focused.
- Run \`npm run check\` after structural changes.

## Standard binding names

- \`DB\`: D1 database
- \`FILES\`: R2 bucket or project-scoped file storage facade
- \`CACHE\`: KV namespace
- \`AI\`: Workers AI
- \`VECTORIZE\`: Vectorize index
- \`ROOMS\`: Durable Object namespace

## Guardrails

- Avoid Python, native Node modules, long-running jobs, and local filesystem assumptions.
- Do not use \`app.listen(...)\`, Express-style bootstraps, or long-lived in-memory server state.
- Prefer Workers-compatible packages.
- Use plain-language UX and error messages where possible.
`;
}

function claudeMd(name) {
  return `# ${name}

This repository uses \`AGENTS.md\` as the canonical project guidance.

Read \`AGENTS.md\` before making changes. Keep the app compatible with CAIL Deploy on Cloudflare Workers.
`;
}

function indexTs(name) {
  return `import { Hono } from "hono";

type Bindings = {
  DB?: unknown;
  FILES?: unknown;
  CACHE?: unknown;
  AI?: unknown;
  VECTORIZE?: unknown;
  ROOMS?: unknown;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/", (c) => c.html(\`<!doctype html>
<html lang="en">
  <body style="font-family: ui-sans-serif, sans-serif; padding: 2rem;">
    <h1>${name}</h1>
    <p>Your CAIL Deploy app is ready to build.</p>
  </body>
</html>\`));

app.get("/api/health", (c) => c.json({ ok: true, project: "${name}" }));

export default app;
`;
}
