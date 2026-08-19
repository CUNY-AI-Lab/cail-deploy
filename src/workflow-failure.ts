import { emitDeployDiagnostic } from "./diagnostics";

const WORKFLOW_FINALIZATION_FAILURE = Symbol("workflow-terminal-finalization-failure");

function emitWorkflowFinalizationDiagnostic(releaseId: string, requestId: string): void {
  emitDeployDiagnostic("workflow_terminal_finalization_failed", { releaseId, requestId });
}

function emitUnattachedDiagnostic(releaseId: string, requestId: string): void {
  emitDeployDiagnostic("workflow_finalization_diagnostic_unattached", { releaseId, requestId });
}

function retainWorkflowFinalizationFailure<TPrimary, TSecondary>(
  primary: TPrimary,
  secondary: TSecondary,
  releaseId: string,
  requestId: string,
): void {
  emitWorkflowFinalizationDiagnostic(releaseId, requestId);
  try {
    if (!(primary instanceof Error)) return;
    const currentCause = primary.cause;
    const previous =
      currentCause instanceof AggregateError && WORKFLOW_FINALIZATION_FAILURE in currentCause
        ? [...currentCause.errors]
        : [];
    const originalCause =
      currentCause instanceof AggregateError && WORKFLOW_FINALIZATION_FAILURE in currentCause
        ? currentCause.cause
        : currentCause;
    const aggregate = new AggregateError(
      [...previous, secondary],
      "Workflow terminal finalization also failed.",
      originalCause === undefined ? undefined : { cause: originalCause },
    );
    Object.defineProperty(aggregate, WORKFLOW_FINALIZATION_FAILURE, {
      value: true,
    });
    Object.defineProperty(primary, "cause", {
      configurable: true,
      value: aggregate,
      writable: true,
    });
  } catch {
    emitUnattachedDiagnostic(releaseId, requestId);
  }
}

export async function finalizeWorkflowFailure<TPrimary>(
  primary: TPrimary,
  finalize: () => Promise<void>,
  context: { releaseId: string; requestId: string },
): Promise<never> {
  try {
    await finalize();
  } catch (secondary) {
    retainWorkflowFinalizationFailure(primary, secondary, context.releaseId, context.requestId);
  }
  throw primary;
}
