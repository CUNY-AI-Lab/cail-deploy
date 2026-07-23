const WORKFLOW_FINALIZATION_FAILURE = Symbol("workflow-terminal-finalization-failure");

type WorkflowFinalizationAggregate = AggregateError & {
  [WORKFLOW_FINALIZATION_FAILURE]: true;
};

function emitWorkflowFinalizationDiagnostic(releaseId: string, requestId: string): void {
  try {
    console.error({
      event: "deploy.workflow.terminal_finalization_failed",
      error: "terminal_finalization_failed",
      releaseId,
      requestId,
    });
  } catch {
    // Diagnostics are observational and must never replace the workflow failure.
  }
}

function emitUnattachedDiagnostic(releaseId: string, requestId: string): void {
  try {
    console.error({
      event: "deploy.workflow.finalization_diagnostic_unattached",
      error: "finalization_diagnostic_unattached",
      releaseId,
      requestId,
    });
  } catch {
    // Diagnostics are observational and must never replace the workflow failure.
  }
}

function retainWorkflowFinalizationFailure(
  primary: unknown,
  secondary: unknown,
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
    ) as WorkflowFinalizationAggregate;
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

export async function finalizeWorkflowFailure(
  primary: unknown,
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
