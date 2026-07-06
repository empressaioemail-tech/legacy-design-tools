import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

/**
 * Tests-only Vite/Vitest config. Intentionally separate from
 * `vite.config.ts`, which requires PORT/BASE_PATH env vars from the dev
 * workflow. Mirrors `artifacts/plan-review/vitest.config.ts` so the
 * artifacts stay in lock-step on test infra.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    // Mirror the `@/*` alias from `vite.config.ts` so test files (and
    // any app modules they pull in) can resolve `@/...` imports.
    //
    // The `@empressaio/*` workspace packages publish only a built `dist/`
    // (bare `import "react"` that vitest's transform pipeline cannot
    // resolve). Alias them to their TS source for tests so the react
    // plugin transforms them and `react` resolves normally.
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@empressaio/tile-shell": path.resolve(
        import.meta.dirname,
        "../../packages/tile-shell/src/index.ts",
      ),
      "@empressaio/cortex-tiles": path.resolve(
        import.meta.dirname,
        "../../packages/cortex-tiles/src/index.ts",
      ),
      "@empressaio/cortex-client": path.resolve(
        import.meta.dirname,
        "../../packages/cortex-client/src/index.ts",
      ),
    },
    // Mirror vite.config.ts so a single React copy is used when the
    // aliased `@empressaio/*` source is transformed from outside the app root.
    dedupe: ["react", "react-dom"],
  },
  test: {
    environment: "happy-dom",
    globals: false,
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test-setup.ts"],
    css: false,
    pool: "forks",
    testTimeout: 10_000,
    server: {
      // Workspace TS packages must be inlined so vite transforms their
      // JSX/TS source.
      deps: {
        inline: ["@workspace/portal-ui", "@workspace/api-client-react"],
      },
    },
  },
});
