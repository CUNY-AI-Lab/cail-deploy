import { describe, expect, test } from "bun:test";
import { authorizationActionUrl, authorizationOrigin } from "../src/oauth-consent";

describe("browser OAuth consent boundary", () => {
  const env = {
    OAUTH_AUTHORIZE_URL: "https://tools.ailab.gc.cuny.edu/api/oauth/authorize",
  } as const;

  test("uses the configured public Doorway origin when the handler URL is internal", () => {
    expect(
      authorizationActionUrl(
        env,
        "https://cail-doorway.ailab-452.workers.dev/api/oauth/authorize?response_type=code&state=state-1",
      ),
    ).toBe("https://tools.ailab.gc.cuny.edu/api/oauth/authorize?response_type=code&state=state-1");
    expect(authorizationOrigin(env)).toBe("https://tools.ailab.gc.cuny.edu");
  });

  test("preserves duplicate and encoded OAuth query parameters exactly", () => {
    const action = authorizationActionUrl(
      env,
      "https://internal.invalid/authorize?scope=cail%3Adeploy&scope=cail%3Adeploy&resource=https%3A%2F%2Fkale.example%2Fmcp%3Fx%3D1",
    );
    expect(action).toBe(
      "https://tools.ailab.gc.cuny.edu/api/oauth/authorize?scope=cail%3Adeploy&scope=cail%3Adeploy&resource=https%3A%2F%2Fkale.example%2Fmcp%3Fx%3D1",
    );
  });

  test("does not inherit an internal request origin", () => {
    expect(
      authorizationOrigin({
        OAUTH_AUTHORIZE_URL: "https://tools.ailab.gc.cuny.edu/api/oauth/authorize",
      }),
    ).not.toBe("https://cail-doorway.ailab-452.workers.dev");
  });
});
