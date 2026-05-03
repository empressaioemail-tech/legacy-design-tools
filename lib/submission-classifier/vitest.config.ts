import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 10_000,
    // `@workspace/db`'s `src/index.ts` throws at import time when
    // `DATABASE_URL` is missing — and the classifier imports drizzle
    // table refs from it, so even pure-unit tests need a value here.
    // The `withTestSchema` helper reads `TEST_DATABASE_URL` first and
    // falls back to `DATABASE_URL`, so DB-backed tests still target
    // whatever the operator's pointing at; this stub is only here to
    // get past the import-time guard. CI passes the real
    // `TEST_DATABASE_URL` via env.
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgres://stub:stub@localhost:5432/stub",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
    },
  },
});
