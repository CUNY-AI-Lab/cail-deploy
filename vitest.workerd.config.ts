import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "wrangler.workerd-test.jsonc" },
    }),
  ],
  test: {
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: ["@cloudflare/worker-bundler"],
        },
      },
    },
    include: ["test/workerd/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
