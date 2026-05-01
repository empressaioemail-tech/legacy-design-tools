import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * Vitest config for `@workspace/briefing-prior-snapshot` (Task #361).
 *
 * The lib's only test file (`src/BriefingPriorSnapshotHeader.test.tsx`)
 * mounts a real React tree to pin the header's meta-line conditional,
 * the friendly-actor rewrite, the seven-section copy payload shape,
 * the silent fallback when `navigator.clipboard` is missing, and the
 * 2 s "Copied!" revert. That requires:
 *
 *   - the React JSX transform (`@vitejs/plugin-react`) so `.tsx` files
 *     compile under vitest,
 *   - `happy-dom` so `render()` from @testing-library has a DOM, and
 *   - a setup file that wires `@testing-library/jest-dom` matchers
 *     and runs `cleanup()` between tests.
 *
 * `server.deps.inline` mirrors the artifact-side configs so the two
 * workspace deps the header pulls from (`@workspace/briefing-diff` for
 * `formatBriefingActor`, `@workspace/portal-ui` for the
 * `CopyPlainTextButton`) are transformed by Vite at test time instead
 * of being treated as opaque externals.
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
      deps: {
        inline: [
          "@workspace/briefing-diff",
          "@workspace/portal-ui",
        ],
      },
    },
  },
});
