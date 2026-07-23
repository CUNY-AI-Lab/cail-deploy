import { createExecutionContext } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import {
  createOAuthProviderOptions,
  oauthWorkerHandler,
} from "../../src/adapters/cloudflare/oauth";
import { ApiError } from "../../src/domain/errors";
import type { Env } from "../../src/env";

const requestId = "22222222-2222-4222-8222-222222222222";

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
