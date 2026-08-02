import { z } from "zod";

export const SUBJECT_PATTERN = /^cail-[0-9a-f]{32}$/u;
export const PROJECT_PATTERN = /^prj_[0-9a-f]{32}$/u;
export const REVISION_PATTERN = /^rev_sha256_[0-9a-f]{64}$/u;
export const RELEASE_PATTERN = /^rel_[0-9a-f]{32}$/u;

const safePath = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (path) => !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes(".."),
    "Artifact paths must be safe relative paths.",
  );

export const artifactSchema = z
  .object({
    schemaVersion: z.literal("kale.artifact.v1"),
    runtime: z.literal("worker"),
    entrypoint: safePath,
    files: z.record(safePath, z.string()).refine((files) => Object.keys(files).length > 0),
    compatibility: z.object({
      date: z.iso.date(),
      flags: z.array(z.string().min(1).max(80)).max(16).default([]),
    }),
    requestedBindings: z
      .array(
        z.object({
          name: z.string().min(1).max(64),
          kind: z.enum(["d1", "r2", "kv", "secret", "service"]),
        }),
      )
      .max(32)
      .default([]),
  })
  .strict()
  .refine(
    (artifact) => Object.hasOwn(artifact.files, artifact.entrypoint),
    "Entrypoint must be present in files.",
  );

export const createProjectSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .refine(
        (value) => Array.from(value).length <= 80,
        "Project name must be at most 80 Unicode code points.",
      ),
  })
  .strict();
export const createReleaseSchema = z
  .object({
    revisionId: z.string().regex(REVISION_PATTERN),
    target: z.enum(["preview", "production"]),
    approval: z.enum(["required", "automatic"]),
  })
  .strict();
export const approvalSchema = z.object({ decision: z.literal("approved") }).strict();
export const rollbackSchema = z.object({ approval: z.enum(["required", "automatic"]) }).strict();

export type Artifact = z.infer<typeof artifactSchema>;
export type CreateRelease = z.infer<typeof createReleaseSchema>;

export const releaseStatuses = [
  "queued",
  "validating",
  "building",
  "prepared",
  "awaiting_approval",
  "publishing",
  "reconciling",
  "live",
  "rejected",
  "failed",
] as const;
