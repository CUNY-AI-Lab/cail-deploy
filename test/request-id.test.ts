import { describe, expect, test } from "bun:test";
import { requestIdForRequest } from "../src/request-id";

describe("cross-component correlation", () => {
  test("adopts the canonical CAIL request ID unchanged", () => {
    const requestId = "019f8bdc-342a-76e1-ba71-005d69808f86";
    expect(
      requestIdForRequest(
        new Request("https://deploy.invalid", {
          headers: { "X-CAIL-Request-Id": requestId },
        }),
      ),
    ).toBe(requestId);
  });

  test("rejects malformed supplied correlation", () => {
    expect(() =>
      requestIdForRequest(
        new Request("https://deploy.invalid", {
          headers: { "X-CAIL-Request-Id": "not-a-uuid" },
        }),
      ),
    ).toThrow("must be a UUID");
  });
});
