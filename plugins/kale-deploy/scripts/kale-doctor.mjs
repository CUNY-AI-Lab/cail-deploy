#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import {
  detectLocalBundleVersion,
  fileExists,
  fetchConnectionHealth,
  inferProjectName,
  readJsonFileIfExists,
  readJsoncFileIfExists,
  readTextFileIfExists,
  resolveHarnessArguments,
  resolveServiceBaseUrlArgument
} from "./kale-plugin-lib.mjs";

const root = process.cwd();
const args = process.argv.slice(2);
const jsonMode = process.argv.includes("--json");
const serviceBaseUrl = resolveServiceBaseUrlArgument(args);
const harnesses = resolveHarnessArguments(args);

const report = await buildReport(root, {
  serviceBaseUrl,
  harnesses
});

if (jsonMode) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.summary.failCount > 0 ? 1 : 0);
}

printReport(report);
process.exit(report.summary.failCount > 0 ? 1 : 0);

async function buildReport(cwd, options) {
  const packageJsonPath = path.join(cwd, "package.json");
  const wranglerPath = path.join(cwd, "wrangler.jsonc");
  const kaleProjectPath = path.join(cwd, "kale.project.json");
  const agentsPath = path.join(cwd, "AGENTS.md");
  const claudePath = path.join(cwd, "CLAUDE.md");
  const entryPath = path.join(cwd, "src", "index.ts");

  const packageJson = await readJsonFileIfExists(packageJsonPath);
  const wrangler = await readJsoncFileIfExists(wranglerPath);
  const kaleProject = await readJsonFileIfExists(kaleProjectPath);
  const entrySource = await readTextFileIfExists(entryPath);

  const projectName = inferProjectName(cwd, {
    wranglerName: wrangler?.name,
    packageName: packageJson?.name
  });
  const declaredShape = shapeFromManifest(kaleProject);
  const inferredShape = inferShape({ kaleProject, wrangler });
  const shape = declaredShape ?? inferredShape ?? "worker";
  const staticDir = kaleProject?.staticOutputDir ?? wrangler?.assets?.directory ?? "public";
  const staticIndexPath = path.join(cwd, staticDir, "index.html");
  const headersPath = path.join(cwd, staticDir, "_headers");
  const redirectsPath = path.join(cwd, staticDir, "_redirects");

  const checks = [];
  checks.push(makeCheck("package-json", await fileExists(packageJsonPath) ? "pass" : "fail", "package.json", await fileExists(packageJsonPath)
    ? "package.json is present."
    : "package.json is missing."));
  checks.push(makeCheck("wrangler", wrangler ? "pass" : "fail", "wrangler.jsonc", wrangler
    ? "wrangler.jsonc is present and parseable."
    : "wrangler.jsonc is missing or invalid JSONC."));
  checks.push(makeCheck("kale-project", kaleProject ? "pass" : "fail", "kale.project.json", kaleProject
    ? "kale.project.json is present."
    : "kale.project.json is missing."));
  checks.push(makeCheck("guidance", (await fileExists(agentsPath)) && (await fileExists(claudePath)) ? "pass" : "warn", "Repo guidance", (await fileExists(agentsPath)) && (await fileExists(claudePath))
    ? "AGENTS.md and CLAUDE.md are present."
    : "AGENTS.md or CLAUDE.md is missing."));

  if (packageJson) {
    checks.push(makeCheck(
      "scripts",
      packageJson?.scripts?.dev && packageJson?.scripts?.check ? "pass" : "warn",
      "npm scripts",
      packageJson?.scripts?.dev && packageJson?.scripts?.check
        ? "package.json includes both dev and check scripts."
        : "package.json should include dev and check scripts."
    ));
  }

  if (shape === "static") {
    checks.push(makeCheck(
      "static-index",
      await fileExists(staticIndexPath) ? "pass" : "fail",
      "Static index",
      await fileExists(staticIndexPath)
        ? `${relativeLabel(cwd, staticIndexPath)} is present.`
        : `${relativeLabel(cwd, staticIndexPath)} is missing.`
    ));
    checks.push(makeCheck(
      "static-assets-config",
      wrangler?.assets?.directory ? "pass" : "fail",
      "Wrangler assets",
      wrangler?.assets?.directory
        ? `wrangler.jsonc serves static assets from ${wrangler.assets.directory}.`
        : "wrangler.jsonc is missing assets.directory for a static project."
    ));
    checks.push(makeCheck(
      "static-control-files",
      (await fileExists(headersPath)) || (await fileExists(redirectsPath)) ? "warn" : "pass",
      "Static control files",
      (await fileExists(headersPath)) || (await fileExists(redirectsPath))
        ? "_headers or _redirects is present. Those projects stay on the dedicated Worker lane today."
        : "No _headers or _redirects control files were found."
    ));

    if (entrySource) {
      const staticSignals = [];
      if (entrySource.includes("/api/health")) {
        staticSignals.push("`/api/health`");
      }
      if (entrySource.includes("set-cookie") || entrySource.includes("Set-Cookie")) {
        staticSignals.push("cookie-setting logic");
      }
      if (entrySource.includes("content-security-policy")) {
        staticSignals.push("custom CSP headers");
      }
      checks.push(makeCheck(
        "static-request-logic",
        staticSignals.length === 0 ? "pass" : "warn",
        "Request-time behavior",
        staticSignals.length === 0
          ? "No obvious request-time Worker behavior was detected in src/index.ts."
          : `src/index.ts mentions ${staticSignals.join(", ")}. That may keep the project on the dedicated Worker lane.`
      ));
    }
  } else {
    checks.push(makeCheck(
      "worker-entry",
      entrySource ? "pass" : "fail",
      "Worker entrypoint",
      entrySource
        ? "src/index.ts is present."
        : "src/index.ts is missing."
    ));
    checks.push(makeCheck(
      "worker-health",
      entrySource?.includes("/api/health") ? "pass" : "warn",
      "Health route",
      entrySource?.includes("/api/health")
        ? "src/index.ts appears to expose /api/health."
        : "src/index.ts does not obviously expose /api/health."
    ));
  }

  const bundle = await detectLocalBundleVersion();
  if (bundle.bundleVersion) {
    checks.push(makeCheck(
      "local-bundle-version",
      bundle.consistent ? "pass" : "warn",
      "Local wrapper bundle",
      bundle.consistent
        ? `Local Kale wrapper bundle version is ${bundle.bundleVersion}.`
        : `Local Kale wrapper versions disagree across manifests: ${bundle.manifests.map((entry) => `${entry.label}=${entry.version}`).join(", ")}.`
    ));
  } else {
    checks.push(makeCheck(
      "local-bundle-version",
      "warn",
      "Local wrapper bundle",
      "Could not detect a local Kale wrapper bundle version from plugin metadata."
    ));
  }

  const liveWrapperStatuses = await loadLiveWrapperStatuses({
    bundleVersion: bundle.bundleVersion,
    harnesses: options.harnesses,
    serviceBaseUrl: options.serviceBaseUrl
  });
  for (const status of liveWrapperStatuses) {
    checks.push(makeCheck(
      `wrapper-${status.harnessId}`,
      status.warning ? "warn" : "pass",
      `${status.harnessLabel} wrapper freshness`,
      status.summary
    ));
  }

  const nextSteps = [];
  if (!kaleProject || !wrangler || !packageJson) {
    nextSteps.push(`Run 'node plugins/kale-deploy/scripts/kale-adapt.mjs --shape ${shape}' to normalize this repo for Kale.`);
  }
  if (shape === "static" && ((await fileExists(headersPath)) || (await fileExists(redirectsPath)))) {
    nextSteps.push("Remove _headers/_redirects or accept that the project will stay on the dedicated Worker lane.");
  }
  if (shape === "worker" && !entrySource?.includes("/api/health")) {
    nextSteps.push("Add a GET /api/health route before relying on worker-shape lifecycle checks.");
  }
  for (const status of liveWrapperStatuses) {
    if (status.warning && status.updateCommand) {
      nextSteps.push(`${status.harnessLabel}: run '${status.updateCommand}' to refresh the local wrapper.`);
    }
  }

  const summary = summarizeChecks(checks);
  return {
    root: cwd,
    serviceBaseUrl: options.serviceBaseUrl,
    projectName,
    shape,
    declaredShape: declaredShape ?? null,
    inferredShape: inferredShape ?? null,
    localBundleVersion: bundle.bundleVersion ?? null,
    liveWrapperStatuses,
    checks,
    nextSteps,
    summary
  };
}

async function loadLiveWrapperStatuses(input) {
  if (!input.bundleVersion) {
    return [];
  }

  const statuses = [];
  for (const harnessId of input.harnesses) {
    try {
      const response = await fetchConnectionHealth({
        serviceBaseUrl: input.serviceBaseUrl,
        harnessId,
        localBundleVersion: input.bundleVersion
      });
      if (response?.localWrapperStatus) {
        statuses.push({
          harnessId,
          harnessLabel: harnessLabel(harnessId),
          warning: Boolean(response.localWrapperStatus.warning),
          summary: response.localWrapperStatus.summary,
          updateCommand: response.localWrapperStatus.updateCommand
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      statuses.push({
        harnessId,
        harnessLabel: harnessLabel(harnessId),
        warning: true,
        summary: `Could not check live wrapper status: ${message}`,
        updateCommand: undefined
      });
    }
  }

  return statuses;
}

function shapeFromManifest(kaleProject) {
  if (kaleProject?.projectShape === "static_site") {
    return "static";
  }
  if (kaleProject?.projectShape === "worker_app") {
    return "worker";
  }
  return undefined;
}

function inferShape({ kaleProject, wrangler }) {
  const declared = shapeFromManifest(kaleProject);
  if (declared) {
    return declared;
  }

  if (wrangler?.assets?.directory) {
    return "static";
  }

  return "worker";
}

function makeCheck(id, status, label, message) {
  return { id, status, label, message };
}

function summarizeChecks(checks) {
  return {
    passCount: checks.filter((entry) => entry.status === "pass").length,
    warnCount: checks.filter((entry) => entry.status === "warn").length,
    failCount: checks.filter((entry) => entry.status === "fail").length
  };
}

function relativeLabel(root, absolutePath) {
  return path.relative(root, absolutePath) || path.basename(absolutePath);
}

function printReport(report) {
  console.log(`Kale doctor for ${report.projectName}`);
  console.log(`Shape: ${report.shape}${report.declaredShape ? ` (declared: ${report.declaredShape})` : ""}`);
  if (report.localBundleVersion) {
    console.log(`Local bundle: ${report.localBundleVersion}`);
  }
  console.log("");

  for (const check of report.checks) {
    console.log(`${statusGlyph(check.status)} ${check.label}: ${check.message}`);
  }

  if (report.nextSteps.length > 0) {
    console.log("");
    console.log("Next steps:");
    for (const step of report.nextSteps) {
      console.log(`- ${step}`);
    }
  }
}

function harnessLabel(harnessId) {
  switch (harnessId) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "gemini":
      return "Gemini CLI";
    default:
      return harnessId;
  }
}

function statusGlyph(status) {
  switch (status) {
    case "pass":
      return "PASS";
    case "warn":
      return "WARN";
    default:
      return "FAIL";
  }
}
