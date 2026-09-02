import { describe, expect, test } from "bun:test";
import { readLoggingContext, type Env } from "../src/env";
import { emitReleaseAdmission, emitReleaseTerminal } from "../src/operational-events";
import type { JsonValue } from "../src/domain/json";

const releaseId = "rel_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa";
const operationalSubject = `cail-v1-${"b".repeat(32)}`;
// SAFETY: this fixture supplies the environment fields consumed by the event sink.
const env = {
  AUTH_MODE: "test",
  CAIL_ENVIRONMENT: "test",
  SERVICE_RELEASE: "8baede9",
} as Env;

interface CapturedEvents {
  records: JsonValue[];
  diagnostics: JsonValue[];
}

function captureEvents(run: () => void): CapturedEvents {
  const records: JsonValue[] = [];
  const diagnostics: JsonValue[] = [];
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  console.log = (record: JsonValue) => {
    records.push(record);
  };
  console.error = (diagnostic: JsonValue) => {
    diagnostics.push(diagnostic);
  };
  try {
    run();
  } finally {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  }
  return { records, diagnostics };
}

describe("release operational event contract", () => {
  for (const [version, requestId] of [
    ["UUIDv4", "11111111-1111-4111-8111-111111111111"],
    ["UUIDv7", "017f22e2-79b0-7cc3-98c4-dc0c0c07398f"],
  ] as const) {
    test(`the actual Workers sink emits ${version} admitted and terminal records with the canonical route`, () => {
      const { records, diagnostics } = captureEvents(() => {
        emitReleaseAdmission(env, releaseId, requestId, operationalSubject);
        emitReleaseTerminal(
          env,
          releaseId,
          requestId,
          operationalSubject,
          new Date(Date.now() - 10).toISOString(),
          { outcome: "ok", reason: "completed" },
        );
      });

      expect(diagnostics).toEqual([]);
      expect(records).toHaveLength(2);
      expect(records).toEqual([
        expect.objectContaining({
          "event.name": "cail.action.admitted",
          "cail.request.id": requestId,
          "url.template": "/v1/projects/{projectId}/releases",
        }),
        expect.objectContaining({
          "event.name": "cail.action.terminal",
          "cail.request.id": requestId,
          "url.template": "/v1/projects/{projectId}/releases",
        }),
      ]);
    });
  }

  test("the actual Workers sink rejects malformed, wrong-version, wrong-variant, and uppercase request IDs", () => {
    const invalidRequestIds = [
      "not-a-uuid",
      "017f22e2-79b0-6cc3-98c4-dc0c0c07398f",
      "017f22e2-79b0-7cc3-78c4-dc0c0c07398f",
      "017F22E2-79B0-7CC3-98C4-DC0C0C07398F",
    ];

    for (const requestId of invalidRequestIds) {
      const { records } = captureEvents(() => {
        emitReleaseAdmission(env, releaseId, requestId, operationalSubject);
        emitReleaseTerminal(
          env,
          releaseId,
          requestId,
          operationalSubject,
          new Date(Date.now() - 10).toISOString(),
          { outcome: "ok", reason: "completed" },
        );
      });

      expect(records).toEqual([]);
    }
  });

  test("joins a production event with exact resource and correlation fields", () => {
    // SAFETY: this fixture changes only the deployment label while retaining the
    // environment fields required by readLoggingContext.
    const productionEnv = { ...env, CAIL_ENVIRONMENT: "production" } as Env;
    const requestId = "11111111-1111-4111-8111-111111111111";
    const { records, diagnostics } = captureEvents(() => {
      emitReleaseAdmission(productionEnv, releaseId, requestId, operationalSubject);
    });

    expect(diagnostics).toEqual([]);
    expect(records).toEqual([
      expect.objectContaining({
        "event.name": "cail.action.admitted",
        "cail.action.id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "cail.product.id": "kale-deploy",
        "cail.request.id": requestId,
        "service.name": "kale-release-control-plane",
        "service.version": "8baede9",
        "deployment.environment.name": "production",
        "cail.principal.type": "user",
      }),
    ]);
  });

  test("fans privacy-safe release events into the fleet diagnostic dataset", () => {
    const points: unknown[] = [];
    // SAFETY: this fixture changes only the deployment label and diagnostic
    // sink while retaining every Env field consumed by the event path.
    const productionEnv = {
      ...env,
      CAIL_ENVIRONMENT: "production",
      CAIL_FLEET_EVENTS: {
        writeDataPoint(point: JsonValue) {
          points.push(point);
        },
      },
    } as Env;
    const { records, diagnostics } = captureEvents(() => {
      emitReleaseAdmission(
        productionEnv,
        releaseId,
        "11111111-1111-4111-8111-111111111111",
        operationalSubject,
      );
    });

    expect(diagnostics).toEqual([]);
    expect(records).toHaveLength(1);
    expect(points).toHaveLength(1);
    expect(JSON.stringify(points[0])).not.toContain(operationalSubject);
    expect(points[0]).toMatchObject({
      blobs: expect.arrayContaining([
        "cail.action.admitted",
        "kale-release-control-plane",
        "production",
        "kale-deploy",
      ]),
    });
  });

  test.each([
    undefined,
    "",
    "development",
    "unknown",
    "Production",
    " production",
    "production ",
    " test",
  ])("rejects missing or non-canonical environment %s without emitting", (environment) => {
    // SAFETY: each table value deliberately violates the runtime environment
    // contract so readLoggingContext can prove it fails closed.
    const invalidEnv = { ...env, CAIL_ENVIRONMENT: environment } as Env;
    expect(readLoggingContext(invalidEnv)).toBeNull();
    const { records, diagnostics } = captureEvents(() => {
      emitReleaseAdmission(invalidEnv, releaseId, "11111111-1111-4111-8111-111111111111");
    });
    expect(records).toEqual([]);
    expect(diagnostics).toEqual([]);
  });
});
