#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "packages", "deploy-service", "src", "harness-onboarding.ts");
const source = await readFile(sourcePath, "utf8");
const sourceVersion = source.match(/KALE_AGENT_BUNDLE_VERSION\s*=\s*"([^"]+)"/u)?.[1];

if (!sourceVersion) {
  fail(`Could not read KALE_AGENT_BUNDLE_VERSION from ${relative(sourcePath)}.`);
}

const checks = [
  {
    label: "Codex plugin manifest",
    path: path.join(root, "plugins", "kale-deploy", ".codex-plugin", "plugin.json"),
    readVersion: (json) => json.version
  },
  {
    label: "Claude plugin manifest",
    path: path.join(root, "plugins", "kale-deploy", ".claude-plugin", "plugin.json"),
    readVersion: (json) => json.version
  },
  {
    label: "Gemini extension manifest",
    path: path.join(root, "gemini-extension.json"),
    readVersion: (json) => json.version
  }
];

const errors = [];
for (const check of checks) {
  const json = await readJson(check.path);
  const version = check.readVersion(json);
  if (version !== sourceVersion) {
    errors.push(`${check.label} has version ${formatVersion(version)}, expected ${sourceVersion}.`);
  }
}

const runtime = await readJson(path.join(root, "platform", "runtime.json"));
const harnessVersions = Array.isArray(runtime.agent_harnesses)
  ? runtime.agent_harnesses.map((entry) => ({
    id: entry?.id,
    version: entry?.local_wrapper?.bundle_version
  }))
  : [];

if (harnessVersions.length === 0) {
  errors.push("platform/runtime.json does not contain agent_harnesses.");
}

for (const entry of harnessVersions) {
  if (entry.version !== sourceVersion) {
    errors.push(`platform/runtime.json harness ${entry.id ?? "(unknown)"} has bundle_version ${formatVersion(entry.version)}, expected ${sourceVersion}.`);
  }
}

if (errors.length > 0) {
  fail(`Kale bundle version drift detected:\n${errors.map((error) => `- ${error}`).join("\n")}`);
}

console.log(`Kale bundle version ${sourceVersion} is consistent.`);

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`Could not read ${relative(filePath)}: ${message}`);
  }
}

function formatVersion(version) {
  return version === undefined ? "(missing)" : JSON.stringify(version);
}

function relative(filePath) {
  return path.relative(root, filePath);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
