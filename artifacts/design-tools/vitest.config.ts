import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * Tests-only Vite/Vitest config. Intentionally separate from `vite.config.ts`
 * which requires PORT/BASE_PATH env vars from the dev workflow. Tests just
 * need React JSX transform + happy-dom + setupFiles.
 */
export default defineConfig({
  plugins: [react()],
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
        ],
      },
    },
  },
});
