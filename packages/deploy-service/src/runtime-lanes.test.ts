import assert from "node:assert/strict";
import test from "node:test";

import {
  canAutoPromoteToSharedStatic,
  formatRuntimeLaneLabel,
  getCurrentRuntimeLane,
  recommendRuntimeLane
} from "./runtime-lanes";

test("recommendRuntimeLane keeps API-style deploys on dedicated workers", () => {
  assert.equal(recommendRuntimeLane({
    projectName: "api-project",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/api-project",
    workerUpload: {
      main_module: "index.js",
      compatibility_date: "2026-04-01",
      bindings: []
    }
  }), "dedicated_worker");
});

test("recommendRuntimeLane keeps pure static asset deploys on dedicated workers until the runner proves shared static eligibility", () => {
  assert.equal(recommendRuntimeLane({
    projectName: "static-project",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/static-project",
    workerUpload: {
      main_module: "index.js",
      compatibility_date: "2026-04-01",
      bindings: []
    },
    staticAssets: {
      files: [
        {
          path: "/index.html",
          partName: "asset-0",
          contentType: "text/html; charset=utf-8"
        }
      ]
    }
  }), "dedicated_worker");
});

test("canAutoPromoteToSharedStatic requires high-confidence runtime evidence", () => {
  assert.equal(canAutoPromoteToSharedStatic({
    projectName: "static-project",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/static-project",
    workerUpload: {
      main_module: "index.js",
      compatibility_date: "2026-04-01",
      bindings: []
    },
    staticAssets: {
      files: [
        {
          path: "/index.html",
          partName: "asset-0",
          contentType: "text/html; charset=utf-8"
        }
      ]
    }
  }), false);

  assert.equal(canAutoPromoteToSharedStatic({
    projectName: "static-project",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/static-project",
    runtimeEvidence: {
      source: "build_runner",
      framework: "next",
      classification: "shared_static_eligible",
      confidence: "high",
      basis: ["next_output_export"],
      summary: "Next.js static export."
    },
    workerUpload: {
      main_module: "index.js",
      compatibility_date: "2026-04-01",
      bindings: []
    },
    staticAssets: {
      files: [
        {
          path: "/index.html",
          partName: "asset-0",
          contentType: "text/html; charset=utf-8"
        }
      ]
    }
  }), true);
});

test("getCurrentRuntimeLane preserves shared static only for already-assigned eligible projects", () => {
  const metadata = {
    projectName: "static-project",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/static-project",
    workerUpload: {
      main_module: "index.js",
      compatibility_date: "2026-04-01",
      bindings: []
    },
    staticAssets: {
      files: [
        {
          path: "/index.html",
          partName: "asset-0",
          contentType: "text/html; charset=utf-8"
        }
      ]
    }
  };

  assert.equal(getCurrentRuntimeLane(metadata), "dedicated_worker");
  assert.equal(getCurrentRuntimeLane(metadata, { runtimeLane: "shared_static" }), "shared_static");
});

test("getCurrentRuntimeLane does not preserve shared static when runtime evidence requires a Worker", () => {
  assert.equal(getCurrentRuntimeLane({
    projectName: "astro-server-project",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/astro-server-project",
    runtimeEvidence: {
      source: "build_runner",
      framework: "astro",
      classification: "dedicated_required",
      confidence: "high",
      basis: ["astro_server_output"],
      summary: "Astro server output."
    },
    workerUpload: {
      main_module: "index.js",
      compatibility_date: "2026-04-01",
      bindings: []
    },
    staticAssets: {
      files: [
        {
          path: "/index.html",
          partName: "asset-0",
          contentType: "text/html; charset=utf-8"
        }
      ]
    }
  }, { runtimeLane: "shared_static" }), "dedicated_worker");
});

test("recommendRuntimeLane lets explicit runtime evidence override the heuristic", () => {
  assert.equal(recommendRuntimeLane({
    projectName: "astro-server-project",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/astro-server-project",
    runtimeEvidence: {
      source: "build_runner",
      framework: "astro",
      classification: "dedicated_required",
      confidence: "high",
      basis: ["astro_server_output"],
      summary: "Astro server output."
    },
    workerUpload: {
      main_module: "index.js",
      compatibility_date: "2026-04-01",
      bindings: []
    },
    staticAssets: {
      files: [
        {
          path: "/index.html",
          partName: "asset-0",
          contentType: "text/html; charset=utf-8"
        }
      ]
    }
  }), "dedicated_worker");
});

test("recommendRuntimeLane marks explicit shared static evidence as shared static", () => {
  assert.equal(recommendRuntimeLane({
    projectName: "next-export-project",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/next-export-project",
    runtimeEvidence: {
      source: "build_runner",
      framework: "next",
      classification: "shared_static_eligible",
      confidence: "high",
      basis: ["next_output_export"],
      summary: "Next.js static export."
    },
    workerUpload: {
      main_module: "index.js",
      compatibility_date: "2026-04-01",
      bindings: []
    },
    staticAssets: {
      files: [
        {
          path: "/index.html",
          partName: "asset-0",
          contentType: "text/html; charset=utf-8"
        }
      ]
    }
  }), "shared_static");
});

test("recommendRuntimeLane keeps worker-first asset apps on dedicated workers", () => {
  assert.equal(recommendRuntimeLane({
    projectName: "hybrid-project",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/hybrid-project",
    workerUpload: {
      main_module: "index.js",
      compatibility_date: "2026-04-01",
      bindings: []
    },
    staticAssets: {
      config: {
        run_worker_first: true
      },
      files: [
        {
          path: "/index.html",
          partName: "asset-0",
          contentType: "text/html; charset=utf-8"
        }
      ]
    }
  }), "dedicated_worker");
});

test("formatRuntimeLaneLabel returns operator-facing labels", () => {
  assert.equal(formatRuntimeLaneLabel("dedicated_worker"), "Dedicated Worker");
  assert.equal(formatRuntimeLaneLabel("shared_static"), "Shared Static");
  assert.equal(formatRuntimeLaneLabel("shared_app"), "Shared App");
});
