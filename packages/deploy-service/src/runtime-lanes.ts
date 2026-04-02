import type {
  DeploymentMetadata,
  ProjectRecord,
  RuntimeLane,
  RuntimeEvidence,
  WorkerAssetsConfig
} from "@cuny-ai-lab/build-contract";

export const DEFAULT_RUNTIME_LANE: RuntimeLane = "dedicated_worker";

export function getCurrentRuntimeLane(
  metadata: DeploymentMetadata,
  project?: Pick<ProjectRecord, "runtimeLane"> | null
): RuntimeLane {
  if (project?.runtimeLane === "shared_static" && supportsSharedStaticLane(metadata)) {
    return "shared_static";
  }

  return DEFAULT_RUNTIME_LANE;
}

export function recommendRuntimeLane(metadata: DeploymentMetadata): RuntimeLane {
  if (!supportsSharedStaticLane(metadata)) {
    return DEFAULT_RUNTIME_LANE;
  }

  return metadata.runtimeEvidence?.classification === "shared_static_eligible"
    ? "shared_static"
    : DEFAULT_RUNTIME_LANE;
}

export function canAutoPromoteToSharedStatic(metadata: DeploymentMetadata): boolean {
  return supportsSharedStaticLane(metadata) && hasHighConfidenceSharedStaticEvidence(metadata.runtimeEvidence);
}

export function formatRuntimeLaneLabel(lane: RuntimeLane): string {
  switch (lane) {
    case "shared_static":
      return "Shared Static";
    case "shared_app":
      return "Shared App";
    default:
      return "Dedicated Worker";
  }
}

function runsWorkerFirst(config?: WorkerAssetsConfig): boolean {
  const value = config?.run_worker_first;

  if (value === undefined) {
    return false;
  }

  if (typeof value === "boolean") {
    return value;
  }

  return value.length > 0;
}

function supportsSharedStaticLane(metadata: DeploymentMetadata): boolean {
  if (!metadata.staticAssets?.files.length) {
    return false;
  }

  if (metadata.runtimeEvidence?.classification === "dedicated_required") {
    return false;
  }

  if ((metadata.workerUpload.bindings ?? []).length > 0) {
    return false;
  }

  if (runsWorkerFirst(metadata.staticAssets.config ?? metadata.workerUpload.assets?.config)) {
    return false;
  }

  return true;
}

function hasHighConfidenceSharedStaticEvidence(evidence: RuntimeEvidence | undefined): boolean {
  return evidence?.classification === "shared_static_eligible" && evidence.confidence === "high";
}
