import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Backfill tests spin up a fresh DB schema each run via
    // @workspace/db/testing, which can take ~5s on a cold pool.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
