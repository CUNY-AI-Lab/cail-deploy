import { readFile } from "node:fs/promises";
import path from "node:path";

export type KaleProjectShape = "static_site" | "worker_app";
export type KaleRequestTimeLogic = "none" | "allowed";

export type KaleProjectConfig = {
  projectShape?: KaleProjectShape;
  staticOutputDir?: string;
  requestTimeLogic?: KaleRequestTimeLogic;
};

const KALE_PROJECT_FILE = "kale.project.json";
const STATIC_SHAPE_DETAIL = "`static_site` with `staticOutputDir` and `requestTimeLogic: \"none\"`";
const WORKER_SHAPE_DETAIL = "`worker_app` with `requestTimeLogic: \"allowed\"`";
const SHAPE_REPAIR_GUIDANCE =
  "Agents should run `kale-init <project-name> --shape static|worker` for a new repository, or `kale-adapt --shape static|worker` for an existing repository.";

export class KaleProjectShapeValidationError extends Error {
  constructor(readonly summary: string, readonly detail: string) {
    super(summary);
    this.name = "KaleProjectShapeValidationError";
  }
}

export async function assertExplicitKaleProjectShape(projectRoot: string): Promise<KaleProjectConfig> {
  const result = await readRawKaleProjectConfig(projectRoot);

  if (result.kind === "missing") {
    throw new KaleProjectShapeValidationError(
      "This repository has not declared whether it is a static site or Worker app.",
      `Add ${KALE_PROJECT_FILE} declaring either ${STATIC_SHAPE_DETAIL} or ${WORKER_SHAPE_DETAIL}. ${SHAPE_REPAIR_GUIDANCE}`
    );
  }

  if (result.kind === "invalid_json") {
    throw new KaleProjectShapeValidationError(
      `${KALE_PROJECT_FILE} is not valid JSON.`,
      `Fix ${KALE_PROJECT_FILE} so it declares either ${STATIC_SHAPE_DETAIL} or ${WORKER_SHAPE_DETAIL}. ${SHAPE_REPAIR_GUIDANCE}`
    );
  }

  if (result.kind === "invalid_format") {
    throw new KaleProjectShapeValidationError(
      `${KALE_PROJECT_FILE} must be a JSON object.`,
      `Rewrite ${KALE_PROJECT_FILE} so it declares either ${STATIC_SHAPE_DETAIL} or ${WORKER_SHAPE_DETAIL}. ${SHAPE_REPAIR_GUIDANCE}`
    );
  }

  const config = normalizeKaleProjectConfig(result.value);
  if (!config.projectShape) {
    throw new KaleProjectShapeValidationError(
      `${KALE_PROJECT_FILE} does not declare a supported Kale app shape.`,
      `Set \`projectShape\` in ${KALE_PROJECT_FILE} to either \`static_site\` or \`worker_app\`. Use ${STATIC_SHAPE_DETAIL} for a pure static site, or ${WORKER_SHAPE_DETAIL} for request-time routes and APIs.`
    );
  }

  if (config.projectShape === "static_site") {
    if (config.requestTimeLogic !== "none") {
      throw new KaleProjectShapeValidationError(
        `${KALE_PROJECT_FILE} declares a static site without a complete static contract.`,
        `For a pure static site, set \`projectShape: "static_site"\`, set \`staticOutputDir\` to the Wrangler assets directory, and set \`requestTimeLogic: "none"\`. If the app needs request-time routes, use ${WORKER_SHAPE_DETAIL} instead.`
      );
    }

    if (!normalizeProjectDirectory(config.staticOutputDir)) {
      throw new KaleProjectShapeValidationError(
        `${KALE_PROJECT_FILE} declares a static site without a static output directory.`,
        `For a pure static site, set \`staticOutputDir\` in ${KALE_PROJECT_FILE} to the directory served by \`wrangler.jsonc\` assets, such as \`public\` or \`dist\`.`
      );
    }
  }

  if (config.projectShape === "worker_app" && config.requestTimeLogic !== "allowed") {
    throw new KaleProjectShapeValidationError(
      `${KALE_PROJECT_FILE} declares a Worker app without the Worker runtime contract.`,
      `For a Worker app, set \`projectShape: "worker_app"\` and \`requestTimeLogic: "allowed"\`. If this is a pure static site, use ${STATIC_SHAPE_DETAIL} instead.`
    );
  }

  return config;
}

export async function readKaleProjectConfig(projectRoot: string): Promise<KaleProjectConfig | undefined> {
  const result = await readRawKaleProjectConfig(projectRoot);
  if (result.kind !== "ok") {
    return undefined;
  }

  return normalizeKaleProjectConfig(result.value);
}

type RawKaleProjectConfigResult =
  | { kind: "ok"; value: Record<string, unknown> }
  | { kind: "missing" }
  | { kind: "invalid_json" }
  | { kind: "invalid_format" };

async function readRawKaleProjectConfig(projectRoot: string): Promise<RawKaleProjectConfigResult> {
  let raw: string;
  try {
    raw = await readFile(path.join(projectRoot, KALE_PROJECT_FILE), "utf8");
  } catch {
    return { kind: "missing" };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { kind: "invalid_format" };
    }

    return {
      kind: "ok",
      value: parsed as Record<string, unknown>
    };
  } catch {
    return { kind: "invalid_json" };
  }
}

function normalizeKaleProjectConfig(parsed: Record<string, unknown>): KaleProjectConfig {
  const projectShape = parsed.projectShape;
  const staticOutputDir = parsed.staticOutputDir;
  const requestTimeLogic = parsed.requestTimeLogic;

  return {
    ...(projectShape === "static_site" || projectShape === "worker_app" ? { projectShape } : {}),
    ...(typeof staticOutputDir === "string" ? { staticOutputDir } : {}),
    ...(requestTimeLogic === "none" || requestTimeLogic === "allowed" ? { requestTimeLogic } : {})
  };
}

function normalizeProjectDirectory(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return value
    .replace(/\\/g, "/")
    .replace(/^\.\//u, "")
    .replace(/\/+$/u, "");
}
