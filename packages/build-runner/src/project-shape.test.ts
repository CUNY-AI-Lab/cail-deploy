import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import {
  assertExplicitKaleProjectShape,
  KaleProjectShapeValidationError,
  readKaleProjectConfig
} from "./project-shape";

async function withProjectRoot(
  files: Record<string, string>,
  run: (projectRoot: string) => Promise<void>
): Promise<void> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "kale-project-shape-"));

  try {
    for (const [relativePath, content] of Object.entries(files)) {
      await writeFile(path.join(projectRoot, relativePath), content, "utf8");
    }

    await run(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

test("assertExplicitKaleProjectShape rejects repositories without kale.project.json", async () => {
  await withProjectRoot({}, async (projectRoot) => {
    await assert.rejects(
      assertExplicitKaleProjectShape(projectRoot),
      (error) => {
        assert.ok(error instanceof KaleProjectShapeValidationError);
        assert.match(error.summary, /not declared/i);
        assert.match(error.detail, /--shape static\|worker/);
        return true;
      }
    );
  });
});

test("assertExplicitKaleProjectShape rejects invalid kale.project.json", async () => {
  await withProjectRoot({
    "kale.project.json": "{ nope"
  }, async (projectRoot) => {
    await assert.rejects(
      assertExplicitKaleProjectShape(projectRoot),
      (error) => {
        assert.ok(error instanceof KaleProjectShapeValidationError);
        assert.match(error.summary, /valid JSON/i);
        return true;
      }
    );
  });
});

test("assertExplicitKaleProjectShape rejects non-object kale.project.json", async () => {
  await withProjectRoot({
    "kale.project.json": JSON.stringify(["static_site"])
  }, async (projectRoot) => {
    await assert.rejects(
      assertExplicitKaleProjectShape(projectRoot),
      (error) => {
        assert.ok(error instanceof KaleProjectShapeValidationError);
        assert.match(error.summary, /JSON object/i);
        return true;
      }
    );
  });
});

test("assertExplicitKaleProjectShape rejects unsupported project shapes", async () => {
  await withProjectRoot({
    "kale.project.json": JSON.stringify({
      projectShape: "node_server",
      requestTimeLogic: "allowed"
    })
  }, async (projectRoot) => {
    await assert.rejects(
      assertExplicitKaleProjectShape(projectRoot),
      (error) => {
        assert.ok(error instanceof KaleProjectShapeValidationError);
        assert.match(error.detail, /static_site/);
        assert.match(error.detail, /worker_app/);
        return true;
      }
    );
  });
});

test("assertExplicitKaleProjectShape rejects incomplete static-site contracts", async () => {
  await withProjectRoot({
    "kale.project.json": JSON.stringify({
      projectShape: "static_site",
      staticOutputDir: "public"
    })
  }, async (projectRoot) => {
    await assert.rejects(
      assertExplicitKaleProjectShape(projectRoot),
      (error) => {
        assert.ok(error instanceof KaleProjectShapeValidationError);
        assert.match(error.detail, /requestTimeLogic: "none"/);
        return true;
      }
    );
  });
});

test("assertExplicitKaleProjectShape rejects static-site contracts without an output directory", async () => {
  await withProjectRoot({
    "kale.project.json": JSON.stringify({
      projectShape: "static_site",
      requestTimeLogic: "none"
    })
  }, async (projectRoot) => {
    await assert.rejects(
      assertExplicitKaleProjectShape(projectRoot),
      (error) => {
        assert.ok(error instanceof KaleProjectShapeValidationError);
        assert.match(error.summary, /static output directory/i);
        return true;
      }
    );
  });
});

test("assertExplicitKaleProjectShape accepts explicit static-site contracts", async () => {
  await withProjectRoot({
    "kale.project.json": JSON.stringify({
      projectShape: "static_site",
      staticOutputDir: "dist",
      requestTimeLogic: "none"
    })
  }, async (projectRoot) => {
    assert.deepEqual(await assertExplicitKaleProjectShape(projectRoot), {
      projectShape: "static_site",
      staticOutputDir: "dist",
      requestTimeLogic: "none"
    });
  });
});

test("assertExplicitKaleProjectShape rejects incomplete Worker app contracts", async () => {
  await withProjectRoot({
    "kale.project.json": JSON.stringify({
      projectShape: "worker_app"
    })
  }, async (projectRoot) => {
    await assert.rejects(
      assertExplicitKaleProjectShape(projectRoot),
      (error) => {
        assert.ok(error instanceof KaleProjectShapeValidationError);
        assert.match(error.detail, /requestTimeLogic: "allowed"/);
        return true;
      }
    );
  });
});

test("assertExplicitKaleProjectShape accepts explicit Worker app contracts", async () => {
  await withProjectRoot({
    "kale.project.json": JSON.stringify({
      projectShape: "worker_app",
      requestTimeLogic: "allowed"
    })
  }, async (projectRoot) => {
    assert.deepEqual(await assertExplicitKaleProjectShape(projectRoot), {
      projectShape: "worker_app",
      requestTimeLogic: "allowed"
    });
  });
});

test("readKaleProjectConfig keeps runtime evidence tolerant of incomplete metadata", async () => {
  await withProjectRoot({
    "kale.project.json": JSON.stringify({
      projectShape: "static_site",
      staticOutputDir: "public"
    })
  }, async (projectRoot) => {
    assert.deepEqual(await readKaleProjectConfig(projectRoot), {
      projectShape: "static_site",
      staticOutputDir: "public"
    });
  });
});
