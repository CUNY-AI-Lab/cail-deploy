import { describe, expect, test } from "bun:test";
import { validatedOAuthPublicBaseUrl } from "../src/adapters/cloudflare/oauth-origin";

describe("OAuth public origin boundary", () => {
  test("accepts exact HTTPS deployment and loopback HTTP test origins", () => {
    expect(
      validatedOAuthPublicBaseUrl(
        "https://ki-20260722223510-ecade68e-deploy.ailab-452.workers.dev",
      ),
    ).toBe("https://ki-20260722223510-ecade68e-deploy.ailab-452.workers.dev");
    expect(validatedOAuthPublicBaseUrl("http://127.0.0.1:49152")).toBe("http://127.0.0.1:49152");
    expect(validatedOAuthPublicBaseUrl("http://localhost:8787")).toBe("http://localhost:8787");
  });

  test("rejects non-loopback HTTP and credential-bearing origins", () => {
    for (const value of [
      "http://deploy.example",
      "http://192.0.2.1:8787",
      "https://user:secret@deploy.example",
      "http://user:secret@127.0.0.1:8787",
    ]) {
      expect(() => validatedOAuthPublicBaseUrl(value)).toThrow();
      try {
        validatedOAuthPublicBaseUrl(value);
      } catch (error) {
        expect(error).toMatchObject({ status: 503, code: "oauth_not_configured" });
      }
    }
  });
});
