import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_COMPATIBILITY_DATE = "2026-03-26";
export const DEFAULT_KALE_SERVICE_BASE_URL = "https://cuny.qzz.io/kale";
export const SUPPORTED_HARNESSES = ["claude", "codex", "gemini"];
export const SUPPORTED_SHAPES = new Set(["static", "worker"]);

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, "..");
const REPOSITORY_ROOT = path.resolve(PLUGIN_ROOT, "..", "..");

export function resolveShapeArgument(args) {
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

export function resolveOptionArgument(args, flagName) {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value) {
      continue;
    }

    if (value === flagName) {
      return args[index + 1];
    }

    if (value.startsWith(`${flagName}=`)) {
      return value.slice(flagName.length + 1);
    }
  }

  return undefined;
}

export function resolveServiceBaseUrlArgument(args) {
  return resolveOptionArgument(args, "--service-base-url") ?? DEFAULT_KALE_SERVICE_BASE_URL;
}

export function resolveHarnessArguments(args) {
  const raw = resolveOptionArgument(args, "--harness");
  if (!raw) {
    return [...SUPPORTED_HARNESSES];
  }

  const harnesses = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (harnesses.length === 0 || harnesses.some((value) => !SUPPORTED_HARNESSES.includes(value))) {
    throw new Error(`Harness must be one of: ${SUPPORTED_HARNESSES.join(", ")}.`);
  }

  return Array.from(new Set(harnesses));
}

export function assertSupportedShape(shape) {
  if (!SUPPORTED_SHAPES.has(shape)) {
    throw new Error("Shape must be one of: static, worker.");
  }
}

export function assertValidProjectName(name) {
  if (name.length > 63 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error("Project names must be lowercase kebab-case and no longer than 63 characters.");
  }
}

export function sanitizeProjectName(value) {
  const normalized = value
    .replace(/^@/u, "")
    .replace(/^[^/]+\//u, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+/u, "")
    .replace(/-+$/u, "")
    .replace(/-{2,}/gu, "-");

  return (normalized || "kale-project").slice(0, 63).replace(/-+$/u, "") || "kale-project";
}

export function inferProjectName(root, options = {}) {
  const candidates = [
    options.wranglerName,
    options.packageName,
    path.basename(root)
  ].filter(Boolean);

  for (const candidate of candidates) {
    const sanitized = sanitizeProjectName(String(candidate));
    if (sanitized) {
      return sanitized;
    }
  }

  return "kale-project";
}

export async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readTextFileIfExists(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

export async function readJsonFileIfExists(filePath) {
  const content = await readTextFileIfExists(filePath);
  if (!content) {
    return undefined;
  }

  return JSON.parse(content);
}

export async function readJsoncFileIfExists(filePath) {
  const content = await readTextFileIfExists(filePath);
  if (!content) {
    return undefined;
  }

  return parseJsonc(content);
}

export async function detectLocalBundleVersion() {
  const manifestCandidates = [
    {
      label: "Claude plugin",
      path: path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json")
    },
    {
      label: "Codex plugin",
      path: path.join(PLUGIN_ROOT, ".codex-plugin", "plugin.json")
    },
    {
      label: "Gemini extension",
      path: path.join(REPOSITORY_ROOT, "gemini-extension.json")
    }
  ];

  const manifests = [];
  for (const candidate of manifestCandidates) {
    const manifest = await readJsonFileIfExists(candidate.path);
    if (manifest?.version) {
      manifests.push({
        label: candidate.label,
        path: candidate.path,
        version: String(manifest.version)
      });
    }
  }

  const versions = Array.from(new Set(manifests.map((entry) => entry.version)));
  return {
    bundleVersion: versions[0] ?? undefined,
    consistent: versions.length <= 1,
    manifests,
    notes: versions.length <= 1
      ? []
      : [`Local Kale wrapper versions disagree: ${versions.join(", ")}.`]
  };
}

export async function fetchConnectionHealth(input = {}) {
  const normalizedBaseUrl = normalizeServiceBaseUrl(input.serviceBaseUrl);
  const url = new URL(".well-known/kale-connection.json", normalizedBaseUrl);
  if (input.harnessId) {
    url.searchParams.set("harness", input.harnessId);
  }
  if (input.localBundleVersion) {
    url.searchParams.set("localBundleVersion", input.localBundleVersion);
  }

  const response = await fetch(url, {
    signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) {
    throw new Error(`Kale connection health request failed with ${response.status}.`);
  }
  return response.json();
}

function normalizeServiceBaseUrl(serviceBaseUrl = DEFAULT_KALE_SERVICE_BASE_URL) {
  return serviceBaseUrl.endsWith("/") ? serviceBaseUrl : `${serviceBaseUrl}/`;
}

export function parseJsonc(value) {
  return JSON.parse(stripJsonComments(value));
}

export function stripJsonComments(value) {
  let output = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < value.length; index += 1) {
    const current = value[index];
    const next = value[index + 1];

    if (lineComment) {
      if (current === "\n") {
        lineComment = false;
        output += current;
      }
      continue;
    }

    if (blockComment) {
      if (current === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }

    if (inString) {
      output += current;
      if (escaped) {
        escaped = false;
        continue;
      }

      if (current === "\\") {
        escaped = true;
        continue;
      }

      if (current === "\"") {
        inString = false;
      }
      continue;
    }

    if (current === "\"") {
      inString = true;
      output += current;
      continue;
    }

    if (current === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }

    if (current === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }

    output += current;
  }

  return output;
}

export function packageJsonObject(name) {
  return {
    name,
    private: true,
    type: "module",
    scripts: {
      dev: "wrangler dev",
      check: "tsc --noEmit"
    },
    devDependencies: {
      typescript: "^6.0.2",
      wrangler: "^4.77.0"
    }
  };
}

export function packageJsonTemplate(name) {
  return stringifyJson(packageJsonObject(name));
}

export function tsconfigJsonObject() {
  return {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      noEmit: true,
      lib: ["ES2022", "DOM", "DOM.Iterable"]
    },
    include: ["src/**/*.ts"]
  };
}

export function tsconfigJsonTemplate() {
  return stringifyJson(tsconfigJsonObject());
}

export function wranglerConfigObject(name, shape, existing = {}) {
  const next = {
    ...(existing && typeof existing === "object" ? existing : {}),
    $schema: "./node_modules/wrangler/config-schema.json",
    name: existing?.name ?? name,
    main: existing?.main ?? "src/index.ts",
    compatibility_date: existing?.compatibility_date ?? DEFAULT_COMPATIBILITY_DATE
  };

  if (shape === "static") {
    next.assets = {
      ...(existing?.assets && typeof existing.assets === "object" ? existing.assets : {}),
      directory: "public"
    };
  }

  return next;
}

export function wranglerJsoncTemplate(name, shape, existing = {}) {
  const next = wranglerConfigObject(name, shape, existing);
  return stringifyJson(next);
}

export function kaleProjectObject(shape) {
  return shape === "static"
    ? {
        projectShape: "static_site",
        staticOutputDir: "public",
        requestTimeLogic: "none"
      }
    : {
        projectShape: "worker_app",
        requestTimeLogic: "allowed"
      };
}

export function kaleProjectJsonTemplate(shape) {
  return stringifyJson(kaleProjectObject(shape));
}

export function stringifyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function agentsMdTemplate(name, shape) {
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

export function claudeMdTemplate(name) {
  return `# ${name}

This repository uses \`AGENTS.md\` as the canonical project guidance.

Read \`AGENTS.md\` before making changes. Keep the app compatible with Kale Deploy on Cloudflare Workers.
`;
}

export function staticIndexHtmlTemplate(name) {
  return `<!doctype html>
<html lang="en">
  <body style="font-family: ui-sans-serif, sans-serif; padding: 2rem;">
    <h1>${name}</h1>
    <p>Your Kale Deploy site is ready to build.</p>
  </body>
</html>
`;
}

export function staticIndexTsTemplate() {
  return `export default {
  async fetch(): Promise<Response> {
    return new Response("Not found.", { status: 404 });
  }
};
`;
}

export function workerIndexTsTemplate(name) {
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

export function indexTsTemplate(name, shape) {
  return shape === "static" ? staticIndexTsTemplate() : workerIndexTsTemplate(name);
}
