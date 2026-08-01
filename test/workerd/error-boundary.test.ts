import { createExecutionContext } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import {
  createOAuthProviderOptions,
  oauthWorkerHandler,
} from "../../src/adapters/cloudflare/oauth";
import { ApiError } from "../../src/domain/errors";
import type { Env, ReleaseWorkflowParams } from "../../src/env";
import { ReleaseWorkflow } from "../../src/workflow";

const requestId = "22222222-2222-4222-8222-222222222222";
const releaseId = `rel_${"3".repeat(32)}`;
const workflowParams: ReleaseWorkflowParams = {
  projectId: `prj_${"2".repeat(32)}`,
  releaseId,
  revisionId: `rev_sha256_${"4".repeat(64)}`,
  requestId,
  admittedAt: "2026-07-23T00:00:00.000Z",
};

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    PUBLIC_BASE_URL: "https://deploy.invalid",
    ...overrides,
  } as Env;
}

async function errorEnvelope(response: Response): Promise<{
  code: string;
  message: string;
  requestId: string;
}> {
  return (
    (await response.json()) as {
      error: { code: string; message: string; requestId: string };
    }
  ).error;
}

function oauthDefaultHandler(env: Env): ExportedHandler<Env> {
  const handler = createOAuthProviderOptions(env).defaultHandler;
  if (typeof handler === "function") {
    throw new Error("Expected the configured default OAuth handler object.");
  }
  return handler;
}

interface BoundStatement {
  sql: string;
  args: unknown[];
}

async function runWorkflowPrimary(primary: unknown): Promise<{
  ambiguousCalls: number;
  batches: BoundStatement[][];
  terminalCalls: number;
  thrown: unknown;
}> {
  const batches: BoundStatement[][] = [];
  const env = {
    AUTH_MODE: "test",
    DB: {
      prepare(sql: string) {
        const statement: BoundStatement & { bind(...args: unknown[]): BoundStatement } = {
          sql,
          args: [],
          bind(...args: unknown[]) {
            statement.args = args;
            return statement;
          },
        };
        return statement;
      },
      async batch(statements: BoundStatement[]) {
        batches.push(statements);
        // transitionReleaseStatus updates the row first, then inserts its
        // event only when that update changed one row. Keep both statements
        // successful so this fake models the atomic pair used by production.
        return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }];
      },
    },
  } as unknown as Env;
  let ambiguousCalls = 0;
  let terminalCalls = 0;
  const step = {
    async do(name: string, ...options: unknown[]) {
      if (name === "mark validating") throw primary;
      const callback = options.find(
        (option): option is () => Promise<unknown> => typeof option === "function",
      );
      if (!callback) throw new Error(`Missing callback for ${name}.`);
      if (name === "record ambiguous publication") ambiguousCalls += 1;
      else if (name === "record terminal failure") terminalCalls += 1;
      else throw new Error(`Unexpected Workflow step ${name}.`);
      return callback();
    },
  };
  let thrown: unknown;
  try {
    await ReleaseWorkflow.prototype.run.call(
      { env } as ReleaseWorkflow,
      { payload: workflowParams } as WorkflowEvent<ReleaseWorkflowParams>,
      step as unknown as WorkflowStep,
    );
  } catch (error) {
    thrown = error;
  }
  return { ambiguousCalls, batches, terminalCalls, thrown };
}

describe("OAuth typed error boundary in workerd", () => {
  test("contains hostile and TypeError-prefixed default-handler failures", async () => {
    const configured = baseEnv();
    const handler = oauthDefaultHandler(configured);
    const privateSentinel = new Error("PRIVATE_OAUTH_PROXY_SENTINEL");
    let hostileTraps = 0;
    const hostile = new Proxy(Object.create(null) as object, {
      get() {
        hostileTraps += 1;
        throw privateSentinel;
      },
      getOwnPropertyDescriptor() {
        hostileTraps += 1;
        throw privateSentinel;
      },
      getPrototypeOf() {
        hostileTraps += 1;
        throw privateSentinel;
      },
    });
    const request = () =>
      new Request("https://deploy.invalid/api/oauth/authorize", {
        headers: { "X-CAIL-Request-Id": requestId },
      });
    const envThrowing = (failure: unknown) =>
      new Proxy(configured, {
        get(target, property, receiver) {
          if (property === "OAUTH_PROVIDER") throw failure;
          return Reflect.get(target, property, receiver);
        },
      });

    const hostileResponse = await handler.fetch?.(request(), envThrowing(hostile), {
      waitUntil() {},
      passThroughOnException() {},
    });
    expect(hostileResponse).toBeInstanceOf(Response);
    expect(hostileResponse?.status).toBe(500);
    expect(await errorEnvelope(hostileResponse as Response)).toEqual({
      code: "internal_error",
      message: "The request could not be completed.",
      requestId,
    });
    expect(hostileResponse?.headers.get("X-CAIL-Request-Id")).toBe(requestId);
    expect(hostileTraps).toBe(0);

    const impersonator = await handler.fetch?.(
      request(),
      envThrowing(new TypeError("X-CAIL-Request-Id PRIVATE_OAUTH_TYPE_ERROR")),
      {
        waitUntil() {},
        passThroughOnException() {},
      },
    );
    expect(impersonator?.status).toBe(500);
    expect(await errorEnvelope(impersonator as Response)).toEqual({
      code: "internal_error",
      message: "The request could not be completed.",
      requestId,
    });

    const genuine = await handler.fetch?.(
      request(),
      envThrowing(new ApiError(503, "owned_oauth_error", "The owned OAuth error.")),
      {
        waitUntil() {},
        passThroughOnException() {},
      },
    );
    expect(genuine?.status).toBe(503);
    expect(await errorEnvelope(genuine as Response)).toEqual({
      code: "owned_oauth_error",
      message: "The owned OAuth error.",
      requestId,
    });
  });

  test("keeps malformed outer request IDs under owned authority", async () => {
    const response = await oauthWorkerHandler.fetch(
      new Request("https://deploy.invalid/", {
        headers: { "X-CAIL-Request-Id": "not-a-uuid" },
      }),
      baseEnv(),
      createExecutionContext(),
    );
    const error = await errorEnvelope(response);

    expect(response.status).toBe(400);
    expect(error.code).toBe("invalid_request_id");
    expect(error.message).toBe("X-CAIL-Request-Id must be a UUID.");
    expect(error.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });
});

describe("Workflow terminal error classification in workerd", () => {
  test("does not inspect a hostile primary and records one safe terminal failure", async () => {
    const privateSentinel = new Error("PRIVATE_WORKFLOW_PRIMARY_SENTINEL");
    let traps = 0;
    const primary = new Proxy(Object.create(null) as object, {
      get() {
        traps += 1;
        throw privateSentinel;
      },
      getOwnPropertyDescriptor() {
        traps += 1;
        throw privateSentinel;
      },
      getPrototypeOf() {
        traps += 1;
        throw privateSentinel;
      },
    });

    const result = await runWorkflowPrimary(primary);

    expect(result.thrown).toBe(primary);
    expect(result.terminalCalls).toBe(1);
    expect(result.ambiguousCalls).toBe(0);
    expect(result.batches).toHaveLength(1);
    expect(result.batches[0]?.[1]?.args[5]).toBe('{"code":"release_failed"}');
    expect(result.batches[0]?.[0]?.args[0]).toBe("failed");
    expect(JSON.stringify(result.batches)).not.toContain(privateSentinel.message);
    expect(traps).toBe(0);
  });

  test("retains owned publication ambiguity and integrity authority", async () => {
    const ambiguous = new ApiError(
      502,
      "publication_ambiguous",
      "Publication outcome is ambiguous.",
    );
    const ambiguousResult = await runWorkflowPrimary(ambiguous);
    expect(ambiguousResult.thrown).toBeUndefined();
    expect(ambiguousResult.ambiguousCalls).toBe(1);
    expect(ambiguousResult.terminalCalls).toBe(0);
    expect(ambiguousResult.batches[0]?.[1]?.args[5]).toBe('{"code":"publication_ambiguous"}');

    const integrity = new ApiError(
      500,
      "artifact_integrity_failed",
      "The retained artifact failed verification.",
    );
    const integrityResult = await runWorkflowPrimary(integrity);
    expect(integrityResult.thrown).toBe(integrity);
    expect(integrityResult.terminalCalls).toBe(1);
    expect(integrityResult.ambiguousCalls).toBe(0);
    expect(integrityResult.batches[0]?.[1]?.args[5]).toBe('{"code":"artifact_integrity_failed"}');
  });
});
