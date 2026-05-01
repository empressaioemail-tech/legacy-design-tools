import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

/**
 * Tests-only Vite/Vitest config. Intentionally separate from `vite.config.ts`
 * which requires PORT/BASE_PATH env vars from the dev workflow. Tests just
 * need React JSX transform + happy-dom + setupFiles.
 *
 * Mirrors `artifacts/design-tools/vitest.config.ts` so both apps share the
 * same fast component-test setup.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    // Mirror the `@/*` alias from `vite.config.ts` so test files (and any
    // app modules they pull in) can resolve imports like `@/lib/utils`.
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
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
      // Workspace TS packages must be inlined so vi.mock works on them and
      // so vite transforms their JSX/TS source.
      deps: {
        inline: [
          "@workspace/portal-ui",
          "@workspace/api-client-react",
          "@workspace/object-storage-web",
        ],
      },
    },
  },
});
