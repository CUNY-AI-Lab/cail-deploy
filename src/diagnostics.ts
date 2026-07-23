export type DeployDiagnostic =
  | "mcp_body_cancel_failed"
  | "mcp_body_release_failed"
  | "reconcile_claim_release_failed"
  | "request_body_cancel_failed"
  | "request_body_release_failed"
  | "workflow_finalization_diagnostic_unattached"
  | "workflow_terminal_finalization_failed";

const diagnosticVocabulary: Record<DeployDiagnostic, { event: string; error: string }> = {
  mcp_body_cancel_failed: {
    event: "deploy.mcp.request.body_cancel_failed",
    error: "body_cancel_failed",
  },
  mcp_body_release_failed: {
    event: "deploy.mcp.request.body_release_failed",
    error: "body_release_failed",
  },
  reconcile_claim_release_failed: {
    event: "deploy.release.reconcile_claim_release_failed",
    error: "reconcile_claim_release_failed",
  },
  request_body_cancel_failed: {
    event: "deploy.request.body_cancel_failed",
    error: "body_cancel_failed",
  },
  request_body_release_failed: {
    event: "deploy.request.body_release_failed",
    error: "body_release_failed",
  },
  workflow_finalization_diagnostic_unattached: {
    event: "deploy.workflow.finalization_diagnostic_unattached",
    error: "finalization_diagnostic_unattached",
  },
  workflow_terminal_finalization_failed: {
    event: "deploy.workflow.terminal_finalization_failed",
    error: "terminal_finalization_failed",
  },
};

export interface DiagnosticContext {
  requestId: string;
  releaseId?: string;
}

export function emitDeployDiagnostic(kind: DeployDiagnostic, context: DiagnosticContext): void {
  const vocabulary = diagnosticVocabulary[kind];
  try {
    console.error({
      event: vocabulary.event,
      error: vocabulary.error,
      requestId: context.requestId,
      ...(context.releaseId ? { releaseId: context.releaseId } : {}),
    });
  } catch {
    // Diagnostics are observational and cannot replace the primary result.
  }
}

export function observeDetachedCleanup(
  cleanup: () => unknown,
  kind: DeployDiagnostic,
  context: DiagnosticContext,
): void {
  try {
    void Promise.resolve(cleanup()).then(undefined, () => {
      emitDeployDiagnostic(kind, context);
    });
  } catch {
    emitDeployDiagnostic(kind, context);
  }
}
