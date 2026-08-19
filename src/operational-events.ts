import { CAIL_EVENTS, isOperationalLogSubject } from "@cuny-ai-lab/cail-log";
import { ApiError } from "./domain/errors";
import { readLoggingContext, type Env } from "./env";

function actionId(releaseId: string): string {
  const hex = releaseId.slice(4);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
        "This service isn't available right now.",
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
  const context = readLoggingContext(env);
  if (!context) return;
  context.logger.emit(CAIL_EVENTS.ACTION_ADMITTED, {
    action_id: actionId(releaseId),
    request_id: requestId,
    product_id: context.product,
    principal: logSubject
      ? { type: "user" as const, subject: logSubject }
      : { type: "anonymous" as const },
    http_method: "POST" as const,
    route: "/v1/projects/{projectId}/releases",
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
  const context = readLoggingContext(env);
  if (!context) return;
  const common = {
    action_id: actionId(releaseId),
    request_id: requestId,
    product_id: context.product,
    principal: logSubject
      ? { type: "user" as const, subject: logSubject }
      : { type: "anonymous" as const },
    http_method: "POST" as const,
    route: "/v1/projects/{projectId}/releases",
    duration_ms: Math.max(0, Date.now() - Date.parse(admittedAt)),
  };
  if (outcome === "ok" && reason === "completed") {
    context.logger.emit(CAIL_EVENTS.ACTION_TERMINAL, {
      ...common,
      terminal: { outcome: "ok", reason: "completed" },
    });
    return;
  }
  if (outcome === "denied" && reason === "denied") {
    context.logger.emit(CAIL_EVENTS.ACTION_TERMINAL, {
      ...common,
      terminal: { outcome: "denied", reason: "denied" },
    });
    return;
  }
  const terminal = { outcome: "error" as const, reason: "upstream_failure" as const };
  if (errorType) {
    context.logger.emit(CAIL_EVENTS.ACTION_TERMINAL, {
      ...common,
      terminal,
      error_type: errorType,
    });
    return;
  }
  context.logger.emit(CAIL_EVENTS.ACTION_TERMINAL, { ...common, terminal });
}
