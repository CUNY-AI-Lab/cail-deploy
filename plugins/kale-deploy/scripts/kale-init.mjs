#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const [rawName, ...rawArgs] = process.argv.slice(2);

if (!rawName) {
  console.error("Usage: kale-init <project-name> --shape static|worker");
  process.exit(1);
}

const projectShape = resolveShape(rawArgs);

if (rawName.length > 63 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rawName)) {
  console.error("Project names must be lowercase kebab-case and no longer than 63 characters.");
  process.exit(1);
}

const root = process.cwd();
await mkdir(path.join(root, "src"), { recursive: true });
if (projectShape === "static") {
  await mkdir(path.join(root, "public"), { recursive: true });
}

await writeFile(path.join(root, ".gitignore"), "node_modules/\n.wrangler/\n");
await writeFile(path.join(root, "package.json"), packageJson(rawName));
await writeFile(path.join(root, "tsconfig.json"), tsconfigJson());
await writeFile(path.join(root, "wrangler.jsonc"), wranglerJsonc(rawName, projectShape));
await writeFile(path.join(root, "kale.project.json"), kaleProjectJson(projectShape));
if (projectShape === "static") {
  await writeFile(path.join(root, "public", "index.html"), staticIndexHtml(rawName));
}
await writeFile(path.join(root, "AGENTS.md"), agentsMd(rawName, projectShape));
await writeFile(path.join(root, "CLAUDE.md"), claudeMd(rawName));
await writeFile(path.join(root, "src", "index.ts"), indexTs(rawName, projectShape));

console.log(`Initialized ${rawName} in ${root} as a ${projectShape} starter`);

function resolveShape(args) {
  const explicitShape = resolveShapeArgument(args);
  if (!explicitShape) {
    console.error("Choose a starter shape with --shape static or --shape worker.");
    console.error("Usage: kale-init <project-name> --shape static|worker");
    process.exit(1);
  }

  const shape = explicitShape;
  if (shape === "static" || shape === "worker") {
    return shape;
  }

  console.error("Shape must be one of: static, worker.");
  process.exit(1);
}

function resolveShapeArgument(args) {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value) {
      continue;
    }

    if (value === "--shape") {
      return args[index + 1];
    }

    if (value.startsWith("--shape=")) {
      return value.slice("--shape=".length);
    }
  }

  return undefined;
}

function packageJson(name) {
  return `${JSON.stringify({
    name,
    private: true,
    type: "module",
    scripts: {
      dev: "wrangler dev",
      check: "tsc --noEmit"
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

function wranglerJsonc(name, shape) {
  return `{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "${name}",
  "main": "src/index.ts",
  "compatibility_date": "2026-03-26",
  ${shape === "static" ? `"assets": { "directory": "public" },` : `// Optional shared-static path:
  // "assets": { "directory": "public" },`}
  // Optional self-service storage bindings:
  // "r2_buckets": [{ "binding": "FILES", "bucket_name": "local-${name}-files" }],
  // "kv_namespaces": [{ "binding": "CACHE", "id": "local-${name}-cache" }]
}
`;
}

function kaleProjectJson(shape) {
  return `${JSON.stringify(shape === "static"
    ? {
        projectShape: "static_site",
        staticOutputDir: "public",
        requestTimeLogic: "none"
      }
    : {
        projectShape: "worker_app",
        requestTimeLogic: "allowed"
      }, null, 2)}\n`;
}

function agentsMd(name, shape) {
  return `# ${name}

This repository targets Kale Deploy on Cloudflare Workers.

## What to build

- Prefer TypeScript and the lightest Worker-compatible shape that fits the project.
- Prefer small server-rendered HTML routes and lightweight JSON APIs.
- Keep the project simple and editable for collaborators who may not be deeply technical.
${shape === "static"
    ? "- This starter is a pure static site. Do not add `/api/health`, auth, redirects, custom response headers, `_headers`, or `_redirects` unless you intentionally move it back onto a Worker lane."
    : "- This starter is a Worker app. Keep `/api/health` available unless you intentionally convert the project to a pure static site."}

## Good first app shapes

- exhibit or archive sites
- course or project sites
- guestbooks, forms, and submissions
- small APIs
- bibliographies or lightweight searchable collections

## Deployment assumptions

- Production bindings are attached by the Kale Deploy service, not by this repository.
- Keep \`wrangler.jsonc\` minimal and local-development-focused.
- Run \`npm run check\` after structural changes.
- Before asking Kale Deploy to validate or deploy, make sure this repo still has:
  - \`package.json\`
  - \`wrangler.jsonc\`
  - \`src/index.ts\`
  - a root route at \`/\`
  - ${shape === "static" ? "if this stays pure static, no request-time Worker routes or custom headers" : "`/api/health`"}

## Standard binding names

- \`DB\`: D1 database
- \`FILES\`: R2 bucket or project-scoped file storage facade
- \`CACHE\`: KV namespace
- \`AI\`: Workers AI
- \`VECTORIZE\`: Vectorize index
- \`ROOMS\`: Durable Object namespace

Current policy defaults for platform-managed bindings are:

- \`DB\`, \`FILES\`, and \`CACHE\` are self-service
- \`AI\`, \`VECTORIZE\`, and \`ROOMS\` require approval
- \`FILES\` and \`CACHE\` are attached as isolated per-project resources when the repository requests them

To request \`FILES\` or \`CACHE\`, add the standard binding names to \`wrangler.jsonc\`:

- \`r2_buckets\` with \`binding: "FILES"\`
- \`kv_namespaces\` with \`binding: "CACHE"\`

Kale replaces the production bucket and namespace values during deployment, so local placeholder values are acceptable when the repository only needs the production binding.

## Guardrails

- Avoid Python, native Node modules, long-running jobs, and local filesystem assumptions.
- Do not use \`app.listen(...)\`, Express-style bootstraps, or long-lived in-memory server state.
- Prefer Workers-compatible packages.
- Use plain-language UX and error messages where possible.
- If Kale Deploy returns a \`guidedInstallUrl\`, stop and hand that URL to the user for the GitHub approval step.
`;
}

function claudeMd(name) {
  return `# ${name}

This repository uses \`AGENTS.md\` as the canonical project guidance.

Read \`AGENTS.md\` before making changes. Keep the app compatible with Kale Deploy on Cloudflare Workers.
`;
}

function staticIndexHtml(name) {
  return `<!doctype html>
<html lang="en">
  <body style="font-family: ui-sans-serif, sans-serif; padding: 2rem;">
    <h1>${name}</h1>
    <p>Your Kale Deploy site is ready to build.</p>
  </body>
</html>
`;
}

function indexTs(name, shape) {
  return shape === "static" ? staticIndexTs() : workerIndexTs(name);
}

function staticIndexTs() {
  return `export default {
  async fetch(): Promise<Response> {
    return new Response("Not found.", { status: 404 });
  }
};
`;
}

function workerIndexTs(name) {
  return `type Bindings = {
  DB?: unknown;
  FILES?: unknown;
  CACHE?: unknown;
  AI?: unknown;
  VECTORIZE?: unknown;
  ROOMS?: unknown;
};

function renderHomePage(): string {
  return \`<!doctype html>
<html lang="en">
  <body style="font-family: ui-sans-serif, sans-serif; padding: 2rem;">
    <h1>${name}</h1>
    <p>Your Kale Deploy app is ready to build.</p>
  </body>
</html>\`;
}

export default {
  async fetch(request: Request, _env: Bindings): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/") {
      return new Response(renderHomePage(), {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }

    if (request.method === "GET" && pathname === "/api/health") {
      return Response.json({ ok: true, project: "${name}" });
    }

    return new Response("Not found.", { status: 404 });
  }
};
`;
}
