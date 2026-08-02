import { describe, expect, test } from "bun:test";
import { TEST_SUBJECTS } from "@cuny-ai-lab/cail-identity/testing";
import { handleMcpWithPrincipal } from "../src/adapters/cloudflare/mcp";
import type { Principal } from "../src/auth";
import { ApiError, errorResponse } from "../src/domain/errors";
import type { Env } from "../src/env";
import { workerHandler } from "../src/handler";

const requestId = "019f8bdc-342a-76e1-ba71-005d69808f86";
const principal: Principal = {
  subject: TEST_SUBJECTS.alice,
  authentication: "cail-identity-jwt",
};

interface HostileValue {
  value: object;
  trapCount(): number;
  sentinel: Error;
}

function hostileValue(label: string): HostileValue {
  const sentinel = new Error(`PRIVATE_${label}_SENTINEL`);
  let traps = 0;
  const trap = () => {
    traps += 1;
    throw sentinel;
  };
  return {
    value: new Proxy(Object.create(null) as object, {
      get: trap,
      getOwnPropertyDescriptor: trap,
      getPrototypeOf: trap,
      has: trap,
      ownKeys: trap,
    }),
    trapCount: () => traps,
    sentinel,
  };
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

function rejectingEnv(rejection: () => unknown): Env {
  const statement = {
    bind() {
      return statement;
    },
    async first() {
      throw rejection();
    },
  };
  return {
    AUTH_MODE: "test",
    CAIL_ENVIRONMENT: "test",
    TEST_PRINCIPALS_JSON: JSON.stringify({ reviewer: TEST_SUBJECTS.alice }),
    SERVICE_AUDIENCE: "https://deploy.invalid",
    DB: {
      prepare() {
        return statement;
      },
    } as unknown as D1Database,
  } as Env;
}

function projectRequest(correlation = requestId): Request {
  return new Request("https://deploy.invalid/v1/projects", {
    method: "POST",
    headers: {
      Authorization: "Bearer reviewer",
      "Content-Type": "application/json",
      "Idempotency-Key": "typed-boundary-regression",
      "X-CAIL-Request-Id": correlation,
    },
    body: JSON.stringify({ name: "Typed boundary regression" }),
  });
}

function mcpCreateProjectRequest(): Request {
  return new Request("https://deploy.invalid/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "kale.create_project",
        arguments: {
          name: "Typed boundary regression",
          idempotencyKey: "typed-boundary-regression",
        },
      },
    }),
  });
}

describe("owned API error boundary", () => {
  test("serializes hostile and primitive rejected values without inspecting them", async () => {
    const hostile = hostileValue("DIRECT");
    const response = errorResponse(hostile.value, requestId);

    expect(response.status).toBe(500);
    expect(await errorEnvelope(response)).toEqual({
      code: "internal_error",
      message: "The request could not be completed.",
      requestId,
    });
    expect(response.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(response.headers.get("X-CAIL-Request-Id")).toBeNull();
    expect(hostile.trapCount()).toBe(0);

    for (const value of [undefined, null, false, 0, 1n, "failure", Symbol("failure")]) {
      const primitive = errorResponse(value, requestId);
      expect(primitive.status).toBe(500);
      expect(await errorEnvelope(primitive)).toEqual({
        code: "internal_error",
        message: "The request could not be completed.",
        requestId,
      });
    }
  });

  test("uses the immutable owned snapshot for genuine ApiError authority", async () => {
    const error = new ApiError(409, "owned_conflict", "The owned request conflicts.");
    let accessorReads = 0;
    for (const property of ["status", "code", "message", "name"]) {
      Object.defineProperty(error, property, {
        configurable: true,
        get() {
          accessorReads += 1;
          throw new Error(`PRIVATE_${property}_ACCESSOR`);
        },
      });
    }

    const response = errorResponse(error, requestId);
    expect(response.status).toBe(409);
    expect(await errorEnvelope(response)).toEqual({
      code: "owned_conflict",
      message: "The owned request conflicts.",
      requestId,
    });
    expect(accessorReads).toBe(0);
  });

  test("contains an authenticated service rejection as the exact correlated generic 500", async () => {
    const hostile = hostileValue("SERVICE");
    const response = await workerHandler.fetch(
      projectRequest(),
      rejectingEnv(() => hostile.value),
    );

    expect(response.status).toBe(500);
    expect(await errorEnvelope(response)).toEqual({
      code: "internal_error",
      message: "The request could not be completed.",
      requestId,
    });
    expect(response.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(response.headers.get("X-CAIL-Request-Id")).toBeNull();
    expect(hostile.trapCount()).toBe(0);
  });

  test("preserves genuine route ApiError authority without trusting a TypeError prefix", async () => {
    const genuine = await workerHandler.fetch(
      projectRequest(),
      rejectingEnv(
        () => new ApiError(503, "owned_service_unavailable", "The owned service is unavailable."),
      ),
    );
    expect(genuine.status).toBe(503);
    expect(await errorEnvelope(genuine)).toEqual({
      code: "owned_service_unavailable",
      message: "The owned service is unavailable.",
      requestId,
    });

    const impersonator = await workerHandler.fetch(
      projectRequest(),
      rejectingEnv(() => new TypeError("X-CAIL-Request-Id PRIVATE_BINDING_TYPE_ERROR")),
    );
    expect(impersonator.status).toBe(500);
    expect(await errorEnvelope(impersonator)).toEqual({
      code: "internal_error",
      message: "The request could not be completed.",
      requestId,
    });
  });

  test("keeps malformed inbound request IDs correlated under owned authority", async () => {
    const response = await workerHandler.fetch(
      projectRequest("not-a-uuid"),
      rejectingEnv(() => new Error("DB_MUST_NOT_BE_REACHED")),
    );
    const error = await errorEnvelope(response);

    expect(response.status).toBe(400);
    expect(error.code).toBe("invalid_request_id");
    expect(error.message).toBe("X-CAIL-Request-Id must be a UUID.");
    expect(error.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  test("contains hostile service rejection inside the correlated MCP tool envelope", async () => {
    const hostile = hostileValue("MCP_SERVICE");
    const response = await handleMcpWithPrincipal(
      mcpCreateProjectRequest(),
      rejectingEnv(() => hostile.value),
      requestId,
      principal,
    );
    const body = (await response.json()) as {
      result: {
        content: [{ text: string }];
        isError: boolean;
      };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("X-CAIL-Request-Id")).toBe(requestId);
    expect(response.headers.get("x-request-id")).toBe(requestId);
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text)).toEqual({
      error: {
        code: "internal_error",
        message: "The request could not be completed.",
        requestId,
      },
    });
    expect(body.result.content[0].text).not.toContain(hostile.sentinel.message);
    expect(hostile.trapCount()).toBe(0);
  });
});
