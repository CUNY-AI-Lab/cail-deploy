#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  agentsMdTemplate,
  assertSupportedShape,
  claudeMdTemplate,
  fileExists,
  inferProjectName,
  indexTsTemplate,
  kaleProjectJsonTemplate,
  packageJsonObject,
  readJsonFileIfExists,
  readJsoncFileIfExists,
  readTextFileIfExists,
  resolveShapeArgument,
  staticIndexHtmlTemplate,
  stringifyJson,
  tsconfigJsonObject,
  wranglerJsoncTemplate
} from "./kale-plugin-lib.mjs";

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const refreshGuidance = args.includes("--refresh-guidance");
const replaceEntry = args.includes("--replace-entry");

const root = process.cwd();
const packageJsonPath = path.join(root, "package.json");
const wranglerPath = path.join(root, "wrangler.jsonc");
const kaleProjectPath = path.join(root, "kale.project.json");
const agentsPath = path.join(root, "AGENTS.md");
const claudePath = path.join(root, "CLAUDE.md");
const gitignorePath = path.join(root, ".gitignore");
const tsconfigPath = path.join(root, "tsconfig.json");
const entryPath = path.join(root, "src", "index.ts");

const packageJson = await readJsonFileIfExists(packageJsonPath);
const wrangler = await readJsoncFileIfExists(wranglerPath);
const kaleProject = await readJsonFileIfExists(kaleProjectPath);
const explicitShape = resolveShapeArgument(args);
if (explicitShape) {
  assertSupportedShape(explicitShape);
}

const shape = explicitShape ?? inferShape({ kaleProject, wrangler });
const projectName = inferProjectName(root, {
  wranglerName: wrangler?.name,
  packageName: packageJson?.name
});

const result = await adaptRepository({
  root,
  shape,
  projectName,
  refreshGuidance,
  replaceEntry,
  packageJson,
  wrangler
});

if (jsonMode) {
  console.log(JSON.stringify(result, null, 2));
} else {
  printResult(result);
}

async function adaptRepository(options) {
  const updates = [];
  const followUps = [];

  await mkdir(path.join(options.root, "src"), { recursive: true });
  if (options.shape === "static") {
    await mkdir(path.join(options.root, "public"), { recursive: true });
  }

  await ensureGitignore(updates);
  await ensurePackageJson(updates, options.projectName, options.packageJson);
  await ensureTsconfig(updates);
  await ensureWrangler(updates, options.projectName, options.shape, options.wrangler);
  await writeFile(kaleProjectPath, kaleProjectJsonTemplate(options.shape), "utf8");
  updates.push("Wrote kale.project.json.");

  await ensureGuidance(updates, followUps, options.projectName, options.shape, options.refreshGuidance);
  await ensureEntry(updates, followUps, options.projectName, options.shape, options.replaceEntry);

  if (options.shape === "static") {
    const staticIndexPath = path.join(options.root, "public", "index.html");
    if (!(await fileExists(staticIndexPath))) {
      await writeFile(staticIndexPath, staticIndexHtmlTemplate(options.projectName), "utf8");
      updates.push("Created public/index.html.");
    }
  }

  return {
    root: options.root,
    projectName: options.projectName,
    shape: options.shape,
    updates,
    followUps
  };
}

async function ensureGitignore(updates) {
  const desired = ["node_modules/", ".wrangler/"];
  const existing = await readTextFileIfExists(gitignorePath);
  if (!existing) {
    await writeFile(gitignorePath, `${desired.join("\n")}\n`, "utf8");
    updates.push("Created .gitignore.");
    return;
  }

  const lines = new Set(existing.split(/\r?\n/u).filter(Boolean));
  let changed = false;
  for (const line of desired) {
    if (!lines.has(line)) {
      lines.add(line);
      changed = true;
    }
  }

  if (changed) {
    await writeFile(gitignorePath, `${Array.from(lines).join("\n")}\n`, "utf8");
    updates.push("Updated .gitignore with Kale defaults.");
  }
}

async function ensurePackageJson(updates, projectName, existing) {
  const base = packageJsonObject(projectName);
  const next = existing && typeof existing === "object" ? { ...existing } : {};

  next.name ??= base.name;
  next.private ??= true;
  next.type ??= "module";
  next.scripts = {
    ...(existing?.scripts ?? {}),
    dev: existing?.scripts?.dev ?? base.scripts.dev,
    check: existing?.scripts?.check ?? base.scripts.check
  };
  next.devDependencies = {
    ...(existing?.devDependencies ?? {}),
    typescript: existing?.devDependencies?.typescript ?? base.devDependencies.typescript,
    wrangler: existing?.devDependencies?.wrangler ?? base.devDependencies.wrangler
  };

  await writeFile(packageJsonPath, stringifyJson(next), "utf8");
  updates.push(existing ? "Normalized package.json for Kale." : "Created package.json.");
}

async function ensureTsconfig(updates) {
  if (await fileExists(tsconfigPath)) {
    return;
  }

  await writeFile(tsconfigPath, stringifyJson(tsconfigJsonObject()), "utf8");
  updates.push("Created tsconfig.json.");
}

async function ensureWrangler(updates, projectName, shape, existing) {
  await writeFile(wranglerPath, wranglerJsoncTemplate(projectName, shape, existing), "utf8");
  updates.push(existing ? "Normalized wrangler.jsonc for Kale." : "Created wrangler.jsonc.");
}

async function ensureGuidance(updates, followUps, projectName, shape, refreshGuidance) {
  const agentsExists = await fileExists(agentsPath);
  if (refreshGuidance || !agentsExists) {
    await writeFile(agentsPath, agentsMdTemplate(projectName, shape), "utf8");
    updates.push(agentsExists && refreshGuidance ? "Refreshed AGENTS.md." : "Created AGENTS.md.");
  } else {
    followUps.push("AGENTS.md already existed and was left unchanged. Use --refresh-guidance to replace it.");
  }

  const claudeExists = await fileExists(claudePath);
  if (refreshGuidance || !claudeExists) {
    await writeFile(claudePath, claudeMdTemplate(projectName), "utf8");
    updates.push(claudeExists && refreshGuidance ? "Refreshed CLAUDE.md." : "Created CLAUDE.md.");
  } else {
    followUps.push("CLAUDE.md already existed and was left unchanged. Use --refresh-guidance to replace it.");
  }
}

async function ensureEntry(updates, followUps, projectName, shape, replaceEntry) {
  const entryExists = await fileExists(entryPath);
  if (!entryExists || replaceEntry) {
    await writeFile(entryPath, indexTsTemplate(projectName, shape), "utf8");
    updates.push(entryExists ? "Replaced src/index.ts with a Kale starter entrypoint." : "Created src/index.ts.");
    return;
  }

  const source = await readTextFileIfExists(entryPath);
  if (shape === "worker" && source && !source.includes("/api/health")) {
    followUps.push("Existing src/index.ts does not obviously expose /api/health. Add that route before relying on worker-shape lifecycle checks.");
  }
  if (shape === "static" && source && source.includes("/api/health")) {
    followUps.push("Existing src/index.ts still mentions /api/health. Remove request-time routes if you want shared_static eligibility.");
  }
  followUps.push("src/index.ts already existed and was left unchanged. Use --replace-entry to overwrite it with a Kale starter entrypoint.");
}

function inferShape({ kaleProject, wrangler }) {
  if (kaleProject?.projectShape === "static_site") {
    return "static";
  }
  if (kaleProject?.projectShape === "worker_app") {
    return "worker";
  }
  if (wrangler?.assets?.directory) {
    return "static";
  }
  return "worker";
}

function printResult(result) {
  console.log(`Adapted ${result.projectName} for Kale as a ${result.shape} project.`);
  console.log("");
  console.log("Changes:");
  for (const update of result.updates) {
    console.log(`- ${update}`);
  }

  if (result.followUps.length > 0) {
    console.log("");
    console.log("Follow-ups:");
    for (const followUp of result.followUps) {
      console.log(`- ${followUp}`);
    }
  }
}
