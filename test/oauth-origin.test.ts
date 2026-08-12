import { describe, expect, test } from "bun:test";
import {
  validatedOAuthAuthorizeUrl,
  validatedOAuthPublicBaseUrl,
} from "../src/adapters/cloudflare/oauth-origin";

describe("OAuth public origin boundary", () => {
  test("accepts exact HTTPS deployment and loopback HTTP test origins", () => {
    expect(
      validatedOAuthPublicBaseUrl("https://kale-release-control-plane.ailab-452.workers.dev"),
    ).toBe("https://kale-release-control-plane.ailab-452.workers.dev");
    expect(validatedOAuthPublicBaseUrl("http://127.0.0.1:49152")).toBe("http://127.0.0.1:49152");
    expect(validatedOAuthPublicBaseUrl("http://localhost:8787")).toBe("http://localhost:8787");
  });

  test("accepts only the exact Doorway or loopback authorization route", () => {
    expect(
      validatedOAuthAuthorizeUrl("https://cail-doorway.ailab-452.workers.dev/api/oauth/authorize"),
    ).toBe("https://cail-doorway.ailab-452.workers.dev/api/oauth/authorize");
    expect(validatedOAuthAuthorizeUrl("http://127.0.0.1:8787/api/oauth/authorize")).toBe(
      "http://127.0.0.1:8787/api/oauth/authorize",
    );
    for (const value of [
      "http://cail-doorway.example/api/oauth/authorize",
      "https://user@cail-doorway.example/api/oauth/authorize",
      "https://cail-doorway.example/oauth/authorize",
      "https://cail-doorway.example/api/oauth/authorize?next=other",
    ]) {
      expect(() => validatedOAuthAuthorizeUrl(value)).toThrow();
    }
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
