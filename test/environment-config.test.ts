import { describe, expect, test } from "bun:test";

interface WranglerConfig {
  compatibility_flags?: string[];
  observability?: {
    enabled?: boolean;
    logs?: Record<string, unknown>;
    traces?: Record<string, unknown>;
  };
  analytics_engine_datasets?: Array<{ binding?: string; dataset?: string }>;
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
    expect(config.observability).toEqual({
      enabled: true,
      logs: {
        enabled: true,
        persist: true,
        head_sampling_rate: 1,
        invocation_logs: false,
      },
      traces: { enabled: false },
    });
    expect(config.analytics_engine_datasets).toEqual([
      { binding: "CAIL_FLEET_EVENTS", dataset: "cail_fleet_events_v1" },
    ]);
  });

  test("the production profile does not pin a source revision", async () => {
    const source = await Bun.file("wrangler.production.jsonc").text();
    expect(source).not.toMatch(/"SERVICE_RELEASE"/u);
  });
});
