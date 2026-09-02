import { describe, expect, test } from "bun:test";
import type { JsonValue } from "../src/domain/json";

interface WranglerConfig {
  analytics_engine_datasets?: Array<{ binding?: string; dataset?: string }>;
  vars?: Record<string, JsonValue>;
}

async function loadConfig(path: string): Promise<WranglerConfig> {
  // SAFETY: Wrangler JSONC is parsed at this file boundary and this named
  // contract covers every field asserted by the configuration tests.
  return Bun.JSONC.parse(await Bun.file(path).text()) as WranglerConfig;
}

describe("Wrangler deployment environment bindings", () => {
  test("the production environment declares its own binding", async () => {
    const config = await loadConfig("wrangler.production.jsonc");
    expect(config.vars?.CAIL_ENVIRONMENT).toBe("production");
    expect(config.analytics_engine_datasets).toEqual([
      { binding: "CAIL_FLEET_EVENTS", dataset: "cail_fleet_events_v1" },
    ]);
  });
});
