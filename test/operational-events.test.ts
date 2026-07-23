import { describe, expect, test } from "bun:test";
import type { Env } from "../src/env";
import { emitReleaseAdmission, emitReleaseTerminal } from "../src/operational-events";

const releaseId = "rel_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa";
const operationalSubject = `cail-v1-${"b".repeat(32)}`;
const env = {
  AUTH_MODE: "test",
  SERVICE_RELEASE: "8baede9",
} as Env;

function captureEvents(run: () => void): {
  records: unknown[];
  diagnostics: unknown[];
} {
  const records: unknown[] = [];
  const diagnostics: unknown[] = [];
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  console.log = (record: unknown) => {
    records.push(record);
  };
  console.error = (diagnostic: unknown) => {
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
          "ok",
          "completed",
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
      const { records, diagnostics } = captureEvents(() => {
        emitReleaseAdmission(env, releaseId, requestId, operationalSubject);
        emitReleaseTerminal(
          env,
          releaseId,
          requestId,
          operationalSubject,
          new Date(Date.now() - 10).toISOString(),
          "ok",
          "completed",
        );
      });

      expect(records).toEqual([]);
      expect(diagnostics).toEqual([
        "cail-log: event_contract_error",
        "cail-log: event_contract_error",
      ]);
    }
  });
});
