import { describe, expect, test } from "bun:test";
import { finalizeWorkflowFailure } from "../src/workflow-failure";

const requestId = "11111111-1111-4111-8111-111111111111";
const releaseId = "rel_22222222222222222222222222222222";

describe("Workflow terminal failure finalization", () => {
  test("preserves the primary failure and retains finalization failure secondarily", async () => {
    const diagnostics: unknown[] = [];
    const originalConsoleError = console.error;
    console.error = (diagnostic: unknown) => {
      diagnostics.push(diagnostic);
    };
    const originalCause = new Error("original cause");
    const primary = new Error("primary workflow failure", {
      cause: originalCause,
    });
    const secondary = new Error("terminal finalization failure");

    try {
      let thrown: unknown;
      try {
        await finalizeWorkflowFailure(
          primary,
          async () => {
            throw secondary;
          },
          { releaseId, requestId },
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBe(primary);
      expect(primary.cause).toBeInstanceOf(AggregateError);
      expect((primary.cause as AggregateError).cause).toBe(originalCause);
      expect((primary.cause as AggregateError).errors).toEqual([secondary]);
      expect(diagnostics).toEqual([
        {
          event: "deploy.workflow.terminal_finalization_failed",
          error: "terminal_finalization_failed",
          releaseId,
          requestId,
        },
      ]);
      expect(JSON.stringify(diagnostics)).not.toContain("workflow failure");
      expect(JSON.stringify(diagnostics)).not.toContain("finalization failure");
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("rethrows the primary failure when finalization succeeds", async () => {
    const primary = new Error("primary workflow failure");
    let finalized = false;

    let thrown: unknown;
    try {
      await finalizeWorkflowFailure(
        primary,
        async () => {
          finalized = true;
        },
        { releaseId, requestId },
      );
    } catch (error) {
      thrown = error;
    }

    expect(finalized).toBe(true);
    expect(thrown).toBe(primary);
    expect(primary.cause).toBeUndefined();
  });
});
