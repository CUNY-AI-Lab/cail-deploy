#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  agentsMdTemplate,
  assertSupportedShape,
  assertValidProjectName,
  claudeMdTemplate,
  fileExists,
  indexTsTemplate,
  kaleProjectJsonTemplate,
  packageJsonTemplate,
  resolveShapeArgument,
  staticIndexHtmlTemplate,
  tsconfigJsonTemplate,
  wranglerJsoncTemplate
} from "./kale-plugin-lib.mjs";

const [rawName, ...rawArgs] = process.argv.slice(2);
const force = rawArgs.includes("--force");

if (!rawName) {
  console.error("Usage: kale-init <project-name> --shape static|worker");
  process.exit(1);
}

const projectShape = resolveShape(rawArgs);

try {
  assertValidProjectName(rawName);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const root = process.cwd();
const targetFiles = [
  ".gitignore",
  "package.json",
  "tsconfig.json",
  "wrangler.jsonc",
  "kale.project.json",
  "AGENTS.md",
  "CLAUDE.md",
  path.join("src", "index.ts"),
  ...(projectShape === "static" ? [path.join("public", "index.html")] : [])
];

if (!force) {
  const existingTargets = [];
  for (const target of targetFiles) {
    if (await fileExists(path.join(root, target))) {
      existingTargets.push(target);
    }
  }

  if (existingTargets.length > 0) {
    console.error("kale-init refuses to overwrite existing project files:");
    for (const target of existingTargets) {
      console.error(`- ${target}`);
    }
    console.error("Run kale-adapt for existing repositories, or pass --force to replace these files.");
    process.exit(1);
  }
}

await mkdir(path.join(root, "src"), { recursive: true });
if (projectShape === "static") {
  await mkdir(path.join(root, "public"), { recursive: true });
}

await writeFile(path.join(root, ".gitignore"), "node_modules/\n.wrangler/\n");
await writeFile(path.join(root, "package.json"), packageJsonTemplate(rawName));
await writeFile(path.join(root, "tsconfig.json"), tsconfigJsonTemplate());
await writeFile(path.join(root, "wrangler.jsonc"), wranglerJsoncTemplate(rawName, projectShape));
await writeFile(path.join(root, "kale.project.json"), kaleProjectJsonTemplate(projectShape));
if (projectShape === "static") {
  await writeFile(path.join(root, "public", "index.html"), staticIndexHtmlTemplate(rawName));
}
await writeFile(path.join(root, "AGENTS.md"), agentsMdTemplate(rawName, projectShape));
await writeFile(path.join(root, "CLAUDE.md"), claudeMdTemplate(rawName));
await writeFile(path.join(root, "src", "index.ts"), indexTsTemplate(rawName, projectShape));

console.log(`Initialized ${rawName} in ${root} as a ${projectShape} starter`);

function resolveShape(args) {
  const explicitShape = resolveShapeArgument(args);
  if (!explicitShape) {
    console.error("Choose a starter shape with --shape static or --shape worker.");
    console.error("Usage: kale-init <project-name> --shape static|worker");
    process.exit(1);
  }

  try {
    assertSupportedShape(explicitShape);
    return explicitShape;
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
