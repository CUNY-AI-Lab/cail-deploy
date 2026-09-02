import { emitDeployDiagnostic } from "./diagnostics";

function emitWorkflowFinalizationDiagnostic(releaseId: string, requestId: string): void {
  emitDeployDiagnostic("workflow_terminal_finalization_failed", { releaseId, requestId });
}

export async function finalizeWorkflowFailure<TPrimary>(
  primary: TPrimary,
  finalize: () => Promise<void>,
  context: { releaseId: string; requestId: string },
): Promise<never> {
  try {
    await finalize();
  } catch {
    emitWorkflowFinalizationDiagnostic(context.releaseId, context.requestId);
  }
  throw primary;
}
