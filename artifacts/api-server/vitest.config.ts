import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./src/__tests__/test-env.ts"],
    include: ["src/**/*.test.ts"],
    globals: false,
    // Each file gets its own worker so per-file PG schemas + test-context state
    // never leak across files. Tests within a file run serially (single
    // schema reused with TRUNCATE between).
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
    fileParallelism: true,
    sequence: {
      concurrent: false,
    },
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // vi.mock("@workspace/...") only intercepts modules that vite has
    // transformed. Workspace TS packages would otherwise be loaded by
    // Node's native ESM loader and bypass the mock registry, so we inline
    // every workspace package whose exports our route handlers reach into.
    server: {
      deps: {
        inline: [
          "@workspace/db",
          "@workspace/codes",
          "@workspace/codes-sources",
          "@workspace/integrations-anthropic-ai",
          "@workspace/api-zod",
          "@workspace/logger",
        ],
      },
    },
  },
});
