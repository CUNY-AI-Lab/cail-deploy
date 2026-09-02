export type DeployDiagnostic =
  | "mcp_body_cancel_failed"
  | "mcp_body_release_failed"
  | "mcp_response_cancel_failed"
  | "mcp_response_release_failed"
  | "reconcile_claim_release_failed"
  | "request_body_cancel_failed"
  | "request_body_release_failed"
  | "wfp_response_body_cancel_failed"
  | "wfp_response_body_release_failed"
  | "workflow_terminal_finalization_failed";

const diagnosticVocabulary = {
  mcp_body_cancel_failed: {
    event: "deploy.mcp.request.body_cancel_failed",
    error: "body_cancel_failed",
  },
  mcp_body_release_failed: {
    event: "deploy.mcp.request.body_release_failed",
    error: "body_release_failed",
  },
  mcp_response_cancel_failed: {
    event: "deploy.mcp.response.body_cancel_failed",
    error: "body_cancel_failed",
  },
  mcp_response_release_failed: {
    event: "deploy.mcp.response.body_release_failed",
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
  wfp_response_body_cancel_failed: {
    event: "deploy.wfp.response.body_cancel_failed",
    error: "body_cancel_failed",
  },
  wfp_response_body_release_failed: {
    event: "deploy.wfp.response.body_release_failed",
    error: "body_release_failed",
  },
  workflow_terminal_finalization_failed: {
    event: "deploy.workflow.terminal_finalization_failed",
    error: "terminal_finalization_failed",
  },
} satisfies Record<DeployDiagnostic, { event: string; error: string }>;

export interface DiagnosticContext {
  requestId?: string;
  releaseId?: string;
}

interface DeployDiagnosticRecord {
  event: string;
  error: string;
  requestId?: string;
  releaseId?: string;
}

export function emitDeployDiagnostic(kind: DeployDiagnostic, context: DiagnosticContext): void {
  const vocabulary = diagnosticVocabulary[kind];
  try {
    const diagnostic: DeployDiagnosticRecord = {
      event: vocabulary.event,
      error: vocabulary.error,
    };
    if ("requestId" in context) diagnostic.requestId = context.requestId;
    if ("releaseId" in context && context.releaseId) diagnostic.releaseId = context.releaseId;
    console.error(diagnostic);
  } catch {
    // Diagnostics are observational and cannot replace the primary result.
  }
}

export function observeDetachedCleanup<T>(
  cleanup: () => T,
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
