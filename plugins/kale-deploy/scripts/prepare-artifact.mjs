#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\).{1,240}$/u;

function usage() {
  return "Usage: bun prepare-artifact.mjs --entrypoint <path> --compatibility-date <YYYY-MM-DD> [--root <dir>] [--source <dir>]";
}

function parseArguments(argv) {
  const values = { root: ".", source: "src" };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || !["--root", "--source", "--entrypoint", "--compatibility-date"].includes(flag)) {
      throw new Error(usage());
    }
    values[flag.slice(2).replaceAll("-", "_")] = value;
  }
  if (!values.entrypoint || !values.compatibility_date) throw new Error(usage());
  requireCompatibilityDate(values.compatibility_date);
  return values;
}

function safeRelativePath(value) {
  const normalized = value.split(path.sep).join("/");
  if (!SAFE_PATH.test(normalized) || normalized.split("/").includes(".")) {
    throw new Error(`Unsafe artifact path: ${value}`);
  }
  return normalized;
}

function requireCompatibilityDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error("Compatibility date must use YYYY-MM-DD.");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error("Compatibility date must be a real calendar date.");
  }
  return value;
}

async function collectFiles(root, directory, output) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${absolute}`);
    if (entry.isDirectory()) {
      await collectFiles(root, absolute, output);
      continue;
    }
    if (!entry.isFile()) continue;
    const relative = safeRelativePath(path.relative(root, absolute));
    const bytes = await readFile(absolute);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\u0000")) throw new Error(`Binary source is not allowed: ${relative}`);
    output[relative] = text;
  }
}

export async function prepareArtifact(input) {
  const compatibilityDate = requireCompatibilityDate(input.compatibilityDate);
  const root = await realpath(input.root);
  const source = await realpath(path.resolve(root, input.source));
  const relativeSource = path.relative(root, source);
  if (relativeSource.startsWith("..") || path.isAbsolute(relativeSource)) {
    throw new Error("Source directory must stay inside the project root.");
  }
  if (!(await stat(source)).isDirectory()) throw new Error("Source path must be a directory.");
  const entrypoint = safeRelativePath(input.entrypoint);
  const files = {};
  await collectFiles(root, source, files);
  if (!Object.hasOwn(files, entrypoint)) {
    throw new Error(`Entrypoint is not present under the source directory: ${entrypoint}`);
  }
  const artifact = {
    schemaVersion: "kale.artifact.v1",
    runtime: "worker",
    entrypoint,
    files,
    compatibility: { date: compatibilityDate, flags: [] },
    requestedBindings: [],
  };
  const bytes = Buffer.from(JSON.stringify(artifact));
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
    throw new Error(`Artifact is larger than ${MAX_ARTIFACT_BYTES} bytes.`);
  }
  const digest = createHash("sha256").update(bytes).digest();
  return {
    artifact,
    bytes,
    uploadArguments: {
      artifactBase64: bytes.toString("base64"),
      contentDigest: `sha-256=:${digest.toString("base64")}:`,
    },
    artifactDigest: digest.toString("hex"),
  };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const result = await prepareArtifact({
    root: args.root,
    source: args.source,
    entrypoint: args.entrypoint,
    compatibilityDate: args.compatibility_date,
  });
  const outputDirectory = path.resolve(args.root, ".kale");
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, "artifact.json"), result.bytes);
  await writeFile(
    path.join(outputDirectory, "upload-arguments.json"),
    JSON.stringify(result.uploadArguments),
  );
  process.stdout.write(
    `${JSON.stringify({ artifactDigest: result.artifactDigest, artifactBytes: result.bytes.byteLength, outputDirectory })}\n`,
  );
}

if (import.meta.main) {
  await main();
}
