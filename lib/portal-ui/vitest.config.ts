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
 * Added in Task #360 to back the standalone `<CopyPlainTextButton />`
 * unit test — the prior coverage was indirect, going through the
 * Plan Review and design-tools `BriefingRecentRunsPanel` integration
 * tests, so a future tweak to the shared button (icon swap, tooltip,
 * timing change) had to wait for both surface suites to fail before a
 * regression surfaced. Tests living next to the component are fast,
 * focused, and don't have to seed a prior-narrative row through
 * react-query before they can click.
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
  },
});
