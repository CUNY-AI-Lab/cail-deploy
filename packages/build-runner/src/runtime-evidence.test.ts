import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { detectRuntimeEvidence } from "./runtime-evidence";

async function withProjectRoot(
  files: Record<string, string>,
  run: (projectRoot: string) => Promise<void>
): Promise<void> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "kale-runtime-evidence-"));

  try {
    for (const [relativePath, content] of Object.entries(files)) {
      await writeFile(path.join(projectRoot, relativePath), content, "utf8");
    }

    await run(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

test("detectRuntimeEvidence marks explicit Next.js static exports as high-confidence shared static", async () => {
  await withProjectRoot({
    "next.config.mjs": "export default { output: 'export' };"
  }, async (projectRoot) => {
    const evidence = await detectRuntimeEvidence({
      projectRoot,
      packageJson: {
        dependencies: {
          next: "^16.0.0"
        }
      },
      requestedBindings: [],
      staticAssets: {
        files: [
          {
            path: "/index.html",
            partName: "asset-0"
          }
        ]
      }
    });

    assert.equal(evidence.framework, "next");
    assert.equal(evidence.classification, "shared_static_eligible");
    assert.equal(evidence.confidence, "high");
    assert.deepEqual(evidence.basis, ["next_output_export"]);
  });
});

test("detectRuntimeEvidence marks adapter-static SvelteKit builds as high-confidence shared static", async () => {
  await withProjectRoot({
    "svelte.config.js": "import adapter from '@sveltejs/adapter-static'; export default { kit: { adapter: adapter() } };"
  }, async (projectRoot) => {
    const evidence = await detectRuntimeEvidence({
      projectRoot,
      packageJson: {
        devDependencies: {
          "@sveltejs/kit": "^2.0.0"
        }
      },
      requestedBindings: [],
      staticAssets: {
        files: [
          {
            path: "/index.html",
            partName: "asset-0"
          }
        ]
      }
    });

    assert.equal(evidence.framework, "sveltekit");
    assert.equal(evidence.classification, "shared_static_eligible");
    assert.equal(evidence.confidence, "high");
    assert.deepEqual(evidence.basis, ["sveltekit_adapter_static"]);
  });
});

test("detectRuntimeEvidence keeps generic asset bundles as recommendation-only without explicit framework evidence", async () => {
  await withProjectRoot({}, async (projectRoot) => {
    const evidence = await detectRuntimeEvidence({
      projectRoot,
      packageJson: {
        devDependencies: {
          vite: "^7.0.0"
        }
      },
      requestedBindings: [],
      staticAssets: {
        files: [
          {
            path: "/index.html",
            partName: "asset-0"
          }
        ]
      }
    });

    assert.equal(evidence.framework, "vite");
    assert.equal(evidence.classification, "unknown");
    assert.equal(evidence.confidence, "medium");
    assert.deepEqual(evidence.basis, ["generic_assets_only"]);
  });
});

test("detectRuntimeEvidence blocks shared static when the asset bundle includes Cloudflare _headers", async () => {
  await withProjectRoot({
    "kale.project.json": JSON.stringify({
      projectShape: "static_site",
      staticOutputDir: "public",
      requestTimeLogic: "none"
    }, null, 2)
  }, async (projectRoot) => {
    const evidence = await detectRuntimeEvidence({
      projectRoot,
      requestedBindings: [],
      staticAssets: {
        files: [
          {
            path: "/index.html",
            partName: "asset-0"
          },
          {
            path: "/_headers",
            partName: "asset-1"
          }
        ]
      },
      assetsDirectory: "public"
    });

    assert.equal(evidence.classification, "dedicated_required");
    assert.equal(evidence.confidence, "high");
    assert.deepEqual(evidence.basis, ["static_asset_headers_file"]);
  });
});

test("detectRuntimeEvidence blocks shared static when the asset bundle includes Cloudflare _redirects", async () => {
  await withProjectRoot({
    "kale.project.json": JSON.stringify({
      projectShape: "static_site",
      staticOutputDir: "public",
      requestTimeLogic: "none"
    }, null, 2)
  }, async (projectRoot) => {
    const evidence = await detectRuntimeEvidence({
      projectRoot,
      requestedBindings: [],
      staticAssets: {
        files: [
          {
            path: "/index.html",
            partName: "asset-0"
          },
          {
            path: "/_redirects",
            partName: "asset-1"
          }
        ]
      },
      assetsDirectory: "public"
    });

    assert.equal(evidence.classification, "dedicated_required");
    assert.equal(evidence.confidence, "high");
    assert.deepEqual(evidence.basis, ["static_asset_redirects_file"]);
  });
});

test("detectRuntimeEvidence certifies Kale static-site projects as high-confidence shared static", async () => {
  await withProjectRoot({
    "kale.project.json": JSON.stringify({
      projectShape: "static_site",
      staticOutputDir: "public",
      requestTimeLogic: "none"
    }, null, 2)
  }, async (projectRoot) => {
    const evidence = await detectRuntimeEvidence({
      projectRoot,
      requestedBindings: [],
      staticAssets: {
        files: [
          {
            path: "/index.html",
            partName: "asset-0"
          }
        ]
      },
      assetsDirectory: "public"
    });

    assert.equal(evidence.framework, "unknown");
    assert.equal(evidence.classification, "shared_static_eligible");
    assert.equal(evidence.confidence, "high");
    assert.deepEqual(evidence.basis, ["kale_static_project_manifest"]);
  });
});

test("detectRuntimeEvidence accepts absolute Wrangler asset directories for Kale static-site projects", async () => {
  await withProjectRoot({
    "kale.project.json": JSON.stringify({
      projectShape: "static_site",
      staticOutputDir: "public",
      requestTimeLogic: "none"
    }, null, 2)
  }, async (projectRoot) => {
    const evidence = await detectRuntimeEvidence({
      projectRoot,
      requestedBindings: [],
      staticAssets: {
        files: [
          {
            path: "/index.html",
            partName: "asset-0"
          }
        ]
      },
      assetsDirectory: path.join(projectRoot, "public")
    });

    assert.equal(evidence.framework, "unknown");
    assert.equal(evidence.classification, "shared_static_eligible");
    assert.equal(evidence.confidence, "high");
    assert.deepEqual(evidence.basis, ["kale_static_project_manifest"]);
  });
});

test("detectRuntimeEvidence certifies Vite static-site projects when Kale static metadata is present", async () => {
  await withProjectRoot({
    "kale.project.json": JSON.stringify({
      projectShape: "static_site",
      staticOutputDir: "dist",
      requestTimeLogic: "none"
    }, null, 2)
  }, async (projectRoot) => {
    const evidence = await detectRuntimeEvidence({
      projectRoot,
      packageJson: {
        scripts: {
          build: "vite build"
        },
        devDependencies: {
          vite: "^7.0.0"
        }
      },
      requestedBindings: [],
      staticAssets: {
        files: [
          {
            path: "/index.html",
            partName: "asset-0"
          }
        ]
      },
      assetsDirectory: "dist"
    });

    assert.equal(evidence.framework, "vite");
    assert.equal(evidence.classification, "shared_static_eligible");
    assert.equal(evidence.confidence, "high");
    assert.deepEqual(evidence.basis, ["kale_static_project_manifest", "vite_build_script"]);
  });
});

test("detectRuntimeEvidence keeps Kale static-site metadata out of the fast path when the declared output directory does not match Wrangler assets", async () => {
  await withProjectRoot({
    "kale.project.json": JSON.stringify({
      projectShape: "static_site",
      staticOutputDir: "public",
      requestTimeLogic: "none"
    }, null, 2)
  }, async (projectRoot) => {
    const evidence = await detectRuntimeEvidence({
      projectRoot,
      requestedBindings: [],
      staticAssets: {
        files: [
          {
            path: "/index.html",
            partName: "asset-0"
          }
        ]
      },
      assetsDirectory: "dist"
    });

    assert.equal(evidence.classification, "unknown");
    assert.equal(evidence.confidence, "medium");
    assert.deepEqual(evidence.basis, ["kale_static_project_manifest_mismatch"]);
  });
});

test("detectRuntimeEvidence keeps Kale static-site metadata out of the fast path when the project does not explicitly promise requestTimeLogic none", async () => {
  await withProjectRoot({
    "kale.project.json": JSON.stringify({
      projectShape: "static_site",
      staticOutputDir: "public"
    }, null, 2)
  }, async (projectRoot) => {
    const evidence = await detectRuntimeEvidence({
      projectRoot,
      requestedBindings: [],
      staticAssets: {
        files: [
          {
            path: "/index.html",
            partName: "asset-0"
          }
        ]
      },
      assetsDirectory: "public"
    });

    assert.equal(evidence.classification, "unknown");
    assert.equal(evidence.confidence, "medium");
    assert.deepEqual(evidence.basis, ["kale_static_project_manifest", "kale_static_project_contract_incomplete"]);
  });
});

test("detectRuntimeEvidence blocks shared static when bindings are requested", async () => {
  await withProjectRoot({}, async (projectRoot) => {
    const evidence = await detectRuntimeEvidence({
      projectRoot,
      requestedBindings: [
        {
          type: "d1",
          name: "DB",
          id: "database-id"
        }
      ],
      staticAssets: {
        files: [
          {
            path: "/index.html",
            partName: "asset-0"
          }
        ]
      }
    });

    assert.equal(evidence.classification, "dedicated_required");
    assert.equal(evidence.confidence, "high");
    assert.deepEqual(evidence.basis, ["bindings_present"]);
  });
});

test("detectRuntimeEvidence treats Astro server output as dedicated-only", async () => {
  await withProjectRoot({
    "astro.config.mjs": "export default { output: 'server' };"
  }, async (projectRoot) => {
    const evidence = await detectRuntimeEvidence({
      projectRoot,
      packageJson: {
        dependencies: {
          astro: "^5.0.0"
        }
      },
      requestedBindings: [],
      staticAssets: {
        files: [
          {
            path: "/index.html",
            partName: "asset-0"
          }
        ]
      }
    });

    assert.equal(evidence.framework, "astro");
    assert.equal(evidence.classification, "dedicated_required");
    assert.equal(evidence.confidence, "high");
    assert.deepEqual(evidence.basis, ["astro_server_output"]);
  });
});
