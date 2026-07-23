import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const packageName = "@cuny-ai-lab/cail-log";
const packageVersion = "0.6.0";
const legacyArchiveName = "cuny-ai-lab-cail-log-0.6.0.tgz";
const archiveName = "cuny-ai-lab-cail-log-0.6.0-cb6ffc0-8689422456eb4b7c.tgz";
const dependencyPath = `file:vendor/${archiveName}`;
const archiveSha256 = "8689422456eb4b7c672538ba91efb7606e9287df473a99a91ee2a60b5f9ba215";
const readmeSha256 = "471004a3b64755a7cbf86865170bb8557567bf90cdee0fd71c1cbf209744184a";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function run(command: string[], cwd = root): Uint8Array {
  const result = Bun.spawnSync({
    cmd: command,
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `log_package_gate_failed:${command[0]}:${result.exitCode}:${result.stderr
        .toString()
        .slice(0, 500)}`,
    );
  }
  return result.stdout;
}

async function acceptedArchiveBytes(): Promise<Uint8Array> {
  const bytes = await readFile(join(root, "vendor", archiveName));
  if (bytes.byteLength !== 50_269 || sha256(bytes) !== archiveSha256) {
    throw new Error("log_package_gate_failed:archive_receipt");
  }
  return bytes;
}

async function writeParentFixture(directory: string): Promise<void> {
  const vendor = join(directory, "vendor");
  await mkdir(vendor, { recursive: true });
  const legacyDependencyPath = `file:vendor/${legacyArchiveName}`;
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "cail-log-legacy-cache-seed",
        private: true,
        dependencies: { [packageName]: legacyDependencyPath },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(directory, "bun.lock"),
    `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "cail-log-legacy-cache-seed",
      "dependencies": {
        "${packageName}": "${legacyDependencyPath}",
      },
    },
  },
  "packages": {
    "${packageName}": ["${packageName}@vendor/${legacyArchiveName}", {}],
  },
}
`,
  );
  await writeFile(join(vendor, legacyArchiveName), await acceptedArchiveBytes());
}

async function writeChildFixture(directory: string, minimal = false): Promise<void> {
  const vendor = join(directory, "vendor");
  await Promise.all([
    mkdir(vendor, { recursive: true }),
    mkdir(join(directory, "docs"), { recursive: true }),
    mkdir(join(directory, "test"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(directory, "docs/PRIMITIVE_PINS.md"),
      await readFile(join(root, "docs/PRIMITIVE_PINS.md")),
    ),
    writeFile(
      join(directory, "test/primitive-pins.test.ts"),
      await readFile(join(root, "test/primitive-pins.test.ts")),
    ),
  ]);
  if (minimal) {
    await writeFile(
      join(directory, "package.json"),
      `${JSON.stringify(
        {
          name: "cail-log-cold-cache-control",
          private: true,
          type: "module",
          dependencies: { [packageName]: dependencyPath },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(directory, "bun.lock"),
      `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "cail-log-cold-cache-control",
      "dependencies": {
        "${packageName}": "${dependencyPath}",
      },
    },
  },
  "packages": {
    "${packageName}": ["${packageName}@vendor/${archiveName}", {}],
  },
}
`,
    );
  } else {
    await Promise.all([
      writeFile(join(directory, "package.json"), await readFile(join(root, "package.json"))),
      writeFile(join(directory, "bun.lock"), await readFile(join(root, "bun.lock"))),
      writeFile(
        join(vendor, "cuny-ai-lab-cail-identity-4.6.0.tgz"),
        await readFile(join(root, "vendor/cuny-ai-lab-cail-identity-4.6.0.tgz")),
      ),
    ]);
  }
  await writeFile(join(vendor, archiveName), await acceptedArchiveBytes());
}

async function verifyInstalledPackage(directory: string): Promise<void> {
  const archive = join(directory, "vendor", archiveName);
  await acceptedArchiveBytes();
  const archiveBytes = await readFile(archive);
  if (archiveBytes.byteLength !== 50_269 || sha256(archiveBytes) !== archiveSha256)
    throw new Error("log_package_gate_failed:archive_receipt");

  const installedRoot = join(directory, "node_modules/@cuny-ai-lab/cail-log");
  const entries = new TextDecoder()
    .decode(run(["tar", "-tzf", archive], directory))
    .trim()
    .split("\n");
  for (const entry of entries) {
    if (!entry.startsWith("package/")) {
      throw new Error("log_package_gate_failed:archive_path");
    }
    const packaged = run(["tar", "-xOzf", archive, entry], directory);
    const installed = await readFile(join(installedRoot, entry.slice("package/".length)));
    if (sha256(installed) !== sha256(packaged)) {
      throw new Error(`log_package_gate_failed:installed_file:${entry}`);
    }
  }

  const manifest = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
    exports?: Record<string, unknown>;
  };
  if (
    manifest.name !== packageName ||
    manifest.version !== packageVersion ||
    manifest.exports?.["."] === undefined ||
    manifest.exports?.["./contract/operational-event-v2.json"] === undefined
  ) {
    throw new Error("log_package_gate_failed:installed_manifest");
  }
  if (sha256(await readFile(join(installedRoot, "README.md"))) !== readmeSha256) {
    throw new Error("log_package_gate_failed:installed_readme");
  }
  run(["bun", "test", "test/primitive-pins.test.ts"], directory);

  await writeFile(
    join(directory, "verify-events.ts"),
    `import {
  CAIL_EVENT_CATALOG,
  CAIL_EVENTS,
  createCailLogger,
  workersStructuredSink,
} from ${JSON.stringify(packageName)};

const records: unknown[] = [];
const diagnostics: unknown[] = [];
const originalLog = console.log;
const originalError = console.error;
console.log = (record: unknown) => records.push(record);
console.error = (diagnostic: unknown) => diagnostics.push(diagnostic);
try {
  const logger = createCailLogger({
    service: "cache-identity-gate",
    release: "test",
    env: "test",
    sourceClass: "platform",
    subjectVersion: "v1",
    catalog: CAIL_EVENT_CATALOG,
    sink: workersStructuredSink,
  });
  for (const requestId of [
    "11111111-1111-4111-8111-111111111111",
    "017f22e2-79b0-7cc3-98c4-dc0c0c07398f",
  ]) {
    logger.emit(CAIL_EVENTS.ACTION_ADMITTED, {
      action_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      request_id: requestId,
      product_id: "kale-deploy",
      principal: { type: "service" },
      http_method: "POST",
      route: "/v1/projects/{projectId}/releases",
    });
    logger.emit(CAIL_EVENTS.ACTION_TERMINAL, {
      action_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      request_id: requestId,
      product_id: "kale-deploy",
      principal: { type: "service" },
      http_method: "POST",
      route: "/v1/projects/{projectId}/releases",
      duration_ms: 1,
      terminal: { outcome: "ok", reason: "completed" },
    });
  }
} finally {
  console.log = originalLog;
  console.error = originalError;
}
if (diagnostics.length !== 0) throw new Error("event_diagnostics");
if (records.length !== 4) throw new Error("event_count");
const ids = records.map((record) => (record as Record<string, unknown>)["cail.request.id"]);
if (
  ids.join(",") !==
  "11111111-1111-4111-8111-111111111111,11111111-1111-4111-8111-111111111111,017f22e2-79b0-7cc3-98c4-dc0c0c07398f,017f22e2-79b0-7cc3-98c4-dc0c0c07398f"
) {
  throw new Error("event_request_ids");
}
`,
  );
  run(["bun", "verify-events.ts"], directory);
}

let temporaryRoot: string | undefined;
let primaryError: unknown;
try {
  temporaryRoot = await mkdtemp(join(tmpdir(), "kale-deploy-log-cache-"));
  await stat(temporaryRoot);
  const legacySeed = join(temporaryRoot, "legacy-seed");
  const child = join(temporaryRoot, "child");
  const coldChild = join(temporaryRoot, "cold-child");
  const coldCache = join(temporaryRoot, "cold-cache");
  await Promise.all([
    mkdir(legacySeed, { mode: 0o700 }),
    mkdir(child, { mode: 0o700 }),
    mkdir(coldChild, { mode: 0o700 }),
    mkdir(coldCache, { mode: 0o700 }),
  ]);

  await writeParentFixture(legacySeed);
  run(["bun", "install", "--frozen-lockfile", "--offline"], legacySeed);

  await writeChildFixture(child);
  run(["bun", "install", "--frozen-lockfile", "--offline"], child);
  await verifyInstalledPackage(child);

  await writeChildFixture(coldChild, true);
  run(["bun", "install", "--frozen-lockfile", "--offline", "--cache-dir", coldCache], coldChild);
  await verifyInstalledPackage(coldChild);
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  if (temporaryRoot) {
    try {
      await rm(temporaryRoot, { recursive: true, force: true });
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError;
    }
  }
}

console.log(`Log legacy-path-warmed and cold-cache package gates passed: ${archiveSha256}`);
