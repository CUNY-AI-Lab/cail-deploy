import { describe, expect, test } from "bun:test";
import { emitDeployDiagnostic, observeDetachedCleanup } from "../src/diagnostics";

const requestId = "11111111-1111-4111-8111-111111111111";

describe("bounded cleanup diagnostics", () => {
  test("observes synchronous and rejected cleanup without logging raw failures", async () => {
    const diagnostics: unknown[] = [];
    const originalConsoleError = console.error;
    console.error = (diagnostic: unknown) => {
      diagnostics.push(diagnostic);
    };
    try {
      observeDetachedCleanup(
        () => {
          throw new Error("PRIVATE_SYNCHRONOUS_CLEANUP_FAILURE");
        },
        "request_body_cancel_failed",
        { requestId },
      );
      observeDetachedCleanup(
        () => Promise.reject(new Error("PRIVATE_REJECTED_CLEANUP_FAILURE")),
        "mcp_body_cancel_failed",
        { requestId },
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(diagnostics).toEqual([
        {
          event: "deploy.request.body_cancel_failed",
          error: "body_cancel_failed",
          requestId,
        },
        {
          event: "deploy.mcp.request.body_cancel_failed",
          error: "body_cancel_failed",
          requestId,
        },
      ]);
      expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_");
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("does not wait for a cleanup that never settles", () => {
    let returned = false;
    observeDetachedCleanup(() => new Promise<void>(() => undefined), "request_body_cancel_failed", {
      requestId,
    });
    returned = true;
    expect(returned).toBe(true);
  });

  test("contains a throwing diagnostic sink", () => {
    const originalConsoleError = console.error;
    console.error = () => {
      throw new Error("PRIVATE_DIAGNOSTIC_SINK_FAILURE");
    };
    try {
      expect(() =>
        emitDeployDiagnostic("request_body_release_failed", { requestId }),
      ).not.toThrow();
      expect(() =>
        observeDetachedCleanup(
          () => {
            throw new Error("PRIVATE_CLEANUP_FAILURE");
          },
          "mcp_body_cancel_failed",
          { requestId },
        ),
      ).not.toThrow();
    } finally {
      console.error = originalConsoleError;
    }
  });
});
