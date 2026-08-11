import { describe, expect, test } from "bun:test";

interface WranglerConfig {
  compatibility_flags?: string[];
  vars?: Record<string, unknown>;
}

const configs = [
  "wrangler.jsonc",
  "wrangler.oauth-config-test.jsonc",
  "wrangler.oauth-test.jsonc",
  "wrangler.release-workerd-test.jsonc",
  "wrangler.wfp-api-test.jsonc",
  "wrangler.workerd-test.jsonc",
] as const;

const allConfigs = [...configs, "wrangler.production.jsonc"] as const;

async function loadConfig(path: string): Promise<WranglerConfig> {
  return Bun.JSONC.parse(await Bun.file(path).text()) as WranglerConfig;
}

describe("Wrangler deployment environment bindings", () => {
  test("every maintained config passes incoming cancellation to subrequests", async () => {
    for (const path of allConfigs) {
      const config = await loadConfig(path);
      expect(config.compatibility_flags, path).toEqual([
        "nodejs_compat",
        "enable_request_signal",
        "request_signal_passthrough",
      ]);
    }
  });

  test("every maintained config declares the isolated test environment", async () => {
    for (const path of configs) {
      const config = await loadConfig(path);
      expect(config.vars?.CAIL_ENVIRONMENT, path).toBe("test");
    }
  });

  test("the production environment declares its own binding", async () => {
    const config = await loadConfig("wrangler.production.jsonc");
    expect(config.vars?.CAIL_ENVIRONMENT).toBe("production");
  });

  test("the production profile does not pin a source revision", async () => {
    const source = await Bun.file("wrangler.production.jsonc").text();
    expect(source).not.toMatch(/"SERVICE_RELEASE"/u);
  });
});
