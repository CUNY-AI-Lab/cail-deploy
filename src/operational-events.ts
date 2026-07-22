import {
  CAIL_EVENT_CATALOG,
  CAIL_EVENTS,
  createCailLogger,
  isOperationalLogSubject,
  workersStructuredSink,
} from "@cuny-ai-lab/cail-log";
import { ApiError } from "./domain/errors";
import type { Env } from "./env";

function actionId(releaseId: string): string {
  const hex = releaseId.slice(4);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function logger(env: Env) {
  return createCailLogger({
    service: "kale-release-control-plane",
    release: env.SERVICE_RELEASE ?? "uncommitted",
    env: env.AUTH_MODE === "test" ? "test" : "staging",
    sourceClass: "platform",
    subjectVersion: "v1",
    catalog: CAIL_EVENT_CATALOG,
    sink: workersStructuredSink,
  });
}

export function operationalLogSubject(
  ownershipSubject: string,
  signedOperationalSubject?: string,
): string | undefined {
  if (signedOperationalSubject !== undefined) {
    if (
      !isOperationalLogSubject(signedOperationalSubject) ||
      signedOperationalSubject.slice("cail-v1-".length) === ownershipSubject.slice("cail-".length)
    ) {
      throw new ApiError(
        503,
        "operational_identity_not_configured",
        "A valid distinct operational pseudonym is required.",
      );
    }
    return signedOperationalSubject;
  }
  return undefined;
}

export function emitReleaseAdmission(
  env: Env,
  releaseId: string,
  requestId: string,
  logSubject?: string,
): void {
  logger(env).emit(CAIL_EVENTS.ACTION_ADMITTED, {
    action_id: actionId(releaseId),
    request_id: requestId,
    product_id: "kale-deploy",
    principal: logSubject
      ? { type: "user" as const, subject: logSubject }
      : { type: "service" as const },
    http_method: "POST" as const,
    route: "/v1/projects/:projectId/releases",
  });
}

export function emitReleaseTerminal(
  env: Env,
  releaseId: string,
  requestId: string,
  logSubject: string | undefined,
  admittedAt: string,
  outcome: "ok" | "error" | "denied",
  reason: "completed" | "upstream_failure" | "denied",
  errorType?: string,
): void {
  const common = {
    action_id: actionId(releaseId),
    request_id: requestId,
    product_id: "kale-deploy",
    principal: logSubject
      ? { type: "user" as const, subject: logSubject }
      : { type: "service" as const },
    http_method: "POST" as const,
    route: "/v1/projects/:projectId/releases",
    duration_ms: Math.max(0, Date.now() - Date.parse(admittedAt)),
  };
  if (outcome === "ok" && reason === "completed") {
    logger(env).emit(CAIL_EVENTS.ACTION_TERMINAL, {
      ...common,
      terminal: { outcome: "ok", reason: "completed" },
    });
    return;
  }
  if (outcome === "denied" && reason === "denied") {
    logger(env).emit(CAIL_EVENTS.ACTION_TERMINAL, {
      ...common,
      terminal: { outcome: "denied", reason: "denied" },
    });
    return;
  }
  logger(env).emit(CAIL_EVENTS.ACTION_TERMINAL, {
    ...common,
    terminal: { outcome: "error", reason: "upstream_failure" },
    ...(errorType ? { error_type: errorType } : {}),
  });
}
