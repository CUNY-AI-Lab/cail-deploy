import { describe, expect, test } from "bun:test";
import type { JsonValue } from "../src/domain/json";
import { finalizeWorkflowFailure } from "../src/workflow-failure";

const requestId = "11111111-1111-4111-8111-111111111111";
const releaseId = "rel_22222222222222222222222222222222";

describe("Workflow terminal failure finalization", () => {
  test("rethrows the primary failure and emits a finalization diagnostic", async () => {
    const diagnostics: JsonValue[] = [];
    const originalConsoleError = console.error;
    console.error = (diagnostic: JsonValue) => {
      diagnostics.push(diagnostic);
    };
    const primary = new Error("primary workflow failure");
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
  });
});
