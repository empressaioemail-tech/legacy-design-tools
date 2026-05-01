import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * Tests-only Vite/Vitest config for the shared portal-ui lib.
 *
 * Mirrors `artifacts/plan-review/vitest.config.ts` and
 * `artifacts/design-tools/vitest.config.ts` (happy-dom + React JSX
 * transform + jest-dom matchers via `setupFiles`) so a unit test that
 * mounts a portal-ui component in isolation behaves the same way as
 * the surface-level integration tests on the two consuming artifacts.
 *
 * Originally added in Task #360 to back the standalone
 * `<CopyPlainTextButton />` unit test, then extended in Task #362 to
 * host component-level tests for the rest of the shared dialogs
 * (`BriefingDivergenceDetailDialog`, `SubmitToJurisdictionDialog`,
 * `ResolvedByChip`, …) so a refactor that touches only portal-ui can
 * never ship without ever running a portal-ui-scoped test.
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
      // Workspace TS packages must be inlined so vi.mock works on them
      // and so vite transforms their JSX/TS source.
      deps: {
        inline: [
          "@workspace/api-client-react",
          "@workspace/api-zod",
          "@workspace/adapters",
        ],
      },
    },
  },
});
