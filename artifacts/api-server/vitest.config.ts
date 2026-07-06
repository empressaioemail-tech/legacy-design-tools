import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // The chat round-trip integration test (`chat-roundtrip.test.ts`)
  // imports the design-tools store and chip renderer via relative path.
  // The renderer is `.tsx`, so we need the React plugin to provide JSX
  // transformation for any cross-artifact files vite pulls into the test
  // graph. Pure-server tests don't render React; the plugin is a no-op
  // for them.
  plugins: [react()],
  resolve: {
    // The `@empressaio/*` workspace packages carry a "workspace" export condition
    // pointing at their TS source (./src). Without this, vite/vitest falls back
    // to the "import"/"require" conditions → dist/, which is not built in the
    // CI Test job (packages aren't prebuilt there), so a *value* import of
    // @empressaio/cortex-client (TILE_CAPABILITIES) fails to resolve. Type-only
    // imports never hit this resolver, which is why the pre-existing type
    // imports resolved fine. Mirrors codex-reviewer-qa/vite.config.ts.
    conditions: ["workspace"],
  },
  // Vitest runs test files through the SSR module graph (pool: "forks"), whose
  // resolver reads ssr.resolve.conditions, NOT the top-level resolve.conditions
  // above. Set it here too so the "workspace" → ./src condition is honored when
  // the test worker resolves @empressaio/cortex-client at runtime.
  ssr: {
    resolve: {
      conditions: ["workspace"],
    },
  },
  test: {
    environment: "node",
    setupFiles: [
      "./src/__tests__/test-env.ts",
      "./src/__tests__/engine-spine-test-setup.ts",
    ],
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
          "@hauska/atom-contract",
          "@empressaio/cortex-client",
          "@workspace/codes-sources",
          "@workspace/integrations-anthropic-ai",
          "@workspace/api-zod",
          "@workspace/logger",
        ],
      },
    },
  },
});
