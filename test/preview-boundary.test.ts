import { describe, expect, test } from "bun:test";
import { handleApiForPrincipal, previewTimeoutMs } from "../src/api";
import type { Principal } from "../src/auth";
import type { Env } from "../src/env";

const projectId = `prj_${"a".repeat(32)}`;
const subject = `cail_${"b".repeat(32)}`;
const requestId = "11111111-1111-4111-8111-111111111111";
const principal: Principal = {
  subject,
  authentication: "isolated-test-bearer",
};

function previewEnv(input: {
  fetch: (request: Request) => Promise<Response>;
  timeout?: string;
}): Env {
  return {
    PREVIEW_TIMEOUT_MS: input.timeout,
    DB: {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async first() {
                if (sql.includes("SELECT * FROM projects")) {
                  return {
                    project_id: projectId,
                    owner_subject: subject,
                    name: "Preview project",
                    created_at: "2026-07-23T00:00:00.000Z",
                  };
                }
                return {
                  project_id: projectId,
                  release_id: `rel_${"c".repeat(32)}`,
                  status: "live",
                  publication_name: "kp-local-preview",
                };
              },
            };
          },
        };
      },
    },
    DISPATCHER: {
      get() {
        return { fetch: input.fetch };
      },
    },
  } as unknown as Env;
}

function previewRequest(signal?: AbortSignal): Request {
  return new Request(`https://deploy.test/v1/projects/${projectId}/preview`, {
    headers: {
      Authorization: "Bearer must-not-forward",
      "X-CAIL-Identity-JWT": "must-not-forward",
      "X-CAIL-Request-Id": requestId,
    },
    signal,
  });
}

describe("live preview operational boundary", () => {
  test("preview deadline configuration is short and bounded", () => {
    expect(previewTimeoutMs(undefined)).toBe(5_000);
    expect(previewTimeoutMs("100")).toBe(100);
    expect(previewTimeoutMs("30000")).toBe(30_000);
    expect(() => previewTimeoutMs("99")).toThrow("Kale Deploy isn't set up correctly right now.");
    expect(() => previewTimeoutMs("30001")).toThrow(
      "Kale Deploy isn't set up correctly right now.",
    );
    expect(() => previewTimeoutMs("invalid")).toThrow(
      "Kale Deploy isn't set up correctly right now.",
    );
  });

  test("caller cancellation reaches one dispatched request and preserves its cause", async () => {
    const controller = new AbortController();
    const callerCause = new Error("caller disconnected");
    let calls = 0;
    let downstreamSignal: AbortSignal | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const env = previewEnv({
      fetch: async (request) => {
        calls += 1;
        downstreamSignal = request.signal;
        markStarted?.();
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), {
            once: true,
          });
        });
      },
    });

    const pending = handleApiForPrincipal(
      previewRequest(controller.signal),
      env,
      principal,
      requestId,
    );
    await started;
    controller.abort(callerCause);

    let captured: unknown;
    try {
      await pending;
    } catch (error) {
      captured = error;
    }
    expect(calls).toBe(1);
    expect(downstreamSignal?.aborted).toBe(true);
    expect(captured).toMatchObject({
      status: 503,
      code: "preview_unavailable",
      cause: callerCause,
    });
  });

  test("a hanging dispatch times out once without retrying", async () => {
    let calls = 0;
    const env = previewEnv({
      timeout: "100",
      fetch: async (request) => {
        calls += 1;
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), {
            once: true,
          });
        });
      },
    });

    let captured: unknown;
    try {
      await handleApiForPrincipal(previewRequest(), env, principal, requestId);
    } catch (error) {
      captured = error;
    }
    expect(calls).toBe(1);
    expect(captured).toMatchObject({
      status: 503,
      code: "preview_unavailable",
    });
    expect((captured as Error).cause).toBeInstanceOf(DOMException);
    expect(((captured as Error).cause as DOMException).name).toBe("TimeoutError");
  });

  test("normal preview strips credentials and preserves correlation", async () => {
    let calls = 0;
    let observed: Request | undefined;
    const env = previewEnv({
      fetch: async (request) => {
        calls += 1;
        observed = request;
        return new Response("preview-ok", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      },
    });

    const response = await handleApiForPrincipal(previewRequest(), env, principal, requestId);
    expect(calls).toBe(1);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("preview-ok");
    expect(observed?.headers.has("authorization")).toBe(false);
    expect(observed?.headers.has("x-cail-identity-jwt")).toBe(false);
    expect(observed?.headers.get("x-cail-request-id")).toBe(requestId);
  });
});
