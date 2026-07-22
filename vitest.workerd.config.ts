import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-07-22",
        compatibilityFlags: ["nodejs_compat"],
      },
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
